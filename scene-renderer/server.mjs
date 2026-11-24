// HA Scene Renderer — render service (runs in the add-on container).
//
// Plain node:http server, no framework. Endpoints:
//   GET  /            service info
//   GET  /health      status, backend, model, scene lights, cameras, script
//   GET  /lights      scene lights from the loaded model
//   GET  /cameras     scene cameras with their effective config
//                     (model + cameras.yaml + defaults, merged)
//   GET  /script      user script (scene.js) status + subscriptions
//   POST /render      { lights, sun, entities, cameras, width, height }
//                     -> JSON { renders: { cameraName:
//                     { data: base64, content_type, lights: [...] } },
//                     script: {...} }
//                     Renders are PNG stills, or animated WebP clips for
//                     cameras with a clip: entry in cameras.yaml.
//                     `lights` is the per-camera projection of the model
//                     lights into image coordinates (see scene.mjs
//                     projectLights).
//   GET  /model       the loaded model GLB bytes (for the HA sidebar
//                     panel, via the integration's proxy; alias of
//                     /model.glb)
//   GET  /render-page the puppeteer render page
//   GET  /static/*    three.js + scene.mjs + script.mjs + ses for the page
//
// Configuration (environment; set by run.sh from the add-on options):
//   PORT                default 3000
//   MODEL_PATH          default ./models/sample-apartment.glb
//   WIDTH / HEIGHT      default 1280x720 (global default render size;
//                       cameras.yaml can override per camera)
//   CAMERAS_CONFIG_PATH default /share/scene-renderer/cameras.yaml
//   SCENE_SCRIPT_PATH   default /share/scene-renderer/scene.js
//   RENDER_BACKEND      node-webgl (default) | puppeteer
//   LOG_LEVEL           trace|debug|info|notice|warning|error|fatal (default info)
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createCameraConfigStore } from "./camera-config.mjs";
import { createScriptStore } from "./script-store.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(readFileSync(join(HERE, "package.json"), "utf8")).version;

// ---------------------------------------------------------------------------
// Config + logging
// ---------------------------------------------------------------------------
const LEVELS = ["trace", "debug", "info", "notice", "warning", "error", "fatal"];
const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();
const LOG_AT = LEVELS.indexOf(LEVELS.includes(LOG_LEVEL) ? LOG_LEVEL : "info");

function log(level, message) {
  if (LEVELS.indexOf(level) < LOG_AT) return;
  const ts = new Date().toISOString();
  const line = `[${ts}] ${level.toUpperCase()} ${message}`;
  if (level === "error" || level === "fatal") console.error(line);
  else console.log(line);
}

const CONFIG = {
  port: parseInt(process.env.PORT || "3000", 10),
  modelPath: resolve(process.env.MODEL_PATH || join(HERE, "models", "sample-apartment.glb")),
  width: parseInt(process.env.WIDTH || "1280", 10),
  height: parseInt(process.env.HEIGHT || "720", 10),
  camerasFile: process.env.CAMERAS_CONFIG_PATH || "/share/scene-renderer/cameras.yaml",
  scriptFile: process.env.SCENE_SCRIPT_PATH || "/share/scene-renderer/scene.js",
  backend: (process.env.RENDER_BACKEND || "node-webgl").toLowerCase(),
};

if (!["node-webgl", "puppeteer"].includes(CONFIG.backend)) {
  log("fatal", `unknown RENDER_BACKEND "${CONFIG.backend}" (want node-webgl or puppeteer)`);
  process.exit(1);
}
if (!existsSync(CONFIG.modelPath)) {
  log("fatal", `model not found: ${CONFIG.modelPath}`);
  process.exit(1);
}

const cameraStore = createCameraConfigStore({ filePath: CONFIG.camerasFile, log });
await cameraStore.load();
cameraStore.watch();

