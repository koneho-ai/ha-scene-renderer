# Scene Scripting

Optionally, place a `scene.js` in `/share/scene-renderer/` to drive the scene from your Home Assistant entities. A commented example ships in the repo as `scene-renderer/scene.example.js` — copy it to `/share/scene-renderer/scene.js` and edit. The file is hot-reloaded: save it and the next render uses the new script.

## The contract

The script is a small module with one required export:

```js
// Which entities the script reads (entity IDs, domains like "light.*",
// or globs like "sensor.*_temperature"). The integration sends only
// these entities (plus the mapped lights and sun.sun) and re-renders
// when one of them changes. Omit it if the script only uses the mapped
// lights and the sun.
export const subscribe = ["sun.sun"];

export default function update({ entities, scene, time, loop }) {
  // entities: { "sun.sun": { state, attributes }, ... } — the snapshot
  //   for this render (frozen across a clip's frames).
  // scene: the capability-limited scene API (below).
  // time: seconds since the clip started; loop: 0..1 across one loop
  //   of the clip. Both are OPTIONAL — destructure only what you use.
}
```

- **`subscribe`** lists the entities the script reads: entity IDs, domains like `light.*`, globs like `sensor.*_temperature`. The integration sends only those (plus the mapped lights and `sun.sun`) and re-renders when one changes. An entity the script reads but does not subscribe to is never sent. Omit the list if the script only uses the mapped lights and the sun.
- **`update({ entities, scene, time, loop })`** runs once per frame, after the built-in light mapping, the sun, and the model's glTF animations are applied — so it always starts from the entity state and sets **absolute** values, never increments (there is deliberately no `dt` parameter).
- **`time`** (seconds since the clip started) and **`loop`** (0..1 across one loop of the clip) are **optional** — destructure only what you use; there is no signature checking. A script that only maps entities never mentions them.
- A clip loops seamlessly when every animated value is periodic over the loop (same value at `loop` 0 and 1) — e.g. `fan.rotation.y = loop * Math.PI * 2` is one whole turn per loop. A still is one frame at time 0.

## The scene API

| Call | Description |
| --- | --- |
| `scene.getLight(name)` | A named model light: `visible`, `intensity`, `color` ([r, g, b] 0..255). |
| `scene.getObject(name)` | Any named object (mesh, group, camera): `position`, `rotation`, `scale` (each `{x, y, z}`), `visible`, `lookAt(x, y, z)`. |
| `scene.getSun()` | The sun: `azimuth`, `elevation`, `intensity`, `color`. |
| `scene.setMorph(object, morph, weight)` | Morph target weight (0..1) on a mesh. |
| `scene.kelvinToRgb(k)` | Color temperature → `[r, g, b]`. |
| `scene.hasLight(name)` / `scene.hasObject(name)` | Guards for optional access. |
| `scene.listLights()` / `scene.listObjects()` | Names in the model. |

Unknown names throw a clear error (which only skips the script for that frame — see below). `console.log` / `warn` / `error` in the script go to the app log, prefixed `[scene.js]`.

Note there is no separate sun parameter: `sun.sun` is an entity like any other, read from `entities`.

## The bundled example

`scene.example.js` drives the sample model's living room TV from the Samsung TV's Plex client (subscribing to `media_player.plex_plex_for_samsung_tv_2023`) and its ceiling fan from a light:

- **TV on/off** — when Plex is playing, paused, or idle, the TV is on: the `tv_screen` mesh becomes visible and the `living_room_tv` point light in front of the screen glows. When Plex is unavailable, the screen goes dark — but the light is left alone, because `living_room_tv` is mapped as a light in the YAML and its entity drives the glow when the TV is off. (Limitation: if the TV is on but Plex is not running, the client is unavailable and the glow stays off — swap in a better "TV is on" entity, e.g. a smart plug, if you have one.)
- **Colorful glow** — while on, the light's color drifts slowly through the hues (one full cycle every 20 s) with a fast flicker on top, like a real screen. Absolute values from `time`, so frames stay independent; a still gets a fixed color, a clip shows the glow shifting.
- **Ceiling fan** — the `ceiling_fan` group spins when `light.wizcolor1` is on (one full turn per loop, so clips loop seamlessly) and parks at 0 when it is off. Any light works here; the point is that a script can drive an object from any entity.
- **Defensive** — each block bails out quietly (`hasLight`/`hasObject`) when the model lacks its parts, so the same file works against any model.

## Security model

The script runs sandboxed in a **SES Compartment** (hardened JS): no `process`, no `require`, no network, no imports, no `eval`. Static checks refuse node-builtin imports and `eval`/`Function`. It can only touch the scene through the API above, and only sees the entities it subscribed to (plus mapped lights and the sun). The foundation of the trust model is file access: only a Home Assistant admin can write to `/share/scene-renderer/`, the same trust level as `configuration.yaml`.

## Failure handling

A script can never break rendering:

- A script that **fails to compile** keeps the last good script running; the error shows in `/health`, `GET /script`, and the log.
- A script that **throws while rendering** only skips its own changes for that frame; the frame still renders.
- Script status (loaded, hash, subscriptions, last error, error count) is in `GET /health`, `GET /script`, and the integration's Render status sensor attributes.

See [[Troubleshooting]] if your script does nothing.
