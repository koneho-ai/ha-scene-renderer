// User script file: /share/scene-renderer/scene.js (optional; path
// overridable with the SCENE_SCRIPT_PATH env var).
//
// The script is a small ESM-style module (see script.mjs): it must export
// a default update function and may declare `export const subscribe`,
// `export const objectDrivers`, and `export const lightMapping`. This
// module only loads and watches the file; compilation happens in the
// render backend's realm (Node for node-webgl, the browser page for
// puppeteer) via the injected `compile` function, which returns
// { ok, subscribe, objectDrivers, lightMapping, error }.
//
// Failure policy (never break rendering):
//   - file missing -> no script (v1 behavior), not an error
//   - file fails to compile -> log error, keep the last good compiled
//     script running, report the error in the status (surfaced via
//     /health and GET /script)
//   - file removed -> the script is cleared (back to v1 behavior)
// The file is hot-reloaded: fs.watch on its directory for prompt reloads,
// plus a modification-time check on every request that needs the status
// (covers the directory not existing at startup, and editors that replace
// the file instead of writing in place).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, watch } from "node:fs";
import { basename, dirname } from "node:path";

const RELOAD_DEBOUNCE_MS = 200;

export function createScriptStore({ filePath, log, compile }) {
  const fileName = basename(filePath);
  const dirPath = dirname(filePath);
  // Status: { present, hash, subscribe, object_drivers, light_mapping,
  // status, error }. status: 'none' (no file) | 'ok' (compiled) |
  // 'error' (last compile failed). object_drivers maps model object
  // names to their driving entity ({ ceiling_fan: "light.wizcolor1" })
  // — from the script's `export const objectDrivers`; the panel shows
  // those objects. light_mapping maps model light names to their
  // driving entity ({ living_room_1: "light.living_room" }) — from the
  // script's `export const lightMapping`; it is THE light→entity
  // mapping (the YAML `lights` block is deprecated), and the panel
  // shows it in the Lights section.
  let status = { present: false, hash: null, subscribe: [], object_drivers: {}, light_mapping: {}, status: "none", error: null };
  let lastHash = null;
  let lastMtimeMs = 0;
  let lastExisted = false;
  let watcher = null;
  let reloadTimer = null;
  let loadPromise = null;

  async function load() {
    // Serialize loads: a watch event and a request-time maybeReload can
    // overlap; compiling twice is harmless but wasteful.
    if (loadPromise) return loadPromise;
    loadPromise = doLoad().finally(() => {
      loadPromise = null;
    });
    return loadPromise;
  }

  async function doLoad() {
    let raw;
    try {
      raw = readFileSync(filePath, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") {
        if (lastExisted) {
          log("info", "scene.js removed — rendering without a script");
          try {
            await compile(null);
          } catch (compileErr) {
            log("error", `scene.js: failed to clear the script: ${compileErr.message}`);
          }
        }
        status = { present: false, hash: null, subscribe: [], object_drivers: {}, light_mapping: {}, status: "none", error: null };
        lastHash = null;
        lastExisted = false;
        lastMtimeMs = 0;
        return;
      }
      log("error", `scene.js: cannot read ${filePath}: ${err.message} — keeping the last good script`);
      return;
    }
    try {
      lastMtimeMs = statSync(filePath).mtimeMs;
    } catch {
      lastMtimeMs = 0;
    }
    const hash = createHash("sha256").update(raw).digest("hex").slice(0, 12);
    if (hash === lastHash && lastExisted) return; // unchanged
    let result;
    try {
      result = await compile(raw);
    } catch (err) {
      result = { ok: false, error: err.message };
    }
    lastHash = hash;
    lastExisted = true;
    if (result.ok) {
      status = {
        present: true,
        hash,
        subscribe: Array.isArray(result.subscribe) ? [...result.subscribe] : [],
        object_drivers:
          result.objectDrivers && typeof result.objectDrivers === "object"
            ? { ...result.objectDrivers }
            : {},
        light_mapping:
          result.lightMapping && typeof result.lightMapping === "object"
            ? { ...result.lightMapping }
            : {},
        status: "ok",
        error: null,
      };
      log("info", `scene.js loaded (${hash}, ${status.subscribe.length} subscription(s))`);
    } else {
      // Keep the last good script running; only the status reports the
      // failure (the integration re-fetches subscriptions on hash change,
      // and the hash only changes on a successful compile — a broken edit
      // must not flip the integration to an empty subscription set).
      status = { ...status, present: true, status: "error", error: result.error || "unknown compile error" };
      log("error", `scene.js: ${status.error} — keeping the last good script`);
    }
  }

  function scheduleReload() {
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      reloadTimer = null;
      load().catch((err) => log("error", `scene.js: reload failed: ${err.message}`));
    }, RELOAD_DEBOUNCE_MS);
  }

  function startWatch() {
    if (watcher || !existsSync(dirPath)) return false;
    try {
      watcher = watch(dirPath, (eventType, changedName) => {
        if (changedName === fileName) scheduleReload();
      });
      watcher.on("error", () => {
        watcher = null;
      });
      return true;
    } catch {
      watcher = null;
      return false;
    }
  }

  return {
    filePath,

    getStatus() {
      return {
        ...status,
        subscribe: [...status.subscribe],
        object_drivers: { ...status.object_drivers },
        light_mapping: { ...status.light_mapping },
      };
    },

    load,

    // Reload if the file changed since the last load (mtime check). Call
    // before handling a request that needs the status.
    async maybeReload() {
      let mtimeMs = 0;
      let existed = false;
      try {
        const st = statSync(filePath);
        mtimeMs = st.mtimeMs;
        existed = true;
      } catch {
        existed = false;
      }
      if (existed !== lastExisted || (existed && mtimeMs !== lastMtimeMs)) {
        await load();
      } else if (!watcher) {
        startWatch();
      }
    },

    watch() {
      startWatch();
    },

    close() {
      if (reloadTimer) clearTimeout(reloadTimer);
      if (watcher) watcher.close();
      watcher = null;
    },
  };
}
