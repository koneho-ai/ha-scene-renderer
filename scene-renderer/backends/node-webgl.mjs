// node-webgl backend: three.js on a real WebGL2 context in Node, no browser.
// Default backend (RENDER_BACKEND=node-webgl).
//
// Requires @onirenaud/node-webgl, which the add-on image builds for Linux
// (it compiles a small native addon on install). The import is dynamic so
// this module loads cleanly when the package is absent and the failure is
// reported as a clear startup error instead of a crash at import time.
import { readFileSync } from "node:fs";

export const BACKEND_NAME = "node-webgl";

export async function createBackend({ modelPath, log }) {
  let nodeWebgl;
  try {
    nodeWebgl = await import("@onirenaud/node-webgl");
  } catch (err) {
    throw new Error(
      "node-webgl backend selected but @onirenaud/node-webgl is not installed. " +
        "Rebuild the add-on image with RENDER_BACKEND=node-webgl, or switch the " +
        `add-on to the puppeteer backend. (${err.message})`,
    );
  }
  const { createCanvas, installDOM } = nodeWebgl;
  installDOM(); // window, document, Image, fetch() for files — three.js + loaders

  // Import three.js after the DOM shims are in place.
  const THREE = await import("three");
  const sceneLib = await import("../scene.mjs");

  const modelData = readFileSync(modelPath);
  // readFileSync returns a Buffer; GLTFLoader wants a plain ArrayBuffer.
  const arrayBuffer = modelData.buffer.slice(
    modelData.byteOffset,
    modelData.byteOffset + modelData.byteLength,
  );
  const model = await sceneLib.loadModel(arrayBuffer);
  const cameraNames = sceneLib.getCameraNames(model);
  log("info", `model loaded: ${model.lights.size} named lights, ${cameraNames.length} cameras`);

  const canvas = createCanvas(1280, 720);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = sceneLib.BASE_EXPOSURE;
  renderer.setPixelRatio(1);

  let currentSize = { width: 1280, height: 720 };

  return {
    name: BACKEND_NAME,
    lights: sceneLib.listLights(model.lights),
    cameraNames,

    async listCameras(fileConfig, defaults) {
      return sceneLib.listCameras(model, fileConfig, defaults, log);
    },

    async render({ lights, sun, cameras, width, height, fileConfig }) {
      return sceneLib.renderCameras({
        renderer,
        model,
        lights,
        sun,
        cameras,
        width,
        height,
        fileConfig: fileConfig || {},
        setSize(w, h) {
          if (w !== currentSize.width || h !== currentSize.height) {
            // Resizing clears the drawing buffer; we render right after,
            // so that is fine.
            canvas.width = w;
            canvas.height = h;
            currentSize = { width: w, height: h };
          }
          renderer.setSize(w, h, false);
        },
        capture: () => canvas.toBuffer("image/png"),
        log,
      });
    },

    async close() {
      renderer.dispose();
      if (typeof canvas.dispose === "function") canvas.dispose();
    },
  };
}
