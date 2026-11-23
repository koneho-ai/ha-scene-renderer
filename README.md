# HA Scene Renderer

Renders a 3D model of your home, lit by your real Home Assistant lights
and the real sun, and exposes the render as a live image in Home Assistant.
Turn a light on, change its brightness or color — the render follows within
a second or two.

Two parts, one repository:

| Part | What it is | Installed via |
| --- | --- | --- |
| **Add-on** (`scene-renderer/`) | Node.js + three.js render service in a container, managed by the Supervisor like Node-RED | Add-on store (custom repository) |
| **Integration** (`custom_components/scene_renderer/`) | Watches your lights + `sun.sun`, sends their state to the add-on, exposes the render | HACS / Marketplace (custom repository) |

```
Home Assistant host
┌──────────────────────────────────────────────────────────────────┐
│  ┌────────────────────────┐    HTTP     ┌──────────────────────┐ │
│  │ HA Core                │  ─────────► │ scene-renderer       │ │
│  │  scene_renderer        │  {lights +  │ add-on (Node.js)     │ │
│  │  integration           │   sun +     │  three.js render     │ │
│  │  image entities+status │  cameras}   │  service             │ │
│  └────────────────────────┘ ◄────────── └──────────────────────┘ │
│                          PNGs, one per camera                    │
└──────────────────────────────────────────────────────────────────┘
```

## Install (in this order)

**1. The add-on first.** The integration cannot be set up until the
add-on is running — the setup flow reads the model's lights from it.

- Settings → Add-ons → Add-on Store → ⋮ → Repositories, add
  `https://github.com/koneho-ai/ha-scene-renderer`
- Install **HA Scene Renderer**, then **Start** it. The log should say
  `ready (backend: node-webgl, 5 scene lights, 2 cameras)`.

**2. Then the integration.**

- HACS (or Settings → Marketplace on HA 2026.11+) → ⋮ → Custom
  repositories, add `https://github.com/koneho-ai/ha-scene-renderer`
  (category: Integration), then install **HA Scene Renderer** and
  restart Home Assistant.
- Settings → Devices & Services → Add Integration → **HA Scene Renderer**.

Setup is three steps, no free text:

1. **Connect** — name, render service URL (usually pre-filled from the
   Supervisor: the add-on's internal hostname, something like
   `http://a1b2c3d4-scene-renderer:3000`), sun on/off. If the add-on is
   not reachable, setup stops here with an error telling you to
   install and start the add-on first.
2. **Map lights** — one entity picker per light in the model, HA light
   entities only. Each picker is optional: a light left unmapped renders
   at its model default (full brightness, model color).
3. **Choose cameras** — multi-select of the scene cameras, all selected
   by default. Each selected camera gets its own image entity; the step
   shows each camera's effective resolution.

The options flow (Configure on the integration) shows the same mapping
and camera UI and re-reads the light and camera lists from the add-on,
so a changed model shows up there. Changing the camera selection
adds or removes image entities (the entry reloads automatically).

## What you get in Home Assistant

- `image.<name>_<camera>` — one image entity per selected camera
  (e.g. `image.scene_renderer_overview`), each serving that camera's
  latest render.
- `sensor.<name>_render_status` (diagnostic) — `idle`, `rendering`,
  `ok`, or `error`, with last render time, render count, last render
  duration, last error, service URL, cameras, and mapped light count.
- `button.<name>_re_render` (diagnostic) — force a re-render.

Each update is one batch render request (lights + sun + cameras) that
returns one PNG per camera. Renders are debounced (~1 s after a light
change), serialized, and at most one every ~2 s. The sun re-renders
when its elevation crosses a 5° step, on sunrise/sunset, or at most
every 15 minutes while it is up.

## Light parametrization

The render emulates what your entities are actually doing. The
integration normalizes each mapped entity into a parameter set:

| Render parameter | From the entity |
| --- | --- |
| `on` | state is `on` (`unavailable` / `unknown` / `off` all render as off) |
| `brightness` (0–1) | `brightness` attribute / 255; absent for on/off-only lights (treated as 1.0) |
| `color` (RGB) | `rgb_color`, else `hs_color` converted, else `xy_color` converted |
| `color_temp_k` | `color_temp_kelvin`, else legacy `color_temp` mireds converted |

`color_mode` decides the priority when both a color and a temperature
are present: `color_temp` mode uses the temperature, `hs` / `xy` / `rgb`
modes use the color.

The service applies the parameters on top of the **model's base values**:
the model's `KHR_lights_punctual` intensity is the "full brightness" look
and its color is the default color.

- intensity = model base intensity × brightness (0 when off)
- color = entity color, else Kelvin→RGB of `color_temp_k`, else model color

