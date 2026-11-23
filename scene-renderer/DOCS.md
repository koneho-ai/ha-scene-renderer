# HA Scene Renderer app

Renders a 3D model of your home, lit by your real Home Assistant lights
and the real sun. The render service runs here, in this app; the
[HA Scene Renderer integration](https://github.com/koneho-ai/ha-scene-renderer)
(HACS) watches your lights, sends their state to this service, and
exposes the render as an image entity.

> **Note:** Home Assistant renamed add-ons to apps in a recent release. If your Home Assistant still shows "Add-ons" / "Add-on Store", it's the same thing.

**Install order: this app first, then the integration.** The
integration's setup reads the model's lights from this service, so the
app must be installed and running before you add the integration.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `model` | `sample-apartment.glb` | Model file: a file in `/share/scene-renderer/models/`, a bundled model, or a literal path. |
| `width` / `height` | `1280` / `720` | Default render size for all cameras. Per-camera overrides in `cameras.yaml` (below). |
| `log_level` | `info` | `trace`, `debug`, `info`, `notice`, `warning`, `error`, `fatal`. |

## Cameras

Each render produces one image per camera, and each camera is its own
image entity in Home Assistant. Cameras come from the model: named glTF
cameras (unique `snake_case` names on the camera definition and its
node). The bundled sample apartment has two: `overview` and
`living_room`. A model with no cameras gets three built-in virtual
cameras computed from its bounding box: `overview` (isometric
dollhouse), `topdown` (straight down), and `front` (low front
elevation). Which cameras render is chosen in the integration's setup
or options flow.

### Per-camera configuration

Optionally, place a `cameras.yaml` in `/share/scene-renderer/` to
override per-camera properties. Keys are camera names (model cameras
and built-in virtual cameras alike); all fields are optional:

```yaml
overview:
  width: 1280
  height: 720
  fov: 50              # perspective only: override model's vertical FOV (degrees)
  near: 0.1            # override near clip plane
  far: 100             # override far clip plane
  position: [6, 8, 10] # override camera position (model units)
  target: [6, 0, 4]    # override look-at target
  background: "#1a1a2e" # override clear color (null = transparent)
  exposure: 1.0        # tone-mapping exposure multiplier
living_room:
  width: 800
  height: 600
```

Precedence: file value > model value > global default (width/height
from the app options; background = scene default; exposure = 1.0).
A commented example ships in the repo as
`cameras.example.yaml` — copy it to `/share/scene-renderer/` and edit.

The file is hot-reloaded: edit it and the app picks up the changes
without a restart (watch the log for a reload message). It never breaks
rendering: an unknown camera name is logged and ignored, invalid values
for one camera fall back to defaults for that camera only, and a
malformed file keeps the last good config.

### Motion clips

Any camera can render a looping animated WebP clip instead of a still:

```yaml
living_room:
  width: 800
  height: 600
  clip:
    duration: 3   # seconds per loop (0.5..30)
    fps: 10       # frames per second (1..30)
```

Frames per loop = `duration` × `fps` (2..300 frames). The clip uses the
camera's configured resolution, and the image entity serves it as
`image/webp` — it animates in the Home Assistant frontend. Cameras
without a `clip` entry stay stills.

What moves in a clip: glTF animations in the model (the bundled sample
apartment has a spinning ceiling fan — one full turn per 3 s, so a 3 s
clip loops seamlessly) and anything your `scene.js` animates (below).
The state snapshot is frozen for the whole clip: every frame sees the
same light and entity state, only the time changes. If the state
changes mid-clip, the frame loop aborts early and the new state renders
instead — and the old clip keeps looping in Home Assistant while the
new one renders.

Cost: a clip renders `duration` × `fps` frames, so a 3 s clip at
10 fps costs ~30 still renders (~6 s at 720p on a Pi-class host).
Keep clips short and small, and only on the cameras where motion
matters.

## Scripting (scene.js)

Optionally, place a `scene.js` in `/share/scene-renderer/` to drive the
scene from your Home Assistant entities. A commented example ships in
the repo as `scene.example.js` — copy it to
`/share/scene-renderer/scene.js` and edit. The file is hot-reloaded,
and it can never break rendering: a script that fails to compile keeps
the last good script running (the error shows in `/health` and in the
log), and a script that throws while rendering only skips its own
changes for that frame.

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

The script runs once per frame, after the built-in light mapping, the
sun, and the model's glTF animations are applied — so it always starts
from the entity state and sets **absolute** values, never increments
(there is deliberately no `dt` parameter). A clip loops seamlessly
when every animated value is periodic over the loop (same value at
`loop` 0 and 1) — e.g. `fan.rotation.y = loop * Math.PI * 2` is one
whole turn per loop.

The scene API:

| Call | Description |
| --- | --- |
| `scene.getLight(name)` | A named model light: `visible`, `intensity`, `color` ([r, g, b] 0..255). |
| `scene.getObject(name)` | Any named object (mesh, group, camera): `position`, `rotation`, `scale` (each `{x, y, z}`), `visible`, `lookAt(x, y, z)`. |
| `scene.getSun()` | The sun: `azimuth`, `elevation`, `intensity`, `color`. |
| `scene.setMorph(object, morph, weight)` | Morph target weight (0..1) on a mesh. |
| `scene.kelvinToRgb(k)` | Color temperature → `[r, g, b]`. |
| `scene.hasLight(name)` / `scene.hasObject(name)` | Guards for optional access. |
| `scene.listLights()` / `scene.listObjects()` | Names in the model. |

Unknown names throw a clear error (which only skips the script for that
frame — see above). `console.log` / `warn` / `error` in the script go
to the app log, prefixed `[scene.js]`.

Sandbox: the script runs in a SES Compartment (hardened JS) — no
`process`, no `require`, no network, no imports, no `eval`. It can
only touch the scene through the API above. Script status (loaded,
hash, subscriptions, last error) is in `GET /health` and
`GET /script`.

## Your own model

Put a `.glb` file in `/share/scene-renderer/models/` (create the folder
if needed), set the `model` option to its file name, and restart the
app. The model should use glTF `KHR_lights_punctual` lights with
unique `snake_case` names (e.g. `living_room_ceiling`) — those names are
what the integration maps to your light entities. The bundled sample
apartment has 5 named lights across 4 rooms.

## How it works

The service (Node.js + three.js) loads the model once at startup and
renders on demand: `GET /health`, `GET /lights`, `GET /cameras`,
`GET /script` (user-script status + subscriptions), `POST /render`
(batch: one image per requested camera — a PNG still, or an animated
WebP clip for cameras with a `clip:` entry in `cameras.yaml`; the
response carries each image's `content_type` plus the current script
status, so the integration knows when to re-subscribe). It
listens on port 3000 inside the container; Home Assistant reaches it on
the internal network, so no host port mapping is needed (the port is
offered in the Network panel for debugging). Rendering uses
`@onirenaud/node-webgl` (WebGL in Node, no browser); a Puppeteer +
headless Chromium build is the fallback variant.

## Troubleshooting

- **App won't start, log says "Model not found":** the `model`
  option names a file that is neither bundled nor in
  `/share/scene-renderer/models/`. Fix the name or add the file.
- **App won't start, log says "failed to start render backend":**
  the render backend could not initialise (e.g. the model file is not a
  valid GLB, or the WebGL backend failed on this hardware). Check the
  log lines above the error; try the sample model first.
- **Integration setup says it cannot reach the render service:** make
  sure the app is installed, started, and its log says `ready`.
- **Renders are slow:** rendering is software (CPU) on hosts without a
  GPU. Lower `width` / `height` in the app options.
- **A clip camera renders a still:** the `clip:` entry is invalid
  (duration 0.5..30, fps 1..30 as an integer, 2..300 frames total) —
  an invalid entry is logged and the whole camera entry falls back to
  defaults. Check the log for `cameras.yaml` errors.
- **My scene.js does nothing:** check `GET /script` (or the
  integration's Render status sensor): `status: "error"` means the
  script failed to compile (the message says why) and the last good
  script — or no script — is running. `last_error` / `error_count`
  show runtime throws. Also check the script's `subscribe` list: an
  entity the script reads but does not subscribe to is never sent.
