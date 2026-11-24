// Puppeteer backend: three.js in headless Chromium, via the render page the
// server itself serves (/render-page). Fallback backend
// (RENDER_BACKEND=puppeteer) for when node-webgl does not hold up on a host.
//
// Requires the optional `puppeteer` dependency (installed only in the
// puppeteer image variant) and a Chromium that can run headless with the
// SwiftShader software GL.
//
// The user script (scene.js) runs in a SES Compartment inside the page
// (lockdown in render-page.html); this module only forwards source and
// status across page.evaluate.
//
// Render output: a map cameraName -> { data: Buffer, contentType, lights }.
// `lights` is the per-camera projection of the model lights into image
// coordinates (see scene.mjs projectLights), computed once per camera.
// Cameras with a clip: entry in cameras.yaml render a duration×fps frame
// sequence (one page.evaluate per frame, so the loop can abort between
// frames) and are encoded to animated WebP in this process via sharp;
// the rest are PNG stills.
import { encodeClip } from "../clip-encode.mjs";
import { clipFrameTimes } from "../scene.mjs";

export const BACKEND_NAME = "puppeteer";

function dataUrlToBuffer(dataUrl) {
  return Buffer.from(dataUrl.split(",")[1], "base64");
}

export async function createBackend({ serverUrl, log }) {
  let puppeteer;
  try {
    puppeteer = (await import("puppeteer")).default;
  } catch (err) {
    throw new Error(
      "puppeteer backend selected but puppeteer is not installed. " +
        "Rebuild the add-on image with RENDER_BACKEND=puppeteer. " +
        `(${err.message})`,
    );
  }

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
    ],
  });
  const page = await browser.newPage();
  page.on("pageerror", (err) => log("error", `render page error: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") log("error", `render page console: ${msg.text()}`);
    else if (msg.type() === "warning") log("warning", `render page console: ${msg.text()}`);
  });
  await page.goto(`${serverUrl}/render-page`, {
    waitUntil: "networkidle0",
    timeout: 60000,
  });
  await page.waitForFunction("window.__sceneReady === true", { timeout: 60000 });
  const lights = await page.evaluate(() => window.__lights());
  const cameraNames = await page.evaluate(() => window.__cameraNames());
  const animations = await page.evaluate(() => window.__animations());
  log("info", `render page ready: ${lights.length} named lights, ${cameraNames.length} cameras, ${animations.length} animation(s)`);

  return {
    name: BACKEND_NAME,
    lights,
    cameraNames,
    animations,

    async listCameras(fileConfig, defaults) {
      return page.evaluate(
        (args) => window.__cameras(args),
        { fileConfig: fileConfig || {}, defaults },
      );
    },

    async setScript(source) {
      return page.evaluate((src) => window.__setScript(src), source ?? null);
    },

    async getScriptInfo() {
      return page.evaluate(() => window.__scriptInfo());
    },

    async render({ lights: lightStates, sun, entities, cameras, width, height, fileConfig, shouldAbort }) {
      // Split stills from clips using the effective configs (which carry
      // the per-camera clip entry, or null). listCameras returns an array;
      // index it by name.
      const configList = await page.evaluate(
        (args) => window.__cameras(args),
        { fileConfig: fileConfig || {}, defaults: { width, height } },
      );
      const configs = {};
      for (const cfg of configList) configs[cfg.name] = cfg;
      const stillNames = [];
      const clipCameras = [];
      for (const name of cameras) {
        const cfg = configs[name];
        if (!cfg) {
          log("warning", `unknown camera "${name}" — skipping it`);
          continue;
        }
        if (cfg.clip) clipCameras.push({ name, cfg });
        else stillNames.push(name);
      }
      const out = {};
      if (stillNames.length > 0) {
        // __render returns { images, render_ms } (per-camera wall
        // clock, see scene.mjs renderCameras).
        const result = await page.evaluate(
          (args) => window.__render(args),
          {
            lights: lightStates || {},
            sun: sun ?? null,
            entities: entities || {},
            cameras: stillNames,
            width,
            height,
            fileConfig: fileConfig || {},
          },
        );
        for (const [name, dataUrl] of Object.entries(result.images)) {
          out[name] = {
            data: dataUrlToBuffer(dataUrl),
            contentType: "image/png",
            render_ms: result.render_ms?.[name] ?? null,
          };
        }
      }
      for (const { name, cfg } of clipCameras) {
        const frames = [];
        const clipStarted = Date.now();
        // Shadow maps render once (frame 0) and freeze for the rest of
        // the clip (see __renderFrame's freezeShadows): with 5 point
        // lights at 6 faces each, re-rendering shadows every frame
        // would cost 30 extra scene renders per frame.
        const frameTimes = clipFrameTimes(cfg.clip.duration, cfg.clip.fps);
        for (let i = 0; i < frameTimes.length; i += 1) {
          const { time, loop } = frameTimes[i];
          if (shouldAbort && shouldAbort()) {
            const err = new Error(`render aborted: newer state arrived while rendering the clip for "${name}"`);
            err.code = "RENDER_ABORTED";
            throw err;
          }
          const dataUrl = await page.evaluate(
            (args) => window.__renderFrame(args),
            {
              name,
              lights: lightStates || {},
              sun: sun ?? null,
              entities: entities || {},
              cfg,
              time,
              loop,
              freezeShadows: i > 0,
            },
          );
          frames.push(dataUrlToBuffer(dataUrl));
        }
        out[name] = {
          data: await encodeClip(frames, { width: cfg.width, height: cfg.height, fps: cfg.clip.fps }),
          contentType: "image/webp",
          // Clip render_ms covers frames + WebP encoding: the whole
          // cost of producing this image.
          render_ms: Date.now() - clipStarted,
        };
      }
      // Projected light positions, once per rendered camera (not per clip
      // frame — camera and lights are static within a request).
      for (const name of Object.keys(out)) {
        out[name].lights = await page.evaluate(
          (args) => window.__projectLights(args),
          { name, cfg: configs[name] },
        );
      }
      return out;
    },

    async close() {
      await browser.close();
    },
  };
}