Unmapped lights render at their model base values. One approximation to
know about: in RGB color modes the brightness lives partly in the color
itself (HA docs), so a natively-RGB light with a dark color renders
slightly dimmer than its brightness value alone would suggest.

## The sun

With sun enabled, the service adds a directional light from `sun.sun`'s
`azimuth` and `elevation` attributes: position, warm-to-neutral color by
elevation, and intensity ramping in over the first 30° above the horizon.
Below the horizon the sun is off and the interior lights carry the scene.
The sun casts the shadows; the model's point lights do not (performance).

## Models

- Format: **GLB**. v1 ships a bundled sample apartment
  (`scene-renderer/models/sample-apartment.glb`, 4 rooms, 5 named
  lights, 2 named cameras), generated by
  `scripts/generate_sample_model.py` (pure Python, no dependencies —
  re-run it to regenerate).
- **Naming convention:** lights are glTF `KHR_lights_punctual` lights
  with a unique `snake_case` `name` (e.g. `living_room_ceiling`). That
  name is the identifier the integration maps to an HA entity. Every
  named punctual light in the model is an enumerable scene light.
  Cameras are glTF cameras with a unique `snake_case` name on both the
  camera definition and its node (e.g. `overview`, `living_room`).
- **Your own model:** put the `.glb` in `/share/scene-renderer/models/`
  on the HA host and set the add-on's `model` option to its file name,
  then restart the add-on. (The add-on maps `share:rw`.) Any GLB with
  named `KHR_lights_punctual` lights works; a model without cameras
  gets the three built-in virtual cameras (see below).
- The bundled sample has no ceiling (dollhouse style) so the overview
  camera sees inside.

## Cameras

Each render produces one image per camera, and each camera is its own
image entity in Home Assistant.

- **Model cameras** — named glTF cameras in the model (the sample has
  `overview` and `living_room`). Position, look-at target, FOV, and
  clip planes come from the model.
- **Built-in virtual cameras** — only when the model defines no cameras
  at all: `overview` (isometric dollhouse), `topdown` (straight down,
  north up), and `front` (low front elevation), computed from the
  model's bounding box, so they adapt to any size.

Which cameras render is chosen in the integration's setup (step 3) or
options flow — all selected by default.

### Per-camera configuration (`cameras.yaml`)

Optionally, place a `cameras.yaml` in `/share/scene-renderer/` to
override per-camera properties. Keys are camera names as enumerated by
`GET /cameras` (model cameras and built-in virtual cameras alike).
A commented example ships in the repo as
`scene-renderer/cameras.example.yaml` — copy it to `/share/` and edit.

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

All fields are optional. Merge precedence: **file value > model value**
(FOV / near / far / position / target from the glTF camera or the
computed virtual camera) **> global default** (width/height from the
add-on options; background = scene default; exposure = 1.0).
`GET /cameras` returns the effective merged config per camera, so the
integration's camera step shows each camera's effective resolution.

The file is hot-reloaded: the add-on watches it and picks up changes
without a restart (the log says whether the reload succeeded). It
never breaks rendering: an unknown camera name is logged and ignored,
invalid values for one camera fall back to defaults for that camera
only, and a malformed file keeps the last good config.

## Render service API

The add-on listens on port 3000 inside the container (no host port
mapping needed — HA reaches it on the internal network).

- `GET /health` — status, backend, model, scene lights, cameras,
  uptime, render count.
- `GET /lights` — scene lights from the loaded model: `name`, `type`
  (`point` / `spot` / `directional`), `position`, `color` (hex),
  `intensity` (base, candela).
- `GET /cameras` — scene cameras with their effective config (model +
  `cameras.yaml` + defaults merged): `name`, `type`
  (`perspective` / `orthographic`), `fov`, `near`, `far`, `position`,
  `target`, `width`, `height`, `background`, `exposure`, `source`
  (`model` / `builtin`).
- `POST /render` — JSON body, returns a JSON map of base64 PNGs, one
  per requested camera:
  ```json
  {
    "lights": {
      "living_room_ceiling": {
        "on": true, "brightness": 0.8,
        "color": [255, 180, 120], "color_temp_k": null
      }
    },
    "sun": {"azimuth": 210, "elevation": 35},
    "cameras": ["overview", "living_room"]
  }
  ```
  Response: `{"renders": {"overview": "<base64 PNG>", ...}}`.
  Any of `lights`, `sun`, `cameras` may be omitted; omitting `cameras`
  renders all cameras. `sun: null` disables the sun for that render.
  Unknown camera names are ignored; a request with no known cameras
  returns HTTP 400. Per-camera size, FOV, position, background, and
  exposure come from the effective camera config (see `cameras.yaml`
  above), not the request.

