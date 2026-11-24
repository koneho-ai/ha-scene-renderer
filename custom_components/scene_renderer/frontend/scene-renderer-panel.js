// HA Scene Renderer sidebar panel — interactive 3D viewer.
//
// Plain ES module, no build step, no dependencies beyond the vendored
// three.js in this directory. Home Assistant loads this file as the
// panel's module (see panel.py) and sets `hass` (on every state change)
// and `panel` (panel config) on the element.
//
// Data flow:
//   panel_entries / panel_data  -- websocket (hass.callWS)
//   /api/scene_renderer/<entry>/model -- model GLB (hass.fetchWithAuth)
//   /api/image_proxy/<entity_id> -- latest render per camera
//
// The panel never talks to the render service directly — the browser
// cannot reach it. Live light states come from hass.states, so markers
// update on every hass set without rebuilding the scene. panel_data is
// fetched at init and again whenever the hass connection is
// re-established (a new hass.connection object, e.g. after a Home
// Assistant restart) — the mapping, sun, cameras and script data are
// re-applied without rebuilding the scene, so a page loaded before a
// restart never keeps stale data.
//
// The toggles and the sun slider are VIEWER-ONLY emulation: flipping a
// toggle sets a local override for that entity in this viewer (never
// calling any HA service), and the sun slider moves the viewer's sun to
// the chosen time of day. Overridden rows are marked "(preview)"; the
// Reset preview button clears all entity overrides and the sun
// slider's Live button returns the sun to the real one. Overrides are
// session-local (gone on reload) and never affect the renders.

import * as THREE from "./three.module.js";
import { OrbitControls } from "./OrbitControls.js";
import { GLTFLoader } from "./GLTFLoader.js";
import { solarPosition } from "./solar-position.mjs";

const OFF_COLOR = 0x3a3f44; // off / unavailable / unknown: dark gray
const UNMAPPED_COLOR = 0xffffff; // model light with no HA entity
const CAMERA_COLOR = 0x29b6f6;
const SUN_COLOR = 0xffd54f;
const OBJECT_COLOR = 0xba68c8; // script-driven object marker (purple)

// The sample model's scripted objects (see scene.example.js): the
// viewer animates the fan and shows/hides the TV screen from their
// driving entities' emulated states, mirroring what the script does in
// the renders. Other models' objects get markers + list rows, but no
// special animation.
const FAN_OBJECT = "ceiling_fan";
const TV_SCREEN_OBJECT = "tv_screen";
const TV_LIGHT = "living_room_tv";
// States that count as "on" for a toggle/emulation (lights, switches,
// media players doing something — same set as the example script uses
// for the TV).
const ON_STATES = new Set(["on", "playing", "paused", "idle"]);

// Mesh shadow rules (mirror scene.mjs applyMeshShadowRules — the viewer
// and the render service must treat a model identically):
// - a mesh whose material is named "ShadowOnly" is invisible in the
//   render but still casts shadows (the convention for a ceiling slab
//   over a roofless dollhouse model, so the sun enters only through
//   the windows while the top-down view stays open);
// - a mesh whose material is named "SheerCurtain" is a sheer curtain:
//   it casts a PARTIAL shadow via a dithered depth material (~45% of
//   the sun gets through, broken up like a weave) and glows warm when
//   the sun is on its side (see _updateCurtainGlow);
// - a mesh whose materials are all transparent (glass) casts no shadow.
const SHADOW_ONLY_MATERIAL = "ShadowOnly";
const SHEER_CURTAIN_MATERIAL = "SheerCurtain";
const CURTAIN_DITHER_DISCARD = 0.35;
const CURTAIN_DITHER_CELL_M = 0.02;
const CURTAIN_GLOW_COLOR = 0xfff2dd;
const CURTAIN_GLOW_SCALE = 0.3;

// Bounce lights (mirror scene.mjs updateBounceLights): empty nodes
// named window_<room> mark the windows; each sunlit window gets one
// soft point light just above the sun patch on the floor. Same
// transmission table, albedo, scale and warm color as the service.
const WINDOW_MARKER_PREFIX = "window_";
const WINDOW_TRANSMISSION = {
  living_room: 0.35,
  bedroom: 0.35,
  dining: 0.5,
  kids_bedroom: 0.5,
  kitchen: 0.5,
  bathroom_1: 0.5,
};
const BOUNCE_FLOOR_ALBEDO = 0.5;
// 1.0 m above the patch, not 0.3 m: at 0.3 m the point light burns a
// hot spot into the patch while barely lifting the room (grazing
// angle) — see scene.mjs.
const BOUNCE_HEIGHT_ABOVE_PATCH = 1.0;
const BOUNCE_SCALE = 2.0;
const BOUNCE_WARM = [1.0, 0.9, 0.75];
// A low sun throws the patch far (~10 m at 9 deg elevation) — past
// the room, into another one. The patch is clamped to within
// BOUNCE_MAX_PATCH_DISTANCE of its window (about one room), and the
// intensity fades linearly to 0 between BOUNCE_FADE_START_DISTANCE
// and the max, so there is no popping as the sun moves. High-sun
// patches sit ~1-1.5 m from the window, well inside the fade start,
// so the high-sun lift is unchanged. (Mirror scene.mjs.)
const BOUNCE_MAX_PATCH_DISTANCE = 5;
const BOUNCE_FADE_START_DISTANCE = 3;

function materialsOf(obj) {
  if (Array.isArray(obj.material)) return obj.material;
  return obj.material ? [obj.material] : [];
}

// Inject a world-space dither discard into a depth material's shaders
// (mirror scene.mjs injectCurtainDither): fragments in ~55% of the
// 2 cm cells are discarded, so the shadow is a broken-up partial
// shadow instead of a solid one.
function injectCurtainDither(material, key) {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nvarying vec3 vCurtainWorldPos;",
      )
      .replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\nvCurtainWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;",
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\nvarying vec3 vCurtainWorldPos;",
      )
      .replace(
        "#include <clipping_planes_fragment>",
        `#include <clipping_planes_fragment>
        {
          vec3 cell = floor(vCurtainWorldPos / ${CURTAIN_DITHER_CELL_M.toFixed(3)});
          float h = fract(sin(dot(cell, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
          if (h < ${CURTAIN_DITHER_DISCARD.toFixed(2)}) discard;
        }`,
      );
  };
  material.customProgramCacheKey = () => key;
  return material;
}

let curtainDepthMaterial = null;
let curtainDistanceMaterial = null;
function ditheredCurtainDepthMaterial() {
  if (!curtainDepthMaterial) {
    curtainDepthMaterial = injectCurtainDither(
      new THREE.MeshDepthMaterial({ side: THREE.DoubleSide }),
      "curtain-dither-depth",
    );
  }
  return curtainDepthMaterial;
}
function ditheredCurtainDistanceMaterial() {
  if (!curtainDistanceMaterial) {
    curtainDistanceMaterial = injectCurtainDither(
      new THREE.MeshDistanceMaterial({ side: THREE.DoubleSide }),
      "curtain-dither-distance",
    );
  }
  return curtainDistanceMaterial;
}

// A curtain's outward normal (mirror scene.mjs curtainOutwardNormal):
// the curtain is a vertical plane facing local +Z; its world normal is
// that axis through the node's orientation, with the sign from the
// model center — the outward side points away from it. The position
// comes from the mesh's bounding-box center, NOT the node's world
// position: Blender bakes the curtain geometry in world coordinates,
// so the node itself sits at the origin. Empty nodes (window markers)
// have no geometry, so they fall back to the node position.
function curtainOutwardNormal(mesh, center) {
  const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(
    mesh.getWorldQuaternion(new THREE.Quaternion()),
  );
  let position;
  if (mesh.isMesh) {
    position = new THREE.Box3().setFromObject(mesh).getCenter(
      new THREE.Vector3(),
    );
  } else {
    position = mesh.getWorldPosition(new THREE.Vector3());
  }
  const toMesh = position.sub(center);
  if (normal.dot(toMesh) < 0) normal.negate();
  normal.y = 0;
  if (normal.lengthSq() < 1e-6) return new THREE.Vector3(0, 0, -1);
  return normal.normalize();
}

function applyMeshShadowRules(obj) {
  const mats = materialsOf(obj);
  if (mats.some((m) => m.name === SHADOW_ONLY_MATERIAL)) {
    for (const m of mats) {
      m.colorWrite = false;
      m.depthWrite = false;
    }
    obj.castShadow = true;
    obj.receiveShadow = false;
    return;
  }
  if (mats.some((m) => m.name === SHEER_CURTAIN_MATERIAL)) {
    // A sheer curtain is transparent, so the rule below would give it
    // no shadow at all and full sun would pass through like clear
    // glass. Instead it casts a dithered partial shadow (both depth
    // materials: the sun renders with the depth material, point lights
    // with the distance material).
    obj.castShadow = true;
    obj.customDepthMaterial = ditheredCurtainDepthMaterial();
    obj.customDistanceMaterial = ditheredCurtainDistanceMaterial();
    obj.receiveShadow = true;
    return;
  }
  obj.castShadow = !(mats.length > 0 && mats.every((m) => m.transparent));
  obj.receiveShadow = true;
}

// Per-light shadow softness (mirror scene.mjs shadowMapSizeForLight —
// the same FNV-1a hash of the light's name, lighter range 256/512/1024
// so the browser's shadow memory stays modest). Deterministic per name,
// so a light's shadows look the same on every load; the same light gets
// the same relative softness in the viewer and in the renders.
const VIEWER_SHADOW_MAP_SIZES = [256, 512, 1024];
function shadowMapSizeForLight(name) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < name.length; i += 1) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return VIEWER_SHADOW_MAP_SIZES[(hash >>> 0) % VIEWER_SHADOW_MAP_SIZES.length];
}

// Domains with a `toggle` service (light.toggle, media_player.toggle,
// ...). A script-driven object whose entity is in another domain (e.g.
// a sensor) gets no switch — there is nothing to toggle.
const TOGGLEABLE_DOMAINS = new Set([
  "light",
  "switch",
  "media_player",
  "fan",
  "cover",
  "input_boolean",
  "automation",
  "group",
  "script",
  "remote",
]);
function isToggleableEntity(entityId) {
  return TOGGLEABLE_DOMAINS.has(entityId.split(".")[0]);
}

// --- color helpers (mirror the integration's normalize_light_state) ---

