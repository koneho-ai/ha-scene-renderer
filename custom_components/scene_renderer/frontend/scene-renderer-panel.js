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
// update on every hass set without rebuilding the scene.

import * as THREE from "./three.module.js";
import { OrbitControls } from "./OrbitControls.js";
import { GLTFLoader } from "./GLTFLoader.js";

const OFF_COLOR = 0x3a3f44; // off / unavailable / unknown: dark gray
const UNMAPPED_COLOR = 0xffffff; // model light with no HA entity
const CAMERA_COLOR = 0x29b6f6;
const SUN_COLOR = 0xffd54f;

// Mesh shadow rules (mirror scene.mjs applyMeshShadowRules — the viewer
// and the render service must treat a model identically):
// - a mesh whose material is named "ShadowOnly" is invisible in the
//   render but still casts shadows (the convention for a ceiling slab
//   over a roofless dollhouse model, so the sun enters only through
//   the windows while the top-down view stays open);
// - a mesh whose materials are all transparent (glass) casts no shadow.
const SHADOW_ONLY_MATERIAL = "ShadowOnly";

function materialsOf(obj) {
  if (Array.isArray(obj.material)) return obj.material;
  return obj.material ? [obj.material] : [];
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
  obj.castShadow = !(mats.length > 0 && mats.every((m) => m.transparent));
  obj.receiveShadow = true;
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
    this._connected = false;
    this._initStarted = false;
    this._loadState = "loading"; // loading | ready | error | no-entries
    this._entries = [];
    this._entryId = null;
    this._panelData = null; // { mapping, cameras, image_entities, sun }
    this._stateMap = new Map();

    // three.js objects (created once, model swapped per entry)
    this._renderer = null;
    this._scene = null;
    this._camera = null;
    this._controls = null;
    this._modelGroup = null;
    this._modelCenter = new THREE.Vector3();
    this._modelRadius = 10;
    this._lightMarkers = []; // { name, mesh, baseRadius }
    this._modelLights = []; // { name, light, baseIntensity, baseColor }
    this._cameraMarkers = []; // { name, group }
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
        aside {
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
            <h2>Lights</h2>
            <ul id="light-list"><li class="row-sub">Loading…</li></ul>
            <h2>Cameras</h2>
            <ul id="camera-list"><li class="row-sub">Loading…</li></ul>
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
      cameraList: this.shadowRoot.querySelector("#camera-list"),
      preview: this.shadowRoot.querySelector("#preview"),
      info: this.shadowRoot.querySelector("#info"),
    };
    this._els.retryButton.addEventListener("click", () => this._retry());
    this._els.entrySelect.addEventListener("change", (ev) => {
      this._loadEntry(ev.target.value);
    });
  }

  set hass(hass) {
    this._hass = hass;
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
    this._updateSunMarker();
    this._updateSunLight();
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
    if (this._entries.length > 1) {
      this._els.entrySelect.hidden = false;
      this._els.entrySelect.innerHTML = this._entries
        .map(
          (e) =>
            `<option value="${e.entry_id}">${e.name || e.entry_id}</option>`,
        )
        .join("");
    }
    await this._loadEntry(this._entries[0].entry_id);
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
    this._renderCameraList();
    this._updateLightMarkers();
    this._updateModelLights();
    this._updateSunMarker();
    this._updateSunLight();
    this._setState("ready", "Ready", "", false);
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

    this._camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
    this._controls = new OrbitControls(this._camera, renderer.domElement);
    this._controls.enableDamping = true;
    this._controls.dampingFactor = 0.08;

    const resize = () => {
      const w = this._els.viewer.clientWidth;
      const h = this._els.viewer.clientHeight;
      if (w === 0 || h === 0) return;
      this._renderer.setSize(w, h, false);
      this._camera.aspect = w / h;
      this._camera.updateProjectionMatrix();
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
      this._controls.update();
      this._renderer.render(this._scene, this._camera);
    };
    animate();
    return true;
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

    // Light markers: one sphere per named light in the model, at the
    // light's world position. Colors are applied by _updateLightMarkers.
    // The real three.js lights are recorded too: _updateModelLights
    // drives their intensity/color from the mapped HA entity, so the
    // viewer shows the same lighting as the rendered images instead of
    // the model's base values.
    modelScene.traverse((obj) => {
      if (obj.isCamera && obj.name) this._modelCameras.set(obj.name, obj);
      if (obj.isMesh) {
        // Model meshes cast and receive shadows (markers live in the
        // group, not the model scene, so they stay shadow-free), except
        // ShadowOnly meshes (invisible, still casting) and fully
        // transparent ones (glass casts no shadow).
        applyMeshShadowRules(obj);
      }
      if (!obj.isLight || !obj.name) return;
      // Every model light casts shadows (point lights: cube maps).
      // 512px faces keep the browser's shadow memory modest
      // (5 lights x 6 faces x 512^2); the render service uses 1024.
      obj.castShadow = true;
      if (obj.shadow) {
        obj.shadow.mapSize.set(512, 512);
        obj.shadow.camera.near = 0.1;
        obj.shadow.camera.far = radius * 3;
        obj.shadow.bias = -0.004;
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

    // Camera markers: a cone at each camera position, apex pointing at
    // its target (or along the GLB camera's orientation when the
    // effective config has no target), plus a line to the target.
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
      group.add(marker);
      this._cameraMarkers.push({ name: cam.name, group: marker });
    }

    // Sun marker: a sphere on a shell around the model, positioned from
    // sun.sun azimuth/elevation by _updateSunMarker.
    const sun = new THREE.Mesh(
      new THREE.SphereGeometry(markerRadius * 1.6, 16, 12),
      new THREE.MeshBasicMaterial({ color: SUN_COLOR }),
    );
    sun.userData = { kind: "sun", name: "sun" };
    group.add(sun);
    this._sunMarker = sun;
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
    if (!st || st.state !== "on") {
      return {
        rgb: [0x3a, 0x3f, 0x44],
        opacity: 0.55,
        scale: 1,
        brightness: 0,
        state: st ? st.state : "unknown",
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
      } else if (app.state !== "on") {
        entry.light.intensity = 0;
        // An off light casts no shadow — and skipping its 6 cube faces
        // keeps the manual shadow update cheap.
        entry.light.castShadow = false;
      } else {
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
  _effectiveSun() {
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

  /** Drive the directional sun light + hemisphere from the effective
  sun (see _effectiveSun).

  Mirrors the render service's applySun: intensity ramps 0 at the
  horizon to 3.0 at 30 degrees, color warms toward the horizon, and
  the hemisphere follows (0.06 at night, 0.15-0.6 by day, 0.5 when no
  sun state is available). Below the horizon the sun light is off. */
  _updateSunLight() {
    if (!this._sunLight || !this._hemi) return;
    const sun = this._effectiveSun();
    if (!sun) {
      this._sunLight.intensity = 0;
      this._hemi.intensity = 0.5;
      this._requestShadowUpdate();
      return;
    }
    const az = sun.azimuth;
    const el = sun.elevation;
    if (el < 0) {
      this._sunLight.intensity = 0;
      this._hemi.intensity = 0.06;
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
    this._requestShadowUpdate();
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
      sub.textContent = entityId || "not mapped";
      main.appendChild(nameEl);
      main.appendChild(sub);
      const stateEl = document.createElement("span");
      stateEl.className = "row-state";
      li.appendChild(dot);
      li.appendChild(main);
      li.appendChild(stateEl);
      // Toggle switch for mapped lights: flips the HA entity so the
      // render can be tested from here. The row click still selects
      // the light for details; the switch stops propagation so the
      // two don't fight. Only light-domain entities get a switch.
      let toggleInput = null;
      if (entityId && entityId.startsWith("light.")) {
        const label = document.createElement("label");
        label.className = "switch";
        toggleInput = document.createElement("input");
        toggleInput.type = "checkbox";
        toggleInput.setAttribute("aria-label", `Toggle ${marker.name}`);
        const slider = document.createElement("span");
        slider.className = "slider";
        label.appendChild(toggleInput);
        label.appendChild(slider);
        label.addEventListener("click", (ev) => ev.stopPropagation());
        toggleInput.addEventListener("change", () =>
          this._toggleLight(entityId),
        );
        li.appendChild(label);
      }
      li.addEventListener("click", () => this._selectLight(marker.name));
      list.appendChild(li);
      this._lightRows.set(marker.name, { dot, stateEl, toggleInput });
    }
    this._updateLightList();
  }

  async _toggleLight(entityId) {
    if (!this._hass || typeof this._hass.callService !== "function") return;
    try {
      await this._hass.callService("light", "toggle", {
        entity_id: entityId,
      });
    } catch (err) {
      // Snap the switch back: the state never changed, so the next
      // hass update alone might take a while to correct it.
      this._updateLightList();
      this._setState(
        "ready",
        `Toggle failed: ${err && err.message ? err.message : err}`,
        "",
        false,
      );
    }
  }

  _updateLightList() {
    if (!this._lightRows) return;
    for (const [name, row] of this._lightRows) {
      const app = this._lightAppearance(name);
      row.dot.style.backgroundColor = `rgb(${app.rgb[0]},${app.rgb[1]},${app.rgb[2]})`;
      row.dot.style.opacity = String(app.opacity);
      row.stateEl.textContent = app.state;
      if (row.toggleInput) {
        row.toggleInput.checked = app.state === "on";
        row.toggleInput.disabled =
          app.state === "unavailable" || app.state === "unknown";
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
      sub.textContent = `${cam.width}×${cam.height} · ${cam.source || ""}`.trim();
      main.appendChild(nameEl);
      main.appendChild(sub);
      li.appendChild(dot);
      li.appendChild(main);
      li.addEventListener("click", () => this._previewCamera(cam.name));
      list.appendChild(li);
      this._cameraRows.set(cam.name, li);
    }
  }

  _selectLight(name) {
    const mapping = (this._panelData && this._panelData.mapping) || {};
    const entityId = mapping[name];
    const app = this._lightAppearance(name);
    this._els.info.textContent = entityId
      ? `Light ${name} — ${entityId} — ${app.state}`
      : `Light ${name} — not mapped to a Home Assistant entity`;
  }

  _selectSun() {
    const sun = this._state("sun.sun");
    if (!sun || !sun.attributes) {
      this._els.info.textContent = "Sun — no sun.sun state available";
      return;
    }
    const az = sun.attributes.azimuth;
    const el = sun.attributes.elevation;
    this._els.info.textContent =
      `Sun — ${sun.state}` +
      (typeof az === "number" && typeof el === "number"
        ? ` — azimuth ${az.toFixed(1)}°, elevation ${el.toFixed(1)}°`
        : "");
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
    this._els.info.textContent = cam
      ? `Camera ${name} — ${cam.width}×${cam.height}` +
        (cam.fov ? ` — fov ${cam.fov}°` : "") +
        (entityId ? ` — ${entityId}` : " — no image entity")
      : `Camera ${name}`;
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