// The script store compiles in the backend's realm (the backend owns the
// SES compartment), so the store is wired up once the backend exists —
// `compileScriptInBackend` closes over the backend variable set at
// startup. Loading happens after the backend is ready (see below).
let backend = null;
const scriptStore = createScriptStore({
  filePath: CONFIG.scriptFile,
  log,
  compile: async (source) => {
    if (!backend) return { ok: false, error: "render backend is not ready yet" };
    return backend.setScript(source);
  },
});

// ---------------------------------------------------------------------------
// Backend + render queue (serialized, coalesced by union of cameras)
// ---------------------------------------------------------------------------
let ready = false;
let renderCount = 0;
let lastRenderMs = null;
const startedAt = Date.now();

// Render generation: incremented on every /render request. A clip render
// in progress checks it between frames and aborts early when a newer
// request arrived, so a state change mid-clip does not waste the full
// render — the aborted waiters are re-queued and served by the newer
// render with the freshest state.
let renderGeneration = 0;

const renderQueue = [];
let renderActive = false;

function enqueueRender(args) {
  return new Promise((resolvePromise, reject) => {
    renderQueue.push({ args, generation: renderGeneration, resolvePromise, reject });
    pumpRenders();
  });
}

async function pumpRenders() {
  if (renderActive) return;
  if (renderQueue.length === 0) return;
  // Coalesce everything queued: render the UNION of the requested cameras
  // once, with the freshest light/sun/size/entities from the latest
  // request, then give each waiter the subset of cameras it asked for.
  const items = renderQueue.splice(0, renderQueue.length);
  const latest = items[items.length - 1];
  const cameraSet = new Set();
  for (const item of items) {
    for (const name of item.args.cameras) cameraSet.add(name);
  }
  const merged = { ...latest.args, cameras: [...cameraSet] };
  const generation = latest.generation;
  renderActive = true;
  const t0 = Date.now();
  try {
    const renders = await backend.render({
      ...merged,
      shouldAbort: () => renderGeneration !== generation,
    });
    renderCount += 1;
    lastRenderMs = Date.now() - t0;
    log("debug", `rendered ${merged.cameras.join(", ")} in ${lastRenderMs} ms`);
    for (const item of items) {
      const subset = {};
      for (const name of item.args.cameras) {
        if (renders[name]) subset[name] = renders[name];
      }
      item.resolvePromise(subset);
    }
  } catch (err) {
    if (err && err.code === "RENDER_ABORTED") {
      // A newer request arrived mid-render: re-queue these waiters so the
      // newer render serves them with fresh state. (The newer request is
      // always in the queue — the generation only advances when one
      // arrives.) Not an error; log at debug.
      log("debug", "render aborted by a newer request; re-queuing waiters");
      renderQueue.unshift(...items);
    } else {
      log("error", `render failed: ${err.message}`);
      for (const item of items) item.reject(err);
    }
  } finally {
    renderActive = false;
    if (renderQueue.length > 0) pumpRenders();
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

async function readJsonBody(req, maxBytes = 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw new Error("request body too large");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  return JSON.parse(text);
}

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".glb": "model/gltf-binary",
};

function serveFile(res, filePath) {
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    sendError(res, 404, "not found");
    return;
  }
  res.writeHead(200, {
    "content-type": MIME[extname(filePath)] || "application/octet-stream",
    "content-length": statSync(filePath).size,
    "cache-control": "no-store",
  });
  createReadStream(filePath).pipe(res);
}

function globalSize() {
  return { width: CONFIG.width, height: CONFIG.height };
}

