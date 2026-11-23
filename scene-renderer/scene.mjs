// Shared three.js scene logic for HA Scene Renderer.
//
// Used by BOTH render backends:
//   - node-webgl: imported directly in Node.
//   - puppeteer: served to the browser page via /static/scene.mjs.
//
// So this module must not use any Node APIs (no fs, no process). The model
// is passed in as an ArrayBuffer.
//
// Light model (see README "Light parametrization"):
//   - The model's KHR_lights_punctual lights hold the BASE look: their
//     intensity is "full brightness" and their color is the default color.
//   - A render request carries per-light parameters from Home Assistant:
//     { on, brightness (0..1 | null), color ([r,g,b] 0..255 | null),
//       color_temp_k (int | null) }.
//   - Applied: intensity = base * brightness (0 when off);
//     color = entity color, else Kelvin -> RGB, else base color.
//   - Lights with no parameters render at base values.
//
// Camera model (see README "Cameras"):
//   - Cameras come from the model: named glTF cameras, identified by name.
//     three.js names a loaded camera from the camera *definition's* name
//     (cameras[i].name); when that is missing, loadModel() falls back to
//     the name of the node that references the camera, so models that only
//     name the node still work.
//   - If the model defines no cameras, three built-in virtual cameras
//     (overview, topdown, front) are computed from the scene bounds.
//   - Per-camera overrides come from cameras.yaml (see camera-config.mjs):
//     resolveCameraConfig() merges file > model > defaults, validating
//     each entry; an invalid entry is dropped for that camera only.
//   - renderCameras() renders a batch: light/sun state is applied once,
//     then each requested camera renders against the already-loaded scene.
//     Model cameras are shared objects, so overrides are applied per
//     render and restored from the base values captured at load time —
//     one camera's overrides never leak into the next camera's render.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { runScriptCall } from "./script.mjs";

export const BUILTIN_CAMERAS = ["overview", "topdown", "front"];

// Base tone-mapping exposure; the per-camera `exposure` config value is a
// multiplier on top of this.
export const BASE_EXPOSURE = 1.1;

const DEFAULT_CLEAR_COLOR = 0x000000;
const DEFAULT_CLEAR_ALPHA = 0;

