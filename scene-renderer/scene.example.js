// Example scene.js for the HA Scene Renderer — copy to
// /share/scene-renderer/scene.js (or the path in SCENE_SCRIPT_PATH) and
// edit to taste. The file is hot-reloaded: save it and the next render
// uses the new script. This example drives the sample model's living
// room TV from the Samsung TV's Plex client, its ceiling fan from a
// light (for testing), and the sheer curtains' glow lights from the
// sun.
//
// The script is a small ESM-style module:
//   - export a default function update({ entities, scene, time, loop })
//   - optionally export `const subscribe = [...]` listing the entities
//     the script reads (entity IDs, domains like "light.*", or globs
//     like "sensor.*_temperature"). The integration sends only those
//     entities (plus the mapped lights and sun.sun) and re-renders when
//     one of them changes. No subscribe list -> the script only sees
//     the mapped lights and sun.sun.
//   - optionally export `const objectDrivers = {...}` mapping model
//     object names to the entity that drives each one
//     ({ ceiling_fan: "light.wizcolor1" }). The sidebar panel shows
//     those objects with their driving entity and a toggle.
//
// Contract (important for clips):
//   - The service re-applies the built-in light/sun mapping before every
//     frame, then runs this script — so set ABSOLUTE values here, never
//     increment (there is deliberately no dt parameter).
//   - `time` is seconds since the start of the clip; `loop` is 0..1
//     across one loop of the clip. Both are OPTIONAL — destructure only
//     what you use; a script that only maps entities never mentions them.
//   - A clip loops seamlessly when every animated value is periodic over
//     the loop (same value at loop 0 and loop 1).
//   - The script runs sandboxed (SES Compartment): no process, no
//     require, no network, no imports, no eval. console.log/warn/error
//     go to the add-on log (prefixed [scene.js]).
//   - A throwing script never breaks the render: the frame renders
//     without the script's changes and the error shows in /health.

// The TV's glow follows the Plex client on the Samsung TV: when Plex is
// playing, paused, or idle, the TV is on; when the client is
// unavailable, the TV is off. (Limitation: if the TV is on but Plex is
// not running — e.g. watching another app — the client is unavailable
// and the glow stays off. Swap in a better "TV is on" entity if you
// have one, e.g. a smart plug or the TV integration's media player.)
const TV_ENTITY = "media_player.plex_plex_for_samsung_tv_2023";
const TV_LIGHT = "living_room_tv"; // point light in front of the TV screen
const TV_SCREEN = "tv_screen"; // the screen mesh (bright emissive material)

// The ceiling fan spins when this light is on — just for testing that
// a script can drive an object from any entity. Any light works here.
const FAN_ENTITY = "light.wizcolor1";
const FAN_OBJECT = "ceiling_fan"; // group node: hub + 4 blades

// Curtain glow lights: the sheer curtains re-emit the sunlight that
// hits them as a soft diffuse glow just inside the window. The model
// has one point light just inside each curtained window (base
// intensity 0 — the renderer treats curtain_glow_* lights as
// non-shadow-casting by name, since they are diffuse re-emission, not
// point sources). Each light's window faces a compass direction (the
// living room window faces north, the bedroom's south); the glow
// follows the sun's alignment with that side: full when the sun is
// square on the window, zero when it is behind the house or below the
// horizon. Guarded with hasLight, so models without the glow lights
// run clean.
const CURTAIN_GLOW_LIGHTS = [
  { light: "curtain_glow_living_room", windowAzimuth: 0 }, // north
  { light: "curtain_glow_bedroom", windowAzimuth: 180 }, // south
];
const CURTAIN_GLOW_MAX = 10;
const CURTAIN_GLOW_COLOR = [255, 240, 214]; // warm white

export const subscribe = [TV_ENTITY, FAN_ENTITY];

// Which entity drives which model object. The sidebar panel shows these
// objects with their driving entity and a toggle — the flat subscribe
// list above cannot say that the fan belongs to the light and the
// screen belongs to the media player, so this mapping says it
// explicitly. Keys are model object names (any named node, not just
// meshes); values are exact entity IDs, not patterns. An object the
// model does not have is skipped by the panel, so the same file works
// against any model.
export const objectDrivers = {
  [FAN_OBJECT]: FAN_ENTITY,
  [TV_SCREEN]: TV_ENTITY,
};