// Script status for /health, GET /script, and the /render response: the
// file status from the store, plus the last runtime error from the backend
// (a script that compiles but throws while rendering).
async function scriptStatus() {
  const status = scriptStore.getStatus();
  let runtime = { lastError: null, errorCount: 0 };
  if (backend && typeof backend.getScriptInfo === "function") {
    try {
      runtime = await backend.getScriptInfo();
    } catch {
      // ignore — the store status is still useful on its own
    }
  }
  return {
    ...status,
    last_error: runtime.lastError || null,
    error_count: runtime.errorCount || 0,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const path = url.pathname;

    // Browsers (incl. the puppeteer render page) request a favicon; there
    // is none — answer 204 so it doesn't show up as an error in the logs.
    if (req.method === "GET" && path === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "GET" && path === "/") {
      sendJson(res, 200, {
        name: "ha-scene-renderer",
        version: VERSION,
        backend: CONFIG.backend,
        ready,
        endpoints: ["GET /health", "GET /lights", "GET /cameras", "GET /script", "GET /model", "POST /render"],
      });
      return;
    }

    if (req.method === "GET" && path === "/health") {
      if (!ready) {
        sendJson(res, 503, { status: "starting", backend: CONFIG.backend });
        return;
      }
      await cameraStore.maybeReload();
      await scriptStore.maybeReload();
      sendJson(res, 200, {
        status: "ok",
        backend: backend.name,
        version: VERSION,
        model: basename(CONFIG.modelPath),
        lights: backend.lights,
        cameras: backend.cameraNames,
        animations: backend.animations || [],
        script: await scriptStatus(),
        uptime_s: Math.round((Date.now() - startedAt) / 1000),
        renders: renderCount,
        last_render_ms: lastRenderMs,
      });
      return;
    }

    if (req.method === "GET" && path === "/script") {
      if (!ready) {
        sendError(res, 503, "render service is still starting");
        return;
      }
      await scriptStore.maybeReload();
      sendJson(res, 200, { script: await scriptStatus() });
      return;
    }

    if (req.method === "GET" && path === "/lights") {
      if (!ready) {
        sendError(res, 503, "render service is still starting");
        return;
      }
      sendJson(res, 200, { lights: backend.lights });
      return;
    }

    if (req.method === "GET" && path === "/cameras") {
      if (!ready) {
        sendError(res, 503, "render service is still starting");
        return;
      }
      await cameraStore.maybeReload();
      const cameras = await backend.listCameras(cameraStore.get(), globalSize());
      sendJson(res, 200, { cameras });
      return;
    }

    if (req.method === "POST" && path === "/render") {
      if (!ready) {
        sendError(res, 503, "render service is still starting");
        return;
      }
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendError(res, 400, `invalid request body: ${err.message}`);
        return;
      }
      await cameraStore.maybeReload();
      await scriptStore.maybeReload();
      const width = Math.min(3840, Math.max(64, parseInt(body.width, 10) || CONFIG.width));
      const height = Math.min(2160, Math.max(64, parseInt(body.height, 10) || CONFIG.height));
      // Cameras: the requested list, filtered to cameras the model offers;
      // omitted -> all cameras.
      let cameras;
      if (Array.isArray(body.cameras) && body.cameras.length > 0) {
        cameras = [];
        for (const name of body.cameras) {
          if (typeof name !== "string") continue;
          if (backend.cameraNames.includes(name)) {
            if (!cameras.includes(name)) cameras.push(name);
          } else {
            log("warning", `render requested unknown camera "${name}" — skipping it`);
          }
        }
        if (cameras.length === 0) {
          sendError(res, 400, "no known cameras requested");
          return;
        }
      } else {
        cameras = [...backend.cameraNames];
      }
      const args = {
        lights: body.lights && typeof body.lights === "object" ? body.lights : {},
        sun: body.sun && typeof body.sun === "object" ? body.sun : null,
        // Entity snapshot for the user script (subscribed entities +
        // mapped lights + sun, as sent by the integration). The script
        // sees the same snapshot on every frame of a clip.
        entities: body.entities && typeof body.entities === "object" ? body.entities : {},
        cameras,
        width,
        height,
        fileConfig: cameraStore.get(),
      };
      renderGeneration += 1;
      try {
        const renders = await enqueueRender(args);
        const encoded = {};
        for (const [name, render] of Object.entries(renders)) {
          encoded[name] = {
            data: render.data.toString("base64"),
            content_type: render.contentType,
            // Wall-clock milliseconds the render of this camera took
            // (frames + encoding for clips); the integration exposes
            // it as the image entity's render_ms attribute.
            render_ms: render.render_ms ?? null,
            // Projected light positions for this camera (see scene.mjs
            // projectLights): [{ name, x_px, y_px, x_pct, y_pct, visible }].
            lights: render.lights || [],
          };
        }
        sendJson(res, 200, { renders: encoded, script: await scriptStatus() });
      } catch (err) {
        sendError(res, 500, `render failed: ${err.message}`);
      }
      return;
    }

    if (req.method === "GET" && path === "/model.glb") {
      serveFile(res, CONFIG.modelPath);
      return;
    }

    // GET /model — the loaded model GLB bytes, for the HA sidebar panel
    // (the integration proxies this; the browser cannot reach the
    // service directly). Alias of /model.glb, which the puppeteer render
    // page uses.
    if (req.method === "GET" && path === "/model") {
      serveFile(res, CONFIG.modelPath);
      return;
    }

    if (req.method === "GET" && path === "/render-page") {
      serveFile(res, join(HERE, "render-page.html"));
      return;
    }

    if (req.method === "GET" && path.startsWith("/static/")) {
      const rel = path.slice("/static/".length);
      let file;
      if (rel === "scene.mjs") {
        file = join(HERE, "scene.mjs");
      } else if (rel === "script.mjs") {
        file = join(HERE, "script.mjs");
      } else if (rel === "ses/dist/lockdown.umd.js") {
        // The SES sandbox for the render page (classic script, sets the
        // lockdown/Compartment/harden globals). Self-contained bundle.
        file = join(HERE, "node_modules", "ses", "dist", "lockdown.umd.js");
      } else if (rel.startsWith("three/")) {
        // Only serve files from the three package, no path traversal.
        file = resolve(join(HERE, "node_modules", rel));
        if (!file.startsWith(resolve(join(HERE, "node_modules", "three")) + "/")) {
          sendError(res, 403, "forbidden");
          return;
        }
      } else {
        sendError(res, 404, "not found");
        return;
      }
      serveFile(res, file);
      return;
    }

    sendError(res, 404, "not found");
  } catch (err) {
    log("error", `request failed: ${err.message}`);
    if (!res.headersSent) sendError(res, 500, "internal error");
  }
});

