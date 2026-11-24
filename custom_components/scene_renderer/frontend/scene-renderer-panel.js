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
// The light→entity mapping lives in the scene script (`lightMapping`,
// panel_data.light_mapping): the viewer applies it the same way the
// script does — a mapped light follows its entity's on/off, brightness
// and color; a light not in the table renders OFF. panel_data.entities
// lists the subscribed entities; the Entities section shows them with
// emulation toggles (and a brightness slider for lights that support
// it), so the preview can be driven from the entities as well as from
// the lights.
//
// The toggles, the sun slider, the season slider and the weather
// select are VIEWER-ONLY emulation: flipping a toggle sets a local
// override for that entity or light in this viewer (never calling any
// HA service), the sun slider moves the viewer's sun to the chosen
// time of day, the season slider moves it to the chosen day of the
// year, and the weather select dims the sun and adds rain or snow —
// all without touching the renders or the real entities. Precedence
// for a light: a direct light toggle wins; otherwise the light
// follows its mapped entity (whose state and brightness may
// themselves be emulated from the Entities section); the TV glow is
// a fallback only when neither is set. Overridden rows are marked
// "(preview)"; the Reset preview button clears all entity, light and
// brightness overrides and the sun slider's Live button returns the
// sun (and the season) to the real ones. Overrides are session-local
// (gone on reload) and never affect the renders.

import * as THREE from "./three.module.js";
import { OrbitControls } from "./OrbitControls.js";
import { GLTFLoader } from "./GLTFLoader.js";
import { RectAreaLightUniformsLib } from "./RectAreaLightUniformsLib.js";
import { solarPosition } from "./solar-position.mjs";
import { lunarPosition } from "./lunar-position.mjs";

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

// Model-declared lights via glTF extras (PRIVATE convention — mirror
// scene.mjs): glTF's KHR_lights_punctual only expresses
// point/spot/directional, so the model declares anything else in
// node extras, from Blender custom properties:
// extras.ha_light = { type, ... }.
//   Area:   { type: "area", follows: "<punctual light>", scale?: n }
//           or { type: "area", intensity: n } — the mesh IS the
//           emitter: a RectAreaLight fitted to the mesh bounds,
//           facing the followed light, driven per frame from the
//           followed light's effective intensity x scale.
//   Ambient: { type: "ambient", color?: "#rrggbb", day?: n, night?: n }
//           on a bare empty — an AmbientLight driven by sun elevation
//           every frame (day at full daylight, night below the
//           horizon — the moonlit-sky floor, so night is dimly
//           visible rather than black). The directional moonlight
//           itself is a separate viewer-owned light (see
//           _updateMoonLight): the model declares only the floor.
//           The model validator (scripts/verify_glb.py) is the strict
//           gate; the viewer is lenient and skips an invalid entry.
const HA_LIGHT_EXTRAS_KEY = "ha_light";
const AREA_LIGHT_NAME_PREFIX = "area_";
const AMBIENT_LIGHT_NAME_PREFIX = "ambient_";
const AREA_LIGHT_OFFSET_M = 0.01;
const AREA_DEFAULT_SCALE = 1.0;
const AMBIENT_DEFAULT_DAY = 0.1;
// Default night floor for an ambient marker without a `night` value:
// 0.2 keeps rooms dimly visible at night (mirror scene.mjs).
const AMBIENT_DEFAULT_NIGHT = 0.2;

// Moonlight (mirror scene.mjs): a dim, cool directional light — a
// second, much weaker sun for the night. Its position comes from
// panel_data.moon (the coordinator's lunar ephemeris) or, while the
// time-of-day slider is overridden, from lunar-position.mjs for the
// slider's time; its intensity keys off the effective sun elevation
// (0 while the sun is up, full once the sun is 12 deg below the
// horizon, 0 when the moon itself is down). Keep these values in sync
// with scene.mjs (MOON_INTENSITY 2.0 tuned 2026-11-24).
const MOON_COLOR = 0xcfdcee;
const MOON_INTENSITY = 2.0;

// Weather presets (mirror scene.mjs WEATHER_PRESETS — the viewer and
// the render service must agree; the panel is emulation-only, the
// coordinator never sends a weather field, so renders stay sunny):
//   sunny:    the current look, untouched.
//   overcast: dim sun, flat bright hemisphere, grey clear tint.
//   rainy:    overcast, darker, plus falling rain.
//   snowy:    bright diffuse light (snow bounce), cool tint, snow.
// The hemisphere override and the clear tint apply only while the
// sun is up (or there is no sun state): an overcast night is still
// dark. The moon is dimmed by the same sun factor.
const WEATHER_PRESETS = {
  sunny: { sun: 1.0, hemi: null, tint: null, particles: null },
  overcast: { sun: 0.25, hemi: 0.6, tint: "#b8bec4", particles: null },
  rainy: { sun: 0.15, hemi: 0.5, tint: "#9aa3ab", particles: "rain" },
  snowy: { sun: 0.4, hemi: 0.7, tint: "#dfe8f0", particles: "snow" },
};
const WEATHER_PARTICLES = {
  rain: { count: 900, size: 0.06, color: 0x9fb4c8, opacity: 0.55, speed: 9.0, seed: 1337 },
  snow: { count: 600, size: 0.12, color: 0xffffff, opacity: 0.85, speed: 1.2, seed: 4242 },
};
// Month abbreviations for the season slider's date label (explicit,
// so the label is the same in every browser locale).
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Seeded RNG (mulberry32, mirror scene.mjs): particle positions must
// be deterministic so the viewer agrees with the service stills.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Particle positions for one kind, seeded and deterministic (mirror
// scene.mjs weatherParticlePositions): uniform in a volume around the
// house (bounds expanded by ~6 m, floor to 7 m up), REJECTING any
// point inside the building footprint (the bounds' x/z extent — for
// the sample model that is the 15 x 8 m house, so no particle ever
// lands inside a room).
function weatherParticlePositions(kind, bounds, floorY) {
  const spec = WEATHER_PARTICLES[kind];
  const rand = mulberry32(spec.seed);
  const xMin = bounds.min.x - 6;
  const xMax = bounds.max.x + 6;
  const zMin = bounds.min.z - 6;
  const zMax = bounds.max.z + 6;
  const yMin = floorY + 0.2;
  const yMax = floorY + 7;
  const out = new Float32Array(spec.count * 3);
  let i = 0;
  while (i < spec.count) {
    const x = xMin + rand() * (xMax - xMin);
    const z = zMin + rand() * (zMax - zMin);
    if (x >= bounds.min.x && x <= bounds.max.x && z >= bounds.min.z && z <= bounds.max.z) {
      continue;
    }
    const y = yMin + rand() * (yMax - yMin);
    out[i * 3] = x;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = z;
    i += 1;
  }
  return out;
}

