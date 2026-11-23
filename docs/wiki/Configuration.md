# Configuration

## The setup flow

Setup is three steps, no free text:

1. **Connect** — name, render service URL (usually pre-filled from the Supervisor: the add-on's internal hostname, something like `http://a1b2c3d4-scene-renderer:3000`), sun on/off. If the add-on is not reachable, setup stops here with an error telling you to install and start the add-on first.
2. **Map lights** — one entity picker per light in the model, HA light entities only. Each picker is optional: a light left unmapped renders at its model default (full brightness, model color).
3. **Choose cameras** — multi-select of the scene cameras, all selected by default. Each selected camera gets its own image entity; the step shows each camera's effective resolution.

## The options flow

**Configure** on the integration shows the same mapping and camera UI and re-reads the light and camera lists from the add-on, so a changed model shows up there. Changing the camera selection adds or removes image entities (the entry reloads automatically).

## How lights are rendered

The integration normalizes each mapped entity into a parameter set:

| Render parameter | From the entity |
| --- | --- |
| `on` | state is `on` (`unavailable` / `unknown` / `off` all render as off) |
| `brightness` (0–1) | `brightness` attribute / 255; absent for on/off-only lights (treated as 1.0) |
| `color` (RGB) | `rgb_color`, else `hs_color` converted, else `xy_color` converted |
| `color_temp_k` | `color_temp_kelvin`, else legacy `color_temp` mireds converted |

`color_mode` decides the priority when both a color and a temperature are present: `color_temp` mode uses the temperature, `hs` / `xy` / `rgb` modes use the color.

The service applies the parameters on top of the **model's base values**: the model's `KHR_lights_punctual` intensity is the "full brightness" look and its color is the default color.

- intensity = model base intensity × brightness (0 when off)
- color = entity color, else Kelvin→RGB of `color_temp_k`, else model color

Unmapped lights render at their model base values. One approximation to know about: in RGB color modes the brightness lives partly in the color itself (HA docs), so a natively-RGB light with a dark color renders slightly dimmer than its brightness value alone would suggest.

## The sun

With sun enabled, the service adds a directional light from `sun.sun`'s `azimuth` and `elevation` attributes: position, warm-to-neutral color by elevation, and intensity ramping in over the first 30° above the horizon. Below the horizon the sun is off and the interior lights carry the scene. The sun casts the shadows; the model's point lights do not (performance).

Renders are debounced (~1 s after a light change), serialized, and at most one every ~2 s. The sun re-renders when its elevation crosses a 5° step, on sunrise/sunset, or at most every 15 minutes while it is up.

## Where your files live

All user files live under `/share/scene-renderer/` on the HA host (the add-on maps `share:rw`):

| Path | What it is |
| --- | --- |
| `/share/scene-renderer/models/*.glb` | Your own models — set the add-on's `model` option to the file name |
| `/share/scene-renderer/cameras.yaml` | Per-camera overrides (optional, hot-reloaded) |
| `/share/scene-renderer/scene.js` | Your scene script (optional, hot-reloaded) |

## Per-camera configuration (`cameras.yaml`)

Optionally, place a `cameras.yaml` in `/share/scene-renderer/` to override per-camera properties. Keys are camera names as enumerated by `GET /cameras` (model cameras and built-in virtual cameras alike). A commented example ships in the repo as `scene-renderer/cameras.example.yaml` — copy it to `/share/` and edit.

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
  clip:
    duration: 3   # seconds per loop (0.5..30)
    fps: 10       # frames per second (1..30)
```

All fields are optional. Merge precedence: **file value > model value** (FOV / near / far / position / target from the glTF camera or the computed virtual camera) **> global default** (width/height from the add-on options; background = scene default; exposure = 1.0). `GET /cameras` returns the effective merged config per camera, so the integration's camera step shows each camera's effective resolution.

The file is hot-reloaded: the add-on watches it and picks up changes without a restart (the log says whether the reload succeeded). It never breaks rendering: an unknown camera name is logged and ignored, invalid values for one camera fall back to defaults for that camera only, and a malformed file keeps the last good config. One exception: an invalid `clip:` entry (duration 0.5–30, fps 1–30 as an integer, 2–300 frames total) drops the **whole camera entry** to defaults — check the log for `cameras.yaml` errors if a clip camera renders a still.

See [[Motion Clips]] for what `clip:` does.

## Render service API

The add-on listens on port 3000 inside the container (no host port mapping needed — HA reaches it on the internal network).

- `GET /health` — status, backend, model, scene lights, cameras, animations, user-script status, uptime, render count.
- `GET /lights` — scene lights from the loaded model: `name`, `type` (`point` / `spot` / `directional`), `position`, `color` (hex), `intensity` (base, candela).
- `GET /cameras` — scene cameras with their effective config (model + `cameras.yaml` + defaults merged): `name`, `type` (`perspective` / `orthographic`), `fov`, `near`, `far`, `position`, `target`, `width`, `height`, `background`, `exposure`, `clip` (`{duration, fps, frames}` or `null`), `source` (`model` / `builtin`).
- `GET /script` — user-script status: `present`, `hash`, `subscribe`, `status` (`none` / `ok` / `error`), `error`, `last_error`, `error_count`.
- `POST /render` — JSON body, returns one image per requested camera (PNG still, or animated WebP for clip cameras) plus the script status:

```json
{
  "lights": {
    "living_room_ceiling": {
      "on": true, "brightness": 0.8,
      "color": [255, 180, 120], "color_temp_k": null
    }
  },
  "sun": {"azimuth": 210, "elevation": 35},
  "entities": {
    "sun.sun": {"state": "above_horizon", "attributes": {"elevation": 35, "azimuth": 210}}
  },
  "cameras": ["overview", "living_room"]
}
```

Response: `{"renders": {"overview": {"data": "<base64>", "content_type": "image/png"}, "living_room": {"data": "<base64>", "content_type": "image/webp"}}, "script": {...}}`. Any of `lights`, `sun`, `entities`, `cameras` may be omitted; omitting `cameras` renders all cameras. `sun: null` disables the sun for that render. Unknown camera names are ignored; a request with no known cameras returns HTTP 400. Per-camera size, FOV, position, background, exposure, and clip come from the effective camera config (see `cameras.yaml` above), not the request.
