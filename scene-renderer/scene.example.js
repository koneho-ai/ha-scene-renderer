// Example scene.js for the HA Scene Renderer — copy to
// /share/scene-renderer/scene.js (or the path in SCENE_SCRIPT_PATH) and
// edit to taste. The file is hot-reloaded: save it and the next render
// uses the new script. This example drives the sample model's living
// room TV from the Samsung TV's Plex client, and its ceiling fan
// from a light (for testing).
//
// The script is a small ESM-style module:
//   - export a default function update({ entities, scene, time, loop })
//   - export `const lightMapping = {...}` mapping model light names to
//     the entity that drives each one ({ living_room_1:
//     "light.living_room" }). This is THE light→entity mapping — the
//     YAML `lights` block is deprecated and ignored. update() applies
//     it every frame (see applyLightMapping below): on -> model base x
//     brightness, color from the entity, color_temp supported; lights
//     not in the table render OFF. List the mapped entities in the
//     YAML `entities` block so the integration subscribes to them.
//   - optionally export `const subscribe = [...]` listing the entities
//     the script reads beyond the YAML list (entity IDs, domains like
//     "light.*", or globs like "sensor.*_temperature"). The
//     integration sends the YAML entities plus these, and re-renders
//     when one of them changes. No subscribe list -> the script only
//     sees the YAML entities and sun.sun.
//   - optionally export `const objectDrivers = {...}` mapping model
//     object names to the entity that drives each one
//     ({ ceiling_fan: "light.wizcolor1" }). The sidebar panel shows
//     those objects with their driving entity and a toggle.
//
// Contract (important for clips):
//   - The service resets every light to its model base value before
//     every frame, then runs this script — so set ABSOLUTE values
//     here, never increment (there is deliberately no dt parameter).
//     applyLightMapping below sets every light every frame, so no
//     light is ever left at base intensity by accident.
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

export const subscribe = [TV_ENTITY, FAN_ENTITY];

// Which entity drives which model light. This is THE light→entity
// mapping: update() applies it every frame (see applyLightMapping
// below), the sidebar panel shows it in its Lights section, and the
// integration warns when it references an entity that is not
// subscribed (list the entities in the YAML `entities` block). Keys
// are model light names; values are exact entity IDs, not patterns.
// A light the model does not have is skipped quietly, so the same
// file works against any model; a model light NOT in this table
// renders OFF.
export const lightMapping = {
  living_room_1: "light.living_room",
  living_room_2: "light.living_room_2",
  living_room_3: "light.living_room_3",
  living_room_4: "light.living_room_4",
  living_room_tv: "light.lampy",
  kitchen_1: "light.kitchen",
  dining_1: "light.dining",
  bedroom_1: "light.bedroom",
  kids_bedroom_1: "light.kids_bedroom",
  kids_bedroom_2: "light.kids_bedroom_2",
  kids_bedroom_3: "light.kids_bedroom_3",
  kids_bedroom_4: "light.kids_bedroom_4",
  office_1: "light.office",
  office_2: "light.office_2",
};

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

// An entity's color temperature in kelvin, from the kelvin attribute
// or the legacy mireds attribute; null when the entity has neither.
function colorTempKelvin(attrs) {
  if (typeof attrs.color_temp_kelvin === "number") {
    return attrs.color_temp_kelvin;
  }
  if (typeof attrs.color_temp === "number" && attrs.color_temp > 0) {
    return 1000000 / attrs.color_temp;
  }
  return null;
}

// An entity's color as sRGB [r, g, b]: rgb_color, hs_color, xy_color,
// or color temperature. color_temp mode prefers the temperature;
// every other mode prefers the color, with the temperature as a
// fallback. No color at all -> the light's model base color.
function colorFromEntity(attrs, scene, baseColor) {
  if (attrs.color_mode === "color_temp") {
    const kelvin = colorTempKelvin(attrs);
    if (kelvin !== null) return scene.kelvinToRgb(kelvin);
    return baseColor;
  }
  if (Array.isArray(attrs.rgb_color) && attrs.rgb_color.length === 3) {
    return attrs.rgb_color;
  }
  if (Array.isArray(attrs.hs_color) && attrs.hs_color.length === 2) {
    return scene.hsToRgb(attrs.hs_color[0], attrs.hs_color[1]);
  }
  if (Array.isArray(attrs.xy_color) && attrs.xy_color.length === 2) {
    return scene.xyToRgb(attrs.xy_color[0], attrs.xy_color[1]);
  }
  const kelvin = colorTempKelvin(attrs);
  if (kelvin !== null) return scene.kelvinToRgb(kelvin);
  return baseColor;
}

// Standard light mapping: drive every model light from its entity in
// lightMapping. Run first in update(), before any special cases (the
// TV block below overrides living_room_tv when the TV is on).
//   - a mapped light whose entity is on shines at model base x
//     brightness, in the entity's color (rgb/hs/xy, or color_temp);
//   - a mapped light whose entity is off, unavailable, unknown, or
//     missing renders OFF;
//   - a light NOT in lightMapping renders OFF — every light gets an
//     absolute value every frame, so nothing is ever left at the
//     model's base intensity by accident.
function applyLightMapping({ entities, scene }) {
  for (const name of scene.listLights()) {
    const light = scene.getLight(name);
    const entity = entities[lightMapping[name]];
    if (!entity || entity.state !== "on") {
      light.intensity = 0;
      continue;
    }
    const attrs = entity.attributes || {};
    const brightness =
      typeof attrs.brightness === "number" ? attrs.brightness / 255 : 1;
    light.intensity = light.baseIntensity * brightness;
    light.color = colorFromEntity(attrs, scene, light.baseColor);
  }
}

export default function update({ entities, scene, time = 0, loop = 0 }) {
  // Every model light, driven from lightMapping (unmapped -> off).
  applyLightMapping({ entities, scene });

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
      // TV off: the screen goes dark, but the light keeps the value
      // applyLightMapping gave it from lightMapping (light.lampy) —
      // the mapped entity drives the glow when the TV is off.
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
}