// Fall one particle column (mirror scene.mjs weatherFallY): base y
// minus speed*time, wrapped into the [yMin, yMax) band so the fall
// loops forever. Pure function of time.
function weatherFallY(baseY, time, speed, yMin, yMax) {
  const height = yMax - yMin;
  let y = (baseY - yMin - speed * time) % height;
  if (y < 0) y += height;
  return yMin + y;
}

function materialsOf(obj) {
  if (Array.isArray(obj.material)) return obj.material;
  return obj.material ? [obj.material] : [];
}

// Read the ha_light declaration off a loaded node (mirror scene.mjs
// parseHaLightExtras): GLTFLoader copies node extras into userData,
// so a Blender dict custom property arrives as an object; a JSON
// string is parsed too. Anything else is ignored.
function parseHaLightExtras(obj) {
  const raw = obj.userData && obj.userData[HA_LIGHT_EXTRAS_KEY];
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      console.warn(`scene-renderer: ha_light on "${obj.name}": not valid JSON — ignored`);
      return null;
    }
  }
  return null;
}

// Extras color: a "#rrggbb" string (sRGB) or a [r, g, b] 0..1 array.
// Returns a THREE.Color or null.
function parseHaColor(value) {
  if (typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value)) {
    return new THREE.Color(value);
  }
  if (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((v) => typeof v === "number")
  ) {
    return new THREE.Color(value[0], value[1], value[2]);
  }
  return null;
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

