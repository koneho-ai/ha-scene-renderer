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
//     The file can also switch a camera's projection
//     (perspective|orthographic) and set its ortho_size (frustum height
//     in metres; default: fit the model's bounding sphere). When the
//     effective projection differs from the model camera's type, a fresh
//     camera of the wanted type is built at the same viewpoint for that
//     render — the model camera itself is untouched.
//   - renderCameras() renders a batch: light/sun state is applied once,
//     then each requested camera renders against the already-loaded scene.
//     Model cameras are shared objects, so overrides are applied per
//     render and restored from the base values captured at load time —
//     one camera's overrides never leak into the next camera's render.
//
// Shadows:
//   - Every model light casts (point lights: cube maps). Each light's
//     shadow map size (512/1024/2048) comes from a deterministic hash of
//     its name, so some lights cast soft shadows and others crisp ones.
//   - After the user script runs, castShadow is synced to the light's
//     effective intensity (castShadow = intensity > 0), so a light the
//     script lights on its own (the TV glow while its mapped entity is
//     off) casts shadows too.
//   - SheerCurtain meshes cast a partial, dithered shadow (~45% of the
//     sun gets through, broken up like a weave) and glow warm when the
//     sun is on their side (see updateCurtainGlow).
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { runScriptCall } from "./script.mjs";

export const BUILTIN_CAMERAS = ["overview", "topdown", "front"];

// Base tone-mapping exposure; the per-camera `exposure` config value is a
// multiplier on top of this.
export const BASE_EXPOSURE = 1.1;

const DEFAULT_CLEAR_COLOR = 0x000000;
const DEFAULT_CLEAR_ALPHA = 0;

// Point/spot shadow maps: one cube map (6 faces) per point light.
// Each light gets its map size from a deterministic hash of its name
// (512, 1024 or 2048 px), so some lights cast soft/chunky shadows and
// others crisp ones — three.js PCFSoftShadowMap ignores shadow.radius,
// so map size is the only softness lever. Deterministic per name, so a
// light's shadows look the same on every render. A 2048 cube map is
// ~100 MB (6 faces x 2048^2 x 4 B), but only lights that are ON
// allocate one, and the hash spreads the 14 sample lights 7/4/3 across
// the sizes (worst case, all on: ~426 MB). Bias: the depth bias is
// ZERO — in a perspective cube shadow camera (near 0.1, far ~26 m)
// a -0.004 NDC bias is ~0.3-0.5 m of world depth at 4-5 m from the
// light, which punches straight through a 0.10 m interior wall (the
// dining-room leak, 0.3.8). Acne is handled by the normal bias
// alone (0.02 m along the surface normal — it offsets the sample
// point, not the depth, so a thin wall still blocks). Too much
// normal bias detaches shadows from their casters (peter-panning).
// The sun keeps its own -0.0005 (proven in production; ortho camera,
// only ~1.7 cm of leak, harmless).
export const POINT_SHADOW_MAP_SIZES = [512, 1024, 2048];
const POINT_SHADOW_BIAS = 0;
const POINT_SHADOW_NORMAL_BIAS = 0.02;

// Shadow map size for one light, from a deterministic hash of its name
// (FNV-1a, 32-bit). The panel viewer mirrors this with a lighter range
// (256/512/1024); the hash itself is identical so the same light gets
// the same relative softness in both. Exported for tests.
export function shadowMapSizeForLight(name) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < name.length; i += 1) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return POINT_SHADOW_MAP_SIZES[(hash >>> 0) % POINT_SHADOW_MAP_SIZES.length];
}

// A mesh whose material is named "ShadowOnly" is invisible in the render
// but still casts shadows: the convention for a ceiling slab over a
// roofless dollhouse model, so the sun enters only through the windows
// while the top-down view stays open. (The panel viewer mirrors this;
// see scene-renderer-panel.js.)
const SHADOW_ONLY_MATERIAL = "ShadowOnly";

