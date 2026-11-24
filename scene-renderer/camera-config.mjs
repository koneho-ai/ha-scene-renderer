// Per-camera configuration file: /share/scene-renderer/cameras.yaml
// (optional; path overridable with the CAMERAS_CONFIG_PATH env var).
//
// Keys are camera names as enumerated by GET /cameras (model cameras and
// built-in virtual cameras alike). All fields are optional:
//
//   overview:
//     width: 1280
//     height: 720
//     fov: 50              # perspective only
//     projection: orthographic  # perspective (default) | orthographic
//     ortho_size: 17       # orthographic only: frustum height in metres
//     near: 0.1
//     far: 100
//     position: [6, 8, 10]
//     target: [6, 0, 4]
//     background: "#1a1a2e"  # null = transparent (default)
//     exposure: 1.0          # tone-mapping exposure multiplier
//
// Merge precedence (see scene.mjs resolveCameraConfig): file > model >
// global defaults. This module only loads and watches the file; field
// validation lives in scene.mjs so both backends share it.
//
// The js-yaml dependency is imported lazily, only when a config file
// actually exists and needs parsing — the service starts and runs fine
// without the file (and without the dependency).
//
// Failure policy (never break rendering):
//   - file missing -> empty config (not an error)
//   - malformed YAML / non-mapping top level -> log error, keep the last
//     good config
//   - unknown camera name -> log warning, ignore that entry
//   - non-mapping entry for a camera -> log error, ignore that entry
// The file is hot-reloaded: fs.watch on its directory for prompt reloads,
// plus a modification-time check on every request that needs the config
// (covers the directory not existing at startup, and editors that replace
// the file instead of writing in place).
import { existsSync, readFileSync, statSync, watch } from "node:fs";
import { basename, dirname } from "node:path";

const RELOAD_DEBOUNCE_MS = 200;

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Lazily loaded js-yaml (only needed when a config file exists). Cached
// after the first load; a failed import is cached too so a missing
// dependency doesn't spam an error on every request.
let yamlModule = null;
let yamlFailed = false;

async function loadYaml(log) {
  if (yamlModule) return yamlModule;
  if (yamlFailed) return null;
  try {
    yamlModule = (await import("js-yaml")).default;
    return yamlModule;
  } catch (err) {
    yamlFailed = true;
    log("error", `cameras.yaml: js-yaml is not available (${err.message}) — camera config file cannot be parsed`);
    return null;
  }
}

export function createCameraConfigStore({ filePath, log }) {
  const fileName = basename(filePath);
  const dirPath = dirname(filePath);
  let config = {};
  let lastMtimeMs = 0;
  let lastExisted = false;
  let knownCameras = null; // Set<string> once the backend has loaded
  let watcher = null;
  let reloadTimer = null;

  function warnUnknownNames(cfg) {
    if (!knownCameras) return;
    for (const name of Object.keys(cfg)) {
      if (!knownCameras.has(name)) {
        log("warning", `cameras.yaml: unknown camera "${name}" — ignoring that entry`);
      }
    }
  }

  async function load() {
    let raw;
    try {
      raw = readFileSync(filePath, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") {
        if (lastExisted) log("info", "cameras.yaml removed — using defaults");
        config = {};
        lastExisted = false;
        lastMtimeMs = 0;
        return;
      }
      log("error", `cameras.yaml: cannot read ${filePath}: ${err.message} — keeping the last good config`);
      return;
    }
    // Record the mtime before parsing: a file that fails to parse must
    // not be re-read (and its error re-logged) on every request — it is
    // re-read only when it changes again. A fixed file is still picked
    // up: the watch fires on the edit, and the mtime check catches any
    // change the watch missed.
    try {
      lastMtimeMs = statSync(filePath).mtimeMs;
    } catch {
      lastMtimeMs = 0;
    }
    const yaml = await loadYaml(log);
    if (!yaml) return; // error already logged; keep the last good config
    let parsed;
    try {
      parsed = yaml.load(raw);
    } catch (err) {
      log("error", `cameras.yaml: invalid YAML (${err.message}) — keeping the last good config`);
      return;
    }
    if (parsed === undefined || parsed === null) {
      config = {};
    } else if (!isPlainObject(parsed)) {
      log("error", "cameras.yaml: top level must be a mapping of camera names — keeping the last good config");
      return;
    } else {
      const next = {};
      for (const [name, entry] of Object.entries(parsed)) {
        if (!isPlainObject(entry)) {
          log("error", `cameras.yaml: entry for camera "${name}" is not a mapping — ignoring it`);
          continue;
        }
        next[name] = entry;
      }
      config = next;
    }
    lastExisted = true;
    warnUnknownNames(config);
    const count = Object.keys(config).length;
    log("info", `cameras.yaml loaded (${count} camera ${count === 1 ? "entry" : "entries"})`);
  }

  function scheduleReload() {
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      reloadTimer = null;
      load().catch((err) => log("error", `cameras.yaml: reload failed: ${err.message}`));
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

    get() {
      return config;
    },

    // The backend calls this once the model is loaded so unknown camera
    // names in the file can be warned about.
    setKnownCameras(names) {
      knownCameras = new Set(names);
      warnUnknownNames(config);
    },

    load,

    // Reload if the file changed since the last load (mtime check). Call
    // before handling a request that needs the config.
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
        // The directory may have appeared since startup.
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