## Render backends

The service renders with three.js. Two backends, selected at image build
time (`RENDER_BACKEND` build arg; the running service also honors the
`RENDER_BACKEND` env var, but only a backend installed in the image can
run):

- `node-webgl` (default) — three.js on `@onirenaud/node-webgl`, a real
  WebGL2 context in Node backed by ANGLE. No browser, smallest image.
  On Linux it compiles a small native addon at install and uses Mesa
  (llvmpipe) when there is no GPU.
- `puppeteer` — three.js in headless Chromium (SwiftShader software GL).
  Heavier image, battle-tested fallback. Both backends run the same
  `scene.mjs`, so they render identically.

## Add-on options

| Option | Default | Notes |
| --- | --- | --- |
| `model` | `sample-apartment.glb` | File name in `/share/scene-renderer/models/`, a bundled model, or a literal path |
| `width` / `height` | `1280` / `720` | Default render size for all cameras (320–3840 × 240–2160); per-camera overrides in `cameras.yaml` |
| `log_level` | `info` | `trace` … `fatal` |

## Repository layout

```
ha-scene-renderer/
├── hacs.json, repository.yaml     # HACS + add-on store metadata
├── .github/workflows/builder.yaml # CI: builds + publishes the add-on image
├── custom_components/scene_renderer/   # the HACS integration
├── scene-renderer/                     # the add-on
│   ├── config.yaml, Dockerfile, run.sh # Supervisor packaging
│   ├── server.mjs, scene.mjs           # render service + shared three.js logic
│   ├── camera-config.mjs               # cameras.yaml hot-reload + merge
│   ├── cameras.example.yaml            # commented per-camera config example
│   ├── backends/                       # node-webgl + puppeteer backends
│   ├── models/sample-apartment.glb     # bundled sample model
│   └── rootfs/                         # S6 service definition
└── scripts/generate_sample_model.py    # sample model generator
```

## Releasing

The add-on image is built and published by GitHub Actions
(`.github/workflows/builder.yaml`, home-assistant/builder actions) when a
release is published. The image is `ghcr.io/koneho-ai/ha-scene-renderer`
(multi-arch: amd64 + aarch64), Cosign-signed, tagged with the release
version and `latest`.

To cut a release:

1. Bump `version` in `scene-renderer/config.yaml` — it is the single
   source of truth: the version users see, the tag the Supervisor pulls,
   and what update notifications compare against. Keep the integration
   version in `custom_components/scene_renderer/manifest.json` and
   `scene-renderer/package.json` in step.
2. Commit and push.
3. Create a GitHub release with the tag **exactly equal to the version,
   e.g. `0.1.0` — no `v` prefix**. The Supervisor pulls the tag matching
   `version`, so `v0.1.0` would never be found.
4. The workflow builds both architectures and publishes the multi-arch
   manifest. HACS users get the integration update from the same release.

First release only: a new GHCR package starts **private** — make it public
(package settings → Danger Zone → Change visibility) or nobody can pull
the image. Also note `config.yaml` already declares `image:`, so add-on
installs will fail to pull until the first image is published — cut the
first release as soon as the repo is live.

To test the build without publishing, run the workflow manually
(Actions → Build add-on image → Run workflow); manual runs build but do
not push.

CI publishes the default **node-webgl** variant only. The puppeteer
variant is not published; build it locally when needed:

```sh
docker build --build-arg RENDER_BACKEND=puppeteer scene-renderer/
```

## Testing limits (honest)

- The integration was syntax/import-checked and its light-state
  normalization + coordinator logic tested against stubbed HA modules —
  it has not run against a live Home Assistant yet. First install is
  the real test.
- The render service was smoke-tested on a dev VM via the Puppeteer
  backend (Chromium + SwiftShader): `/health`, `/lights`, `/cameras`,
  and batch `/render` all verified, PNG output checked per camera,
  including the built-in virtual cameras with a model that has none.
  The node-webgl backend (the default) could not be installed on the
  dev VM and is validated by the add-on image build on real HA hardware.
- The `cameras.yaml` merge/validation logic was tested with hand-built
  config objects; parsing a real YAML file and the hot-reload watch
  were not exercised on the dev VM (the `js-yaml` package could not be
  loaded there) — first verify on a real install by editing the file
  and watching the add-on log.
- The add-on image build itself (Docker) was not run here — no Docker
  on the dev VM. The Dockerfile follows the current (post-April-2026
  BuildKit migration) conventions: base image pinned in the Dockerfile,
  no `build.yaml`, S6 service under `rootfs/`.

## License

MIT.