// Sheer curtains: a mesh whose material is named "SheerCurtain" is a
// sheer curtain. Real sheer fabric lets roughly half the sunlight
// through, broken up by the weave, and glows when the sun is behind
// it. Two conventions implement that (the panel viewer mirrors both):
//   - the mesh CASTS a partial shadow via a dithered depth material
//     (fragments are discarded from the shadow map in a 2 cm
//     world-space weave, so the sun gets through the discarded cells;
//     CURTAIN_DITHER_DISCARD is the fraction discarded — measured
//     ~45% transmission at 0.35 on the sample model, the sin-hash
//     runs ~10 points hot for these cell coordinates; PCFSoft blurs
//     the dither into a soft dimming instead of a hard window-shaped
//     patch);
//   - the mesh GLOWS (warm emissive) when the sun is on its side, with
//     intensity proportional to sun intensity x alignment (see
//     updateCurtainGlow). Each curtain mesh gets its own clone of the
//     shared material so the two windows can glow independently.
//   The curtain's own glow is the material emissive, not a light:
//   the room fill from a sunlit window comes from the bounce lights
//   below, not from a separate glow light.
const SHEER_CURTAIN_MATERIAL = "SheerCurtain";
const CURTAIN_DITHER_DISCARD = 0.35;
const CURTAIN_DITHER_CELL_M = 0.02;
const CURTAIN_GLOW_COLOR = 0xfff2dd;
const CURTAIN_GLOW_SCALE = 0.3;

// Bounce lights (emulated indirect illumination): when the sun shines
// through a window, the bright patch on the floor re-illuminates the
// room. A real bounce needs ray tracing; instead each sunlit window
// gets one soft point light placed above the patch (see
// updateBounceLights). The windows are marked by empty nodes named
// window_<room> at the window centers — a model without markers gets
// no bounce, silently. The panel viewer mirrors this.
//   - transmission: how much sun the window's treatment lets through,
//     by room (the bundled model has a fixed treatment per room;
//     unknown rooms default to a bare window, 1.0). A curtained window
//     gets a dim patch bounce (the curtain's own glow is its material
//     emissive, not a light); a bare window gets a full bounce.
//   - the bounce light never casts shadows (diffuse re-emission), has
//     a short range (~room size), and peaks at ~20% of the direct
//     sun's effect at 2 m (BOUNCE_SCALE), so the bounce lifts the
//     room without blowing it out.
//   - the patch never wanders further than one room from its window:
//     past 3 m the intensity fades out, and at 5 m it is gone (a low
//     sun used to throw the patch ~10 m across the house, where the
//     whole-house bounds clamp stacked it in the wrong room).
export const WINDOW_MARKER_PREFIX = "window_";
export const WINDOW_TRANSMISSION = {
  living_room: 0.35, // sheer curtains
  bedroom: 0.35, // sheer curtains
  dining: 0.5, // horizontal blinds, semi-open
  kids_bedroom: 0.5, // horizontal blinds, semi-open
  kitchen: 0.5, // vertical blinds, semi-open
  bathroom_1: 0.5, // vertical blinds, semi-open
  // office, bathroom_2: bare windows (default 1.0)
};
const BOUNCE_FLOOR_ALBEDO = 0.5; // warm wood floor
// 1.0 m above the patch, not 0.3 m: at 0.3 m the point light sits so
// close to the floor that it burns a hot spot into the patch (peak
// 233 in the live proof) while barely lifting the room — its light
// hits the surrounding floor at a grazing angle (measured lift only
// 8-13%, below the 15-25% target). At 1.0 m the hot spot is gone and
// the room lift lands in the target band.
const BOUNCE_HEIGHT_ABOVE_PATCH = 1.0;
const BOUNCE_SCALE = 2.0;
const BOUNCE_WARM = [1.0, 0.9, 0.75];
// A low sun throws the patch far (~10 m at 9 deg elevation) — past
// the room, into another one. The patch is clamped to within
// BOUNCE_MAX_PATCH_DISTANCE of its window (about one room), and the
// intensity fades linearly to 0 between BOUNCE_FADE_START_DISTANCE
// and the max, so there is no popping as the sun moves. High-sun
// patches sit ~1-1.5 m from the window, well inside the fade start,
// so the high-sun lift is unchanged.
const BOUNCE_MAX_PATCH_DISTANCE = 5;
const BOUNCE_FADE_START_DISTANCE = 3;