// ---------------------------------------------------------------------------
// Startup: listen first (the puppeteer backend loads its page from us),
// then initialise the backend (loads the model).
// ---------------------------------------------------------------------------
server.listen(CONFIG.port, "0.0.0.0", async () => {
  log("info", `HA Scene Renderer ${VERSION} listening on port ${CONFIG.port} (backend: ${CONFIG.backend})`);
  log("info", `model: ${CONFIG.modelPath}`);
  try {
    const module = await import(`./backends/${CONFIG.backend}.mjs`);
    backend = await module.createBackend({
      modelPath: CONFIG.modelPath,
      serverUrl: `http://127.0.0.1:${CONFIG.port}`,
      log,
    });
    cameraStore.setKnownCameras(backend.cameraNames);
    // Load the user script now that the backend can compile it.
    await scriptStore.load();
    scriptStore.watch();
    ready = true;
    log("info", `ready (backend: ${backend.name}, ${backend.lights.length} scene lights, ${backend.cameraNames.length} cameras)`);
  } catch (err) {
    log("fatal", `failed to start render backend: ${err.message}`);
    process.exit(1);
  }
});

async function shutdown(signal) {
  log("info", `received ${signal}, shutting down`);
  server.close();
  cameraStore.close();
  scriptStore.close();
  if (backend && typeof backend.close === "function") {
    try {
      await backend.close();
    } catch {
      // ignore shutdown errors
    }
  }
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
