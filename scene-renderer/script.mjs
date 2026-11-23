// User script (scene.js) runtime — shared by both render backends.
//
// The script is a small ESM-style module with exactly two supported exports:
//
//   export const subscribe = [...]             (optional)
//   export default function update(...) {...}  (required)
//
// It runs inside a SES Compartment (Agoric hardened JS): no process, no
// require, no fs/network, no imports at all. The compartment is created by
// the host realm (Node for the node-webgl backend, the browser page for the
// puppeteer backend) after lockdown(); this module uses the Compartment
// global SES installs, and reports a clear error when SES is not
// initialized.
//
// Compilation strategy: instead of SES module loading (which would need
// the @endo/static-module-record package and its dependency tree served to
// the browser page), the two supported export forms are transformed into
// plain declarations and the result is evaluated with
// compartment.evaluate(). Imports are refused outright, so nothing is
// lost: a script that cannot import has no use for real module loading.
//
// This module must not use any Node APIs (it is served to the browser page
// for the puppeteer backend). It does not import three.js; the scene API
// lives in scene.mjs (createSceneApi).

// ---------------------------------------------------------------------------
// Comment stripping (string-aware; comments become whitespace, newlines are
// preserved so error line numbers still match the original file).
// ---------------------------------------------------------------------------
export function stripComments(source) {
  let out = "";
  let i = 0;
  const n = source.length;
  let quote = null;
  let escaped = false;
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (quote) {
      out += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      quote = c;
      out += c;
      i += 1;
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < n && source[i] !== "\n") {
        out += " ";
        i += 1;
      }
      continue;
    }
    if (c === "/" && next === "*") {
      out += "  ";
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        out += source[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      if (i < n) {
        out += "  ";
        i += 2;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

// Blank string literals (for the static checks only, so a mention of
// "eval(" inside a string does not trip the check). Template literal
// ${} bodies are blanked too — acceptable for a UX guard; the compartment
// itself is the real enforcement.
function blankStrings(code) {
  let out = "";
  let i = 0;
  const n = code.length;
  let quote = null;
  let escaped = false;
  while (i < n) {
    const c = code[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === quote) {
        quote = null;
        out += '""';
      } else if (c === "\n") {
        out += "\n"; // keep line numbers (template literals span lines)
      }
      i += 1;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      quote = c;
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Static checks (UX guard — fail fast with a clear message. The compartment
// is the real enforcement: imports cannot resolve there, and eval/Function
// inside a compartment are SES-confined even if the check misses them).
// ---------------------------------------------------------------------------
const FORBIDDEN = [
  [/\bimport\b/, "scene.js may not import modules — everything the script needs comes from its arguments (entities, scene)"],
  [/\brequire\s*\(/, "require is not available in scene.js"],
  [/\beval\s*\(/, "eval is not allowed in scene.js"],
  [/\bFunction\s*\(/, "the Function constructor is not allowed in scene.js"],
  [/\bawait\b/, "scene.js must be synchronous — await is not allowed (update runs once per frame)"],
  [/\basync\s+function\b/, "scene.js must be synchronous — async functions are not allowed"],
  [/\basync\s*\(/, "scene.js must be synchronous — async functions are not allowed"],
];

export function checkScriptSource(source) {
  const stripped = stripComments(source);
  const blanked = blankStrings(stripped);
  // `typeof process` is a harmless probe (process is undefined in the
  // compartment anyway); only actual uses of process are rejected.
  const noTypeofProcess = blanked.replace(/\btypeof\s+process\b/g, '""');
  if (/\bprocess\b/.test(noTypeofProcess)) {
    return { ok: false, error: "process is not available in scene.js", stripped };
  }
  for (const [pattern, message] of FORBIDDEN) {
    if (pattern.test(blanked)) return { ok: false, error: message, stripped };
  }
  return { ok: true, stripped };
}

// ---------------------------------------------------------------------------
// Export transform. Supported forms (each at the start of a line):
//   export const subscribe = [...]        -> const subscribe = [...]
//   export default function update(...)   -> function update(...)
//   export default function (...)         -> const __sceneDefault = function (...)
//   export default update;                -> (removed; update is the default)
//   export default (...) => ...           -> const __sceneDefault = (...) => ...
// Anything else starting with `export` is an error, and any leftover
// `export` after the transform is an error too.
// ---------------------------------------------------------------------------
const DEFAULT_ALIAS = "__sceneRendererDefault";

export function transformScript(stripped) {
  const lines = stripped.split("\n");
  let defaultName = null;
  let defaultCount = 0;
  const out = [];

  for (const line of lines) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith("export ")) {
      out.push(line);
      continue;
    }
    const indent = line.slice(0, line.length - trimmed.length);

    let m = trimmed.match(/^export\s+const\s+subscribe\s*=/);
    if (m) {
      out.push(indent + trimmed.slice("export ".length));
      continue;
    }
    if (/^export\s+const\s+/.test(trimmed)) {
      return { ok: false, error: "scene.js may only export `subscribe` (as `export const subscribe = [...]`)" };
    }
    if (/^export\s+(let|var|class|abstract|interface|type|enum|namespace)\b/.test(trimmed)) {
      return { ok: false, error: "scene.js supports only `export const subscribe` and a default export — no other exports" };
    }
    if (/^export\s*\{/.test(trimmed) || /^export\s*\*/.test(trimmed)) {
      return { ok: false, error: "scene.js does not support `export { ... }` or `export *` — use `export const subscribe` and `export default function update`" };
    }
    if (trimmed.startsWith("export default")) {
      defaultCount += 1;
      if (defaultCount > 1) {
        return { ok: false, error: "scene.js may only have one default export" };
      }
      m = trimmed.match(/^export\s+default\s+function\s+([A-Za-z_$][\w$]*)\s*\(/);
      if (m) {
        defaultName = m[1];
        out.push(indent + trimmed.slice("export default ".length));
        continue;
      }
      if (/^export\s+default\s+function\s*\(/.test(trimmed)) {
        defaultName = DEFAULT_ALIAS;
        out.push(indent + trimmed.replace(/^export\s+default\s+/, `const ${DEFAULT_ALIAS} = `));
        continue;
      }
      m = trimmed.match(/^export\s+default\s+([A-Za-z_$][\w$]*)\s*;?\s*$/);
      if (m) {
        defaultName = m[1];
        out.push(""); // the identifier is declared elsewhere in the file
        continue;
      }
      // Arrow function or any other expression: bind it to the alias.
      // A non-function default is caught by the runtime check below.
      defaultName = DEFAULT_ALIAS;
      out.push(indent + trimmed.replace(/^export\s+default\s+/, `const ${DEFAULT_ALIAS} = `));
      continue;
    }
    return { ok: false, error: `unsupported export in scene.js: "${trimmed.slice(0, 60)}" — use \`export const subscribe\` and \`export default function update\`` };
  }

  const code = out.join("\n");
  if (/\bexport\b/.test(blankStrings(code))) {
    return { ok: false, error: "unsupported export in scene.js — use `export const subscribe` and `export default function update`" };
  }
  if (defaultName === null) {
    return { ok: false, error: "scene.js must export a default update function (`export default function update({ entities, scene }) { ... }`)" };
  }
  return { ok: true, code, defaultName };
}

// ---------------------------------------------------------------------------
// Compilation: static checks + transform + compartment.evaluate.
// Returns a handle { ok, update, subscribe, lastError, errorCount } or
// { ok: false, error }.
// ---------------------------------------------------------------------------
function formatLogArgs(args) {
  const parts = args.map((a) => {
    if (typeof a === "string") return a;
    try {
      const s = JSON.stringify(a);
      return s === undefined ? String(a) : s;
    } catch {
      return String(a);
    }
  });
  const joined = parts.join(" ");
  return joined.length > 500 ? `${joined.slice(0, 500)}…` : joined;
}

export function compileScript(source, { log = () => {} } = {}) {
  const checked = checkScriptSource(source);
  if (!checked.ok) return { ok: false, error: checked.error };
  const transformed = transformScript(checked.stripped);
  if (!transformed.ok) return { ok: false, error: transformed.error };

  const CompartmentCtor = globalThis.Compartment;
  if (typeof CompartmentCtor !== "function") {
    return { ok: false, error: "SES is not initialized in this realm (lockdown() has not run) — scene.js cannot be loaded" };
  }

  // The script gets a console that forwards to the server log (debug for
  // log, so normal script chatter does not fill the log by default).
  const consoleShim = {
    log: (...args) => log("debug", `[scene.js] ${formatLogArgs(args)}`),
    warn: (...args) => log("warning", `[scene.js] ${formatLogArgs(args)}`),
    error: (...args) => log("error", `[scene.js] ${formatLogArgs(args)}`),
  };

  let compartment;
  try {
    compartment = new CompartmentCtor({ console: consoleShim });
  } catch (err) {
    return { ok: false, error: `could not create the scene.js sandbox: ${err.message}` };
  }

  const wrapped =
    `(() => {\n${transformed.code}\n` +
    `return { update: typeof ${transformed.defaultName} === "function" ? ${transformed.defaultName} : undefined, ` +
    `subscribe: typeof subscribe !== "undefined" ? subscribe : undefined };\n})()`;

  let result;
  try {
    result = compartment.evaluate(wrapped);
  } catch (err) {
    return { ok: false, error: `scene.js failed to load: ${err.message}` };
  }
  if (typeof result.update !== "function") {
    return { ok: false, error: "scene.js default export must be a function" };
  }
  let subscribe = [];
  if (result.subscribe !== undefined) {
    if (!Array.isArray(result.subscribe) || !result.subscribe.every((s) => typeof s === "string")) {
      return { ok: false, error: "scene.js `subscribe` must be an array of entity ID, domain, or glob strings" };
    }
    subscribe = [...result.subscribe];
  }
  return {
    ok: true,
    update: result.update,
    subscribe,
    lastError: null,
    lastErrorAt: null,
    errorCount: 0,
    lastLoggedError: null,
  };
}

// ---------------------------------------------------------------------------
// Running: one call per frame. Errors are isolated (the render continues)
// and reported back; identical consecutive errors are flagged as repeats so
// the caller logs them once instead of once per frame.
// ---------------------------------------------------------------------------
export function deepFreeze(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (desc && "value" in desc) deepFreeze(desc.value, seen);
  }
  return Object.freeze(value);
}

export function runScriptCall(compiled, { entities, scene, time, loop }) {
  // The entities snapshot is shared across every frame of a clip — freeze
  // it so a script cannot corrupt later frames. The scene API object is
  // frozen too (its setters are accessors, which keep working when frozen).
  const args = Object.freeze({
    entities: deepFreeze(entities || {}),
    scene: Object.freeze(scene),
    time,
    loop,
  });
  try {
    compiled.update(args);
  } catch (err) {
    const message = err && err.message ? String(err.message) : String(err);
    compiled.errorCount += 1;
    compiled.lastError = message;
    compiled.lastErrorAt = new Date().toISOString();
    const isNew = compiled.lastLoggedError !== message;
    if (isNew) compiled.lastLoggedError = message;
    return { ok: false, error: message, newError: isNew };
  }
  // A clean run clears the sticky error (a fixed script recovers silently);
  // the count keeps the history.
  compiled.lastError = null;
  compiled.lastLoggedError = null;
  return { ok: true };
}
