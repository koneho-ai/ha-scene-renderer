# Scene Scripting

Optionally, place a `scene.js` in `/share/scene-renderer/` to drive the scene from your Home Assistant entities. A commented example ships in the repo as `scene-renderer/scene.example.js` — copy it to `/share/scene-renderer/scene.js` and edit. The file is hot-reloaded: save it and the next render uses the new script.

## The contract

The script is a small module with one required export:

```js
// Which entity drives which model light (light name -> entity id).
// This is THE light→entity mapping: update() applies it every frame
// (see the bundled example), the panel shows it in its Lights section,
// and the integration warns when it references an entity it does not
// subscribe to — list the entities in the YAML `entities:` block.
export const lightMapping = {
  living_room_1: "light.living_room",
  kitchen_1: "light.kitchen",
};

// Which entities the script reads beyond the YAML list (entity IDs,
// domains like "light.*", or globs like "sensor.*_temperature"). The
// integration sends the YAML entities plus these, and re-renders when
// one of them changes. Omit it if the script only uses the YAML
// entities and the sun.
export const subscribe = ["sun.sun"];

// Which model objects each entity drives (object name -> entity id).
// The panel lists these objects in its Objects section (with markers
// in the 3D view), and the integration re-renders when a driver entity
// changes, even if it is not in `subscribe`. Omit it if the script
// drives no objects.
export const objectDrivers = {
  tv_screen: "media_player.plex_plex_for_samsung_tv_2023",
  ceiling_fan: "light.wizcolor1",
};

export default function update({ entities, scene, time, loop }) {
  // entities: { "sun.sun": { state, attributes }, ... } — the snapshot
  //   for this render (frozen across a clip's frames).
  // scene: the capability-limited scene API (below).
  // time: seconds since the clip started; loop: 0..1 across one loop
  //   of the clip. Both are OPTIONAL — destructure only what you use.
}
```