// ---------------------------------------------------------------------------
// Kelvin -> RGB (Tanner / Charity approximation, as used by most tools).
// Input kelvin, output [r, g, b] in 0..255.
// ---------------------------------------------------------------------------
export function kelvinToRgb(kelvin) {
  const temp = Math.min(40000, Math.max(1000, kelvin)) / 100;
  let r;
  let g;
  let b;
  if (temp <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(temp) - 161.1195681661;
  } else {
    r = 329.698727446 * Math.pow(temp - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(temp - 60, -0.0755148492);
  }
  if (temp >= 66) {
    b = 255;
  } else if (temp <= 19) {
    b = 0;
  } else {
    b = 138.5177312231 * Math.log(temp - 10) - 305.0447927307;
  }
  const clamp = (v) => Math.min(255, Math.max(0, Math.round(v)));
  return [clamp(r), clamp(g), clamp(b)];
}

// ---------------------------------------------------------------------------
// Model loading
// ---------------------------------------------------------------------------
export async function loadModel(arrayBuffer) {
  const gltf = await new Promise((resolve, reject) => {
    new GLTFLoader().parse(arrayBuffer, "", resolve, reject);
  });
  const scene = gltf.scene;

  // Name fallback: three.js names a loaded camera from the camera
  // definition's name. When the definition is unnamed but the node that
  // references it is named, use the node name — that is what model
  // authors see in Blender, and what the naming convention refers to.
  // gltf.cameras is in file order (same order as json.cameras).
  if (Array.isArray(gltf.cameras)) {
    const nodes = gltf.parser?.json?.nodes || [];
    const nodeNameByCamera = new Map();
    for (const node of nodes) {
      if (node.camera !== undefined && node.name && !nodeNameByCamera.has(node.camera)) {
        nodeNameByCamera.set(node.camera, node.name);
      }
    }
    gltf.cameras.forEach((camera, index) => {
      if (!camera.name && nodeNameByCamera.has(index)) {
        camera.name = nodeNameByCamera.get(index);
      }
    });
  }

  // Shadows on everything; collect the named punctual lights with their
  // base values (captured once, so repeated renders never compound).
  const lights = new Map();
  const cameras = new Map();
  scene.traverse((obj) => {
    if (obj.isMesh) {
      obj.castShadow = true;
      obj.receiveShadow = true;
    }
    if (obj.isLight && obj.name) {
      obj.userData.baseIntensity = obj.intensity;
      obj.userData.baseColor = obj.color.clone();
      lights.set(obj.name, obj);
    }
    if (obj.isCamera && obj.name && !cameras.has(obj.name)) {
      // Capture the base transform + projection so per-render overrides
      // can be restored afterwards (see resetRenderCamera).
      obj.userData.base = {
        position: obj.position.clone(),
        quaternion: obj.quaternion.clone(),
        fov: obj.isPerspectiveCamera ? obj.fov : null,
        near: obj.near,
        far: obj.far,
        aspect: obj.isPerspectiveCamera ? obj.aspect : null,
        left: obj.isOrthographicCamera ? obj.left : null,
        right: obj.isOrthographicCamera ? obj.right : null,
        top: obj.isOrthographicCamera ? obj.top : null,
        bottom: obj.isOrthographicCamera ? obj.bottom : null,
      };
      cameras.set(obj.name, obj);
    }
  });

  const bounds = new THREE.Box3().setFromObject(scene);
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const diag = Math.max(size.x, size.y, size.z, 1);

  // Sun (directional, added by the service, not part of the model) and a
  // hemisphere fill so unlit areas never go pure black.
  const sun = new THREE.DirectionalLight(0xffffff, 0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = diag * 4;
  sun.shadow.camera.left = -diag;
  sun.shadow.camera.right = diag;
  sun.shadow.camera.top = diag;
  sun.shadow.camera.bottom = -diag;
  sun.shadow.bias = -0.0005;
  scene.add(sun);
  scene.add(sun.target);
  const hemi = new THREE.HemisphereLight(0xbfd4e6, 0x8a7a66, 0.5);
  scene.add(hemi);

  // glTF animations (e.g. a spinning fan): one mixer, all clips playing,
  // sampled per frame with mixer.setTime(t). Actions loop by default
  // (LoopRepeat), so a time past the clip's duration wraps around.
  const mixer = new THREE.AnimationMixer(scene);
  const animations = [];
  for (const clip of gltf.animations || []) {
    mixer.clipAction(clip).play();
    animations.push({ name: clip.name, duration: clip.duration });
  }

  return { scene, lights, cameras, bounds, center, size, diag, sun, hemi, mixer, animations, sunState: null };
}

export function listLights(lights) {
  const out = [];
  for (const [name, light] of lights) {
    const pos = light.getWorldPosition(new THREE.Vector3());
    const type = light.isPointLight
      ? "point"
      : light.isSpotLight
        ? "spot"
        : light.isDirectionalLight
          ? "directional"
          : "unknown";
    out.push({
      name,
      type,
      position: [+pos.x.toFixed(3), +pos.y.toFixed(3), +pos.z.toFixed(3)],
      color: `#${light.userData.baseColor.getHexString()}`,
      intensity: light.userData.baseIntensity,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Light state application
// ---------------------------------------------------------------------------
function setLightColor(light, rgb) {
  // rgb is sRGB 0..255; convert into three's linear working space.
  light.color.setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace);
}

export function applyLightStates(lights, params) {
  for (const [name, light] of lights) {
    const p = params?.[name];
    if (!p) {
      // Unmapped: render at the model's base values.
      light.visible = true;
      light.intensity = light.userData.baseIntensity;
      light.color.copy(light.userData.baseColor);
      continue;
    }
    const on = p.on === true;
    const brightness = typeof p.brightness === "number" ? p.brightness : 1;
    light.visible = on;
    light.intensity = on ? light.userData.baseIntensity * brightness : 0;
    if (Array.isArray(p.color) && p.color.length === 3) {
      setLightColor(light, p.color);
    } else if (typeof p.color_temp_k === "number") {
      setLightColor(light, kelvinToRgb(p.color_temp_k));
    } else {
      light.color.copy(light.userData.baseColor);
    }
  }
}

// ---------------------------------------------------------------------------
// Sun
// ---------------------------------------------------------------------------
// HA sun convention: azimuth 0 = north, 90 = east, 180 = south, 270 = west
// (clockwise); elevation = degrees above the horizon. The model is laid out
// with +X = east, +Z = south, so north is -Z.
function sunColorForElevation(elevation) {
  // Warm at the horizon, neutral at noon. Stops in sRGB.
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

// Position the sun light from azimuth/elevation (HA convention, see
// applySun). Shared by applySun and the script's getSun() — a script can
// move the sun the same way the built-in mapping does.
export function positionSun(model, azimuth, elevation) {
  const { sun: sunLight, center, diag } = model;
  const az = (azimuth * Math.PI) / 180;
  const el = (elevation * Math.PI) / 180;
  const dir = new THREE.Vector3(
    Math.cos(el) * Math.sin(az),
    Math.sin(el),
    -Math.cos(el) * Math.cos(az),
  );
  sunLight.position.copy(center).addScaledVector(dir, diag * 2);
  sunLight.target.position.copy(center);
  sunLight.target.updateMatrixWorld();
  model.sunState = { azimuth, elevation };
}

// Daylight intensity ramp: 0 at the horizon, full at 30 degrees.
function sunIntensityForElevation(elevation) {
  return 3.0 * Math.min(1, Math.max(0, elevation / 30));
}

export function applySun(model, sun) {
  const { sun: sunLight, hemi } = model;
  if (!sun || typeof sun.elevation !== "number" || sun.elevation <= 0) {
    // Night, or sun disabled: no direct sun; a low ambient so the interior
    // lights carry the scene.
    sunLight.intensity = 0;
    hemi.intensity = sun ? 0.06 : 0.5;
    model.sunState = sun ? { azimuth: sun.azimuth ?? 0, elevation: sun.elevation ?? 0 } : null;
    return;
  }
  positionSun(model, sun.azimuth, sun.elevation);
  const rgb = sunColorForElevation(sun.elevation);
  sunLight.color.setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace);
  // 3.0 is bright daylight with ACES.
  sunLight.intensity = sunIntensityForElevation(sun.elevation);
  hemi.intensity = 0.15 + 0.45 * Math.min(1, Math.max(0, sun.elevation / 30));
}

// ---------------------------------------------------------------------------
// Cameras
// ---------------------------------------------------------------------------

// Camera names the model offers: its named glTF cameras, or the built-in
// virtual cameras when the model defines none.
export function getCameraNames(model) {
  if (model.cameras.size > 0) return [...model.cameras.keys()];
  return [...BUILTIN_CAMERAS];
}

// Bounding-box-relative pose for a built-in virtual camera, so any model
// works. Returns plain arrays (serializable).
export function builtinCameraPose(name, model) {
  const { center, diag } = model;
  switch (name) {
    case "topdown":
      return {
        position: [center.x, center.y + diag * 1.5, center.z + 0.001],
        target: [center.x, center.y, center.z],
        up: [0, 0, -1],
      };
    case "front":
      return {
        position: [center.x, center.y + diag * 0.35, center.z + diag * 1.2],
        target: [center.x, center.y, center.z],
        up: [0, 1, 0],
      };
    case "overview":
    default:
      return {
        position: [
          center.x + diag * 0.75,
          center.y + diag * 0.85,
          center.z + diag * 0.75,
        ],
        target: [center.x, center.y, center.z],
        up: [0, 1, 0],
      };
  }
}

export function createBuiltinCamera(name, model, aspect) {
  const camera = new THREE.PerspectiveCamera(45, aspect, 0.1, 1000);
  const pose = builtinCameraPose(name, model);
  camera.position.set(...pose.position);
  camera.up.set(...pose.up);
  camera.lookAt(new THREE.Vector3(...pose.target));
  return camera;
}

function round3(v) {
  return +v.toFixed(3);
}

// Model-side camera info (before file overrides): the values a camera
// carries from the model itself. Returns null for an unknown name.
export function getCameraInfo(model, name) {
  const camera = model.cameras.get(name);
  if (camera) {
    const pos = camera.getWorldPosition(new THREE.Vector3());
    return {
      name,
      type: camera.isPerspectiveCamera ? "perspective" : "orthographic",
      fov: camera.isPerspectiveCamera ? camera.fov : null,
      near: camera.near,
      far: camera.far,
      position: [round3(pos.x), round3(pos.y), round3(pos.z)],
      // A model camera's orientation comes from its node rotation; it has
      // no look-at target unless cameras.yaml sets one.
      target: null,
      source: "model",
    };
  }
  if (model.cameras.size === 0 && BUILTIN_CAMERAS.includes(name)) {
    const pose = builtinCameraPose(name, model);
    return {
      name,
      type: "perspective",
      fov: 45,
      near: 0.1,
      far: 1000,
      position: pose.position.map(round3),
      target: pose.target.map(round3),
      source: "builtin",
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Per-camera config (cameras.yaml): merge + validation
// ---------------------------------------------------------------------------
const MAX_WIDTH = 3840;
const MAX_HEIGHT = 2160;
const MIN_SIZE = 64;

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isVec3(v) {
  return (
    Array.isArray(v) &&
    v.length === 3 &&
    v.every((n) => typeof n === "number" && Number.isFinite(n))
  );
}

function isHexColor(v) {
  return typeof v === "string" && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v);
}

// Merge precedence: cameras.yaml value > model value > global default.
// `defaults` is { width, height } (the add-on's global render size).
// An invalid file entry is dropped wholesale for that camera (logged);
// other cameras are unaffected. Returns the effective config:
// { name, type, fov, near, far, position, target, width, height,
//   background, exposure, source, clip } where clip is
// { duration, fps, frames } or null (no clip key -> a still image).
export function resolveCameraConfig(info, fileEntry, defaults, log = () => {}) {
  const out = {
    name: info.name,
    type: info.type,
    fov: info.fov,
    near: info.near,
    far: info.far,
    position: info.position,
    target: info.target,
    width: defaults.width,
    height: defaults.height,
    background: null,
    exposure: 1.0,
    source: info.source,
    clip: null,
  };
  if (fileEntry === undefined || fileEntry === null) return out;
  if (!isPlainObject(fileEntry)) {
    log("error", `cameras.yaml: entry for camera "${info.name}" is not a mapping — ignoring it`);
    return out;
  }
  const invalid = (field, why) => {
    log(
      "error",
      `cameras.yaml: camera "${info.name}": invalid ${field} (${why}) — ignoring the whole entry, using defaults`,
    );
  };
  // Validate everything first; a single bad field drops the entry.
  if (fileEntry.width !== undefined) {
    if (!Number.isInteger(fileEntry.width) || fileEntry.width < MIN_SIZE || fileEntry.width > MAX_WIDTH) {
      invalid("width", `want an integer ${MIN_SIZE}..${MAX_WIDTH}, got ${JSON.stringify(fileEntry.width)}`);
      return out;
    }
  }
  if (fileEntry.height !== undefined) {
    if (!Number.isInteger(fileEntry.height) || fileEntry.height < MIN_SIZE || fileEntry.height > MAX_HEIGHT) {
      invalid("height", `want an integer ${MIN_SIZE}..${MAX_HEIGHT}, got ${JSON.stringify(fileEntry.height)}`);
      return out;
    }
  }
  if (fileEntry.fov !== undefined) {
    if (info.type !== "perspective") {
      log("warning", `cameras.yaml: camera "${info.name}" is orthographic — fov is ignored`);
    } else if (typeof fileEntry.fov !== "number" || !Number.isFinite(fileEntry.fov) || fileEntry.fov <= 0 || fileEntry.fov >= 180) {
      invalid("fov", `want a number 0..180, got ${JSON.stringify(fileEntry.fov)}`);
      return out;
    }
  }
  if (fileEntry.near !== undefined) {
    if (typeof fileEntry.near !== "number" || !Number.isFinite(fileEntry.near) || fileEntry.near <= 0) {
      invalid("near", `want a number > 0, got ${JSON.stringify(fileEntry.near)}`);
      return out;
    }
  }
  if (fileEntry.far !== undefined) {
    if (typeof fileEntry.far !== "number" || !Number.isFinite(fileEntry.far) || fileEntry.far <= 0) {
      invalid("far", `want a number > 0, got ${JSON.stringify(fileEntry.far)}`);
      return out;
    }
  }
  const near = fileEntry.near ?? info.near;
  const far = fileEntry.far ?? info.far;
  if (near >= far) {
    invalid("near/far", `near (${near}) must be smaller than far (${far})`);
    return out;
  }
  if (fileEntry.position !== undefined && !isVec3(fileEntry.position)) {
    invalid("position", `want [x, y, z] numbers, got ${JSON.stringify(fileEntry.position)}`);
    return out;
  }
  if (fileEntry.target !== undefined && !isVec3(fileEntry.target)) {
    invalid("target", `want [x, y, z] numbers, got ${JSON.stringify(fileEntry.target)}`);
    return out;
  }
  if (fileEntry.background !== undefined && fileEntry.background !== null && !isHexColor(fileEntry.background)) {
    invalid("background", `want a hex color like "#1a1a2e" or null, got ${JSON.stringify(fileEntry.background)}`);
    return out;
  }
  if (fileEntry.exposure !== undefined) {
    if (typeof fileEntry.exposure !== "number" || !Number.isFinite(fileEntry.exposure) || fileEntry.exposure <= 0 || fileEntry.exposure > 10) {
      invalid("exposure", `want a number 0..10, got ${JSON.stringify(fileEntry.exposure)}`);
      return out;
    }
  }
  // Motion clip (opt-in): clip: { duration, fps }. Frames per loop =
  // duration x fps. The clip uses the camera's configured resolution.
  let clip = null;
  if (fileEntry.clip !== undefined && fileEntry.clip !== null) {
    if (!isPlainObject(fileEntry.clip)) {
      invalid("clip", `want a mapping {duration, fps}, got ${JSON.stringify(fileEntry.clip)}`);
      return out;
    }
    const duration = fileEntry.clip.duration ?? 3;
    const fps = fileEntry.clip.fps ?? 10;
    if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0.5 || duration > 30) {
      invalid("clip.duration", `want a number 0.5..30 (seconds), got ${JSON.stringify(fileEntry.clip.duration)}`);
      return out;
    }
    if (!Number.isInteger(fps) || fps < 1 || fps > 30) {
      invalid("clip.fps", `want an integer 1..30, got ${JSON.stringify(fileEntry.clip.fps)}`);
      return out;
    }
    const frames = Math.round(duration * fps);
    if (frames < 2 || frames > 300) {
      invalid("clip", `duration x fps = ${frames} frames, want 2..300`);
      return out;
    }
    clip = { duration, fps, frames };
  }

  if (fileEntry.width !== undefined) out.width = fileEntry.width;
  if (fileEntry.height !== undefined) out.height = fileEntry.height;
  if (fileEntry.fov !== undefined && info.type === "perspective") out.fov = fileEntry.fov;
  if (fileEntry.near !== undefined) out.near = fileEntry.near;
  if (fileEntry.far !== undefined) out.far = fileEntry.far;
  if (fileEntry.position !== undefined) out.position = fileEntry.position;
  if (fileEntry.target !== undefined) out.target = fileEntry.target;
  if (fileEntry.background !== undefined) out.background = fileEntry.background;
  if (fileEntry.exposure !== undefined) out.exposure = fileEntry.exposure;
  out.clip = clip;
  return out;
}

// Frame times for a clip: frame i at t = i/fps seconds, loop phase
// i/frames (0..1, exclusive of 1 — the loop wraps to the first frame).
export function clipFrameTimes(duration, fps) {
  const frames = Math.round(duration * fps);
  const times = [];
  for (let i = 0; i < frames; i += 1) {
    times.push({ time: i / fps, loop: i / frames });
  }
  return times;
}

// Effective config for every camera the model offers.
export function listCameras(model, fileConfig, defaults, log = () => {}) {
  return getCameraNames(model).map((name) => {
    const info = getCameraInfo(model, name);
    return resolveCameraConfig(info, fileConfig?.[name], defaults, log);
  });
}

// ---------------------------------------------------------------------------
// Scene API for user scripts (scene.js)
//
// Capability-limited helpers — the script never sees raw three.js objects.
// A fresh API object is built per frame (wrappers are cheap closures); the
// script sets absolute values, so nothing carries over between frames
// except through the scene itself. Unknown names throw a clear error (the
// script call is isolated — a throw only skips the script for that frame);
// hasLight/hasObject guard optional access.
// ---------------------------------------------------------------------------
function vec3Proxy(vec) {
  return Object.freeze({
    get x() {
      return vec.x;
    },
    set x(v) {
      vec.x = v;
    },
    get y() {
      return vec.y;
    },
    set y(v) {
      vec.y = v;
    },
    get z() {
      return vec.z;
    },
    set z(v) {
      vec.z = v;
    },
  });
}

function lightWrapper(light) {
  const wrapper = {
    name: light.name,
    get visible() {
      return light.visible;
    },
    set visible(v) {
      light.visible = !!v;
    },
    get intensity() {
      return light.intensity;
    },
    set intensity(v) {
      light.intensity = v;
    },
    // Color as sRGB [r, g, b] 0..255.
    get color() {
      const c = light.color.getRGB(new THREE.Color(), THREE.SRGBColorSpace);
      return [Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255)];
    },
    set color(rgb) {
      if (!Array.isArray(rgb) || rgb.length !== 3 || !rgb.every((n) => typeof n === "number")) {
        throw new Error(`scene.js: light color must be [r, g, b] (0..255), got ${JSON.stringify(rgb)}`);
      }
      light.color.setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace);
    },
  };
  return Object.freeze(wrapper);
}

function objectWrapper(obj) {
  const wrapper = {
    name: obj.name,
    position: vec3Proxy(obj.position),
    rotation: vec3Proxy(obj.rotation),
    scale: vec3Proxy(obj.scale),
    get visible() {
      return obj.visible;
    },
    set visible(v) {
      obj.visible = !!v;
    },
    lookAt(x, y, z) {
      obj.lookAt(x, y, z);
    },
  };
  return Object.freeze(wrapper);
}

export function createSceneApi(model) {
  const api = {
    getLight(name) {
      const light = model.lights.get(name);
      if (!light) throw new Error(`scene.js: no light named "${name}" in the model`);
      return lightWrapper(light);
    },
    getObject(name) {
      const obj = model.scene.getObjectByName(name);
      if (!obj) throw new Error(`scene.js: no object named "${name}" in the model`);
      return objectWrapper(obj);
    },
    getSun() {
      const sun = model.sun;
      const wrapper = {
        get azimuth() {
          return model.sunState ? model.sunState.azimuth : null;
        },
        set azimuth(v) {
          const el = model.sunState ? model.sunState.elevation : 30;
          positionSun(model, v, el);
        },
        get elevation() {
          return model.sunState ? model.sunState.elevation : null;
        },
        set elevation(v) {
          const az = model.sunState ? model.sunState.azimuth : 180;
          positionSun(model, az, v);
          // Moving the sun re-derives daylight intensity from the new
          // elevation (same ramp as the built-in mapping); the script
          // can still override intensity afterwards.
          sun.intensity = sunIntensityForElevation(v);
        },
        get intensity() {
          return sun.intensity;
        },
        set intensity(v) {
          sun.intensity = v;
        },
        get color() {
          const c = sun.color.getRGB(new THREE.Color(), THREE.SRGBColorSpace);
          return [Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255)];
        },
        set color(rgb) {
          if (!Array.isArray(rgb) || rgb.length !== 3 || !rgb.every((n) => typeof n === "number")) {
            throw new Error(`scene.js: sun color must be [r, g, b] (0..255), got ${JSON.stringify(rgb)}`);
          }
          sun.color.setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace);
        },
      };
      return Object.freeze(wrapper);
    },
    // Morph target weight (0..1) for a mesh in the model.
    setMorph(objectName, morphName, weight) {
      const obj = model.scene.getObjectByName(objectName);
      if (!obj) throw new Error(`scene.js: no object named "${objectName}" in the model`);
      if (!obj.isMesh || !obj.morphTargetDictionary) {
        throw new Error(`scene.js: object "${objectName}" has no morph targets`);
      }
      const index = obj.morphTargetDictionary[morphName];
      if (index === undefined) {
        throw new Error(`scene.js: object "${objectName}" has no morph target named "${morphName}"`);
      }
      obj.morphTargetInfluences[index] = Math.min(1, Math.max(0, Number(weight)));
    },
    kelvinToRgb(k) {
      return kelvinToRgb(k);
    },
    hasLight(name) {
      return model.lights.has(name);
    },
    hasObject(name) {
      return model.scene.getObjectByName(name) !== undefined;
    },
    listLights() {
      return [...model.lights.keys()];
    },
    listObjects() {
      const names = [];
      model.scene.traverse((o) => {
        if (o.name) names.push(o.name);
      });
      return names;
    },
  };
  return Object.freeze(api);
}

// ---------------------------------------------------------------------------
// Per-frame rendering
//
// One frame of one camera. The pipeline (per frame):
//   camera setup (reset to base + apply overrides) -> built-in light
//   mapping -> sun -> glTF animations sampled at `time` -> user script
//   -> render.
// The built-in mapping is re-applied before every frame, so the script
// always starts from the entity state and sets absolute values — frames
// are independent and clips loop cleanly. A still is one frame at
// time 0, loop 0; a clip is N frames at t = i/fps, loop = i/frames.
// ---------------------------------------------------------------------------
export function renderFrame({
  renderer,
  model,
  lights,
  sun,
  entities,
  info,
  cfg,
  time,
  loop,
  script,
  setSize,
  capture,
  onScriptError,
  log = () => {},
}) {
  const camera = getRenderCamera(model, info, cfg);
  applyLightStates(model.lights, lights || {});
  applySun(model, sun ?? null);
  if (model.mixer) model.mixer.setTime(time);
  if (script) {
    const result = runScriptCall(script, {
      entities: entities || {},
      scene: createSceneApi(model),
      time,
      loop,
    });
    if (!result.ok && result.newError) {
      log("error", `scene.js: ${result.error} — continuing without the script's changes for this frame`);
      if (typeof onScriptError === "function") onScriptError(result.error);
    }
  }
  setSize(cfg.width, cfg.height);
  if (cfg.background) {
    renderer.setClearColor(new THREE.Color(cfg.background), 1);
  } else {
    renderer.setClearColor(DEFAULT_CLEAR_COLOR, DEFAULT_CLEAR_ALPHA);
  }
  renderer.toneMappingExposure = BASE_EXPOSURE * cfg.exposure;
  renderer.render(model.scene, camera);
  const out = capture();
  // Reset per-frame state so nothing leaks into the next frame/camera.
  resetRenderCamera(model, info, camera);
  renderer.setClearColor(DEFAULT_CLEAR_COLOR, DEFAULT_CLEAR_ALPHA);
  renderer.toneMappingExposure = BASE_EXPOSURE;
  return out;
}

// ---------------------------------------------------------------------------
// Light projection (per-render light positions for image attributes)
// ---------------------------------------------------------------------------
// Project each model light's 3D world position through one camera into
// image coordinates: pixel x/y at the camera's configured resolution and
// the same as percentages of the image size, plus a `visible` flag (the
// light is in front of the camera and inside the frame).
//
//   [{ name, x_px, y_px, x_pct, y_pct, visible }]
//
// Coordinate contract:
// - `visible` is true only when the light is in front of the camera and
//   its projected position is inside the frame (NDC x/y/z all in
//   [-1, 1] — the z check excludes lights nearer than the near plane or
//   beyond the far plane).
// - A light in front of the camera but outside the frame still reports
//   its real projected coordinates (they fall outside 0..100%) — useful
//   for "just off-frame" indicators.
// - A light behind the camera reports null coordinates: the projection
//   of a behind-camera point is mirrored and meaningless.
// - The camera used is the same render camera getRenderCamera builds
//   (overrides applied), and it is reset afterwards, so projecting never
//   leaks state into the next render. Projection is computed once per
//   render request, not per clip frame (camera and lights are static
//   within a request); the backends call it after rendering the camera
//   so it reflects the scene as last rendered (including any
//   scene.js light moves).
// Occlusion (a light behind a wall from this camera) is NOT detected —
// that needs a raycast and is deferred by design.
export function projectLights(model, info, cfg) {
  const camera = getRenderCamera(model, info, cfg);
  // Refresh every world matrix (model cameras may sit under transformed
  // parents) so the camera's matrixWorldInverse and the lights' world
  // positions are current.
  model.scene.updateMatrixWorld(true);
  const out = [];
  for (const [name, light] of model.lights) {
    const worldPos = light.getWorldPosition(new THREE.Vector3());
    const viewPos = worldPos.clone().applyMatrix4(camera.matrixWorldInverse);
    const inFront = viewPos.z < 0;
    if (!inFront) {
      out.push({ name, x_px: null, y_px: null, x_pct: null, y_pct: null, visible: false });
      continue;
    }
    const ndc = worldPos.clone().project(camera);
    // Normalize -0 to 0 (Math.round can produce -0 at the frame edges,
    // and strict consumers distinguish the two).
    const xPx = Math.round((ndc.x * 0.5 + 0.5) * cfg.width) + 0;
    const yPx = Math.round((-ndc.y * 0.5 + 0.5) * cfg.height) + 0;
    // A small epsilon: a light exactly on the frame edge computes to
    // NDC ±1.000000000x in floating point and would otherwise flicker
    // between visible and not.
    const EPS = 1e-6;
    const visible =
      ndc.x >= -1 - EPS && ndc.x <= 1 + EPS &&
      ndc.y >= -1 - EPS && ndc.y <= 1 + EPS &&
      ndc.z >= -1 - EPS && ndc.z <= 1 + EPS;
    out.push({
      name,
      x_px: xPx,
      y_px: yPx,
      x_pct: +(((ndc.x * 0.5 + 0.5) * 100).toFixed(1)) + 0,
      y_pct: +(((-ndc.y * 0.5 + 0.5) * 100).toFixed(1)) + 0,
      visible,
    });
  }
  resetRenderCamera(model, info, camera);
  return out;
}

// Render a batch of still cameras against the already-loaded scene.
//   setSize(width, height) — resize the drawing buffer for a camera.
//   capture() — return the current frame (Buffer in Node, data URL in the
//     browser page).
// Returns { cameraName: capture() } for every requested camera that exists.
// `script` is a compiled script handle (or null); `entities` is the frozen
// entity snapshot the script reads.
export function renderCameras({
  renderer,
  model,
  lights,
  sun,
  entities,
  script,
  cameras,
  width,
  height,
  fileConfig,
  setSize,
  capture,
  onScriptError,
  log = () => {},
}) {
  const out = {};
  for (const name of cameras) {
    const info = getCameraInfo(model, name);
    if (!info) {
      log("warning", `unknown camera "${name}" — skipping it`);
      continue;
    }
    const cfg = resolveCameraConfig(info, fileConfig?.[name], { width, height }, log);
    out[name] = renderFrame({
      renderer,
      model,
      lights,
      sun,
      entities,
      info,
      cfg,
      time: 0,
      loop: 0,
      script: script || null,
      setSize,
      capture,
      onScriptError,
      log,
    });
  }
  return out;
}

// Restore a model camera to the base values captured at load time, so a
// previous render's overrides never leak into the next render.
function resetRenderCamera(model, info, camera) {
  if (info.source !== "model") return;
  const base = camera.userData.base;
  camera.position.copy(base.position);
  camera.quaternion.copy(base.quaternion);
  camera.near = base.near;
  camera.far = base.far;
  if (camera.isPerspectiveCamera) {
    camera.fov = base.fov;
    camera.aspect = base.aspect;
  } else {
    camera.left = base.left;
    camera.right = base.right;
    camera.top = base.top;
    camera.bottom = base.bottom;
  }
  camera.updateProjectionMatrix();
}

// Build the camera to render with: a model camera with overrides applied
// (restored to base first), or a fresh built-in camera.
function getRenderCamera(model, info, cfg) {
  const aspect = cfg.width / cfg.height;
  if (info.source === "builtin") {
    const camera = createBuiltinCamera(info.name, model, aspect);
    if (cfg.fov !== null) camera.fov = cfg.fov;
    camera.near = cfg.near;
    camera.far = cfg.far;
    // Fresh camera: always apply the effective pose (model-computed pose
    // or the cameras.yaml override).
    camera.position.set(...cfg.position);
    camera.lookAt(new THREE.Vector3(...cfg.target));
    camera.updateProjectionMatrix();
    return camera;
  }

  const camera = model.cameras.get(info.name);
  resetRenderCamera(model, info, camera);
  if (camera.isPerspectiveCamera) {
    camera.aspect = aspect;
    if (cfg.fov !== null) camera.fov = cfg.fov;
  } else {
    // Orthographic cameras have no aspect: keep the horizontal frustum
    // and fit the vertical one to the render aspect, so the image is not
    // stretched when the render size differs from the model's frustum.
    const base = camera.userData.base;
    const frustumWidth = base.right - base.left;
    const frustumHeight = frustumWidth / aspect;
    camera.top = frustumHeight / 2;
    camera.bottom = -frustumHeight / 2;
  }
  camera.near = cfg.near;
  camera.far = cfg.far;
  const positionOverridden =
    cfg.position[0] !== info.position[0] ||
    cfg.position[1] !== info.position[1] ||
    cfg.position[2] !== info.position[2];
  if (positionOverridden) {
    // The override is a world-space position; convert to the camera's
    // local space (its parent may have a transform).
    if (camera.parent) {
      camera.parent.updateWorldMatrix(true, false);
      camera.position.copy(camera.parent.worldToLocal(new THREE.Vector3(...cfg.position)));
    } else {
      camera.position.set(...cfg.position);
    }
  }
  if (cfg.target !== null) {
    // lookAt works in world space and accounts for the parent transform.
    camera.lookAt(new THREE.Vector3(...cfg.target));
  }
  camera.updateProjectionMatrix();
  return camera;
}

