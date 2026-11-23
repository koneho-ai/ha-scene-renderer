# HA Scene Renderer add-on

Renders a 3D model of your home, lit by your real Home Assistant lights
and the real sun. The render service runs here, in this add-on; the
[HA Scene Renderer integration](https://github.com/koneho-ai/ha-scene-renderer)
(HACS) watches your lights, sends their state to this service, and
exposes the render as an image entity.

**Install order: this add-on first, then the integration.** The
integration's setup reads the model's lights from this service, so the
add-on must be installed and running before you add the integration.

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
from the add-on options; background = scene default; exposure = 1.0).
A commented example ships in the repo as
`cameras.example.yaml` — copy it to `/share/scene-renderer/` and edit.

The file is hot-reloaded: edit it and the add-on picks up the changes
without a restart (watch the log for a reload message). It never breaks
rendering: an unknown camera name is logged and ignored, invalid values
for one camera fall back to defaults for that camera only, and a
malformed file keeps the last good config.

## Your own model

Put a `.glb` file in `/share/scene-renderer/models/` (create the folder
if needed), set the `model` option to its file name, and restart the
add-on. The model should use glTF `KHR_lights_punctual` lights with
unique `snake_case` names (e.g. `living_room_ceiling`) — those names are
what the integration maps to your light entities. The bundled sample
apartment has 5 named lights across 4 rooms.

## How it works

The service (Node.js + three.js) loads the model once at startup and
renders on demand: `GET /health`, `GET /lights`, `GET /cameras`,
`POST /render` (batch: one PNG per requested camera). It
listens on port 3000 inside the container; Home Assistant reaches it on
the internal network, so no host port mapping is needed (the port is
offered in the Network panel for debugging). Rendering uses
`@onirenaud/node-webgl` (WebGL in Node, no browser); a Puppeteer +
headless Chromium build is the fallback variant.

## Troubleshooting

- **Add-on won't start, log says "Model not found":** the `model`
  option names a file that is neither bundled nor in
  `/share/scene-renderer/models/`. Fix the name or add the file.
- **Add-on won't start, log says "failed to start render backend":**
  the render backend could not initialise (e.g. the model file is not a
  valid GLB, or the WebGL backend failed on this hardware). Check the
  log lines above the error; try the sample model first.
- **Integration setup says it cannot reach the render service:** make
  sure the add-on is installed, started, and its log says `ready`.
- **Renders are slow:** rendering is software (CPU) on hosts without a
  GPU. Lower `width` / `height` in the add-on options.