- **`lightMapping`** maps model light names to the entity driving each one. It is the light→entity mapping — the old YAML `lights` block is deprecated and ignored (see [[Configuration]] for the migration). The script applies it in `update()`, every frame, for every model light (the bundled example's `applyLightMapping` is the standard logic — copy it): a mapped light whose entity is on shines at model base × brightness, in the entity's color (`rgb_color`, `hs_color`, `xy_color`, or `color_temp`, with `color_temp` mode preferring the temperature); a mapped light whose entity is off, unavailable, unknown, or missing renders OFF; a light **not** in the table renders OFF — every light gets an absolute value every frame, so nothing is ever left at the model's base intensity by accident. A driver for a light the model does not have is skipped quietly, so the same script works against any model. It must be a plain object of string → string; anything else fails compilation. The integration reads the table from the script status (see `GET /script`) for the panel and the image attributes, and warns when it references an entity it does not subscribe to.
- **`subscribe`** lists the entities the script reads beyond the YAML `entities` list: entity IDs, domains like `light.*`, globs like `sensor.*_temperature`. The integration sends the YAML entities plus these and re-renders when one changes. An entity the script reads but does not subscribe to (and that is not in the YAML list) is never sent. Omit the list if the script only uses the YAML entities and the sun.
- **`objectDrivers`** maps model object names to the entity driving each one. The panel lists those objects in its Objects section (with markers in the 3D view), and the integration re-renders when a driver entity changes, even if it is not in `subscribe`. Only objects that exist in the model are listed — a driver for an object the model does not have is skipped quietly, so the same script works against any model. It must be a plain object of string → string; anything else fails compilation. The same mapping can live in the YAML `objects` block instead (see [[Configuration]]) — no script needed — and a YAML mapping wins over `objectDrivers` for the same object.
- **`update({ entities, scene, time, loop })`** runs once per frame, after the lights are reset to their model base values, the sun, and the model's glTF animations are applied — so it always starts from a known state and sets **absolute** values, never increments (there is deliberately no `dt` parameter). A light the script lights on its own shines and casts shadows: after the script runs, each light's visibility and shadow casting follow its effective intensity, so setting `intensity` alone is enough — you do not need to set `visible` yourself.
- **`time`** (seconds since the clip started) and **`loop`** (0..1 across one loop of the clip) are **optional** — destructure only what you use; there is no signature checking. A script that only maps entities never mentions them.
- A clip loops seamlessly when every animated value is periodic over the loop (same value at `loop` 0 and 1) — e.g. `fan.rotation.y = loop * Math.PI * 2` is one whole turn per loop. A still is one frame at time 0.

## The scene API

| Call | Description |
| --- | --- |
| `scene.getLight(name)` | A named model light: `visible`, `intensity`, `color` ([r, g, b] 0..255), plus read-only `baseIntensity` and `baseColor` (the model's base values — the lightMapping apply logic scales the base by the entity's brightness). |
| `scene.getObject(name)` | Any named object (mesh, group, camera): `position`, `rotation`, `scale` (each `{x, y, z}`), `visible`, `lookAt(x, y, z)`. |
| `scene.getSun()` | The sun: `azimuth`, `elevation`, `intensity`, `color`. The azimuth is in **model frame** — the YAML `north_offset` is already applied (see [[Configuration]]), so a script that moves the sun works in the same frame the renderer does. |
| `scene.setMorph(object, morph, weight)` | Morph target weight (0..1) on a mesh. |
| `scene.kelvinToRgb(k)` | Color temperature → `[r, g, b]`. |
| `scene.hsToRgb(h, s)` | HA `hs_color` ([hue 0–360, saturation 0–100]) → `[r, g, b]`. |
| `scene.xyToRgb(x, y, brightness?)` | CIE `xy_color` (+ optional brightness 0–1) → `[r, g, b]`. |
| `scene.hasLight(name)` / `scene.hasObject(name)` | Guards for optional access. |
| `scene.listLights()` / `scene.listObjects()` | Names in the model. |

Unknown names throw a clear error (which only skips the script for that frame — see below). `console.log` / `warn` / `error` in the script go to the app log, prefixed `[scene.js]`.

Note there is no separate sun parameter: `sun.sun` is an entity like any other, read from `entities`.

## The bundled example

`scene.example.js` drives the sample model's living room TV from the Samsung TV's Plex client (subscribing to `media_player.plex_plex_for_samsung_tv_2023`) and its ceiling fan from a light:

- **Light mapping** — a `lightMapping` table for all 14 sample lights, applied first in `update()` by `applyLightMapping`: on → model base × brightness, color from the entity (rgb/hs/xy/color_temp), unmapped → off. Copy the table and the function into your own script as-is; the TV block below then overrides `living_room_tv` when the TV is on.
- **TV on/off** — when Plex is playing, paused, or idle, the TV is on: the `tv_screen` mesh becomes visible and the `living_room_tv` point light in front of the screen glows. When Plex is unavailable, the screen goes dark — but the light keeps the value `applyLightMapping` gave it from `lightMapping` (`light.lampy`), so the mapped entity drives the glow when the TV is off. (Limitation: if the TV is on but Plex is not running, the client is unavailable and the glow stays off — swap in a better "TV is on" entity, e.g. a smart plug, if you have one.)
- **Colorful glow** — while on, the light's color drifts slowly through the hues (one full cycle every 20 s) with a fast flicker on top, like a real screen. Absolute values from `time`, so frames stay independent; a still gets a fixed color, a clip shows the glow shifting.
- **Ceiling fan** — the `ceiling_fan` group spins when `light.wizcolor1` is on (one full turn per loop, so clips loop seamlessly) and parks at 0 when it is off. Any light works here; the point is that a script can drive an object from any entity.
- **Defensive** — each block bails out quietly (`hasLight`/`hasObject`) when the model lacks its parts, so the same file works against any model.

## Security model

The script runs sandboxed in a **SES Compartment** (hardened JS): no `process`, no `require`, no network, no imports, no `eval`. Static checks refuse node-builtin imports and `eval`/`Function`. It can only touch the scene through the API above, and only sees the entities it subscribed to (plus the YAML entities list and the sun). The foundation of the trust model is file access: only a Home Assistant admin can write to `/share/scene-renderer/`, the same trust level as `configuration.yaml`.

## Failure handling

A script can never break rendering:

- A script that **fails to compile** keeps the last good script running; the error shows in `/health`, `GET /script`, and the log.
- A script that **throws while rendering** only skips its own changes for that frame; the frame still renders.
- Script status (loaded, hash, subscriptions, last error, error count) is in `GET /health`, `GET /script`, and the integration's Render status sensor attributes.

See [[Troubleshooting]] if your script does nothing.