// Inject a world-space dither discard into a depth material's shaders:
// fragments in ~55% of the 2 cm cells are discarded, so the shadow is a
// broken-up partial shadow instead of a solid one. The pattern is fixed
// to the surface (world space, quantized to cells), so it is stable as
// the sun moves — like a real weave. Exported for tests.
export function injectCurtainDither(material, key) {
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
  // The program cache key must name the injection, or three.js may reuse
  // a compiled program from an un-injected depth material.
  material.customProgramCacheKey = () => key;
  return material;
}

// Shared dithered depth materials (one per shadow type — the sun uses
// the depth material, point lights the distance material). Stateless:
// the dither pattern comes from the fragment's world position, so one
// instance serves every curtain mesh. Exported for tests.
let curtainDepthMaterial = null;
let curtainDistanceMaterial = null;
export function ditheredCurtainDepthMaterial() {
  if (!curtainDepthMaterial) {
    // DoubleSide: the curtain is a double-sided plane, and the sun can
    // be on either side of it — a front-side-only depth material would
    // cast no shadow when the sun is behind the plane's front face.
    curtainDepthMaterial = injectCurtainDither(
      new THREE.MeshDepthMaterial({ side: THREE.DoubleSide }),
      "curtain-dither-depth",
    );
  }
  return curtainDepthMaterial;
}
export function ditheredCurtainDistanceMaterial() {
  if (!curtainDistanceMaterial) {
    curtainDistanceMaterial = injectCurtainDither(
      new THREE.MeshDistanceMaterial({ side: THREE.DoubleSide }),
      "curtain-dither-distance",
    );
  }
  return curtainDistanceMaterial;
}

function hasSheerCurtainMaterial(obj) {
  return materialsOf(obj).some((m) => m.name === SHEER_CURTAIN_MATERIAL);
}

function materialsOf(obj) {
  if (Array.isArray(obj.material)) return obj.material;
  return obj.material ? [obj.material] : [];
}

function hasShadowOnlyMaterial(obj) {
  return materialsOf(obj).some((m) => m.name === SHADOW_ONLY_MATERIAL);
}

// A mesh whose materials are all transparent (glass) does not block
// light: with castShadow it would throw a solid shadow, so it casts
// none. A mesh with any opaque material still casts.
function allMaterialsTransparent(obj) {
  const mats = materialsOf(obj);
  return mats.length > 0 && mats.every((m) => m.transparent);
}

