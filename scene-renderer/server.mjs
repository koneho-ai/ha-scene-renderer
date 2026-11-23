// HA Scene Renderer — render service (runs in the add-on container).
//
// Plain node:http server, no framework. Endpoints:
//   GET  /            service info
//   GET  /health      status, backend, model, scene lights, cameras
//   GET  /lights      scene lights from the loaded model
//   GET  /cameras     scene cameras with their effective config
//                     (model + cameras.yaml + defaults, merged)
//   POST /render      { lights, sun, cameras, width, height }
//                     -> JSON { renders: { cameraName: base64 PNG } }
//   GET  /model.glb   the loaded model (used by the puppeteer render page)
//   GET  /render-page the puppeteer render page
//   GET  /static/*    three.js + scene.mjs for the render page
//
// Configuration (environment; set by run.sh from the add-on options):
//   PORT                default 3000
//   MODEL_PATH          default ./models/sample-apartment.glb
//   WIDTH / HEIGHT      default 1280x720 (global default render size;
//                       cameras.yaml can override per camera)
//   CAMERAS_CONFIG_PATH default /share/scene-renderer/cameras.yaml
//   RENDER_BACKEND      node-webgl (default) | puppeteer
//   LOG_LEVEL           trace|debug|info|notice|warning|error|fatal (default info)
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createCameraConfigStore } from "./camera-config.mjs";

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

// ---------------------------------------------------------------------------
// Backend + render queue (serialized, coalesced by union of cameras)
// ---------------------------------------------------------------------------
let backend = null;
let ready = false;
let renderCount = 0;
let lastRenderMs = null;
const startedAt = Date.now();

const renderQueue = [];
let renderActive = false;

function enqueueRender(args) {
  return new Promise((resolvePromise, reject) => {
    renderQueue.push({ args, resolvePromise, reject });
    pumpRenders();
  });
}

async function pumpRenders() {
  if (renderActive) return;
  if (renderQueue.length === 0) return;
  // Coalesce everything queued: render the UNION of the requested cameras
  // once, with the freshest light/sun/size from the latest request, then
  // give each waiter the subset of cameras it asked for.
  const items = renderQueue.splice(0, renderQueue.length);
  const latest = items[items.length - 1];
  const cameraSet = new Set();
  for (const item of items) {
    for (const name of item.args.cameras) cameraSet.add(name);
  }
  const merged = { ...latest.args, cameras: [...cameraSet] };
  renderActive = true;
  const t0 = Date.now();
  try {
    const renders = await backend.render(merged);
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
    log("error", `render failed: ${err.message}`);
    for (const item of items) item.reject(err);
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
        endpoints: ["GET /health", "GET /lights", "GET /cameras", "POST /render"],
      });
      return;
    }

    if (req.method === "GET" && path === "/health") {
      if (!ready) {
        sendJson(res, 503, { status: "starting", backend: CONFIG.backend });
        return;
      }
      await cameraStore.maybeReload();
      sendJson(res, 200, {
        status: "ok",
        backend: backend.name,
        version: VERSION,
        model: basename(CONFIG.modelPath),
        lights: backend.lights,
        cameras: backend.cameraNames,
        uptime_s: Math.round((Date.now() - startedAt) / 1000),
        renders: renderCount,
        last_render_ms: lastRenderMs,
      });
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
        cameras,
        width,
        height,
        fileConfig: cameraStore.get(),
      };
      try {
        const renders = await enqueueRender(args);
        const encoded = {};
        for (const [name, png] of Object.entries(renders)) {
          encoded[name] = png.toString("base64");
        }
        sendJson(res, 200, { renders: encoded });
      } catch (err) {
        sendError(res, 500, `render failed: ${err.message}`);
      }
      return;
    }

    if (req.method === "GET" && path === "/model.glb") {
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