// Shadow blur radius (mirror scene.mjs shadowRadiusForLight). Only
// the TV gets a blur; every other light keeps the three.js default of
// 1. The value is halved vs the service (8 vs 16): the viewer's maps
// are half the service's (256 vs 512 for the TV), and the radius is
// in texels, so half the value gives the same angular blur.
const TV_SHADOW_RADIUS = 8;
const DEFAULT_SHADOW_RADIUS = 1;
function shadowRadiusForLight(name) {
  return name === "living_room_tv" ? TV_SHADOW_RADIUS : DEFAULT_SHADOW_RADIUS;
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
    this._areaLights = []; // { name, mesh, light, followed, scale, baseIntensity, colorOverride, facing, width, height } — ha_light area entries (RectAreaLight fitted to the mesh, follows a punctual light)
    this._ambientLights = []; // { name, light, day, night } — ha_light ambient entries (AmbientLight driven by sun elevation)
    this._rectAreaLibReady = false; // RectAreaLightUniformsLib.init() once per page
    this._floorY = 0; // floor plane for the bounce patch (bottom of the model bounds)
    this._modelBounds = null; // Box3 of the model, for clamping the bounce patch inside the house
    this._objectMarkers = []; // { name, entityId, mesh } — 3D markers for the script-driven objects
    // Viewer-only emulation overrides (see the file header): entity_id
    // -> emulated state ("on"/"off" for lights, "playing"/"off" for
    // media players). Toggles write here, never to HA. Session-local.
    this._overrides = new Map();
    // Direct light toggles (Lights section): model light name ->
    // "on"/"off". A set toggle wins over the mapped entity's state
    // (and over the TV glow) for that light.
    this._lightOverrides = new Map();
    // Emulated brightness (Entities section slider): entity_id -> 0..1.
    // Only the brightness is overridden; the on/off state still comes
    // from the entity (or its toggle override).
    this._brightnessOverrides = new Map();
    // Viewer-only sun override from the time-of-day slider: minutes
    // from midnight, or null for the live sun (panel_data / sun.sun).
    this._sunOverride = null;
    // Viewer-only season override from the day-of-year slider: 1..365,
    // or null for today's date (the live season). The NOAA solar calc
    // takes the season date, so the sun's elevation/azimuth follow
    // the season; the moon follows too (see _computedMoon). Like the
    // sun override, viewer-local emulation — the renders always use
    // the real date. The Live button clears both overrides.
    this._seasonOverride = null;
    // North offset in degrees (YAML `north_offset`, via panel_data):
    // the true-north azimuth the model's north side (-Z) faces. The
    // viewer rotates true-north sun/moon azimuths into model frame
    // by it (see _sunDirection), so the panel agrees with the renders.
    this._northOffset = 0;
    // Viewer-only weather preset ("sunny"|"overcast"|"rainy"|"snowy"):
    // emulation only, like the sun slider — the renders are always
    // sunny. See WEATHER_PRESETS and _applyWeather.
    this._weather = "sunny";
    // Weather particle systems (THREE.Points), built lazily per model
    // from the model bounds (see _ensureWeatherParticles); _weatherTime
    // is the shared fall clock, advanced in the render loop.
    this._weatherPoints = null; // kind -> THREE.Points
    this._weatherBase = null; // kind -> Float32Array of seeded positions
    this._weatherTime = 0;
    // Fan spin state: the ceiling_fan group's current angle, advanced
    // in the render loop while its emulated state is on.
    this._fanAngle = 0;
    this._clock = new THREE.Clock();
    this._sunMarker = null;
    this._sunLight = null; // DirectionalLight driven by sun.sun
    this._moonLight = null; // DirectionalLight driven by the moon position (panel_data.moon or the sun slider's time)
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
        .sun-row select {
          background: var(--card-background-color, #fff);
          color: var(--primary-text-color, #212121);
          border: 1px solid var(--divider-color, #e0e0e0);
          border-radius: 4px; padding: 6px 8px; font-size: 14px;
        }
        .season-label { flex-shrink: 0; min-width: 52px; text-align: right; }
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
        .brightness-row {
          display: flex; align-items: center; gap: 6px; margin-top: 2px;
        }
        .brightness-row input[type="range"] {
          flex: 1; min-width: 0; height: 16px; cursor: pointer;
        }
        .brightness-row input[type="range"]:disabled {
          opacity: 0.5; cursor: default;
        }
        .brightness-row span {
          font-size: 11px; width: 32px; text-align: right; flex-shrink: 0;
          color: var(--secondary-text-color, #727272);
        }
        .brightness-row span.preview {
          color: var(--warning-color, #ff9800);
          font-weight: 500;
        }
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
            <h2>Entities</h2>
            <ul id="entity-list"><li class="row-sub">Loading…</li></ul>
            <h2>Objects</h2>
            <ul id="object-list"><li class="row-sub">Loading…</li></ul>
            <h2>Cameras</h2>
            <ul id="camera-list"><li class="row-sub">Loading…</li></ul>
            <div id="sun-section" hidden>
              <h2>Sun</h2>
              <div class="sun-row">
                <input type="range" id="sun-slider" min="0" max="1439" step="15" value="720" aria-label="Time of day">
                <button id="sun-live" class="mini" disabled title="Return the viewer's sun and season to the live ones">Live</button>
              </div>
              <div class="sun-row">
                <input type="range" id="season-slider" min="1" max="365" step="1" value="172" aria-label="Day of year">
                <span class="row-sub season-label" id="season-label">21 Jun</span>
              </div>
              <div class="row-sub" id="sun-label">Live</div>
            </div>
            <div id="weather-section">
              <h2>Weather</h2>
              <div class="sun-row">
                <select id="weather-select" aria-label="Weather">
                  <option value="sunny">Sunny</option>
                  <option value="overcast">Overcast</option>
                  <option value="rainy">Rainy</option>
                  <option value="snowy">Snowy</option>
                </select>
              </div>
              <div class="row-sub">Preview only — the renders are always sunny.</div>
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
      entityList: this.shadowRoot.querySelector("#entity-list"),
      objectList: this.shadowRoot.querySelector("#object-list"),
      cameraList: this.shadowRoot.querySelector("#camera-list"),
      preview: this.shadowRoot.querySelector("#preview"),
      info: this.shadowRoot.querySelector("#info"),
      resetPreview: this.shadowRoot.querySelector("#reset-preview"),
      sunSection: this.shadowRoot.querySelector("#sun-section"),
      sunSlider: this.shadowRoot.querySelector("#sun-slider"),
      seasonSlider: this.shadowRoot.querySelector("#season-slider"),
      seasonLabel: this.shadowRoot.querySelector("#season-label"),
      sunLive: this.shadowRoot.querySelector("#sun-live"),
      sunLabel: this.shadowRoot.querySelector("#sun-label"),
      weatherSelect: this.shadowRoot.querySelector("#weather-select"),
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
    this._els.seasonSlider.addEventListener("input", (ev) => {
      this._seasonOverride = Number(ev.target.value);
      this._updateSunSlider();
      this._updateSunMarker();
      this._updateSunLight();
      this._updateLightMarkers();
      this._updateModelLights();
      this._updateLightList();
    });
    this._els.sunLive.addEventListener("click", () => {
      this._sunOverride = null;
      this._seasonOverride = null;
      this._updateSunSlider();
      this._updateSunMarker();
      this._updateSunLight();
      this._updateLightMarkers();
      this._updateModelLights();
      this._updateLightList();
    });
    this._els.weatherSelect.addEventListener("change", (ev) => {
      this._weather = ev.target.value;
      this._updateSunLight();
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
    this._updateEntityList();
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
    this._updateEntityList();
    this._updateObjectList();
    this._updateTvState();
  }

  // Flip a light's direct toggle (Lights section): a LOCAL preview
  // override for that one model light, never touching HA. It wins
  // over the mapped entity's state (and over the TV glow) until Reset
  // preview clears it. The color still comes from the mapped entity's
  // attributes when there is one (see _lightAppearance).
  _toggleLight(modelName) {
    const current = this._lightOverrides.get(modelName);
    const app = this._lightAppearance(modelName);
    const isOn = current ? current === "on" : app.state === "on" || app.state === "tv";
    this._lightOverrides.set(modelName, isOn ? "off" : "on");
    this._updateResetButton();
    this._updateLightMarkers();
    this._updateModelLights();
    this._updateLightList();
    this._updateEntityList();
  }

  // Set a LOCAL preview brightness for an entity (Entities section
  // slider, 0..1), never touching HA. A value equal to the entity's
  // real brightness clears the override instead, so the slider
  // returning to the real value removes the "(preview)" mark.
  _setBrightnessOverride(entityId, value) {
    const st = this._state(entityId);
    const real =
      st && typeof st.attributes?.brightness === "number"
        ? st.attributes.brightness / 255
        : 1;
    if (Math.abs(value - real) < 0.005) {
      this._brightnessOverrides.delete(entityId);
    } else {
      this._brightnessOverrides.set(entityId, value);
    }
    this._updateResetButton();
    this._updateLightMarkers();
    this._updateModelLights();
    this._updateLightList();
    this._updateEntityList();
  }

  // Clear all entity, light and brightness overrides and return the
  // viewer to the real entity states. (The sun slider has its own
  // Live button.)
  _resetOverrides() {
    if (
      this._overrides.size === 0 &&
      this._lightOverrides.size === 0 &&
      this._brightnessOverrides.size === 0
    )
      return;
    this._overrides.clear();
    this._lightOverrides.clear();
    this._brightnessOverrides.clear();
    this._updateResetButton();
    this._updateLightMarkers();
    this._updateModelLights();
    this._updateLightList();
    this._updateEntityList();
    this._updateObjectList();
    this._updateTvState();
  }

  _updateResetButton() {
    this._els.resetPreview.disabled =
      this._overrides.size === 0 &&
      this._lightOverrides.size === 0 &&
      this._brightnessOverrides.size === 0;
  }

  // The light->entity mapping from the script (panel_data.light_mapping);
  // older integrations sent it as `mapping` — accept that too so a
  // stale integration still shows its lights.
  _lightMapping() {
    if (!this._panelData) return {};
    return this._panelData.light_mapping || this._panelData.mapping || {};
  }

  // The entity's color as [r, g, b] (sRGB), following the same
  // priority as the example script's apply logic: rgb, then hs, then
  // xy, then color temperature (kelvin, else legacy mireds). Returns
  // null when the entity has no color information at all.
  _entityColor(st) {
    if (!st) return null;
    const attrs = st.attributes || {};
    if (Array.isArray(attrs.rgb_color)) return attrs.rgb_color;
    if (Array.isArray(attrs.hs_color)) {
      return hsToRgb(attrs.hs_color[0], attrs.hs_color[1]);
    }
    if (Array.isArray(attrs.xy_color)) {
      return xyToRgb(attrs.xy_color[0], attrs.xy_color[1]);
    }
    if (typeof attrs.color_temp_kelvin === "number") {
      return kelvinToRgb(attrs.color_temp_kelvin);
    }
    if (typeof attrs.color_temp === "number" && attrs.color_temp > 0) {
      return kelvinToRgb(1000000 / attrs.color_temp);
    }
    return null;
  }

  // The brightness (0..1) the viewer shows for an entity: the local
  // slider override when one is set, else the real brightness
  // attribute (1 for on/off-only entities).
  _emulatedBrightness(entityId) {
    if (this._brightnessOverrides.has(entityId)) {
      return this._brightnessOverrides.get(entityId);
    }
    const st = this._state(entityId);
    if (st && typeof st.attributes?.brightness === "number") {
      return st.attributes.brightness / 255;
    }
    return 1;
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
    // North offset (YAML `north_offset`): the true-north azimuth the
    // model's north side (-Z) faces. Older integrations send no field
    // — default 0 (the model laid out true-north-up).
    this._northOffset =
      data && typeof data.north_offset === "number" ? data.north_offset : 0;
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
    this._renderEntityList();
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
    this._northOffset =
      data && typeof data.north_offset === "number" ? data.north_offset : 0;
    this._collectScriptObjects();
    this._renderLightList();
    this._renderEntityList();
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
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.shadowMap.autoUpdate = false;
    this._renderer = renderer;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0); // transparent: HA theme shows through
    this._els.viewer.appendChild(renderer.domElement);

    this._scene = new THREE.Scene();
    // Dim base illumination so the model stays readable when every HA
    // light is off; _updateSunLight drives its intensity from the sun
    // elevation the same way the render service does (0 at night —
    // night is dark — up to 0.6 at full daylight). It must stay dim,
    // or it washes out the state-driven lights entirely — the old
    // fixed 0.9 made every room look lit no matter what.
    this._hemi = new THREE.HemisphereLight(0xffffff, 0x555566, 0.15);
    this._scene.add(this._hemi);
    // Directional sun, positioned and colored by _updateSunLight from
    // sun.sun. It casts shadows; the shadow camera is sized to the
    // model in _buildScene once the radius is known.
    this._sunLight = new THREE.DirectionalLight(0xffffff, 0);
    this._sunLight.name = "sun";
    this._sunLight.castShadow = true;
    this._sunLight.shadow.mapSize.set(2048, 2048);
    this._sunLight.shadow.bias = -0.0005;
    this._scene.add(this._sunLight);
    this._scene.add(this._sunLight.target);
    // Directional moon, positioned and dimmed by _updateMoonLight
    // (same shadow setup as the sun). It shines through windows at
    // night, so the night render is moonlit, not black.
    this._moonLight = new THREE.DirectionalLight(MOON_COLOR, 0);
    this._moonLight.name = "moon";
    this._moonLight.castShadow = true;
    this._moonLight.shadow.mapSize.set(2048, 2048);
    this._moonLight.shadow.bias = -0.0005;
    this._scene.add(this._moonLight);
    this._scene.add(this._moonLight.target);

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
      // Weather particles fall continuously while rain or snow is
      // selected (the fall loops; _weatherTime is the shared clock,
      // advanced by the same clamped delta as the fan).
      this._weatherTime += dt;
      const weatherPreset =
        WEATHER_PRESETS[this._weather] || WEATHER_PRESETS.sunny;
      if (weatherPreset.particles) {
        this._updateWeatherParticles(weatherPreset.particles);
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
    this._areaLights = [];
    this._ambientLights = [];
    this._sunMarker = null;
    // Weather particles belong to the old model's bounds — drop them
    // so they are rebuilt for the new model on the next _applyWeather.
    if (this._weatherPoints) {
      for (const points of Object.values(this._weatherPoints)) {
        this._scene.remove(points);
        points.geometry.dispose();
        points.material.dispose();
      }
      this._weatherPoints = null;
      this._weatherBase = null;
    }
    const haLightNodes = [];

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
    // the frustum must cover the whole model. The moon sits at the
    // same distance (see _updateMoonLight), so it gets the same
    // shadow camera.
    if (this._sunLight) {
      this._sunLight.shadow.camera.near = 0.5;
      this._sunLight.shadow.camera.far = radius * 8;
      this._sunLight.shadow.camera.left = -radius * 1.5;
      this._sunLight.shadow.camera.right = radius * 1.5;
      this._sunLight.shadow.camera.top = radius * 1.5;
      this._sunLight.shadow.camera.bottom = -radius * 1.5;
    }
    if (this._moonLight) {
      this._moonLight.shadow.camera.near = 0.5;
      this._moonLight.shadow.camera.far = radius * 8;
      this._moonLight.shadow.camera.left = -radius * 1.5;
      this._moonLight.shadow.camera.right = radius * 1.5;
      this._moonLight.shadow.camera.top = radius * 1.5;
      this._moonLight.shadow.camera.bottom = -radius * 1.5;
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
      // Model-declared lights (ha_light extras): collected here, built
      // in _finalizeHaLights after the bounds are known.
      const ha = parseHaLightExtras(obj);
      if (ha) haLightNodes.push({ obj, ha });
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
        // Blur radius: the TV's shadows are soft (big area source);
        // every other light keeps the three.js default (crisp).
        obj.shadow.radius = shadowRadiusForLight(obj.name);
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

    // Model-declared lights (ha_light extras): area lights fitted to
    // their mesh + ambient lights on bare empties (see
    // _finalizeHaLights).
    this._finalizeHaLights(haLightNodes);
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

  // Model-declared lights from ha_light extras (mirror scene.mjs
  // loadModel): area lights fitted to their mesh, ambient lights on
  // bare empties. Not model lights — no marker, no list row, no
  // shadow. The area light's RectAreaLight needs
  // RectAreaLightUniformsLib.init() (the LTC lookup textures) before
  // the first render with one; once per page is enough.
  _finalizeHaLights(haLightNodes) {
    if (haLightNodes.length === 0) return;
    this._modelGroup.updateMatrixWorld(true);
    for (const { obj, ha } of haLightNodes) {
      if (ha.type === "area") {
        const built = this._buildAreaLight(obj, ha);
        if (built) {
          this._modelGroup.add(built.light);
          this._areaLights.push(built);
        }
      } else if (ha.type === "ambient") {
        const day = typeof ha.day === "number" ? ha.day : AMBIENT_DEFAULT_DAY;
        const night =
          typeof ha.night === "number" ? ha.night : AMBIENT_DEFAULT_NIGHT;
        const light = new THREE.AmbientLight(
          parseHaColor(ha.color) ?? 0xffffff,
          day,
        );
        light.name = AMBIENT_LIGHT_NAME_PREFIX + obj.name;
        this._modelGroup.add(light);
        this._ambientLights.push({ name: obj.name, light, day, night });
      } else {
        console.warn(
          `scene-renderer: ha_light on "${obj.name}": unknown type ${JSON.stringify(ha.type)} — ignored`,
        );
      }
    }
    if (this._areaLights.length > 0 && !this._rectAreaLibReady) {
      RectAreaLightUniformsLib.init();
      this._rectAreaLibReady = true;
    }
    // New lights: sync them to the current states right away (the
    // TV may already be on, the sun may already be up).
    this._updateAreaLights();
    this._updateAmbientLights();
  }

  // Build the RectAreaLight for one mesh with ha_light type "area"
  // (mirror scene.mjs buildAreaLight): size and facing come from the
  // mesh geometry — the emitting face is the thin axis of the world
  // bounding box, the facing sign comes from the followed light's
  // side (it sits just in front of the emitting face), width/height
  // are the other two extents (height is the vertical one). Returns
  // null when the declaration cannot drive a light.
  _buildAreaLight(mesh, ha) {
    let followed = null;
    if (typeof ha.follows === "string") {
      const entry = this._modelLights.find((e) => e.name === ha.follows);
      followed = entry ? entry.light : null;
      if (!followed) {
        console.warn(
          `scene-renderer: ha_light area on "${mesh.name}": follows "${ha.follows}", not a model light`,
        );
      }
    }
    const standalone = typeof ha.intensity === "number";
    if (!followed && !standalone) {
      console.warn(
        `scene-renderer: ha_light area on "${mesh.name}": needs "follows" or "intensity" — ignored`,
      );
      return null;
    }
    const box = new THREE.Box3().setFromObject(mesh);
    const meshCenter = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const extents = [size.x, size.y, size.z];
    let thinAxis = 0;
    for (let i = 1; i < 3; i += 1) {
      if (extents[i] < extents[thinAxis]) thinAxis = i;
    }
    const refPoint = followed
      ? followed.getWorldPosition(new THREE.Vector3())
      : meshCenter.clone().sub(this._modelCenter).add(meshCenter);
    const sign =
      refPoint.getComponent(thinAxis) >= meshCenter.getComponent(thinAxis)
        ? 1
        : -1;
    const facing = new THREE.Vector3();
    facing.setComponent(thinAxis, sign);
    let width;
    let height;
    if (thinAxis === 0) {
      width = size.z;
      height = size.y;
    } else if (thinAxis === 1) {
      width = size.x;
      height = size.z;
    } else {
      width = size.x;
      height = size.y;
    }
    const colorOverride = parseHaColor(ha.color);
    const light = new THREE.RectAreaLight(
      colorOverride ? colorOverride.clone() : 0xffffff,
      0,
      Math.max(width, 0.01),
      Math.max(height, 0.01),
    );
    // The emitting mesh may carry a baked emissive (the TV screen
    // glows at strength 2.0 in the model). Capture it here so
    // _updateAreaLights can switch the mesh off with its light —
    // otherwise the screen glows white even when the TV is off
    // (mirror scene.mjs buildAreaLight).
    const mat = mesh.material;
    const emissiveIntensity =
      mat && typeof mat.emissiveIntensity === "number"
        ? mat.emissiveIntensity
        : 0;
    light.name = AREA_LIGHT_NAME_PREFIX + mesh.name;
    // RectAreaLight emits along its local -Z (lookAt aims a light's
    // -Z at the target), so look at a point in front of the face. The
    // up vector flips when the facing is near-vertical (a ceiling
    // panel), or lookAt degenerates.
    light.position.copy(meshCenter).addScaledVector(facing, AREA_LIGHT_OFFSET_M);
    const up =
      Math.abs(facing.y) > 0.9
        ? new THREE.Vector3(0, 0, 1)
        : new THREE.Vector3(0, 1, 0);
    light.up.copy(up);
    light.lookAt(meshCenter.clone().add(facing));
    return {
      name: mesh.name,
      mesh,
      light,
      followed,
      scale:
        typeof ha.scale === "number" && ha.scale > 0
          ? ha.scale
          : AREA_DEFAULT_SCALE,
      baseIntensity: standalone ? ha.intensity : 0,
      colorOverride,
      emissiveIntensity,
      facing: facing.clone(),
      width,
      height,
    };
  }

  // Drive the area lights from their followed punctual light's
  // effective intensity (mirror scene.mjs updateAreaLights): intensity
  // = followed intensity x scale, color = followed color unless
  // extras.color overrides it. The mesh's own emissive follows the
  // light too (a TV screen must not glow when off). Called at the end
  // of _updateModelLights (the followed light's intensity is set
  // there) and once when the model loads.
  _updateAreaLights() {
    for (const a of this._areaLights) {
      if (a.followed) {
        const lit = a.followed.intensity > 0;
        a.light.intensity = a.followed.intensity * a.scale;
        if (!a.colorOverride) a.light.color.copy(a.followed.color);
        a.light.visible = lit;
        const mat = a.mesh && a.mesh.material;
        if (mat && typeof mat.emissiveIntensity === "number") {
          mat.emissiveIntensity = lit ? a.emissiveIntensity : 0;
        }
      } else {
        a.light.intensity = a.baseIntensity;
        a.light.visible = a.baseIntensity > 0;
      }
    }
  }

  // Daylight factor from a sun position: 0 at/below the horizon, 1
  // at 30 degrees and above — the same ramp as the sun intensity and
  // the hemisphere fill (mirror scene.mjs daylightFactor). No sun
  // (null) counts as night.
  _daylightFactor(sun) {
    if (!sun || typeof sun.elevation !== "number") return 0;
    return Math.min(1, Math.max(0, sun.elevation / 30));
  }

  // Drive the ambient lights from the sun elevation (mirror scene.mjs
  // updateAmbientLights): intensity interpolates between the extras
  // `night` value below the horizon and `day` at full daylight. The
  // sun comes from _effectiveSun, so the time-of-day slider drives
  // the ambient too. Called from _updateSunLight and once when the
  // model loads.
  _updateAmbientLights() {
    if (this._ambientLights.length === 0) return;
    const factor = this._daylightFactor(this._effectiveSun());
    for (const a of this._ambientLights) {
      a.light.intensity = a.night + (a.day - a.night) * factor;
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

  /** Marker color/opacity/scale for one model light from its HA entity.

  Mirrors the example script's apply logic: the light follows its
  mapped entity (on -> base x brightness, color from the entity);
  unmapped lights render OFF. Precedence: a direct light toggle wins
  first, then the mapped entity (whose state and brightness may be
  emulated), then the TV glow as a fallback. */
  _lightAppearance(modelName) {
    const mapping = this._lightMapping();
    const entityId = mapping[modelName];
    // A direct light toggle wins over everything — the entity and the
    // TV glow. "on" keeps the entity's color/brightness when there is
    // one (the toggle only flips on/off, like the entity toggles).
    const lightOverride = this._lightOverrides.get(modelName);
    if (lightOverride !== undefined) {
      if (lightOverride === "off") {
        return {
          rgb: [0x3a, 0x3f, 0x44],
          opacity: 0.55,
          scale: 1,
          brightness: 0,
          state: "off",
        };
      }
      const st = entityId ? this._state(entityId) : null;
      const rgb = this._entityColor(st) || [255, 255, 255];
      const brightness = entityId ? this._emulatedBrightness(entityId) : 1;
      return {
        rgb,
        opacity: 0.35 + 0.65 * brightness,
        scale: 0.85 + 0.3 * brightness,
        brightness,
        state: "on",
      };
    }
    if (!entityId) {
      // Unmapped: off in the viewer, like the script renders it.
      // The marker stays neutral white but dim so the light is still
      // findable in the 3D view.
      return {
        rgb: [255, 255, 255],
        opacity: 0.55,
        scale: 1,
        brightness: 0,
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
    const rgb = this._entityColor(st) || [255, 255, 255];
    const brightness = this._emulatedBrightness(entityId);
    return {
      rgb,
      opacity: 0.35 + 0.65 * brightness,
      scale: 0.85 + 0.3 * brightness,
      brightness,
      state: "on",
    };
  }

  /** Drive the model's real three.js lights from the mapped HA entities.

  Mirrors the example script's apply logic (scene.example.js
  applyLightMapping): on -> intensity = model base x brightness,
  color = entity color (or color temperature); off/unavailable ->
  intensity 0; unmapped -> intensity 0 too (the script sets absolute
  values for every light, so nothing is left at base by accident).
  Without this the viewer showed every light at full base brightness
  no matter what HA said. */
  _updateModelLights() {
    for (const entry of this._modelLights) {
      const app = this._lightAppearance(entry.name);
      if (app.state === "unmapped") {
        entry.light.intensity = 0;
        entry.light.castShadow = false;
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
    // Area lights follow their punctual light's effective intensity
    // (set above) — the TV's area fill tracks the TV light.
    this._updateAreaLights();
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
  // +Z = south, so north is -Z. Shared by the sun marker, the sun
  // light, the moon light, the curtain glow and the bounce lights so
  // they always agree on where the sun is.
  //
  // North offset: `az` is a TRUE-north azimuth (from sun.sun, the
  // fixed pin, or the NOAA calc), but the model frame is rotated by
  // `north_offset` — the true-north azimuth the model's north side
  // (-Z) faces. Subtract it before placing the sun/moon (mirror
  // scene.mjs modelAzimuth — the viewer and the service must agree).
  // With offset 0 the model is laid out true-north-up and the
  // direction is unchanged.
  _sunDirection(az, el) {
    const modelAz = (((az - (this._northOffset || 0)) % 360) + 360) % 360;
    const azR = (modelAz * Math.PI) / 180;
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
  // emulation — it never touches the renders or the real sun. A
  // season-only override (day-of-year set, time live) computes the
  // sun for today at the current time on the season date.
  _effectiveSun() {
    if (this._sunOverride !== null || this._seasonOverride !== null) {
      const now = new Date();
      const minutes =
        this._sunOverride !== null
          ? this._sunOverride
          : now.getHours() * 60 + now.getMinutes();
      const computed = this._computedSun(minutes, this._seasonOverride);
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

  // The moon position the viewer renders: the time-of-day slider's
  // override when set (computed for the slider's time and season, so
  // night slider positions show moonlight), else panel_data.moon
  // from the coordinator's lunar ephemeris. Null when neither is
  // available (older integration, sun disabled) — no moonlight then.
  _effectiveMoon() {
    if (this._sunOverride !== null || this._seasonOverride !== null) {
      const now = new Date();
      const minutes =
        this._sunOverride !== null
          ? this._sunOverride
          : now.getHours() * 60 + now.getMinutes();
      const computed = this._computedMoon(minutes, this._seasonOverride);
      if (computed) return computed;
      // No lat/lon (or an invalid date): fall through to panel_data.
    }
    if (this._panelData && "moon" in this._panelData) {
      const panelMoon = this._panelData.moon;
      if (
        panelMoon &&
        typeof panelMoon.azimuth === "number" &&
        typeof panelMoon.elevation === "number"
      ) {
        return panelMoon;
      }
      return null;
    }
    return null;
  }

  // The calendar date for a day-of-year (1 = Jan 1) in the current
  // year. The season slider's date; the timezone offset is taken from
  // this date, so DST is right for the season, not for today.
  _seasonDate(dayOfYear) {
    return new Date(new Date().getFullYear(), 0, dayOfYear);
  }

  // Sun elevation/azimuth for the given local minutes-from-midnight,
  // from hass.config latitude/longitude (NOAA). `dayOfYear` (1..365)
  // is the season slider's date; null means today. Null when the
  // location is unavailable.
  _computedSun(minutes, dayOfYear = null) {
    const config = this._hass && this._hass.config;
    if (
      !config ||
      typeof config.latitude !== "number" ||
      typeof config.longitude !== "number"
    ) {
      return null;
    }
    const date = dayOfYear !== null ? this._seasonDate(dayOfYear) : new Date();
    return solarPosition({
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      minutes,
      latitude: config.latitude,
      longitude: config.longitude,
      tzOffsetMinutes: date.getTimezoneOffset(),
    });
  }

  // Moon elevation/azimuth for the given local minutes-from-midnight,
  // from hass.config latitude/longitude (Schlyter). `dayOfYear`
  // (1..365) is the season slider's date; null means today. Null when
  // the location is unavailable. Mirror _computedSun.
  _computedMoon(minutes, dayOfYear = null) {
    const config = this._hass && this._hass.config;
    if (
      !config ||
      typeof config.latitude !== "number" ||
      typeof config.longitude !== "number"
    ) {
      return null;
    }
    const date = dayOfYear !== null ? this._seasonDate(dayOfYear) : new Date();
    return lunarPosition({
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      minutes,
      latitude: config.latitude,
      longitude: config.longitude,
      tzOffsetMinutes: date.getTimezoneOffset(),
    });
  }

  // Moon suffix for the sun label: " · moon el 24.1°, az 98.3°" when
  // the moon is up, empty otherwise (moon down or no moon data).
  _moonLabelSuffix() {
    const moon = this._effectiveMoon();
    if (!moon || moon.elevation <= 0) return "";
    return ` · moon el ${moon.elevation.toFixed(1)}°, az ${moon.azimuth.toFixed(1)}°`;
  }

  // Keep the Sun section in sync with the overrides: show it only
  // when the location is known, label the effective sun (live or the
  // sliders' time and season), and enable the Live button only while
  // either slider is overridden. The season slider is parked at
  // today's day-of-year while live, and shows the override date
  // ("21 Jun") in the season label.
  _updateSunSlider() {
    const hasLocation = this._computedSun(720) !== null;
    this._els.sunSection.hidden = !hasLocation;
    if (!hasLocation) return;
    const overridden = this._sunOverride !== null || this._seasonOverride !== null;
    this._els.sunLive.disabled = !overridden;
    const now = new Date();
    const minutes =
      this._sunOverride !== null
        ? this._sunOverride
        : now.getHours() * 60 + now.getMinutes();
    const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
    const mm = String(minutes % 60).padStart(2, "0");
    // Day-of-year for today (Jan 1 = 1): park the season slider there
    // while live so dragging starts from the current season.
    const todayDoy = Math.floor(
      (now - new Date(now.getFullYear(), 0, 0)) / 86400000,
    );
    const doy = this._seasonOverride !== null ? this._seasonOverride : todayDoy;
    this._els.seasonSlider.value = String(doy);
    const seasonDate = this._seasonDate(doy);
    const dateStr = `${seasonDate.getDate()} ${MONTHS_SHORT[seasonDate.getMonth()]}`;
    this._els.seasonLabel.textContent = dateStr;
    const sun = this._effectiveSun();
    if (!overridden) {
      this._els.sunLabel.textContent = sun
        ? `Live — elevation ${sun.elevation.toFixed(1)}°, azimuth ${sun.azimuth.toFixed(1)}°${this._moonLabelSuffix()}`
        : "Live — no sun data";
      // Park the time slider at the current time so dragging starts
      // from now rather than from wherever it was left.
      this._els.sunSlider.value = String(minutes);
      return;
    }
    this._els.sunLabel.textContent = sun
      ? `${hh}:${mm} · ${dateStr} — elevation ${sun.elevation.toFixed(1)}°, azimuth ${sun.azimuth.toFixed(1)}° (preview)${this._moonLabelSuffix()}`
      : `${hh}:${mm} · ${dateStr} (preview)`;
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
      this._updateMoonLight();
      this._applyWeather();
      this._updateCurtainGlow();
      this._updateBounceLights();
      this._updateAmbientLights();
      this._requestShadowUpdate();
      return;
    }
    const az = sun.azimuth;
    const el = sun.elevation;
    if (el < 0) {
      this._sunLight.intensity = 0;
      // Night: the hemisphere goes to 0 — night is dark (an earlier
      // 0.06 floor kept every night render dimly lit). A model that
      // wants a moonlight floor declares it in its ambient light's
      // `night` value instead. Mirror scene.mjs applySun.
      this._hemi.intensity = 0;
      this._updateMoonLight();
      this._applyWeather();
      this._updateCurtainGlow();
      this._updateBounceLights();
      this._updateAmbientLights();
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
    this._updateMoonLight();
    this._applyWeather();
    this._updateCurtainGlow();
    this._updateBounceLights();
    this._updateAmbientLights();
    this._requestShadowUpdate();
  }

  // Moon fade from a sun position (mirror scene.mjs moonFadeFactor):
  // 0 while the sun is up, 1 once the sun is 12 degrees below the
  // horizon. No sun (null) counts as no moon.
  _moonFadeFactor(sun) {
    if (!sun || typeof sun.elevation !== "number") return 0;
    return Math.min(1, Math.max(0, -sun.elevation / 12));
  }

  /** Drive the directional moon light from the effective moon
  position (see _effectiveMoon) and the effective sun elevation.

  Mirrors the render service's applyMoon: the moon shines through
  windows and casts shadows like a dim second sun, fading in as the
  sun sets (full once the sun is 12 deg below the horizon) and off
  when the moon itself is below the horizon or the sun is up. Called
  from _updateSunLight on all paths, so the sun slider moves the
  moonlight with the sun, like the ambient lights. */
  _updateMoonLight() {
    if (!this._moonLight) return;
    const moon = this._effectiveMoon();
    if (!moon || moon.elevation <= 0) {
      this._moonLight.intensity = 0;
      return;
    }
    const fade = this._moonFadeFactor(this._effectiveSun());
    if (fade <= 0) {
      this._moonLight.intensity = 0;
      return;
    }
    const dir = this._sunDirection(moon.azimuth, moon.elevation);
    this._moonLight.position
      .copy(this._modelCenter)
      .addScaledVector(dir, this._modelRadius * 4);
    this._moonLight.target.position.copy(this._modelCenter);
    this._moonLight.target.updateMatrixWorld();
    this._moonLight.intensity = MOON_INTENSITY * fade;
  }

  // Apply the emulated weather preset (mirror scene.mjs applyWeather):
  // dim the sun and moon, flatten the hemisphere while the sun is up,
  // tint the clear color, and show the rain/snow particles. Called
  // from _updateSunLight AFTER the sun and moon intensities are set
  // (so the dimming is not overwritten) and BEFORE the curtain glow
  // and bounce lights (which read the weathered sun intensity). The
  // sun/moon/hemi intensities are set fresh on every _updateSunLight
  // call, so the multiplication never compounds.
  _applyWeather() {
    if (!this._sunLight || !this._hemi || !this._renderer) return;
    const preset = WEATHER_PRESETS[this._weather] || WEATHER_PRESETS.sunny;
    this._sunLight.intensity *= preset.sun;
    if (this._moonLight) this._moonLight.intensity *= preset.sun;
    const sun = this._effectiveSun();
    const sunUp = !sun || sun.elevation > 0;
    if (preset.hemi !== null && sunUp) {
      this._hemi.intensity = preset.hemi;
    }
    if (preset.tint && sunUp) {
      this._renderer.setClearColor(new THREE.Color(preset.tint), 1);
    } else {
      this._renderer.setClearColor(0x000000, 0);
    }
    this._updateWeatherParticles(preset.particles);
  }

  // Lazily create the rain/snow THREE.Points (once per model) and add
  // them to the scene (mirror scene.mjs ensureWeatherParticles).
  // Points never cast shadows; depthWrite off so a flake never
  // occludes the house behind it.
  _ensureWeatherParticles() {
    if (!this._scene || !this._modelBounds) return;
    this._weatherPoints = {};
    this._weatherBase = {};
    for (const kind of ["rain", "snow"]) {
      const spec = WEATHER_PARTICLES[kind];
      const positions = weatherParticlePositions(
        kind,
        this._modelBounds,
        this._floorY,
      );
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      const material = new THREE.PointsMaterial({
        color: spec.color,
        size: spec.size,
        sizeAttenuation: true,
        transparent: true,
        opacity: spec.opacity,
        depthWrite: false,
      });
      const points = new THREE.Points(geometry, material);
      points.name = `weather_${kind}`;
      points.visible = false;
      points.frustumCulled = false; // the cloud spans the whole volume
      this._scene.add(points);
      this._weatherPoints[kind] = points;
      this._weatherBase[kind] = positions;
    }
  }

  // Show/hide the particle systems for the current weather and advance
  // the fall to _weatherTime (mirror scene.mjs updateWeatherParticles).
  // Called from _applyWeather (on weather or sun changes) and from the
  // render loop (every frame, while rain or snow is selected).
  _updateWeatherParticles(kind) {
    if (!this._scene || !this._modelBounds) return;
    if (!this._weatherPoints) this._ensureWeatherParticles();
    if (!this._weatherPoints) return;
    const yMin = this._floorY + 0.2;
    const yMax = this._floorY + 7;
    for (const [name, points] of Object.entries(this._weatherPoints)) {
      const active = name === kind;
      points.visible = active;
      if (!active) continue;
      const spec = WEATHER_PARTICLES[name];
      const base = this._weatherBase[name];
      const attr = points.geometry.getAttribute("position");
      const arr = attr.array;
      for (let i = 0; i < spec.count; i += 1) {
        arr[i * 3 + 1] = weatherFallY(
          base[i * 3 + 1],
          this._weatherTime,
          spec.speed,
          yMin,
          yMax,
        );
      }
      attr.needsUpdate = true;
    }
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
    const mapping = this._lightMapping();
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
      // Direct toggle switch for the light: flips the viewer's LOCAL
      // preview override for this model light (emulation-only — never
      // calls an HA service, and never touches the mapped entity). A
      // set toggle wins over the entity's state. Every light gets one,
      // mapped or not — an unmapped light can be previewed on too.
      // The row click still selects the light for details; the switch
      // stops propagation so the two don't fight.
      const toggle = this._makeLightToggle(
        marker.name,
        `Toggle ${marker.name}`,
      );
      li.appendChild(toggle.label);
      li.addEventListener("click", () => this._selectLight(marker.name));
      list.appendChild(li);
      this._lightRows.set(marker.name, {
        dot,
        stateEl,
        toggleInput: toggle.input,
      });
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

  // A toggle switch for one model light: flips the viewer's LOCAL
  // preview override for it (emulation-only — never calls an HA
  // service, and never touches the mapped entity). The label stops
  // propagation so a switch inside a clickable row does not also
  // trigger the row's click handler.
  _makeLightToggle(modelName, labelText) {
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
    input.addEventListener("change", () => this._toggleLight(modelName));
    return { label, input };
  }

  _updateLightList() {
    if (!this._lightRows) return;
    const mapping = this._lightMapping();
    for (const [name, row] of this._lightRows) {
      const app = this._lightAppearance(name);
      row.dot.style.backgroundColor = `rgb(${app.rgb[0]},${app.rgb[1]},${app.rgb[2]})`;
      row.dot.style.opacity = String(app.opacity);
      const entityId = mapping[name];
      // Preview when the light itself is toggled, or its entity is
      // (state or brightness) emulated.
      const overridden =
        this._lightOverrides.has(name) ||
        (entityId &&
          (this._isOverridden(entityId) ||
            this._brightnessOverrides.has(entityId)));
      row.stateEl.textContent = overridden ? `${app.state} (preview)` : app.state;
      row.stateEl.classList.toggle("preview", overridden);
      if (row.toggleInput) {
        row.toggleInput.checked = app.state === "on" || app.state === "tv";
        // A mapped light whose entity is gone cannot be previewed
        // from the entity — but the direct toggle still works, so it
        // is never disabled: it flips the light, not the entity.
        row.toggleInput.disabled = false;
      }
    }
  }

  // Subscribed entities (panel_data.entities — the YAML list plus the
  // script's subscriptions and the object drivers): one row per
  // entity, with the lights it drives, its live state, and emulation
  // controls — a toggle for toggleable domains and a brightness slider
  // for lights that report a brightness. Everything here feeds the
  // preview ONLY, through the lightMapping: flipping an entity's
  // toggle drives every light it maps to.
  _renderEntityList() {
    const entities = (this._panelData && this._panelData.entities) || [];
    const mapping = this._lightMapping();
    const list = this._els.entityList;
    list.innerHTML = "";
    this._entityRows = new Map();
    if (entities.length === 0) {
      list.innerHTML = `<li class="row-sub">No subscribed entities. List them in the YAML <code>entities</code> block or declare them in scene.js with <code>subscribe</code>.</li>`;
      return;
    }
    // Reverse the mapping: entity id -> model lights it drives.
    const drivenBy = new Map();
    for (const [light, entityId] of Object.entries(mapping)) {
      if (!drivenBy.has(entityId)) drivenBy.set(entityId, []);
      drivenBy.get(entityId).push(light);
    }
    for (const entityId of entities) {
      const li = document.createElement("li");
      li.className = "clickable";
      const dot = document.createElement("span");
      dot.className = "dot";
      const main = document.createElement("div");
      main.className = "row-main";
      const nameEl = document.createElement("div");
      nameEl.className = "row-name";
      nameEl.textContent = entityId;
      const sub = document.createElement("div");
      sub.className = "row-sub";
      const driven = drivenBy.get(entityId) || [];
      sub.textContent =
        driven.length > 0 ? `drives ${driven.join(", ")}` : "drives no light";
      main.appendChild(nameEl);
      main.appendChild(sub);
      // Brightness slider for lights that report a brightness: the
      // value comes from the real attribute until the slider moves.
      let sliderInput = null;
      let sliderLabel = null;
      const st = this._state(entityId);
      if (
        entityId.startsWith("light.") &&
        st &&
        typeof st.attributes?.brightness === "number"
      ) {
        const row = document.createElement("div");
        row.className = "brightness-row";
        sliderInput = document.createElement("input");
        sliderInput.type = "range";
        sliderInput.min = "0";
        sliderInput.max = "100";
        sliderInput.step = "1";
        sliderInput.setAttribute("aria-label", `Brightness ${entityId}`);
        sliderLabel = document.createElement("span");
        sliderInput.addEventListener("click", (ev) => ev.stopPropagation());
        sliderInput.addEventListener("input", () => {
          this._setBrightnessOverride(entityId, Number(sliderInput.value) / 100);
        });
        row.appendChild(sliderInput);
        row.appendChild(sliderLabel);
        main.appendChild(row);
      }
      const stateEl = document.createElement("span");
      stateEl.className = "row-state";
      li.appendChild(dot);
      li.appendChild(main);
      li.appendChild(stateEl);
      let toggleInput = null;
      if (isToggleableEntity(entityId)) {
        const toggle = this._makeToggle(entityId, `Toggle ${entityId}`);
        toggleInput = toggle.input;
        li.appendChild(toggle.label);
      }
      li.addEventListener("click", () => this._selectEntity(entityId));
      list.appendChild(li);
      this._entityRows.set(entityId, {
        dot,
        stateEl,
        toggleInput,
        sliderInput,
        sliderLabel,
      });
    }
    this._updateEntityList();
  }

  _updateEntityList() {
    if (!this._entityRows) return;
    for (const [entityId, row] of this._entityRows) {
      const state = this._emulatedState(entityId);
      const overridden =
        this._isOverridden(entityId) ||
        this._brightnessOverrides.has(entityId);
      row.stateEl.textContent = overridden ? `${state} (preview)` : state;
      row.stateEl.classList.toggle("preview", overridden);
      const active = ON_STATES.has(state);
      row.dot.style.backgroundColor = active ? "#ffb300" : "#3a3f44";
      row.dot.style.opacity = active ? "1" : "0.55";
      if (row.toggleInput) {
        row.toggleInput.checked = active;
        row.toggleInput.disabled =
          state === "unavailable" || state === "unknown";
      }
      if (row.sliderInput) {
        const brightness = this._emulatedBrightness(entityId);
        // Don't fight the user mid-drag: only move the slider when
        // the value actually changed (the input event already set
        // the override, so a re-render keeps it in place).
        if (Number(row.sliderInput.value) !== Math.round(brightness * 100)) {
          row.sliderInput.value = String(Math.round(brightness * 100));
        }
        row.sliderInput.disabled = state !== "on";
        row.sliderLabel.textContent = `${Math.round(brightness * 100)}%`;
        row.sliderLabel.classList.toggle(
          "preview",
          this._brightnessOverrides.has(entityId),
        );
      }
    }
  }

  _selectEntity(entityId) {
    const mapping = this._lightMapping();
    const driven = Object.entries(mapping)
      .filter(([, e]) => e === entityId)
      .map(([light]) => light);
    const state = this._emulatedState(entityId);
    this._els.info.textContent =
      `Entity ${entityId} — ${state}` +
      (driven.length > 0 ? ` — drives ${driven.join(", ")}` : " — drives no light") +
      (this._isOverridden(entityId) || this._brightnessOverrides.has(entityId)
        ? " (preview)"
        : "");
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
    const mapping = this._lightMapping();
    const entityId = mapping[name];
    const app = this._lightAppearance(name);
    const overridden =
      this._lightOverrides.has(name) ||
      (entityId &&
        (this._isOverridden(entityId) ||
          this._brightnessOverrides.has(entityId)));
    this._els.info.textContent = entityId
      ? `Light ${name} — ${entityId} — ${app.state}` +
        (overridden ? " (preview)" : "")
      : `Light ${name} — not mapped to a Home Assistant entity` +
        (overridden ? " (preview)" : "");
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
