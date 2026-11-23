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

Unknown names throw a clear error (which only skips the script for that frame — see below). `console.log` / `warn` / `error` in the script go to the add-on log, prefixed `[scene.js]`.

Note there is no separate sun parameter: `sun.sun` is an entity like any other, read from `entities`.

## The bundled example

`scene.example.js` does three things against the sample apartment (subscribing to `sun.sun`):

1. **Spinning fan** — `ceiling_fan.rotation.y = loop * Math.PI * 2`, one whole turn per loop. This overrides the model's own `ceiling_fan_spin` glTF animation (the script runs after the glTF animation is sampled); delete the block to let the built-in animation spin the fan.
2. **Flickering lamp** — scales the `living_room_lamp` intensity (already set from the entity state by the built-in mapping) by `0.88 + 0.12 * sin(loop * 2π * 3)`, three full sine periods per loop so it stays periodic. Only when the lamp is on.
3. **Blinds follow the sun** — reads `sun.sun`'s elevation, maps 0–30° to 0–1, and sets the `blinds` group's `position.y` from 1.2 (low sun, blinds down) to 2.0 (high sun, blinds up).

## Security model

The script runs sandboxed in a **SES Compartment** (hardened JS): no `process`, no `require`, no network, no imports, no `eval`. Static checks refuse node-builtin imports and `eval`/`Function`. It can only touch the scene through the API above, and only sees the entities it subscribed to (plus mapped lights and the sun). The foundation of the trust model is file access: only a Home Assistant admin can write to `/share/scene-renderer/`, the same trust level as `configuration.yaml`.

## Failure handling

A script can never break rendering:

- A script that **fails to compile** keeps the last good script running; the error shows in `/health`, `GET /script`, and the log.
- A script that **throws while rendering** only skips its own changes for that frame; the frame still renders.
- Script status (loaded, hash, subscriptions, last error, error count) is in `GET /health`, `GET /script`, and the integration's Render status sensor attributes.

See [[Troubleshooting]] if your script does nothing.