// Apply the shadow/material rules to one model mesh at load: ShadowOnly
// meshes write neither color nor depth (invisible, no occlusion) but
// keep casting — the shadow pass uses its own depth material and is
// unaffected by colorWrite/depthWrite. SheerCurtain meshes cast a
// PARTIAL shadow via the dithered depth materials (see above) instead
// of the no-shadow the transparent rule would give them. Exported for
// tests.
export function applyMeshShadowRules(obj) {
  if (hasShadowOnlyMaterial(obj)) {
    for (const m of materialsOf(obj)) {
      m.colorWrite = false;
      m.depthWrite = false;
    }
    obj.castShadow = true;
    obj.receiveShadow = false;
    return;
  }
  if (hasSheerCurtainMaterial(obj)) {
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
  obj.castShadow = !allMaterialsTransparent(obj);
  obj.receiveShadow = true;
}

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
  const curtainMeshes = [];
  const windowMarkers = [];
  scene.traverse((obj) => {
    if (obj.isMesh) {
      applyMeshShadowRules(obj);
      if (hasSheerCurtainMaterial(obj)) curtainMeshes.push(obj);
    }
    // Window markers for bounce lights (see updateBounceLights):
    // empty nodes named window_<room>. Meshes/lights/cameras with a
    // window_ name are not markers.
    if (
      obj.name &&
      obj.name.startsWith(WINDOW_MARKER_PREFIX) &&
      !obj.isMesh &&
      !obj.isLight &&
      !obj.isCamera
    ) {
      windowMarkers.push(obj);
    }
    if (obj.isLight && obj.name) {
      obj.userData.baseIntensity = obj.intensity;
      obj.userData.baseColor = obj.color.clone();
      // Every model light casts shadows (point lights: cube maps, spot
      // lights: 2D maps). Shadow camera near/far are set after the
      // bounds are known, below. applyLightStates switches castShadow
      // off with the light, so off lights cost no shadow passes.
      obj.castShadow = true;
      if (obj.shadow) {
        // Per-light shadow softness: the map size comes from the light's
        // name (see shadowMapSizeForLight). Set at load time, before the
        // first render, so no map disposal is ever needed.
        const mapSize = shadowMapSizeForLight(obj.name);
        obj.shadow.mapSize.set(mapSize, mapSize);
        obj.shadow.bias = POINT_SHADOW_BIAS;
        obj.shadow.normalBias = POINT_SHADOW_NORMAL_BIAS;
      }
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

  // Sheer curtains: each mesh gets its own clone of the shared material
  // (so the two windows can glow independently) with a warm emissive
  // that updateCurtainGlow drives per frame, and its outward normal
  // (derived from the mesh, not hardcoded per room). World matrices
  // must be current for the normal derivation.
  scene.updateMatrixWorld(true);
  const curtains = curtainMeshes.map((mesh) => {
    const mats = materialsOf(mesh);
    const sheer = mats.find((m) => m.name === SHEER_CURTAIN_MATERIAL);
    let material = sheer;
    if (sheer) {
      material = sheer.clone();
      material.emissive = new THREE.Color(CURTAIN_GLOW_COLOR);
      material.emissiveIntensity = 0;
      if (Array.isArray(mesh.material)) {
        mesh.material = mesh.material.map((m) => (m === sheer ? material : m));
      } else {
        mesh.material = material;
      }
    }
    return {
      name: mesh.name,
      mesh,
      material,
      outward: curtainOutwardNormal(mesh, center),
    };
  });

  // Bounce-light windows: one renderer-owned point light per marker,
  // created once here and repositioned per frame by
  // updateBounceLights. Not part of `lights` (it is not a model light:
  // no mapping, no projection, no shadow). The outward normal is
  // derived like a curtain's (see curtainOutwardNormal): the marker's
  // local +Z through its orientation, signed away from the model
  // center — robust to the marker facing in or out. The floor plane
  // is the bottom of the model's bounds (the floor slab's underside;
  // a few centimetres low for a diffuse light 0.3 m above the patch
  // is invisible). The range is ~room size, derived from the model.
  const floorY = bounds.min.y;
  const windows = windowMarkers.map((marker) => {
    const room = marker.name.slice(WINDOW_MARKER_PREFIX.length);
    const light = new THREE.PointLight(0xffffff, 0, diag * 0.4, 2);
    light.castShadow = false;
    light.name = `bounce_${room}`;
    scene.add(light);
    return {
      name: marker.name,
      room,
      position: marker.getWorldPosition(new THREE.Vector3()),
      outward: curtainOutwardNormal(marker, center),
      transmission: WINDOW_TRANSMISSION[room] ?? 1.0,
      light,
    };
  });
  for (const light of lights.values()) {
    if (!light.shadow) continue;
    light.shadow.camera.near = 0.1;
    light.shadow.camera.far = diag * 1.5;
  }

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

  return { scene, lights, cameras, curtains, windows, floorY, bounds, center, size, diag, sun, hemi, mixer, animations, sunState: null };
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
      light.castShadow = true;
      light.intensity = light.userData.baseIntensity;
      light.color.copy(light.userData.baseColor);
      continue;
    }
    const on = p.on === true;
    const brightness = typeof p.brightness === "number" ? p.brightness : 1;
    light.visible = on;
    // An off light casts no shadow — and skipping its 6 cube faces is
    // the difference between 5 and 30 shadow passes per render.
    light.castShadow = on;
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

// Sync each light's visibility AND shadow casting to its EFFECTIVE
// intensity, after the user script has run: visible = intensity > 0,
// castShadow = intensity > 0. The built-in mapping above sets both
// from the mapped entity's on/off, but the script can raise a light's
// intensity on its own (the TV glow while light.lampy is off) —
// without this sync that light would stay invisible (three.js skips
// invisible lights entirely: no illumination, no shadow) and shine
// without casting any shadow. A script that dims a mapped-on light
// to 0 hides it and stops its shadow the same way. No exceptions:
// every lit light casts. Exported for tests.
export function syncLightVisibilityAndShadow(lights) {
  for (const light of lights.values()) {
    const lit = light.intensity > 0;
    light.visible = lit;
    light.castShadow = lit;
  }
}

// Direction from the model toward the sun (HA convention: azimuth 0
// = north, +X east, +Z south). Shared by updateCurtainGlow and
// updateBounceLights.
function sunDirection(sunState) {
  const az = (sunState.azimuth * Math.PI) / 180;
  const el = (sunState.elevation * Math.PI) / 180;
  return new THREE.Vector3(
    Math.cos(el) * Math.sin(az),
    Math.sin(el),
    -Math.cos(el) * Math.cos(az),
  );
}

// Sheer-curtain glow: a curtain glows (warm emissive) when the sun is
// on its side — backlit fabric. Intensity is proportional to sun
// intensity x alignment (dot of the sun direction and the curtain's
// outward normal); zero when the sun is on the other side or below
// the horizon. Called per frame after the user script (the script can
// move the sun). Exported for tests.
export function updateCurtainGlow(model) {
  const curtains = model.curtains || [];
  if (curtains.length === 0) return;
  const sun = model.sun;
  const sunState = model.sunState;
  if (!sun || !sunState || sunState.elevation <= 0 || sun.intensity <= 0) {
    for (const c of curtains) c.material.emissiveIntensity = 0;
    return;
  }
  const dirToSun = sunDirection(sunState);
  for (const c of curtains) {
    const alignment = Math.max(0, dirToSun.dot(c.outward));
    c.material.emissiveIntensity =
      CURTAIN_GLOW_SCALE * sun.intensity * alignment;
  }
}

// Bounce lights (emulated indirect illumination): for each window
// marker, when the sun is above the horizon and on the window's side,
// place a soft point light just above the sun patch on the floor — the
// patch re-illuminating the room. The patch is the analytic
// intersection of the sunlight ray through the window center with the
// floor plane (no scene raycast: cheap, deterministic, and the exact
// patch shape does not matter for a diffuse light). A low sun throws
// the patch far, so it is clamped to within 5 m of its window (about
// one room) and the intensity fades to 0 as the patch approaches that
// limit — without the clamp the patch crossed the house and the
// whole-house bounds clamp stacked it in the wrong room. Intensity is
// sun intensity x window transmission x floor albedo x alignment (the
// window's projected area) x BOUNCE_SCALE x the distance fade; color
// is the sun color warmed. The light is created once at load and
// repositioned per frame, intensity 0 when its window is dark. Called
// per frame after the user script (the script can move the sun), next
// to updateCurtainGlow. Exported for tests.
export function updateBounceLights(model) {
  const windows = model.windows || [];
  if (windows.length === 0) return;
  const sun = model.sun;
  const sunState = model.sunState;
  const dark =
    !sun || !sunState || sunState.elevation <= 0 || sun.intensity <= 0;
  const dirToSun = dark ? null : sunDirection(sunState);
  // The sunlight travels toward the floor along -dirToSun.
  const sunDir = dirToSun ? dirToSun.clone().negate() : null;
  const bounds = model.bounds;
  for (const w of windows) {
    if (dark) {
      w.light.intensity = 0;
      continue;
    }
    // Sun on the window's side? (alignment is also the window's
    // projected area, so it scales the intensity below.)
    const alignment = dirToSun.dot(w.outward);
    if (alignment <= 0) {
      w.light.intensity = 0;
      continue;
    }
    // Patch: window center + sun travel direction to the floor plane.
    const t = (model.floorY - w.position.y) / sunDir.y;
    if (!(t > 0)) {
      w.light.intensity = 0;
      continue;
    }
    const patch = w.position.clone().addScaledVector(sunDir, t);
    // A low sun throws the patch far — clamp it to within one room
    // of its window (the whole-house bounds clamp below used to let
    // it land in a different room entirely), and fade the intensity
    // out as the patch approaches the limit so there is no popping
    // as the sun moves.
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
    patch.y = model.floorY + BOUNCE_HEIGHT_ABOVE_PATCH;
    w.light.position.copy(patch);
    w.light.intensity =
      sun.intensity *
      w.transmission *
      BOUNCE_FLOOR_ALBEDO *
      BOUNCE_SCALE *
      alignment *
      fade;
    w.light.color
      .copy(sun.color)
      .multiply(new THREE.Color(BOUNCE_WARM[0], BOUNCE_WARM[1], BOUNCE_WARM[2]));
  }
}

// A curtain's outward normal (the side the sun hits): the curtain is a
// vertical plane facing local +Z; its world normal is that axis through
// the node's orientation, with the sign from the model center — the
// outward side points away from it (a curtain hangs in a window on an
// exterior wall). The vertical component is dropped: a tilted mesh
// still faces a compass direction. The position comes from the mesh's
// bounding-box center, NOT the node's world position: Blender bakes
// the curtain geometry in world coordinates, so the node itself sits
// at the origin and its position says nothing about where the curtain
// hangs. Empty nodes (window markers) have no geometry, so they fall
// back to the node position. Exported for tests.
export function curtainOutwardNormal(mesh, center) {
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
// { name, type, projection, ortho_size, fov, near, far, position,
//   target, width, height, background, exposure, source, clip } where
// type is the MODEL camera's type, projection is the EFFECTIVE
// projection (file override, else the model type), ortho_size is the
// orthographic frustum height in metres (null = fit the model's
// bounding sphere, or the model camera's own frustum for a native
// orthographic camera), and clip is { duration, fps, frames } or null
// (no clip key -> a still image).
export function resolveCameraConfig(info, fileEntry, defaults, log = () => {}) {
  const out = {
    name: info.name,
    type: info.type,
    projection: info.type,
    ortho_size: null,
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
  // Effective projection first: the fov check below depends on it.
  let projection = info.type;
  if (fileEntry.projection !== undefined) {
    if (fileEntry.projection !== "perspective" && fileEntry.projection !== "orthographic") {
      invalid("projection", `want "perspective" or "orthographic", got ${JSON.stringify(fileEntry.projection)}`);
      return out;
    }
    projection = fileEntry.projection;
  }
  if (fileEntry.ortho_size !== undefined) {
    if (typeof fileEntry.ortho_size !== "number" || !Number.isFinite(fileEntry.ortho_size) || fileEntry.ortho_size <= 0) {
      invalid("ortho_size", `want a number > 0 (frustum height in metres), got ${JSON.stringify(fileEntry.ortho_size)}`);
      return out;
    }
    if (projection !== "orthographic") {
      log("warning", `cameras.yaml: camera "${info.name}" is perspective — ortho_size is ignored`);
    }
  }
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
    if (projection !== "perspective") {
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
  if (fileEntry.fov !== undefined && projection === "perspective") out.fov = fileEntry.fov;
  if (fileEntry.near !== undefined) out.near = fileEntry.near;
  if (fileEntry.far !== undefined) out.far = fileEntry.far;
  if (fileEntry.position !== undefined) out.position = fileEntry.position;
  if (fileEntry.target !== undefined) out.target = fileEntry.target;
  if (fileEntry.background !== undefined) out.background = fileEntry.background;
  if (fileEntry.exposure !== undefined) out.exposure = fileEntry.exposure;
  out.projection = projection;
  if (fileEntry.ortho_size !== undefined) out.ortho_size = fileEntry.ortho_size;
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
//   -> shadow sync (castShadow follows effective intensity) -> render.
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
  // The script may have lit a light whose mapped entity is off (or
  // dimmed one to 0): sync visibility and shadow casting to the
  // effective intensity (see syncLightVisibilityAndShadow), so
  // script-lit lights shine and cast shadows.
  syncLightVisibilityAndShadow(model.lights);
  // Sheer curtains glow from the FINAL sun state (the script may have
  // moved the sun above).
  updateCurtainGlow(model);
  // Bounce lights track the sun patch per frame, same sun state.
  updateBounceLights(model);
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
// Returns { images, render_ms }: { cameraName: capture() } for every
// requested camera that exists, plus the wall-clock milliseconds each
// camera's renderFrame took (the integration exposes it as the image
// entity's render_ms attribute). Projection is not timed — it is
// metadata about the image, not the render itself.
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
  const renderMs = {};
  for (const name of cameras) {
    const info = getCameraInfo(model, name);
    if (!info) {
      log("warning", `unknown camera "${name}" — skipping it`);
      continue;
    }
    const cfg = resolveCameraConfig(info, fileConfig?.[name], { width, height }, log);
    const started = Date.now();
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
    renderMs[name] = Date.now() - started;
  }
  return { images: out, render_ms: renderMs };
}

// Restore a model camera to the base values captured at load time, so a
// previous render's overrides never leak into the next render. A fresh
// camera (built for a projection switch) has no base — nothing to
// restore, it is discarded after the render.
function resetRenderCamera(model, info, camera) {
  if (info.source !== "model") return;
  const base = camera.userData.base;
  if (!base) return;
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

// The bounding sphere's diameter: the default ortho_size (an
// orthographic camera with no ortho_size frames the whole model).
// loadModel stores the bounding-box size; its diagonal is the sphere
// diameter. Models without `size` (synthetic test models) fall back to
// twice the largest extent. Exported for tests.
export function boundingSphereDiameter(model) {
  if (model.size) return model.size.length();
  return (model.diag || 10) * 2;
}

// Frustum height for a freshly built orthographic camera: the
// configured ortho_size, else the bounding sphere (fit the model).
function freshOrthoHeight(model, cfg) {
  if (typeof cfg.ortho_size === "number" && cfg.ortho_size > 0) return cfg.ortho_size;
  return boundingSphereDiameter(model);
}

// Build a fresh camera of the wanted projection when the model camera's
// type differs (a perspective model camera rendered orthographic, or a
// native orthographic camera rendered perspective) or for a built-in
// camera rendered orthographic. The fresh camera sits at the effective
// position and aims along the model camera's forward direction (or at
// the configured target), so switching projection never moves the
// viewpoint. Fresh cameras are discarded after the render — the model
// camera is untouched and needs no reset.
function buildFreshCamera(model, info, cfg, projection) {
  const aspect = cfg.width / cfg.height;
  const modelCamera = info.source === "model" ? model.cameras.get(info.name) : null;
  let camera;
  if (projection === "orthographic") {
    const height = freshOrthoHeight(model, cfg);
    const width = height * aspect;
    camera = new THREE.OrthographicCamera(
      -width / 2, width / 2, height / 2, -height / 2, cfg.near, cfg.far,
    );
  } else {
    // A native orthographic camera carries no fov; 45° is the built-in
    // virtual cameras' default.
    camera = new THREE.PerspectiveCamera(cfg.fov ?? 45, aspect, cfg.near, cfg.far);
  }
  camera.position.set(...cfg.position);
  if (modelCamera) camera.up.copy(modelCamera.up);
  if (cfg.target !== null) {
    // A target directly above/below the camera is parallel to the up
    // vector and lookAt goes degenerate — use north-up, like the
    // built-in topdown camera does.
    const dir = new THREE.Vector3(...cfg.target).sub(camera.position).normalize();
    if (Math.abs(dir.dot(camera.up)) > 0.999) camera.up.set(0, 0, -1);
    camera.lookAt(new THREE.Vector3(...cfg.target));
  } else if (modelCamera) {
    // No target: keep the model camera's orientation (its node rotation
    // is the framing the model author chose).
    camera.quaternion.copy(modelCamera.getWorldQuaternion(new THREE.Quaternion()));
  }
  camera.updateProjectionMatrix();
  return camera;
}

// Build the camera to render with: a model camera with overrides applied
// (restored to base first), or a fresh built-in camera, or — when the
// effective projection differs from the model camera's type — a fresh
// camera of the wanted type at the same viewpoint. The matrices are
// refreshed here (see getRenderCamera): a fresh camera is not in the
// scene graph, so scene.updateMatrixWorld never reaches it, and lookAt
// refreshes matrixWorldInverse BEFORE setting the orientation — a
// camera built with a single lookAt would otherwise project with a
// stale (translation-only) inverse.
function getRenderCamera(model, info, cfg) {
  const camera = buildRenderCamera(model, info, cfg);
  camera.updateMatrixWorld();
  return camera;
}

function buildRenderCamera(model, info, cfg) {
  const aspect = cfg.width / cfg.height;
  // Configs built before 0.3.7 have no projection field; the model
  // camera's type is the default (projection: perspective|orthographic
  // in cameras.yaml overrides it).
  const projection = cfg.projection || info.type;
  if (info.source === "builtin") {
    if (projection === "orthographic") {
      return buildFreshCamera(model, info, cfg, "orthographic");
    }
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
  if (projection === "orthographic" && !camera.isOrthographicCamera) {
    return buildFreshCamera(model, info, cfg, "orthographic");
  }
  if (projection === "perspective" && !camera.isPerspectiveCamera) {
    return buildFreshCamera(model, info, cfg, "perspective");
  }
  resetRenderCamera(model, info, camera);
  if (camera.isPerspectiveCamera) {
    camera.aspect = aspect;
    if (cfg.fov !== null) camera.fov = cfg.fov;
  } else {
    // Orthographic model camera, rendered orthographic.
    if (typeof cfg.ortho_size === "number" && cfg.ortho_size > 0) {
      // Explicit frustum height (width follows the render aspect).
      const frustumHeight = cfg.ortho_size;
      const frustumWidth = frustumHeight * aspect;
      camera.left = -frustumWidth / 2;
      camera.right = frustumWidth / 2;
      camera.top = frustumHeight / 2;
      camera.bottom = -frustumHeight / 2;
    } else {
      // No ortho_size: keep the model's horizontal frustum and fit the
      // vertical one to the render aspect, so the image is not
      // stretched when the render size differs from the model's frustum.
      const base = camera.userData.base;
      const frustumWidth = base.right - base.left;
      const frustumHeight = frustumWidth / aspect;
      camera.top = frustumHeight / 2;
      camera.bottom = -frustumHeight / 2;
    }
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

