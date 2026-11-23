// Verify the sample model loads in three.js GLTFLoader and list its
// contents. Run from the scene-renderer directory:
//   npm run verify-model
//   node scripts/verify_model.mjs [path/to/model.glb]
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const modelPath = resolve(process.argv[2] ?? "models/sample-apartment.glb");
const data = readFileSync(modelPath);

const gltf = await new Promise((resolvePromise, reject) => {
  new GLTFLoader().parse(data.buffer, "", resolvePromise, reject);
});

let meshes = 0;
let triangles = 0;
let badIndices = 0;
const lights = [];
const cameras = [];
const bounds = new THREE.Box3();
gltf.scene.traverse((obj) => {
  if (obj.isMesh) {
    meshes += 1;
    const geo = obj.geometry;
    triangles += (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
    // Regression check: every index must address a vertex of its own
    // POSITION attribute. Global indices with per-mesh accessor windows
    // load fine but render as garbage (giant stretched triangles).
    if (geo.index) {
      const nVerts = geo.attributes.position.count;
      for (let i = 0; i < geo.index.count; i += 1) {
        if (geo.index.getX(i) >= nVerts) badIndices += 1;
      }
    }
    bounds.expandByObject(obj);
  }
  if (obj.isLight) {
    const pos = obj.getWorldPosition(new THREE.Vector3());
    lights.push({
      name: obj.name,
      type: obj.isPointLight
        ? "point"
        : obj.isSpotLight
          ? "spot"
          : obj.isDirectionalLight
            ? "directional"
            : "unknown",
      color: `#${obj.color.getHexString()}`,
      intensity: obj.intensity,
      position: [+pos.x.toFixed(2), +pos.y.toFixed(2), +pos.z.toFixed(2)],
    });
  }
  if (obj.isCamera) {
    const pos = obj.getWorldPosition(new THREE.Vector3());
    // Where the camera looks: its local -Z axis in world space.
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(obj.getWorldQuaternion(new THREE.Quaternion()));
    cameras.push({
      name: obj.name,
      type: obj.isPerspectiveCamera ? "perspective" : "orthographic",
      fov: obj.isPerspectiveCamera ? obj.fov : null,
      near: obj.near,
      far: obj.far,
      position: [+pos.x.toFixed(2), +pos.y.toFixed(2), +pos.z.toFixed(2)],
      direction: [+dir.x.toFixed(2), +dir.y.toFixed(2), +dir.z.toFixed(2)],
    });
  }
});

console.log(`Model: ${modelPath}`);
console.log(`  meshes: ${meshes}, triangles: ${triangles}`);
console.log(
  `  bounds: x [${bounds.min.x.toFixed(2)}, ${bounds.max.x.toFixed(2)}], ` +
  `y [${bounds.min.y.toFixed(2)}, ${bounds.max.y.toFixed(2)}], ` +
  `z [${bounds.min.z.toFixed(2)}, ${bounds.max.z.toFixed(2)}]`,
);
if (badIndices > 0) {
  console.error(`ERROR: ${badIndices} indices address vertices outside their mesh's POSITION attribute — the model will render as garbage.`);
  process.exit(1);
}
console.log(`  lights (${lights.length}):`);
for (const l of lights) {
  console.log(`    - ${l.name} (${l.type}, ${l.color}, intensity ${l.intensity}, at ${l.position.join(", ")})`);
}
const unnamed = lights.filter((l) => !l.name);
if (unnamed.length > 0) {
  console.error(`ERROR: ${unnamed.length} light(s) have no name — every scene light needs a unique snake_case name.`);
  process.exit(1);
}
const names = new Set(lights.map((l) => l.name));
if (names.size !== lights.length) {
  console.error("ERROR: duplicate light names in model.");
  process.exit(1);
}
console.log(`  cameras (${cameras.length}):`);
for (const c of cameras) {
  console.log(
    `    - ${c.name} (${c.type}, fov ${c.fov}, near ${c.near}, far ${c.far}, ` +
    `at ${c.position.join(", ")}, looking ${c.direction.join(", ")})`,
  );
}
const unnamedCameras = cameras.filter((c) => !c.name);
if (unnamedCameras.length > 0) {
  console.error(`ERROR: ${unnamedCameras.length} camera(s) have no name — every scene camera needs a unique snake_case name.`);
  process.exit(1);
}
const cameraNames = new Set(cameras.map((c) => c.name));
if (cameraNames.size !== cameras.length) {
  console.error("ERROR: duplicate camera names in model.");
  process.exit(1);
}
console.log("OK: model loads, all lights and cameras named and unique.");