/** Kelvin to [r, g, b] 0-255 (Tanner Helland approximation). */
function kelvinToRgb(kelvin) {
  const temp = Math.max(1000, Math.min(40000, kelvin)) / 100;
  let r;
  let g;
  let b;
  if (temp <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(temp) - 161.1195681661;
    b = temp <= 19 ? 0 : 138.5177312231 * Math.log(temp - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(temp - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(temp - 60, -0.0755148492);
    b = 255;
  }
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
  return [clamp(r), clamp(g), clamp(b)];
}

/** HA hs_color ([hue 0-360, saturation 0-100]) to [r, g, b] 0-255. */
function hsToRgb(h, s) {
  const hue = ((h % 360) + 360) % 360 / 360;
  const sat = Math.max(0, Math.min(100, s)) / 100;
  const light = 0.5; // HA's color_hs_to_RGB uses lightness 0.5
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const x = c * (1 - Math.abs(((hue * 6) % 2) - 1));
  const m = light - c / 2;
  let r;
  let g;
  let b;
  if (hue < 1 / 6) [r, g, b] = [c, x, 0];
  else if (hue < 2 / 6) [r, g, b] = [x, c, 0];
  else if (hue < 3 / 6) [r, g, b] = [0, c, x];
  else if (hue < 4 / 6) [r, g, b] = [0, x, c];
  else if (hue < 5 / 6) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ];
}

/** CIE xy (+ optional brightness 0-1) to [r, g, b] 0-255. */
function xyToRgb(x, y, brightness = 1) {
  const z = 1 - x - y;
  const yy = Math.max(0, Math.min(1, brightness));
  const xr = (yy / y) * x;
  const zr = (yy / y) * z;
  let r = xr * 1.656492 - yy * 0.354851 - zr * 0.255038;
  let g = -xr * 0.707196 + yy * 1.655397 + zr * 0.036152;
  let b = xr * 0.051713 - yy * 0.121364 + zr * 1.01153;
  const fix = (v) =>
    v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  r = fix(r);
  g = fix(g);
  b = fix(b);
  const max = Math.max(r, g, b, 1);
  const clamp = (v) => Math.max(0, Math.min(255, Math.round((v / max) * 255)));
  return [clamp(r), clamp(g), clamp(b)];
}

class SceneRendererPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._panel = null;
    // The hass.connection object last seen: the websocket connection is
    // stable across state updates but is replaced when the frontend
    // reconnects (e.g. after a Home Assistant restart). A new
    // connection means the integration may have new data (mapping,
    // sun, cameras, script), so panel_data is re-fetched (see set
    // hass). The hass object itself is NOT the identity — HA hands out
    // a new hass object on every state update.
    this._hassConnection = null;
    this._connected = false;
    this._initStarted = false;
    this._loadState = "loading"; // loading | ready | error | no-entries
    this._entries = [];
    this._entryId = null;
    this._panelData = null; // { mapping, objects, cameras, image_entities, sun, script_entities, script_object_drivers }
    this._stateMap = new Map();

    // three.js objects (created once, model swapped per entry)
    this._renderer = null;
    this._scene = null;
    this._camera = null; // the ACTIVE viewer camera (perspective or ortho)
    this._perspCamera = null; // the orbit camera (always perspective)
    this._orthoCamera = null; // created lazily when an ortho camera is selected
    this._orthoSize = null; // current ortho frustum height in metres (null = fit the model)
    this._controls = null;
    this._modelGroup = null;
    this._modelCenter = new THREE.Vector3();
    this._modelRadius = 10;
    this._lightMarkers = []; // { name, mesh, baseRadius }
    this._modelLights = []; // { name, light, baseIntensity, baseColor }
    this._cameraMarkers = []; // { name, group }
    this._scriptObjects = []; // { name, entityId, object } — driven objects: the YAML `objects` mapping merged with the script's objectDrivers (YAML wins on conflict)
    this._curtains = []; // { name, mesh, material, outward } — sheer curtains, for the glow + dithered shadow
    this._windows = []; // { name, room, position, outward, transmission, light } — window markers, for the bounce lights
    this._floorY = 0; // floor plane for the bounce patch (bottom of the model bounds)
    this._modelBounds = null; // Box3 of the model, for clamping the bounce patch inside the house
    this._objectMarkers = []; // { name, entityId, mesh } — 3D markers for the script-driven objects
    // Viewer-only emulation overrides (see the file header): entity_id
    // -> emulated state ("on"/"off" for lights, "playing"/"off" for
    // media players). Toggles write here, never to HA. Session-local.
    this._overrides = new Map();
    // Viewer-only sun override from the time-of-day slider: minutes
    // from midnight, or null for the live sun (panel_data / sun.sun).
    this._sunOverride = null;
    // Fan spin state: the ceiling_fan group's current angle, advanced
    // in the render loop while its emulated state is on.
    this._fanAngle = 0;
    this._clock = new THREE.Clock();
    this._sunMarker = null;
    this._sunLight = null; // DirectionalLight driven by sun.sun
    this._hemi = null; // HemisphereLight, dim floor driven by sun elevation
    this._modelCameras = new Map(); // name -> THREE camera object in the GLB
    this._raycaster = new THREE.Raycaster();
    this._pointerDown = null;
    this._animationFrame = null;
    this._resizeObserver = null;
    this._previewUrl = null;
    this._selectedCamera = null;

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          height: 100%;
          background: var(--primary-background-color, #fafafa);
          color: var(--primary-text-color, #212121);
          font-family: var(--paper-font-body1_-_font-family, inherit);
        }
        .wrap { display: flex; flex-direction: column; height: 100%; }
        header {
          display: flex; align-items: center; gap: 12px;
          padding: 12px 16px;
          border-bottom: 1px solid var(--divider-color, #e0e0e0);
          flex-wrap: wrap;
        }
        header h1 { font-size: 20px; margin: 0; font-weight: 500; }
        header select {
          background: var(--card-background-color, #fff);
          color: var(--primary-text-color, #212121);
          border: 1px solid var(--divider-color, #e0e0e0);
          border-radius: 4px; padding: 6px 8px; font-size: 14px;
        }
        .status {
          margin-left: auto; font-size: 13px;
          color: var(--secondary-text-color, #727272);
        }
        .body { display: flex; flex: 1; min-height: 0; }
        .viewer { position: relative; flex: 1; min-width: 0; min-height: 320px; }
        .viewer canvas { display: block; width: 100%; height: 100%; }
        .overlay {
          position: absolute; inset: 0; display: flex;
          flex-direction: column; align-items: center; justify-content: center;
          gap: 12px; text-align: center; padding: 24px;
          background: var(--primary-background-color, #fafafa);
          color: var(--secondary-text-color, #727272);
          z-index: 2;
        }
        .overlay[hidden] { display: none; }
        .overlay .error { color: var(--error-color, #db4437); }
        button {
          background: var(--primary-color, #03a9f4);
          color: var(--text-primary-color, #fff);
          border: none; border-radius: 4px; padding: 8px 16px;
          font-size: 14px; cursor: pointer;
        }
        button:hover { opacity: 0.9; }
        button:disabled { opacity: 0.5; cursor: default; }
        button.mini {
          padding: 4px 10px; font-size: 12px; flex-shrink: 0;
        }
        .section-head {
          display: flex; align-items: baseline;
          justify-content: space-between; gap: 8px;
        }
        .section-head h2 { margin-bottom: 8px; }
        .sun-row { display: flex; align-items: center; gap: 8px; }
        .sun-row input[type="range"] { flex: 1; min-width: 0; }
        aside {
          width: 300px; flex-shrink: 0; overflow-y: auto;
          border-left: 1px solid var(--divider-color, #e0e0e0);
          padding: 12px 16px;
          background: var(--card-background-color, #fff);
        }
          width: 300px; flex-shrink: 0; overflow-y: auto;
          border-left: 1px solid var(--divider-color, #e0e0e0);
          padding: 12px 16px;
          background: var(--card-background-color, #fff);
        }
        aside h2 {
          font-size: 14px; margin: 16px 0 8px; font-weight: 500;
          color: var(--secondary-text-color, #727272);
          text-transform: uppercase; letter-spacing: 0.04em;
        }
        aside h2:first-child { margin-top: 0; }
        ul { list-style: none; margin: 0; padding: 0; }
        li {
          display: flex; align-items: center; gap: 8px;
          padding: 6px 4px; font-size: 14px;
          border-bottom: 1px solid var(--divider-color, #eee);
        }
        li.clickable { cursor: pointer; }
        li.clickable:hover, li.active { background: var(--secondary-background-color, #f5f5f5); }
        .dot {
          width: 12px; height: 12px; border-radius: 50%;
          flex-shrink: 0; border: 1px solid rgba(0,0,0,0.2);
        }
        .row-main { flex: 1; min-width: 0; }
        .row-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .row-sub {
          font-size: 12px; color: var(--secondary-text-color, #727272);
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .row-state { font-size: 12px; color: var(--secondary-text-color, #727272); }
        .row-state.preview {
          color: var(--warning-color, #ff9800);
          font-weight: 500;
        }
        .switch {
          position: relative; display: inline-block;
          width: 36px; height: 20px; flex-shrink: 0;
        }
        .switch input { opacity: 0; width: 0; height: 0; }
        .switch .slider {
          position: absolute; cursor: pointer; inset: 0;
          background-color: var(--divider-color, #ccc);
          border-radius: 20px; transition: background-color 0.2s;
        }
        .switch .slider:before {
          position: absolute; content: "";
          height: 16px; width: 16px; left: 2px; top: 2px;
          background-color: white; border-radius: 50%;
          transition: transform 0.2s;
        }
        .switch input:checked + .slider {
          background-color: var(--primary-color, #03a9f4);
        }
        .switch input:checked + .slider:before {
          transform: translateX(16px);
        }
        .switch input:disabled + .slider { opacity: 0.5; cursor: default; }
        .preview img { max-width: 100%; border-radius: 4px; display: block; }
        .preview .none {
          font-size: 13px; color: var(--secondary-text-color, #727272);
        }
        .info {
          margin-top: 16px; font-size: 13px;
          color: var(--secondary-text-color, #727272);
          border-top: 1px solid var(--divider-color, #e0e0e0);
          padding-top: 12px; word-break: break-word;
        }
        @media (max-width: 800px) {
          .body { flex-direction: column; }
          aside { width: auto; border-left: none; border-top: 1px solid var(--divider-color, #e0e0e0); }
        }
      </style>
      <div class="wrap">
        <header>
          <h1>Scene Renderer</h1>
          <select id="entry-select" hidden></select>
          <div class="status" id="status">Loading…</div>
        </header>
        <div class="body">
          <div class="viewer" id="viewer">
            <div class="overlay" id="overlay">
              <div id="overlay-text">Loading 3D model…</div>
              <button id="retry-button" hidden>Retry</button>
            </div>
          </div>
          <aside>
            <div class="section-head">
              <h2>Lights</h2>
              <button id="reset-preview" class="mini" disabled title="Clear all preview overrides and return to the real entity states">Reset preview</button>
            </div>
            <ul id="light-list"><li class="row-sub">Loading…</li></ul>
            <h2>Objects</h2>
            <ul id="object-list"><li class="row-sub">Loading…</li></ul>
            <h2>Cameras</h2>
            <ul id="camera-list"><li class="row-sub">Loading…</li></ul>
            <div id="sun-section" hidden>
              <h2>Sun</h2>
              <div class="sun-row">
                <input type="range" id="sun-slider" min="0" max="1439" step="15" value="720" aria-label="Time of day">
                <button id="sun-live" class="mini" disabled title="Return the viewer's sun to the live sun">Live</button>
              </div>
              <div class="row-sub" id="sun-label">Live</div>
            </div>
            <h2>Preview</h2>
            <div class="preview" id="preview"><div class="none">Select a camera to preview its latest render.</div></div>
            <div class="info" id="info">Click a light or camera marker in the 3D view, or a camera in the list, for details.</div>
          </aside>
        </div>
      </div>
    `;

    this._els = {
      status: this.shadowRoot.querySelector("#status"),
      overlay: this.shadowRoot.querySelector("#overlay"),
      overlayText: this.shadowRoot.querySelector("#overlay-text"),
      retryButton: this.shadowRoot.querySelector("#retry-button"),
      viewer: this.shadowRoot.querySelector("#viewer"),
      entrySelect: this.shadowRoot.querySelector("#entry-select"),
      lightList: this.shadowRoot.querySelector("#light-list"),
      objectList: this.shadowRoot.querySelector("#object-list"),
      cameraList: this.shadowRoot.querySelector("#camera-list"),
      preview: this.shadowRoot.querySelector("#preview"),
      info: this.shadowRoot.querySelector("#info"),
      resetPreview: this.shadowRoot.querySelector("#reset-preview"),
      sunSection: this.shadowRoot.querySelector("#sun-section"),
      sunSlider: this.shadowRoot.querySelector("#sun-slider"),
      sunLive: this.shadowRoot.querySelector("#sun-live"),
      sunLabel: this.shadowRoot.querySelector("#sun-label"),
    };
    this._els.resetPreview.addEventListener("click", () => this._resetOverrides());
    this._els.sunSlider.addEventListener("input", (ev) => {
      this._sunOverride = Number(ev.target.value);
      this._updateSunSlider();
      this._updateSunMarker();
      this._updateSunLight();
      this._updateLightMarkers();
      this._updateModelLights();
      this._updateLightList();
    });
    this._els.sunLive.addEventListener("click", () => {
      this._sunOverride = null;
      this._updateSunSlider();
      this._updateSunMarker();
      this._updateSunLight();
      this._updateLightMarkers();
      this._updateModelLights();
      this._updateLightList();
    });
    this._els.retryButton.addEventListener("click", () => this._retry());
    this._els.entrySelect.addEventListener("change", (ev) => {
      this._loadEntry(ev.target.value);
    });
  }

  set hass(hass) {
    const prevConnection = this._hassConnection;
    this._hass = hass;
    this._hassConnection = hass ? hass.connection || null : null;
    this._rebuildStateMap();
    if (!this._connected) return;
    if (!this._initStarted) {
      this._maybeInit();
      return;
    }
    // Live update: markers, sun and side lists only — never rebuilds
    // the scene.
    this._updateLightMarkers();
    this._updateModelLights();
    this._updateLightList();
    this._updateObjectList();
    this._updateTvState();
    this._updateSunMarker();
    this._updateSunLight();
    this._updateSunSlider();
    // A new connection object means the frontend reconnected (e.g.
    // after a Home Assistant restart or a YAML change): the mapping,
    // sun, cameras and script data may have changed since the page
    // loaded, so re-fetch them. Without this a page loaded before a
    // restart keeps stale data forever — a pinned sun would never
    // reach a page that loaded before the pin existed (the rendered
    // images were right, the panel's sun shadows were wrong).
    // State updates reuse the same connection, so this never fires
    // for ordinary state changes.
    if (this._hass && this._hassConnection !== prevConnection) {
      if (this._loadState === "ready" && this._entryId) {
        this._refreshPanelData();
      } else if (this._loadState === "no-entries") {
        // The scene may exist now (the YAML block was added and HA
        // restarted while this page was open on "not configured").
        this._init();
      }
    }
  }

  get hass() {
    return this._hass;
  }

  set panel(panel) {
    this._panel = panel;
  }

  get panel() {
    return this._panel;
  }

  connectedCallback() {
    this._connected = true;
    this._fixParentHeight();
    this._maybeInit();
  }

  disconnectedCallback() {
    this._connected = false;
    this._restoreParentHeight();
    if (this._animationFrame !== null) {
      cancelAnimationFrame(this._animationFrame);
      this._animationFrame = null;
    }
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }
    if (this._controls) this._controls.dispose();
    if (this._renderer) this._renderer.dispose();
    if (this._previewUrl) URL.revokeObjectURL(this._previewUrl);
  }

  // --- parent height ---------------------------------------------------
  // ha-panel-custom ships with no styles of its own (an inline element
  // with auto height), so our :host { height: 100% } resolves against
  // an auto-height parent and the panel collapses to content height,
  // leaving a black gap at the bottom of the page. The rest of the
  // chain is full-height (partial-panel-resolver is display:block,
  // height:100% inside home-assistant-main), so giving the parent a
  // definite height completes it. Only touches the real HA parent;
  // harmless in any other host (tests, iframe embedding).
  _fixParentHeight() {
    const parent = this.parentElement;
    if (!parent || parent.tagName !== "HA-PANEL-CUSTOM") return;
    this._parentPrevDisplay = parent.style.display;
    this._parentPrevHeight = parent.style.height;
    parent.style.display = "block";
    parent.style.height = "100%";
  }

  _restoreParentHeight() {
    const parent = this.parentElement;
    if (!parent || parent.tagName !== "HA-PANEL-CUSTOM") return;
    parent.style.display = this._parentPrevDisplay || "";
    parent.style.height = this._parentPrevHeight || "";
  }

  // --- state helpers ---------------------------------------------------

  /** hass.states is an array in the real frontend; accept a dict too. */
  _rebuildStateMap() {
    this._stateMap = new Map();
    const states = this._hass && this._hass.states;
    if (!states) return;
    if (Array.isArray(states)) {
      for (const st of states) {
        if (st && st.entity_id) this._stateMap.set(st.entity_id, st);
      }
    } else {
      for (const [entityId, st] of Object.entries(states)) {
        this._stateMap.set(entityId, st);
      }
    }
  }

  _state(entityId) {
    return this._stateMap.get(entityId) || null;
  }

  // Viewer-only emulation: the state the viewer shows for an entity —
  // the local override when one is set, else the real HA state. The
  // attributes always come from the real entity (brightness/color),
  // because an override only flips the on/off state.
  _emulatedState(entityId) {
    const st = this._state(entityId);
    if (!st) return "unknown";
    return this._overrides.get(entityId) || st.state;
  }

  _isOverridden(entityId) {
    return this._overrides.has(entityId);
  }

  // Flip a toggle: set a LOCAL preview override, never touching HA
  // (the toggles are emulation-only — see the file header). The
  // emulated state flips between the entity's "on" and "off" forms:
  // media players flip to "playing" (the TV's on state), everything
  // else to "on".
  _toggleEntity(entityId) {
    const current = this._emulatedState(entityId);
    const onState = entityId.startsWith("media_player.") ? "playing" : "on";
    this._overrides.set(
      entityId,
      ON_STATES.has(current) ? "off" : onState,
    );
    this._updateResetButton();
    this._updateLightMarkers();
    this._updateModelLights();
    this._updateLightList();
    this._updateObjectList();
    this._updateTvState();
  }

  // Clear all entity overrides and return the viewer to the real
  // entity states. (The sun slider has its own Live button.)
  _resetOverrides() {
    if (this._overrides.size === 0) return;
    this._overrides.clear();
    this._updateResetButton();
    this._updateLightMarkers();
    this._updateModelLights();
    this._updateLightList();
    this._updateObjectList();
    this._updateTvState();
  }

  _updateResetButton() {
    this._els.resetPreview.disabled = this._overrides.size === 0;
  }

  // The sample model's fan is "on" when its driving entity's emulated
  // state is on; the TV is "on" when its media player is playing,
  // paused or idle (the example script's set). Without a driver for
  // the object, both are false and the viewer leaves the objects alone.
  _fanOn() {
    const fan = this._scriptObjects.find((o) => o.name === FAN_OBJECT);
    return fan ? ON_STATES.has(this._emulatedState(fan.entityId)) : false;
  }

  _tvOn() {
    const tv = this._scriptObjects.find((o) => o.name === TV_SCREEN_OBJECT);
    return tv ? ON_STATES.has(this._emulatedState(tv.entityId)) : false;
  }

  // Show/hide the TV screen mesh from the TV's emulated state, like
  // the example script does in the renders. Without a tv_screen
  // driver the mesh stays as the model left it (visible).
  _updateTvState() {
    const tv = this._scriptObjects.find((o) => o.name === TV_SCREEN_OBJECT);
    if (!tv || !tv.object) return;
    tv.object.visible = this._tvOn();
  }

  _setState(state, statusText, overlayText, showRetry) {
    this._loadState = state;
    this.setAttribute("data-state", state);
    this._els.status.textContent = statusText;
    if (state === "ready") {
      this._els.overlay.hidden = true;
      return;
    }
    this._els.overlay.hidden = false;
    this._els.overlayText.textContent = overlayText;
    this._els.overlayText.classList.toggle("error", state === "error");
    this._els.retryButton.hidden = !showRetry;
  }

  _showError(statusText, overlayText) {
    this._setState("error", statusText, overlayText, true);
  }

  _retry() {
    if (this._entryId) this._loadEntry(this._entryId);
    else this._init();
  }

  // --- init ------------------------------------------------------------

  _maybeInit() {
    if (!this._connected || !this._hass || this._initStarted) return;
    this._initStarted = true;
    this._init();
  }

  async _init() {
    if (!this._setupViewer()) return; // error state already shown
    this._setState("loading", "Loading…", "Loading 3D model…", false);
    let entries;
    try {
      entries = await this._hass.callWS({
        type: "scene_renderer/panel_entries",
      });
    } catch (err) {
      this._showError(
        "Error",
        `Could not list Scene Renderer scenes: ${err && err.message ? err.message : err}`,
      );
      return;
    }
    this._entries = entries || [];
    if (this._entries.length === 0) {
      this._setState(
        "no-entries",
        "Not configured",
        "No Scene Renderer scene configured yet — add a scene_renderer block to configuration.yaml and restart.",
        false,
      );
      return;
    }
    this._renderEntrySelect();
    await this._loadEntry(this._entries[0].entry_id);
  }

  // The entry picker (only shown when there is more than one scene).
  _renderEntrySelect() {
    if (this._entries.length > 1) {
      this._els.entrySelect.hidden = false;
      this._els.entrySelect.innerHTML = this._entries
        .map(
          (e) =>
            `<option value="${e.entry_id}">${e.name || e.entry_id}</option>`,
        )
        .join("");
      this._els.entrySelect.value =
        this._entryId || this._entries[0].entry_id;
    } else {
      this._els.entrySelect.hidden = true;
    }
  }

  async _loadEntry(entryId) {
    this._entryId = entryId;
    this._els.entrySelect.value = entryId;
    this._clearPreview();
    this._setState("loading", "Loading…", "Loading scene data…", false);
    let data;
    try {
      data = await this._hass.callWS({
        type: "scene_renderer/panel_data",
        entry_id: entryId,
      });
    } catch (err) {
      this._showError(
        "Service unreachable",
        `Could not reach the render service: ${err && err.message ? err.message : err}`,
      );
      return;
    }
    this._panelData = data;
    this._setState("loading", "Loading…", "Loading 3D model…", false);
    let glb;
    try {
      const resp = await this._hass.fetchWithAuth(
        `/api/scene_renderer/${entryId}/model`,
      );
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      glb = await resp.arrayBuffer();
    } catch (err) {
      this._showError(
        "Model unavailable",
        `Could not load the 3D model: ${err && err.message ? err.message : err}`,
      );
      return;
    }
    let gltf;
    try {
      gltf = await new Promise((resolve, reject) => {
        new GLTFLoader().parse(glb, "", resolve, reject);
      });
    } catch (err) {
      this._showError(
        "Model unavailable",
        `Could not parse the 3D model: ${err && err.message ? err.message : err}`,
      );
      return;
    }
    this._buildScene(gltf.scene);
    this._renderLightList();
    this._renderObjectList();
    this._renderCameraList();
    this._updateLightMarkers();
    this._updateModelLights();
    this._updateSunMarker();
    this._updateSunLight();
    this._updateSunSlider();
    this._setState("ready", "Ready", "", false);
  }

  // Re-fetch panel_data after a reconnect (see set hass) and re-apply
  // it — mapping, sun, cameras, script entities — WITHOUT rebuilding
  // the 3D scene. The model itself does not change across an HA restart
  // (it comes from the app), so the scene, markers and camera positions
  // stay; only the data the integration owns is refreshed. A failed
  // refresh keeps the last good data in place — the panel keeps
  // working with stale data rather than going blank.
  async _refreshPanelData() {
    if (!this._hass || !this._entryId) return;
    let data;
    try {
      data = await this._hass.callWS({
        type: "scene_renderer/panel_data",
        entry_id: this._entryId,
      });
    } catch (err) {
      // The entry may be gone (e.g. the YAML block was removed): check
      // the entry list, and reload from scratch when it changed.
      await this._refreshEntriesAfterReconnect();
      return;
    }
    this._panelData = data;
    this._collectScriptObjects();
    this._renderLightList();
    this._renderObjectList();
    this._renderCameraList();
    this._buildCameraMarkers();
    this._updateLightMarkers();
    this._updateModelLights();
    this._updateSunMarker();
    this._updateSunLight();
    this._updateSunSlider();
  }

  // After a failed panel_data refresh, check whether the entry list
  // changed. Unchanged entries mean a transient failure (keep the last
  // good data); a changed list reloads the (new) first entry from
  // scratch, or shows "not configured" when no scene remains.
  async _refreshEntriesAfterReconnect() {
    if (!this._hass) return;
    let entries;
    try {
      entries = await this._hass.callWS({
        type: "scene_renderer/panel_entries",
      });
    } catch {
      return; // still unreachable — keep the last good data
    }
    entries = entries || [];
    const ids = entries.map((e) => e.entry_id);
    const knownIds = this._entries.map((e) => e.entry_id);
    if (
      ids.join(",") === knownIds.join(",") &&
      ids.includes(this._entryId)
    ) {
      return; // entries unchanged — the failure was transient
    }
    this._entries = entries;
    if (this._entries.length === 0) {
      this._setState(
        "no-entries",
        "Not configured",
        "No Scene Renderer scene configured yet — add a scene_renderer block to configuration.yaml and restart.",
        false,
      );
      return;
    }
    this._renderEntrySelect();
    await this._loadEntry(this._entries[0].entry_id);
  }

  // --- three.js viewer -------------------------------------------------

  _setupViewer() {
    if (this._renderer) return true;
    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch (err) {
      this._showError(
        "WebGL unavailable",
        "WebGL is not available in this browser, so the 3D viewer cannot run.",
      );
      return false;
    }
    // Shadows: every model light and the sun cast (mirroring the render
    // service). Shadow maps update only on demand (autoUpdate off):
    // the scene is static except for light states, so re-rendering 5
    // cube maps every animation frame would waste the GPU. Light and
    // sun updates set needsUpdate (see _updateModelLights /
    // _updateSunLight); orbiting the camera needs no shadow update.
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.shadowMap.autoUpdate = false;
    this._renderer = renderer;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0); // transparent: HA theme shows through
    this._els.viewer.appendChild(renderer.domElement);

    this._scene = new THREE.Scene();
    // Dim base illumination so the model stays readable when every HA
    // light is off; _updateSunLight drives its intensity from the sun
    // elevation the same way the render service does. It must stay dim
    // (0.06-0.6), or it washes out the state-driven lights entirely —
    // the old fixed 0.9 made every room look lit no matter what.
    this._hemi = new THREE.HemisphereLight(0xffffff, 0x555566, 0.15);
    this._scene.add(this._hemi);
    // Directional sun, positioned and colored by _updateSunLight from
    // sun.sun. It casts shadows; the shadow camera is sized to the
    // model in _buildScene once the radius is known.
    this._sunLight = new THREE.DirectionalLight(0xffffff, 0);
    this._sunLight.castShadow = true;
    this._sunLight.shadow.mapSize.set(2048, 2048);
    this._sunLight.shadow.bias = -0.0005;
    this._scene.add(this._sunLight);
    this._scene.add(this._sunLight.target);

    // Two viewer cameras: the default perspective orbit camera, and an
    // orthographic one (created lazily) for when the user selects an
    // orthographic model camera — the viewer adopts that camera's
    // projection (see _jumpToCamera). OrbitControls is bound to one
    // camera, so switching cameras recreates the controls (see
    // _setActiveCamera).
    this._perspCamera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
    this._camera = null;
    this._controls = null;
    this._setActiveCamera(this._perspCamera);

    const resize = () => {
      const w = this._els.viewer.clientWidth;
      const h = this._els.viewer.clientHeight;
      if (w === 0 || h === 0) return;
      this._renderer.setSize(w, h, false);
      this._updateCameraProjection();
    };
    this._resizeObserver = new ResizeObserver(resize);
    this._resizeObserver.observe(this._els.viewer);
    resize();

    renderer.domElement.addEventListener("pointerdown", (ev) => {
      this._pointerDown = { x: ev.clientX, y: ev.clientY };
    });
    renderer.domElement.addEventListener("pointerup", (ev) => {
      if (!this._pointerDown) return;
      const dx = ev.clientX - this._pointerDown.x;
      const dy = ev.clientY - this._pointerDown.y;
      this._pointerDown = null;
      if (dx * dx + dy * dy > 25) return; // it was a drag, not a click
      this._handlePick(ev);
    });
    renderer.domElement.addEventListener("pointermove", (ev) => {
      renderer.domElement.style.cursor = this._pick(ev) ? "pointer" : "";
    });

    const animate = () => {
      if (!this._connected) return;
      this._animationFrame = requestAnimationFrame(animate);
      // Clamped: after a long main-thread block (or a backgrounded
      // tab) the raw delta would spin the fan by whole turns at once.
      const dt = Math.min(this._clock.getDelta(), 0.1);
      this._controls.update();
      // The ceiling fan spins in the viewer while its emulated state
      // is on (the viewer does not run scene.js, so this is its own
      // animation — one turn per ~3 s, matching the script's loop
      // rate). The angle is kept when the fan stops: no snap to 0.
      if (this._fanOn()) {
        const fan = this._scriptObjects.find((o) => o.name === FAN_OBJECT);
        if (fan && fan.object) {
          this._fanAngle += (dt * Math.PI * 2) / 3;
          fan.object.rotation.y = this._fanAngle;
        }
      }
      this._renderer.render(this._scene, this._camera);
    };
    animate();
    return true;
  }

  // Switch the active viewer camera (perspective <-> orthographic).
  // OrbitControls is bound to one camera, so switching disposes the old
  // controls and creates new ones for the new camera, keeping the orbit
  // target. The render loop and picking always use this._camera.
  _setActiveCamera(camera) {
    if (this._camera === camera) return;
    const prevTarget = this._controls ? this._controls.target.clone() : null;
    if (this._controls) this._controls.dispose();
    this._camera = camera;
    this._controls = new OrbitControls(camera, this._renderer.domElement);
    this._controls.enableDamping = true;
    this._controls.dampingFactor = 0.08;
    if (prevTarget) this._controls.target.copy(prevTarget);
    this._updateCameraProjection();
  }

  // Apply the viewer size to the active camera: aspect for perspective,
  // frustum from _orthoSize (or fit the model) for orthographic.
  _updateCameraProjection() {
    if (!this._camera) return;
    const w = this._els.viewer.clientWidth;
    const h = this._els.viewer.clientHeight;
    if (w === 0 || h === 0) return;
    const aspect = w / h;
    if (this._camera.isOrthographicCamera) {
      const height = this._orthoSize || this._modelRadius * 2;
      const width = height * aspect;
      this._camera.left = -width / 2;
      this._camera.right = width / 2;
      this._camera.top = height / 2;
      this._camera.bottom = -height / 2;
    } else {
      this._camera.aspect = aspect;
    }
    this._camera.updateProjectionMatrix();
  }

  _ensureOrthoCamera() {
    if (!this._orthoCamera) {
      this._orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.05, 1000);
    }
    return this._orthoCamera;
  }

  // Jump the viewer to a model camera's viewpoint, adopting its
  // projection (perspective or orthographic, from the panel_data camera
  // config — default perspective). Called when the user selects a
  // camera in the side list or clicks its marker. The orbit controls
  // keep working from the new viewpoint (orbit, zoom, pan).
  _jumpToCamera(cam) {
    if (!cam || !Array.isArray(cam.position)) return;
    const projection = cam.projection || cam.type || "perspective";
    const radius = this._modelRadius || 10;
    const position = new THREE.Vector3(...cam.position);
    if (projection === "orthographic") {
      // Frustum height: the camera's ortho_size, else fit the whole
      // model (bounding-sphere diameter = 2 x radius).
      this._orthoSize =
        typeof cam.ortho_size === "number" && cam.ortho_size > 0
          ? cam.ortho_size
          : radius * 2;
      const camera = this._ensureOrthoCamera();
      camera.near = Math.max(radius / 100, 0.05);
      camera.far = radius * 20;
      this._setActiveCamera(camera);
    } else {
      this._orthoSize = null;
      const camera = this._perspCamera;
      if (typeof cam.fov === "number" && cam.fov > 0) camera.fov = cam.fov;
      camera.near = Math.max(radius / 100, 0.05);
      camera.far = radius * 20;
      this._setActiveCamera(camera);
    }
    this._camera.position.copy(position);
    if (Array.isArray(cam.target)) {
      const target = new THREE.Vector3(...cam.target);
      // A target directly above/below the camera is parallel to the up
      // vector and lookAt goes degenerate — use north-up, like the
      // render service does for top-down cameras.
      const dir = target.clone().sub(position).normalize();
      if (Math.abs(dir.dot(this._camera.up)) > 0.999) {
        this._camera.up.set(0, 0, -1);
      } else {
        this._camera.up.set(0, 1, 0);
      }
      this._controls.target.copy(target);
      this._camera.lookAt(target);
    } else {
      // No target: keep the GLB camera's orientation when the model has
      // one, else look at the model center.
      const glbCam = this._modelCameras.get(cam.name);
      if (glbCam) {
        this._camera.quaternion.copy(
          glbCam.getWorldQuaternion(new THREE.Quaternion()),
        );
        this._camera.up.copy(glbCam.up);
      } else {
        this._camera.lookAt(this._modelCenter);
      }
      this._controls.target.copy(this._modelCenter);
    }
    this._updateCameraProjection();
    this._controls.update();
  }

  _disposeGroup(group) {
    group.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        const materials = Array.isArray(obj.material)
          ? obj.material
          : [obj.material];
        for (const mat of materials) {
          if (mat.map) mat.map.dispose();
          mat.dispose();
        }
      }
    });
  }

  _buildScene(modelScene) {
    if (this._modelGroup) {
      this._scene.remove(this._modelGroup);
      this._disposeGroup(this._modelGroup);
    }
    this._lightMarkers = [];
    this._modelLights = [];
    this._cameraMarkers = [];
    this._modelCameras = new Map();
    this._scriptObjects = [];
    this._curtains = [];
    this._windows = [];
    this._sunMarker = null;

    const group = new THREE.Group();
    group.add(modelScene);
    this._scene.add(group);
    this._modelGroup = group;

    // Frame the model: orbit target = model center, camera pulled back
    // along a diagonal by the bounding-sphere radius.
    const box = new THREE.Box3().setFromObject(modelScene);
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1);
    this._modelCenter.copy(center);
    this._modelRadius = radius;
    // The bounce patch clamps inside these bounds, on the floor plane
    // (the bottom of the bounds — the floor slab's underside).
    this._modelBounds = box;
    this._floorY = box.min.y;
    // A fresh model starts from the default perspective orbit view,
    // even if an orthographic camera was selected for the last one.
    this._orthoSize = null;
    this._setActiveCamera(this._perspCamera);
    this._controls.target.copy(center);
    this._camera.position.copy(center).add(
      new THREE.Vector3(radius * 1.1, radius * 0.9, radius * 1.1),
    );
    this._camera.near = Math.max(radius / 100, 0.05);
    this._camera.far = radius * 20;
    this._camera.updateProjectionMatrix();
    this._controls.update();

    // Sun shadow camera: the sun sits radius*4 out from the center
    // (see _updateSunLight), so the far plane must clear 5 radii and
    // the frustum must cover the whole model.
    if (this._sunLight) {
      this._sunLight.shadow.camera.near = 0.5;
      this._sunLight.shadow.camera.far = radius * 8;
      this._sunLight.shadow.camera.left = -radius * 1.5;
      this._sunLight.shadow.camera.right = radius * 1.5;
      this._sunLight.shadow.camera.top = radius * 1.5;
      this._sunLight.shadow.camera.bottom = -radius * 1.5;
    }

    const markerRadius = Math.max(0.05, Math.min(0.35, radius * 0.012));
    // Kept as a field: _buildCameraMarkers re-runs after a reconnect
    // refresh, when the local above is long gone.
    this._markerRadius = markerRadius;

    // Light markers: one sphere per named light in the model, at the
    // light's world position. Colors are applied by _updateLightMarkers.
    // The real three.js lights are recorded too: _updateModelLights
    // drives their intensity/color from the mapped HA entity, so the
    // viewer shows the same lighting as the rendered images instead of
    // the model's base values.
    modelScene.traverse((obj) => {
      if (obj.isCamera && obj.name) this._modelCameras.set(obj.name, obj);
      if (
        obj.name &&
        obj.name.startsWith(WINDOW_MARKER_PREFIX) &&
        !obj.isMesh &&
        !obj.isLight &&
        !obj.isCamera
      ) {
        // Window marker for bounce lights (see _finalizeWindows).
        this._windows.push({ name: obj.name, marker: obj, light: null });
      }
      if (obj.isMesh) {
        // Model meshes cast and receive shadows (markers live in the
        // group, not the model scene, so they stay shadow-free), except
        // ShadowOnly meshes (invisible, still casting) and fully
        // transparent ones (glass casts no shadow).
        applyMeshShadowRules(obj);
        if (materialsOf(obj).some((m) => m.name === SHEER_CURTAIN_MATERIAL)) {
          this._curtains.push({ name: obj.name, mesh: obj, material: null, outward: null });
        }
      }
      if (!obj.isLight || !obj.name) return;
      // Every model light casts shadows (point lights: cube maps).
      // The map size comes from the light's name (256/512/1024), so
      // some lights cast soft shadows and others crisp ones — the same
      // hash the render service uses, one step lighter so the
      // browser's shadow memory stays modest.
      obj.castShadow = true;
      if (obj.shadow) {
        const mapSize = shadowMapSizeForLight(obj.name);
        obj.shadow.mapSize.set(mapSize, mapSize);
        obj.shadow.camera.near = 0.1;
        obj.shadow.camera.far = radius * 3;
        // No depth bias: in a perspective cube camera -0.004 NDC is
        // ~0.3-0.5 m of world depth at 4-5 m, which punches through a
        // 0.10 m interior wall (the dining-room leak, 0.3.8). The
        // normal bias alone handles acne — mirror scene.mjs.
        obj.shadow.bias = 0;
        obj.shadow.normalBias = 0.02;
      }
      this._modelLights.push({
        name: obj.name,
        light: obj,
        baseIntensity: obj.intensity,
        baseColor: obj.color.clone(),
      });
      const pos = obj.getWorldPosition(new THREE.Vector3());
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(markerRadius, 16, 12),
        new THREE.MeshBasicMaterial({
          color: UNMAPPED_COLOR,
          transparent: true,
          opacity: 0.9,
          depthTest: true,
        }),
      );
      mesh.position.copy(pos);
      mesh.userData = { kind: "light", name: obj.name };
      group.add(mesh);
      this._lightMarkers.push({ name: obj.name, mesh, baseRadius: markerRadius });
    });

    // Camera markers (see _buildCameraMarkers): a cone at each camera
    // position, apex pointing at its target, plus a line to the target.
    this._buildCameraMarkers();

    // Sun marker: a sphere on a shell around the model, positioned from
    // sun.sun azimuth/elevation by _updateSunMarker.
    const sun = new THREE.Mesh(
      new THREE.SphereGeometry(markerRadius * 1.6, 16, 12),
      new THREE.MeshBasicMaterial({ color: SUN_COLOR }),
    );
    sun.userData = { kind: "sun", name: "sun" };
    group.add(sun);
    this._sunMarker = sun;

    // Script-driven objects (ceiling fan, TV screen) — see
    // _collectScriptObjects.
    this._collectScriptObjects();

    // Sheer curtains: each mesh gets its own clone of the shared
    // material (so the two windows can glow independently) with a warm
    // emissive that _updateCurtainGlow drives, and its outward normal
    // (derived from the mesh, not hardcoded per room).
    this._finalizeCurtains();

    // Bounce-light windows: one renderer-owned point light per
    // window_* marker (see _finalizeWindows).
    this._finalizeWindows();
  }

  _finalizeCurtains() {
    if (this._curtains.length === 0) {
      return;
    }
    this._modelGroup.updateMatrixWorld(true);
    for (const curtain of this._curtains) {
      const mats = materialsOf(curtain.mesh);
      const sheer = mats.find((m) => m.name === SHEER_CURTAIN_MATERIAL);
      if (sheer) {
        const clone = sheer.clone();
        clone.emissive = new THREE.Color(CURTAIN_GLOW_COLOR);
        clone.emissiveIntensity = 0;
        if (Array.isArray(curtain.mesh.material)) {
          curtain.mesh.material = curtain.mesh.material.map((m) =>
            m === sheer ? clone : m,
          );
        } else {
          curtain.mesh.material = clone;
        }
        curtain.material = clone;
      }
      curtain.outward = curtainOutwardNormal(curtain.mesh, this._modelCenter);
    }
  }

  // Bounce-light windows (mirror scene.mjs loadModel): one
  // renderer-owned point light per window_* marker, created once here
  // and repositioned per frame by _updateBounceLights. Not a model
  // light (no marker, no list row, no shadow). The outward normal is
  // derived like a curtain's — robust to the marker facing in or out.
  _finalizeWindows() {
    if (this._windows.length === 0) return;
    this._modelGroup.updateMatrixWorld(true);
    const size = this._modelBounds.getSize(new THREE.Vector3());
    const diag = Math.max(size.x, size.y, size.z, 1);
    for (const w of this._windows) {
      const room = w.name.slice(WINDOW_MARKER_PREFIX.length);
      const light = new THREE.PointLight(0xffffff, 0, diag * 0.4, 2);
      light.castShadow = false;
      light.name = `bounce_${room}`;
      this._modelGroup.add(light);
      w.room = room;
      w.position = w.marker.getWorldPosition(new THREE.Vector3());
      w.outward = curtainOutwardNormal(w.marker, this._modelCenter);
      w.transmission = WINDOW_TRANSMISSION[room] ?? 1.0;
      w.light = light;
    }
  }

  // Collect the driven objects for the Objects section: the YAML
  // `objects` mapping (panel_data.objects) merged with the script's
  // objectDrivers — YAML wins when both drive the same object, so a
  // fan mapped in configuration.yaml beats the script's driver for
  // it. Only objects that exist in this model are listed — the same
  // scene.js works against any model, so a driver for an object
  // this model does not have is skipped quietly. Runs at scene build
  // and again after a reconnect refresh (the drivers come from
  // panel_data, so they can appear or change). Also rebuilds the 3D
  // object markers and applies the TV visibility.
  _collectScriptObjects() {
    this._scriptObjects = [];
    if (!this._modelGroup) return;
    const drivers = {
      ...((this._panelData && this._panelData.script_object_drivers) || {}),
      ...((this._panelData && this._panelData.objects) || {}),
    };
    for (const [name, entityId] of Object.entries(drivers)) {
      if (typeof entityId !== "string") continue;
      const obj = this._modelGroup.getObjectByName(name);
      if (!obj) continue;
      this._scriptObjects.push({ name, entityId, object: obj });
    }
    this._buildObjectMarkers();
    this._updateTvState();
  }

  // Object markers: a purple sphere at each script-driven object's
  // bounding-box center, clickable for details (like the light and
  // camera markers — the fan and TV screen are otherwise invisible in
  // the viewer). Rebuilt with the objects, old markers removed and
  // disposed first.
  _buildObjectMarkers() {
    for (const { group } of this._objectMarkers) {
      if (this._modelGroup) this._modelGroup.remove(group);
      this._disposeGroup(group);
    }
    this._objectMarkers = [];
    if (!this._modelGroup) return;
    const markerRadius = this._markerRadius || 0.1;
    for (const { name } of this._scriptObjects) {
      const obj = this._modelGroup.getObjectByName(name);
      if (!obj) continue;
      const center = new THREE.Box3().setFromObject(obj).getCenter(
        new THREE.Vector3(),
      );
      const group = new THREE.Group();
      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(markerRadius, 12, 8),
        new THREE.MeshBasicMaterial({ color: OBJECT_COLOR }),
      );
      sphere.userData = { kind: "object", name };
      group.add(sphere);
      group.position.copy(center);
      this._modelGroup.add(group);
      this._objectMarkers.push({ name, group });
    }
  }

  // Select a script-driven object: details in the info line and the
  // row highlighted in the Objects list.
  _selectObject(name) {
    const entry = this._scriptObjects.find((o) => o.name === name);
    if (!entry) return;
    const state = this._emulatedState(entry.entityId);
    this._els.info.textContent =
      `Object ${name} — ${entry.entityId} — ${state}` +
      (this._isOverridden(entry.entityId) ? " (preview)" : "");
    if (this._objectRows) {
      for (const [rowName, row] of this._objectRows) {
        row.li.classList.toggle("active", rowName === name);
      }
    }
  }

  // Camera markers: a cone at each camera position, apex pointing at
  // its target (or along the GLB camera's orientation when the
  // effective config has no target), plus a line to the target. Runs
  // at scene build and again after a reconnect refresh (cameras come
  // from panel_data, so they can change); old markers are removed and
  // disposed first. The model itself is untouched.
  _buildCameraMarkers() {
    for (const { group } of this._cameraMarkers) {
      if (this._modelGroup) this._modelGroup.remove(group);
      this._disposeGroup(group);
    }
    this._cameraMarkers = [];
    if (!this._modelGroup) return;
    const markerRadius = this._markerRadius || 0.1;
    const cameras = (this._panelData && this._panelData.cameras) || [];
    for (const cam of cameras) {
      if (!cam || !cam.name || !Array.isArray(cam.position)) continue;
      const position = new THREE.Vector3(...cam.position);
      let direction = null;
      if (Array.isArray(cam.target)) {
        direction = new THREE.Vector3(...cam.target)
          .sub(position)
          .normalize();
      } else {
        const glbCam = this._modelCameras.get(cam.name);
        if (glbCam) {
          direction = new THREE.Vector3(0, 0, -1)
            .applyQuaternion(glbCam.getWorldQuaternion(new THREE.Quaternion()))
            .normalize();
        }
      }
      if (!direction || direction.lengthSq() === 0) {
        direction = new THREE.Vector3(0, 0, -1);
      }
      const marker = new THREE.Group();
      const coneHeight = markerRadius * 4;
      const cone = new THREE.Mesh(
        new THREE.ConeGeometry(markerRadius * 1.2, coneHeight, 16),
        new THREE.MeshBasicMaterial({ color: CAMERA_COLOR, transparent: true, opacity: 0.85 }),
      );
      // Cone apex is +Y; aim it at the target.
      cone.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        direction,
      );
      cone.position.copy(direction).multiplyScalar(coneHeight / 2);
      cone.userData = { kind: "camera", name: cam.name };
      marker.add(cone);
      const base = new THREE.Mesh(
        new THREE.SphereGeometry(markerRadius * 0.8, 12, 8),
        new THREE.MeshBasicMaterial({ color: CAMERA_COLOR }),
      );
      base.userData = { kind: "camera", name: cam.name };
      marker.add(base);
      if (Array.isArray(cam.target)) {
        const lineGeo = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(0, 0, 0),
          new THREE.Vector3(...cam.target).sub(position),
        ]);
        marker.add(
          new THREE.Line(
            lineGeo,
            new THREE.LineBasicMaterial({
              color: CAMERA_COLOR,
              transparent: true,
              opacity: 0.4,
            }),
          ),
        );
      }
      marker.position.copy(position);
      this._modelGroup.add(marker);
      this._cameraMarkers.push({ name: cam.name, group: marker });
    }
  }

  // --- live state ------------------------------------------------------

  /** Marker color/opacity/scale for one model light from its HA entity. */
  _lightAppearance(modelName) {
    const mapping = (this._panelData && this._panelData.mapping) || {};
    const entityId = mapping[modelName];
    if (!entityId) {
      return {
        rgb: [255, 255, 255],
        opacity: 0.9,
        scale: 1,
        brightness: 1,
        state: "unmapped",
      };
    }
    const st = this._state(entityId);
    // Emulated state: a toggle override wins over the real state.
    const state = this._emulatedState(entityId);
    // The TV's light glows when the TV is on, even when its mapped
    // entity (light.lampy) is off — the viewer mirrors the example
    // script, which lights living_room_tv from the media player.
    // Only when the entity itself is off: when the entity is on, the
    // normal path below reports "on" (the TV is not the reason the
    // light is on).
    if (modelName === TV_LIGHT && state !== "on" && this._tvOn()) {
      return {
        rgb: [255, 240, 214],
        opacity: 1,
        scale: 1.15,
        brightness: 1,
        state: "tv",
      };
    }
    if (!st || state !== "on") {
      return {
        rgb: [0x3a, 0x3f, 0x44],
        opacity: 0.55,
        scale: 1,
        brightness: 0,
        state: st ? state : "unknown",
      };
    }
    const attrs = st.attributes || {};
    let rgb = null;
    if (Array.isArray(attrs.rgb_color)) rgb = attrs.rgb_color;
    else if (Array.isArray(attrs.hs_color)) {
      rgb = hsToRgb(attrs.hs_color[0], attrs.hs_color[1]);
    } else if (Array.isArray(attrs.xy_color)) {
      rgb = xyToRgb(attrs.xy_color[0], attrs.xy_color[1]);
    } else if (typeof attrs.color_temp_kelvin === "number") {
      rgb = kelvinToRgb(attrs.color_temp_kelvin);
    } else if (typeof attrs.color_temp === "number" && attrs.color_temp > 0) {
      rgb = kelvinToRgb(1000000 / attrs.color_temp);
    }
    if (!rgb) rgb = [255, 255, 255];
    const brightness =
      typeof attrs.brightness === "number" ? attrs.brightness / 255 : 1;
    return {
      rgb,
      opacity: 0.35 + 0.65 * brightness,
      scale: 0.85 + 0.3 * brightness,
      brightness,
      state: "on",
    };
  }

  /** Drive the model's real three.js lights from the mapped HA entities.

  Mirrors the render service's built-in mapping (scene.mjs applyLights):
  on -> intensity = model base x brightness, color = entity color (or
  color temperature); off/unavailable -> intensity 0; unmapped -> model
  base values. Without this the viewer showed every light at full base
  brightness no matter what HA said. */
  _updateModelLights() {
    for (const entry of this._modelLights) {
      const app = this._lightAppearance(entry.name);
      if (app.state === "unmapped") {
        entry.light.intensity = entry.baseIntensity;
        entry.light.color.copy(entry.baseColor);
        entry.light.castShadow = true;
      } else if (app.state !== "on" && app.state !== "tv") {
        entry.light.intensity = 0;
        // An off light casts no shadow — and skipping its 6 cube faces
        // keeps the manual shadow update cheap.
        entry.light.castShadow = false;
      } else {
        // "tv" is the TV's light glowing because the TV is on (see
        // _lightAppearance) — it shines like an on light, warm white.
        entry.light.intensity = entry.baseIntensity * app.brightness;
        entry.light.castShadow = true;
        entry.light.color.setRGB(
          app.rgb[0] / 255,
          app.rgb[1] / 255,
          app.rgb[2] / 255,
          THREE.SRGBColorSpace,
        );
      }
    }
    // Light states changed: re-render the shadow maps on the next frame.
    this._requestShadowUpdate();
  }

  _updateLightMarkers() {
    for (const marker of this._lightMarkers) {
      const app = this._lightAppearance(marker.name);
      // The rgb values are sRGB (HA attributes); tell three.js so, or
      // setRGB would treat them as linear and render them too bright.
      marker.mesh.material.color.setRGB(
        app.rgb[0] / 255,
        app.rgb[1] / 255,
        app.rgb[2] / 255,
        THREE.SRGBColorSpace,
      );
      marker.mesh.material.opacity = app.opacity;
      marker.mesh.scale.setScalar(app.scale);
    }
  }

  // HA azimuth: 0 = north, 90 = east. Model layout: +X = east,
  // +Z = south, so north is -Z. Shared by the sun marker and the sun
  // light so they always agree on where the sun is.
  _sunDirection(az, el) {
    const azR = (az * Math.PI) / 180;
    const elR = (el * Math.PI) / 180;
    return new THREE.Vector3(
      Math.cos(elR) * Math.sin(azR),
      Math.sin(elR),
      -Math.cos(elR) * Math.cos(azR),
    );
  }

  // Warm at the horizon, neutral at noon. Mirrors scene.mjs
  // sunColorForElevation (same stops, sRGB).
  _sunColorForElevation(elevation) {
    const stops = [
      [0, [1.0, 0.45, 0.18]],
      [10, [1.0, 0.62, 0.35]],
      [30, [1.0, 0.85, 0.68]],
      [60, [1.0, 0.97, 0.92]],
    ];
    const e = Math.max(0, elevation);
    for (let i = 0; i < stops.length - 1; i += 1) {
      const [e0, c0] = stops[i];
      const [e1, c1] = stops[i + 1];
      if (e >= e0 && e <= e1) {
        const t = (e - e0) / (e1 - e0);
        return [
          Math.round((c0[0] + (c1[0] - c0[0]) * t) * 255),
          Math.round((c0[1] + (c1[1] - c0[1]) * t) * 255),
          Math.round((c0[2] + (c1[2] - c0[2]) * t) * 255),
        ];
      }
    }
    return stops[stops.length - 1][1].map((v) => Math.round(v * 255));
  }

  // The sun position the renders use: the coordinator's effective sun
  // from panel_data (fixed override, live sun.sun, or null when the
  // sun is disabled) — so the viewer agrees with the images. When
  // panel_data has no sun field yet (older integration), fall back to
  // the sun.sun state. Returns { azimuth, elevation } or null.
  // The sun the viewer renders: the time-of-day slider's override
  // when set, else the fixed sun from panel_data (when present), else
  // the live sun.sun state. The slider override is viewer-local
  // emulation — it never touches the renders or the real sun.
  _effectiveSun() {
    if (this._sunOverride !== null) {
      const computed = this._computedSun(this._sunOverride);
      if (computed) return computed;
      // No lat/lon (or an invalid date): fall through to the live sun.
    }
    if (this._panelData && "sun" in this._panelData) {
      const panelSun = this._panelData.sun;
      if (
        panelSun &&
        typeof panelSun.azimuth === "number" &&
        typeof panelSun.elevation === "number"
      ) {
        return panelSun;
      }
      return null;
    }
    const sun = this._state("sun.sun");
    if (!sun || !sun.attributes) return null;
    const { azimuth, elevation } = sun.attributes;
    if (typeof azimuth !== "number" || typeof elevation !== "number") {
      return null;
    }
    return { azimuth, elevation };
  }

  // Sun elevation/azimuth for today at the given local minutes-from-
  // midnight, from hass.config latitude/longitude (NOAA). Null when
  // the location is unavailable.
  _computedSun(minutes) {
    const config = this._hass && this._hass.config;
    if (
      !config ||
      typeof config.latitude !== "number" ||
      typeof config.longitude !== "number"
    ) {
      return null;
    }
    const now = new Date();
    return solarPosition({
      year: now.getFullYear(),
      month: now.getMonth() + 1,
      day: now.getDate(),
      minutes,
      latitude: config.latitude,
      longitude: config.longitude,
      tzOffsetMinutes: now.getTimezoneOffset(),
    });
  }

  // Keep the Sun section in sync with the override: show it only when
  // the location is known, label the effective sun (live or the
  // slider's time), and enable the Live button only while overridden.
  _updateSunSlider() {
    const hasLocation = this._computedSun(720) !== null;
    this._els.sunSection.hidden = !hasLocation;
    if (!hasLocation) return;
    if (this._sunOverride === null) {
      this._els.sunLive.disabled = true;
      const sun = this._effectiveSun();
      this._els.sunLabel.textContent = sun
        ? `Live — elevation ${sun.elevation.toFixed(1)}°, azimuth ${sun.azimuth.toFixed(1)}°`
        : "Live — no sun data";
      // Park the slider at the current time so dragging starts from
      // now rather than from wherever it was left.
      const now = new Date();
      this._els.sunSlider.value = String(
        now.getHours() * 60 + now.getMinutes(),
      );
      return;
    }
    this._els.sunLive.disabled = false;
    const sun = this._effectiveSun();
    const hh = String(Math.floor(this._sunOverride / 60)).padStart(2, "0");
    const mm = String(this._sunOverride % 60).padStart(2, "0");
    this._els.sunLabel.textContent = sun
      ? `${hh}:${mm} — elevation ${sun.elevation.toFixed(1)}°, azimuth ${sun.azimuth.toFixed(1)}° (preview)`
      : `${hh}:${mm} (preview)`;
  }

  /** Drive the directional sun light + hemisphere from the effective
  sun (see _effectiveSun).

  Mirrors the render service's applySun: intensity ramps 0 at the
  horizon to 3.0 at 30 degrees, color warms toward the horizon, and
  the hemisphere follows (0.06 at night, 0.15-0.6 by day, 0.5 when no
  sun state is available). Below the horizon the sun light is off.
  Also drives the sheer curtains' glow (see _updateCurtainGlow) and
  the bounce lights (see _updateBounceLights) — all follow the same
  effective sun. */
  _updateSunLight() {
    if (!this._sunLight || !this._hemi) return;
    const sun = this._effectiveSun();
    if (!sun) {
      this._sunLight.intensity = 0;
      this._hemi.intensity = 0.5;
      this._updateCurtainGlow();
      this._updateBounceLights();
      this._requestShadowUpdate();
      return;
    }
    const az = sun.azimuth;
    const el = sun.elevation;
    if (el < 0) {
      this._sunLight.intensity = 0;
      this._hemi.intensity = 0.06;
      this._updateCurtainGlow();
      this._updateBounceLights();
      this._requestShadowUpdate();
      return;
    }
    const dir = this._sunDirection(az, el);
    this._sunLight.position
      .copy(this._modelCenter)
      .addScaledVector(dir, this._modelRadius * 4);
    this._sunLight.target.position.copy(this._modelCenter);
    this._sunLight.target.updateMatrixWorld();
    const rgb = this._sunColorForElevation(el);
    this._sunLight.color.setRGB(
      rgb[0] / 255,
      rgb[1] / 255,
      rgb[2] / 255,
      THREE.SRGBColorSpace,
    );
    const dayFrac = Math.min(1, Math.max(0, el / 30));
    this._sunLight.intensity = 3.0 * dayFrac;
    this._hemi.intensity = 0.15 + 0.45 * dayFrac;
    this._updateCurtainGlow();
    this._updateBounceLights();
    this._requestShadowUpdate();
  }

  // Sheer-curtain glow (mirror scene.mjs updateCurtainGlow): a curtain
  // glows warm when the sun is on its side, with intensity proportional
  // to sun intensity x alignment; zero when the sun is on the other
  // side or below the horizon. The glow is the curtain material's
  // emissive — there is no separate glow light.
  _updateCurtainGlow() {
    const sun = this._effectiveSun();
    const sunI = this._sunLight ? this._sunLight.intensity : 0;
    if (!sun || sun.elevation <= 0 || sunI <= 0) {
      for (const c of this._curtains) {
        if (c.material) c.material.emissiveIntensity = 0;
      }
      return;
    }
    const dir = this._sunDirection(sun.azimuth, sun.elevation);
    for (const c of this._curtains) {
      if (!c.material || !c.outward) continue;
      const alignment = Math.max(0, dir.dot(c.outward));
      c.material.emissiveIntensity = CURTAIN_GLOW_SCALE * sunI * alignment;
    }
  }

  // Bounce lights (mirror scene.mjs updateBounceLights): for each
  // window marker, when the effective sun is above the horizon and on
  // the window's side, place a soft point light just above the sun
  // patch on the floor — the patch re-illuminating the room. The
  // patch is clamped to within 5 m of its window and the intensity
  // fades to 0 as it approaches that limit, so a low sun never
  // throws the bounce into another room. Called from _updateSunLight
  // on all paths, so the sun slider moves the bounce with the sun,
  // like the curtain glow.
  _updateBounceLights() {
    if (this._windows.length === 0) return;
    const sun = this._effectiveSun();
    const sunI = this._sunLight ? this._sunLight.intensity : 0;
    if (!sun || sun.elevation <= 0 || sunI <= 0) {
      for (const w of this._windows) {
        if (w.light) w.light.intensity = 0;
      }
      return;
    }
    const dirToSun = this._sunDirection(sun.azimuth, sun.elevation);
    const sunDir = dirToSun.clone().negate();
    const bounds = this._modelBounds;
    for (const w of this._windows) {
      if (!w.light) continue;
      const alignment = dirToSun.dot(w.outward);
      if (alignment <= 0) {
        w.light.intensity = 0;
        continue;
      }
      const t = (this._floorY - w.position.y) / sunDir.y;
      if (!(t > 0)) {
        w.light.intensity = 0;
        continue;
      }
      const patch = w.position.clone().addScaledVector(sunDir, t);
      // A low sun throws the patch far — clamp it to within one room
      // of its window (the whole-house bounds clamp below used to let
      // it land in a different room entirely), and fade the intensity
      // out as the patch approaches the limit so there is no popping
      // as the sun moves. (Mirror scene.mjs.)
      const dx = patch.x - w.position.x;
      const dz = patch.z - w.position.z;
      const patchDistance = Math.hypot(dx, dz);
      const fade =
        patchDistance <= BOUNCE_FADE_START_DISTANCE
          ? 1
          : Math.max(
              0,
              (BOUNCE_MAX_PATCH_DISTANCE - patchDistance) /
                (BOUNCE_MAX_PATCH_DISTANCE - BOUNCE_FADE_START_DISTANCE),
            );
      if (patchDistance > BOUNCE_MAX_PATCH_DISTANCE) {
        const s = BOUNCE_MAX_PATCH_DISTANCE / patchDistance;
        patch.x = w.position.x + dx * s;
        patch.z = w.position.z + dz * s;
      }
      if (bounds) {
        patch.x = Math.min(
          Math.max(patch.x, bounds.min.x + 0.2),
          bounds.max.x - 0.2,
        );
        patch.z = Math.min(
          Math.max(patch.z, bounds.min.z + 0.2),
          bounds.max.z - 0.2,
        );
      }
      patch.y = this._floorY + BOUNCE_HEIGHT_ABOVE_PATCH;
      w.light.position.copy(patch);
      w.light.intensity =
        sunI * w.transmission * BOUNCE_FLOOR_ALBEDO * BOUNCE_SCALE * alignment * fade;
      w.light.color
        .copy(this._sunLight.color)
        .multiply(
          new THREE.Color(BOUNCE_WARM[0], BOUNCE_WARM[1], BOUNCE_WARM[2]),
        );
    }
  }

  // Shadow maps update on demand (autoUpdate is off): the sun moved,
  // rose, or set, so the next frame re-renders them.
  _requestShadowUpdate() {
    if (this._renderer) this._renderer.shadowMap.needsUpdate = true;
  }

  _updateSunMarker() {
    if (!this._sunMarker) return;
    const sun = this._effectiveSun();
    if (!sun) {
      this._sunMarker.visible = false;
      return;
    }
    const az = sun.azimuth;
    const el = sun.elevation;
    if (el < 0) {
      // Below the horizon (or no data): hide the sun.
      this._sunMarker.visible = false;
      return;
    }
    const dir = this._sunDirection(az, el);
    this._sunMarker.position
      .copy(this._modelCenter)
      .addScaledVector(dir, this._modelRadius * 1.1);
    this._sunMarker.visible = true;
  }

  // --- picking ---------------------------------------------------------

  _pickables() {
    const out = [];
    for (const m of this._lightMarkers) out.push(m.mesh);
    for (const m of this._cameraMarkers) out.push(...m.group.children);
    for (const m of this._objectMarkers) out.push(...m.group.children);
    if (this._sunMarker) out.push(this._sunMarker);
    return out;
  }

  _pick(ev) {
    if (!this._renderer) return null;
    const rect = this._renderer.domElement.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((ev.clientX - rect.left) / rect.width) * 2 - 1,
      -((ev.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this._raycaster.setFromCamera(pointer, this._camera);
    const hits = this._raycaster.intersectObjects(this._pickables(), false);
    return hits.length > 0 ? hits[0].object.userData : null;
  }

  _handlePick(ev) {
    const hit = this._pick(ev);
    if (!hit) return;
    if (hit.kind === "camera") this._previewCamera(hit.name);
    else if (hit.kind === "light") this._selectLight(hit.name);
    else if (hit.kind === "object") this._selectObject(hit.name);
    else if (hit.kind === "sun") this._selectSun();
  }

  // --- side lists ------------------------------------------------------

  _renderLightList() {
    const mapping = (this._panelData && this._panelData.mapping) || {};
    const list = this._els.lightList;
    list.innerHTML = "";
    this._lightRows = new Map();
    if (this._lightMarkers.length === 0) {
      list.innerHTML = `<li class="row-sub">No lights in this model.</li>`;
      return;
    }
    for (const marker of this._lightMarkers) {
      const entityId = mapping[marker.name];
      const li = document.createElement("li");
      li.className = "clickable";
      const dot = document.createElement("span");
      dot.className = "dot";
      const main = document.createElement("div");
      main.className = "row-main";
      const nameEl = document.createElement("div");
      nameEl.className = "row-name";
      nameEl.textContent = marker.name;
      const sub = document.createElement("div");
      sub.className = "row-sub";
      sub.textContent = entityId ? entityId : "not mapped";
      main.appendChild(nameEl);
      main.appendChild(sub);
      const stateEl = document.createElement("span");
      stateEl.className = "row-state";
      li.appendChild(dot);
      li.appendChild(main);
      li.appendChild(stateEl);
      // Toggle switch for mapped lights: flips the viewer's LOCAL
      // preview override for the entity (emulation-only — never
      // calls an HA service). The row click still selects the light
      // for details; the switch stops propagation so the two don't
      // fight. Only light-domain entities get a switch.
      let toggleInput = null;
      if (entityId && entityId.startsWith("light.")) {
        const toggle = this._makeToggle(entityId, `Toggle ${marker.name}`);
        toggleInput = toggle.input;
        li.appendChild(toggle.label);
      }
      li.addEventListener("click", () => this._selectLight(marker.name));
      list.appendChild(li);
      this._lightRows.set(marker.name, { dot, stateEl, toggleInput });
    }
    this._updateLightList();
  }

  // A toggle switch for one entity: flips the viewer's LOCAL preview
  // override for it (emulation-only — never calls an HA service).
  // The label stops propagation so a switch inside a clickable row
  // does not also trigger the row's click handler.
  _makeToggle(entityId, labelText) {
    const label = document.createElement("label");
    label.className = "switch";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.setAttribute("aria-label", labelText);
    const slider = document.createElement("span");
    slider.className = "slider";
    label.appendChild(input);
    label.appendChild(slider);
    label.addEventListener("click", (ev) => ev.stopPropagation());
    input.addEventListener("change", () => this._toggleEntity(entityId));
    return { label, input };
  }

  _updateLightList() {
    if (!this._lightRows) return;
    const mapping = (this._panelData && this._panelData.mapping) || {};
    for (const [name, row] of this._lightRows) {
      const app = this._lightAppearance(name);
      row.dot.style.backgroundColor = `rgb(${app.rgb[0]},${app.rgb[1]},${app.rgb[2]})`;
      row.dot.style.opacity = String(app.opacity);
      const entityId = mapping[name];
      const overridden = entityId ? this._isOverridden(entityId) : false;
      row.stateEl.textContent = overridden ? `${app.state} (preview)` : app.state;
      row.stateEl.classList.toggle("preview", overridden);
      if (row.toggleInput) {
        row.toggleInput.checked = app.state === "on" || app.state === "tv";
        row.toggleInput.disabled =
          app.state === "unavailable" || app.state === "unknown";
      }
    }
  }

  // Script-driven objects (fan, TV screen): one row per object the
  // script declared a driver for (see _buildScene) — object name,
  // driving entity, live state, and a toggle for the entity when its
  // domain has a toggle service.
  _renderObjectList() {
    const list = this._els.objectList;
    list.innerHTML = "";
    this._objectRows = new Map();
    if (this._scriptObjects.length === 0) {
      list.innerHTML = `<li class="row-sub">No driven objects. Map one in the YAML <code>objects</code> block or declare it in scene.js with <code>objectDrivers</code>.</li>`;
      return;
    }
    for (const { name, entityId } of this._scriptObjects) {
      const li = document.createElement("li");
      li.className = "clickable";
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.style.backgroundColor = "#ffb300";
      const main = document.createElement("div");
      main.className = "row-main";
      const nameEl = document.createElement("div");
      nameEl.className = "row-name";
      nameEl.textContent = name;
      const sub = document.createElement("div");
      sub.className = "row-sub";
      sub.textContent = entityId;
      main.appendChild(nameEl);
      main.appendChild(sub);
      const stateEl = document.createElement("span");
      stateEl.className = "row-state";
      li.appendChild(dot);
      li.appendChild(main);
      li.appendChild(stateEl);
      let toggleInput = null;
      if (isToggleableEntity(entityId)) {
        const toggle = this._makeToggle(entityId, `Toggle ${name}`);
        toggleInput = toggle.input;
        li.appendChild(toggle.label);
      }
      li.addEventListener("click", () => this._selectObject(name));
      list.appendChild(li);
      this._objectRows.set(name, { li, dot, stateEl, toggleInput, entityId });
    }
    this._updateObjectList();
  }

  _updateObjectList() {
    if (!this._objectRows) return;
    for (const [name, row] of this._objectRows) {
      const state = this._emulatedState(row.entityId);
      const overridden = this._isOverridden(row.entityId);
      row.stateEl.textContent = overridden ? `${state} (preview)` : state;
      row.stateEl.classList.toggle("preview", overridden);
      // Active: on, or a media player doing something (playing, paused
      // and idle all mean the TV is on — same as the example script).
      const active = ON_STATES.has(state);
      row.dot.style.backgroundColor = active ? "#ffb300" : "#3a3f44";
      row.dot.style.opacity = active ? "1" : "0.55";
      if (row.toggleInput) {
        row.toggleInput.checked = active;
        row.toggleInput.disabled =
          state === "unavailable" || state === "unknown";
      }
    }
  }

  _renderCameraList() {
    const cameras = (this._panelData && this._panelData.cameras) || [];
    const list = this._els.cameraList;
    list.innerHTML = "";
    this._cameraRows = new Map();
    if (cameras.length === 0) {
      list.innerHTML = `<li class="row-sub">No cameras in this model.</li>`;
      return;
    }
    for (const cam of cameras) {
      const li = document.createElement("li");
      li.className = "clickable";
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.style.backgroundColor = "#29b6f6";
      const main = document.createElement("div");
      main.className = "row-main";
      const nameEl = document.createElement("div");
      nameEl.className = "row-name";
      nameEl.textContent = cam.name;
      const sub = document.createElement("div");
      sub.className = "row-sub";
      const projection = cam.projection || cam.type || "perspective";
      sub.textContent =
        `${cam.width}×${cam.height}` +
        (projection === "orthographic" ? " · ortho" : "") +
        (cam.source ? ` · ${cam.source}` : "");
      main.appendChild(nameEl);
      main.appendChild(sub);
      li.appendChild(dot);
      li.appendChild(main);
      li.addEventListener("click", () => this._previewCamera(cam.name));
      list.appendChild(li);
      this._cameraRows.set(cam.name, li);
    }
    // Keep the selected camera highlighted when the list rebuilds
    // (e.g. after a reconnect refresh).
    if (this._selectedCamera && this._cameraRows.has(this._selectedCamera)) {
      this._cameraRows.get(this._selectedCamera).classList.add("active");
    }
  }

  _selectLight(name) {
    const mapping = (this._panelData && this._panelData.mapping) || {};
    const entityId = mapping[name];
    const app = this._lightAppearance(name);
    this._els.info.textContent = entityId
      ? `Light ${name} — ${entityId} — ${app.state}` +
        (this._isOverridden(entityId) ? " (preview)" : "")
      : `Light ${name} — not mapped to a Home Assistant entity`;
  }

  _selectSun() {
    const sun = this._effectiveSun();
    if (!sun) {
      this._els.info.textContent = "Sun — no sun data available";
      return;
    }
    this._els.info.textContent =
      `Sun — azimuth ${sun.azimuth.toFixed(1)}°, elevation ${sun.elevation.toFixed(1)}°` +
      (this._sunOverride !== null ? " (preview)" : "");
  }

  _clearPreview() {
    if (this._previewUrl) {
      URL.revokeObjectURL(this._previewUrl);
      this._previewUrl = null;
    }
    this._selectedCamera = null;
    if (this._cameraRows) {
      for (const li of this._cameraRows.values()) li.classList.remove("active");
    }
    this._els.preview.innerHTML =
      `<div class="none">Select a camera to preview its latest render.</div>`;
  }

  async _previewCamera(name) {
    this._selectedCamera = name;
    if (this._cameraRows) {
      for (const [camName, li] of this._cameraRows) {
        li.classList.toggle("active", camName === name);
      }
    }
    const cameras = (this._panelData && this._panelData.cameras) || [];
    const cam = cameras.find((c) => c.name === name);
    const entityId =
      this._panelData &&
      this._panelData.image_entities &&
      this._panelData.image_entities[name];
    const projection = cam ? cam.projection || cam.type || "perspective" : null;
    this._els.info.textContent = cam
      ? `Camera ${name} — ${cam.width}×${cam.height}` +
        (projection === "orthographic"
          ? ` — ortho${typeof cam.ortho_size === "number" ? ` ${cam.ortho_size} m` : ""}`
          : cam.fov
            ? ` — fov ${cam.fov}°`
            : "") +
        (entityId ? ` — ${entityId}` : " — no image entity")
      : `Camera ${name}`;
    // Selecting a camera also jumps the 3D viewer to its viewpoint and
    // adopts its projection (an orthographic camera views orthographic).
    if (cam) this._jumpToCamera(cam);
    if (!entityId) {
      this._els.preview.innerHTML =
        `<div class="none">No render yet for camera ${name}.</div>`;
      return;
    }
    this._els.preview.innerHTML = `<div class="none">Loading render…</div>`;
    try {
      const resp = await this._hass.fetchWithAuth(
        `/api/image_proxy/${entityId}`,
      );
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const blob = await resp.blob();
      if (this._selectedCamera !== name) return; // user moved on
      if (this._previewUrl) URL.revokeObjectURL(this._previewUrl);
      this._previewUrl = URL.createObjectURL(blob);
      this._els.preview.innerHTML = "";
      const img = document.createElement("img");
      img.src = this._previewUrl;
      img.alt = `Latest render from camera ${name}`;
      this._els.preview.appendChild(img);
    } catch (err) {
      if (this._selectedCamera !== name) return;
      this._els.preview.innerHTML =
        `<div class="none">Could not load the render for camera ${name}.</div>`;
    }
  }
}

customElements.define("scene-renderer-panel", SceneRendererPanel);
