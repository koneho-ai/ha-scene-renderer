// Puppeteer backend: three.js in headless Chromium, via the render page the
// server itself serves (/render-page). Fallback backend
// (RENDER_BACKEND=puppeteer) for when node-webgl does not hold up on a host.
//
// Requires the optional `puppeteer` dependency (installed only in the
// puppeteer image variant) and a Chromium that can run headless with the
// SwiftShader software GL.
export const BACKEND_NAME = "puppeteer";

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
  log("info", `render page ready: ${lights.length} named lights, ${cameraNames.length} cameras`);

  return {
    name: BACKEND_NAME,
    lights,
    cameraNames,

    async listCameras(fileConfig, defaults) {
      return page.evaluate(
        (args) => window.__cameras(args),
        { fileConfig: fileConfig || {}, defaults },
      );
    },

    async render({ lights: lightStates, sun, cameras, width, height, fileConfig }) {
      const dataUrls = await page.evaluate(
        (args) => window.__render(args),
        {
          lights: lightStates || {},
          sun: sun ?? null,
          cameras,
          width,
          height,
          fileConfig: fileConfig || {},
        },
      );
      const out = {};
      for (const [name, dataUrl] of Object.entries(dataUrls)) {
        out[name] = Buffer.from(dataUrl.split(",")[1], "base64");
      }
      return out;
    },

    async close() {
      await browser.close();
    },
  };
}
