// node-webgl backend: three.js on a real WebGL2 context in Node, no browser.
// Default backend (RENDER_BACKEND=node-webgl).
//
// Requires @onirenaud/node-webgl, which the add-on image builds for Linux
// (it compiles a small native addon on install). The import is dynamic so
// this module loads cleanly when the package is absent and the failure is
// reported as a clear startup error instead of a crash at import time.
//
// The user script (scene.js) runs in a SES Compartment in this process:
// lockdown() runs once when this module loads. If lockdown fails (or the
// ses package is missing), scripting is disabled with a clear log line and
// rendering continues without it — never break renders for scripting.
//
// Render output: a map cameraName -> { data: Buffer, contentType, lights }.
// `lights` is the per-camera projection of the model lights into image
// coordinates (see scene.mjs projectLights), computed once per camera.
// Cameras with a clip: entry in cameras.yaml render a duration×fps frame
// sequence and are encoded to animated WebP; the rest are PNG stills.
// The frame loop checks shouldAbort between frames and throws an error
// with code RENDER_ABORTED when a newer request arrived (the server
// re-queues the waiters in that case).
import { readFileSync } from "node:fs";

import { encodeClip } from "../clip-encode.mjs";
import { compileScript } from "../script.mjs";

export const BACKEND_NAME = "node-webgl";

// Lock SES down once, at module load: lockdown() installs the Compartment
// global that script.mjs compiles user scripts into. If it fails, the
// backend still renders — scripting is just unavailable.
//
// ses 2.x exports NOTHING from its ESM entry (index.js only imports the
// shims for their side effects) — `const { lockdown } = await import("ses")`
// destructures undefined and the lockdown never happens, which silently
// disabled scene.js in this backend until 0.3.5. The import installs
// lockdown/Compartment as globals; call the global.
let sesAvailable = false;
try {
  await import("ses");
  globalThis.lockdown();
  sesAvailable = true;
} catch (err) {
  console.error(`[ha-scene-renderer] SES lockdown failed (${err.message}) — scene.js scripting is disabled`);
}

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
  log("info", `model loaded: ${model.lights.size} named lights, ${cameraNames.length} cameras, ${model.animations.length} animation(s)`);

  const canvas = createCanvas(1280, 720);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = sceneLib.BASE_EXPOSURE;
  renderer.setPixelRatio(1);

  let currentSize = { width: 1280, height: 720 };
  // The compiled user script (or null). The compile result IS the handle:
  // runScriptCall tracks lastError/errorCount on it. Kept as last-good: a
  // failed compile leaves the previous script running.
  let script = null;

  function setSize(w, h) {
    if (w !== currentSize.width || h !== currentSize.height) {
      // Resizing clears the drawing buffer; we render right after,
      // so that is fine.
      canvas.width = w;
      canvas.height = h;
      currentSize = { width: w, height: h };
    }
    renderer.setSize(w, h, false);
  }

  function capture() {
    return canvas.toBuffer("image/png");
  }

  return {
    name: BACKEND_NAME,
    lights: sceneLib.listLights(model.lights),
    cameraNames,
    animations: model.animations.map((clip) => ({ name: clip.name, duration: clip.duration })),

    async listCameras(fileConfig, defaults) {
      return sceneLib.listCameras(model, fileConfig, defaults, log);
    },

    // Compile a new user script (or clear it with null). Returns
    // { ok, subscribe, error }; a failed compile keeps the last good
    // script running.
    async setScript(source) {
      if (source === null || source === undefined) {
        script = null;
        return { ok: true, subscribe: [] };
      }
      if (!sesAvailable) {
        return { ok: false, error: "SES is not available in this process — scene.js cannot be loaded" };
      }
      const result = compileScript(source, {
        log: (level, message) => log(level, message),
      });
      if (!result.ok) return result;
      script = result;
      return { ok: true, subscribe: result.subscribe };
    },

    async getScriptInfo() {
      return {
        present: script !== null,
        lastError: script ? script.lastError : null,
        errorCount: script ? script.errorCount : 0,
      };
    },

    async render({ lights, sun, entities, cameras, width, height, fileConfig, shouldAbort }) {
      const out = {};
      const defaults = { width, height };
      const frameArgs = {
        renderer,
        model,
        lights,
        sun,
        entities: entities || {},
        script,
        setSize,
        capture,
        log,
      };
      for (const name of cameras) {
        const info = sceneLib.getCameraInfo(model, name);
        if (!info) {
          log("warning", `unknown camera "${name}" — skipping it`);
          continue;
        }
        const cfg = sceneLib.resolveCameraConfig(info, fileConfig?.[name], defaults, log);
        if (!cfg.clip) {
          // Still: one frame at time 0, loop 0. render_ms is the wall
          // clock of the render itself (projection is metadata, not
          // timed); the integration exposes it as the image entity's
          // render_ms attribute.
          const started = Date.now();
          const data = sceneLib.renderFrame({ ...frameArgs, info, cfg, time: 0, loop: 0 });
          out[name] = {
            data,
            contentType: "image/png",
            render_ms: Date.now() - started,
            // Projected light positions, computed once per camera after
            // the render (not per clip frame — camera and lights are
            // static within a request).
            lights: sceneLib.projectLights(model, info, cfg),
          };
          continue;
        }
        // Clip: one frame per (duration × fps), state snapshot frozen.
        // Shadow maps render once (frame 0) and freeze for the rest of
        // the clip: with 5 point lights at 6 faces each, re-rendering
        // shadows every frame would cost 30 extra scene renders per
        // frame. Only the fan shadow would move between frames, and it
        // is barely visible. autoUpdate is restored in the finally so
        // an abort never leaves a later still with stale shadows.
        const frames = [];
        const clipStarted = Date.now();
        renderer.shadowMap.autoUpdate = true;
        renderer.shadowMap.needsUpdate = true;
        try {
          let first = true;
          for (const { time, loop } of sceneLib.clipFrameTimes(cfg.clip.duration, cfg.clip.fps)) {
            if (shouldAbort && shouldAbort()) {
              const err = new Error(`render aborted: newer state arrived while rendering the clip for "${name}"`);
              err.code = "RENDER_ABORTED";
              throw err;
            }
            frames.push(sceneLib.renderFrame({ ...frameArgs, info, cfg, time, loop }));
            if (first) {
              renderer.shadowMap.autoUpdate = false;
              first = false;
            }
          }
        } finally {
          renderer.shadowMap.autoUpdate = true;
        }
        out[name] = {
          data: await encodeClip(frames, { width: cfg.width, height: cfg.height, fps: cfg.clip.fps }),
          contentType: "image/webp",
          // Clip render_ms covers frames + WebP encoding: the whole
          // cost of producing this image.
          render_ms: Date.now() - clipStarted,
          lights: sceneLib.projectLights(model, info, cfg),
        };
      }
      return out;
    },

    async close() {
      renderer.dispose();
      if (typeof canvas.dispose === "function") canvas.dispose();
    },
  };
}