// Hue (0..1) -> sRGB [r, g, b] 0..255 at full saturation, lightness 0.6.
function hueToRgb(h) {
  const x = ((h % 1) + 1) % 1;
  const c = 0.8;
  const m = 0.2;
  const sector = x * 6;
  const f = sector - Math.floor(sector);
  const v = (n) => Math.round(255 * (m + c * n));
  if (sector < 1) return [v(1), v(f), v(0)];
  if (sector < 2) return [v(1 - f), v(1), v(0)];
  if (sector < 3) return [v(0), v(1), v(f)];
  if (sector < 4) return [v(0), v(1 - f), v(1)];
  if (sector < 5) return [v(f), v(0), v(1)];
  return [v(1), v(0), v(1 - f)];
}

export default function update({ entities, scene, time = 0, loop = 0 }) {
  // The TV and the fan are only in models that have them — a script
  // that throws on every frame is worse than a script that does
  // nothing, so each block bails out quietly when its model parts are
  // missing (and neither block returns early from the other).
  if (scene.hasLight(TV_LIGHT) && scene.hasObject(TV_SCREEN)) {
    const tv = entities[TV_ENTITY];
    const on = !!tv && (tv.state === "playing" || tv.state === "paused" || tv.state === "idle");
    const light = scene.getLight(TV_LIGHT);
    const screen = scene.getObject(TV_SCREEN);

    if (!on) {
      // TV off: the screen goes dark, but the light is left alone —
      // living_room_tv is mapped as a light in the YAML, so the
      // mapped entity drives the glow when the TV is off.
      screen.visible = false;
    } else {
      // TV on: the screen shows and the light glows in front of the
      // TV. The color drifts slowly through the hues (one full cycle
      // every 20 s) with a fast flicker on top, like a real screen —
      // absolute values from `time`, so frames stay independent. A
      // still (time 0) gets a fixed warm red; a clip shows the glow
      // shifting.
      screen.visible = true;
      light.visible = true;
      const flicker = 0.85 + 0.15 * Math.sin(time * 7.3) * Math.sin(time * 3.1);
      light.intensity = 14 * flicker;
      light.color = hueToRgb(time * 0.05);
    }
  }

  if (scene.hasObject(FAN_OBJECT)) {
    const fanSwitch = entities[FAN_ENTITY];
    const spinning = !!fanSwitch && fanSwitch.state === "on";
    const fan = scene.getObject(FAN_OBJECT);
    // One full turn per loop when the light is on (seamless: the same
    // angle at loop 0 and loop 1); parked at 0 when it is off. A still
    // (loop 0) always shows the fan at rest.
    fan.rotation.y = spinning ? loop * Math.PI * 2 : 0;
  }

  // Curtain glow: re-emitted sunlight from the sheer curtains. No
  // subscribe entry is needed — the sun is always sent to the script,
  // and the integration re-renders as it moves.
  const sun = scene.getSun();
  const sunAz = sun.azimuth;
  const sunEl = sun.elevation;
  const sunI = sun.intensity;
  for (const { light: name, windowAzimuth } of CURTAIN_GLOW_LIGHTS) {
    if (!scene.hasLight(name)) continue;
    const glow = scene.getLight(name);
    let intensity = 0;
    if (
      typeof sunAz === "number" &&
      typeof sunEl === "number" &&
      typeof sunI === "number" &&
      sunEl > 0 &&
      sunI > 0
    ) {
      // Alignment of the sun with the window's side: 1 when the sun is
      // square on the window, 0 at 90 deg or behind the house. The
      // cos(elevation) term is the 3D dot product — a high sun shines
      // through a vertical window less than a low one.
      const alignment = Math.max(
        0,
        Math.cos(((sunAz - windowAzimuth) * Math.PI) / 180) *
          Math.cos((sunEl * Math.PI) / 180),
      );
      intensity = CURTAIN_GLOW_MAX * (sunI / 3.0) * alignment;
    }
    glow.intensity = intensity;
    glow.color = CURTAIN_GLOW_COLOR;
  }
}
