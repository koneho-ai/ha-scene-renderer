# Configuration

## YAML configuration

The integration is YAML-only — there is no UI setup flow. Add a
`scene_renderer` block to `configuration.yaml` and restart Home
Assistant. Every key is optional:

```yaml
scene_renderer:
  entities:
    - light.living_room
    - light.kitchen
```

| Key | Default | Notes |
| --- | --- | --- |
| `service_url` | discovered | Base URL of the render service. Only needed if Supervisor discovery fails (e.g. the app runs outside the Supervisor); usually something like `http://a1b2c3d4-scene-renderer:3000` |
| `sun_entity` | `sun.sun` | Sun entity to follow; set to `null` to disable the sun |
| `sun_elevation` | — | Fix the sun at this elevation (0–90°); requires `sun_azimuth` |
| `sun_azimuth` | — | Fix the sun at this azimuth (0–360°); requires `sun_elevation` |
| `north_offset` | `0` | Rotate the sun (and moon) to match the real house orientation (0–360°); see North offset below |
| `name` | `Scene Renderer` | Scene name, used for the device and entities |
| `entities` | `[]` | The entities the integration subscribes to — their states are sent to the render service in every render request, and the script maps them to model lights via its `lightMapping` table (see [[Scene Scripting]]) |
| `objects` | `{}` | Mapping of model object names (e.g. `ceiling_fan`) to HA entity ids — see Mapping objects below |
| `cameras` | all | Camera names to expose, one image entity each; omit to expose every camera the app offers |

The YAML only lists the entities to subscribe to — the light→entity
mapping itself lives in the scene script (`scene.js`), as a
`lightMapping` table the script applies every frame: a mapped light
whose entity is on shines at model base × brightness in the entity's
color (or color temperature); a mapped light whose entity is off, and
any light not in the table, renders OFF. So the demo model needs no
onboarding at all — a bare `scene_renderer:` line works (no script, no
entities, all lights off except the sun), and the app is discovered
automatically. The script's own `subscribe` export adds further
entities on top of the YAML list (e.g. the Plex media player that
drives the TV). The integration warns in the log when `lightMapping`
references an entity it does not subscribe to — that light would
render off with no visible reason — so add the entity to `entities:`
(or to the script's `subscribe`).

### The deprecated `lights` mapping

Before 0.3.9 the mapping lived in YAML (`lights:`, model light name →
entity id). It is deprecated and **no longer affects renders**: if
your `configuration.yaml` still has a `lights:` block, setup logs a
warning with the equivalent `lightMapping` table — paste it into your
`scene.js` (the integration never writes your script for you), list
the entities in `entities:`, and delete the `lights:` block:

```yaml
# BEFORE (deprecated, ignored)
scene_renderer:
  lights:
    living_room_1: light.living_room
    kitchen_1: light.kitchen

# AFTER
scene_renderer:
  entities:
    - light.living_room
    - light.kitchen
```

```js
// in /share/scene-renderer/scene.js
export const lightMapping = {
  living_room_1: "light.living_room",
  kitchen_1: "light.kitchen",
};
```

The bundled `scene.example.js` already contains a full `lightMapping`
table for the sample model plus the standard apply logic — copy it as
a starting point (see [[Scene Scripting]]).

### Mapping objects

A mapping of model object names to HA entity ids: the object's
driving entity shows in the panel's Objects section with a toggle,
and the integration re-renders when the driver changes. The sample
house's ceiling fan is the example:

```yaml
scene_renderer:
  objects:
    ceiling_fan: light.wizcolor1
```

The mapping only links object and entity — it does not animate the
object. The fan still spins because `scene.js` spins it from that
entity (the panel viewer spins it too, from the same emulated
state). An object the model does not have is skipped quietly, so
the same block works against any model. If the script's
`objectDrivers` drives the same object, the YAML mapping wins.

Changing the YAML needs a Home Assistant restart (standard for
YAML-only integrations). To remove the integration, delete the block
and restart.

### Upgrading from 0.2.x

The config flow is gone in 0.3.0. Delete the old integration entry
first (Settings → Devices & Services → HA Scene Renderer → ⋮ →
Delete), then add the YAML block above with your entity list and your
`scene.js` `lightMapping`, and restart. Deleting first frees up the
entity ids
(`image.<name>_<camera>` etc.), so the YAML setup reuses them; if the
old entry still exists when the YAML setup runs, the new entities get
`_2` suffixes instead.

### Upgrading from 0.3.0

0.3.0 registered bare entity ids (`image.overview`,
`sensor.render_status`, `button.re_render`) because no device attaches
to a YAML-only setup. 0.3.1 renames them to the scene-prefixed ids
(`image.scene_renderer_overview`, …) automatically on the first
restart after updating — no action needed, unless you built
automations or dashboards on the bare ids, in which case update them
to the new ids. 0.3.1 also fixes the sidebar panel leaving a black gap
at the bottom of the page, and adds a toggle switch to each mapped
light in the panel's light list so the render can be tested from the
panel itself.

**0.3.2** fixes a startup crash in 0.3.1 (`No module named
'homeassistant.util.slugify'` — the migration imported slugify from a
submodule that doesn't exist in HA; it lives in `homeassistant.util`).
If 0.3.1 left the entities unavailable and the panel missing, update to
0.3.2 and restart — the migration runs on setup and everything comes
back under the new ids.

**0.3.3** fixes the migration itself: 0.3.1/0.3.2 removed the bare
registry entries, but HA stashes removed entries in `deleted_entities`
and restores the old id when the entity is re-added, so the bare ids
came straight back. 0.3.3 renames the entries in place instead, which
sticks.

**0.3.4** fixes the panel showing stale code after an update: the panel
JS was served at a fixed URL, so browsers kept running the old cached
copy (no toggles, black gap at the bottom) until a manual hard refresh.
The module URL now carries the integration version, so every release
loads fresh. 0.3.4 also makes the panel's 3D viewer use the real
lighting: the model's lights now follow their mapped HA entities
(on/off, brightness, color) and the sun follows `sun.sun`, mirroring
the rendered images — previously the viewer showed every light at full
base brightness under a strong fixed ambient, no matter what HA said.

**0.3.6** makes every light cast shadows, in the rendered images and
in the panel's 3D viewer: each model light renders a shadow map
(point lights use cube maps), the sun casts too, and every model
mesh casts and receives. Off lights cast nothing, so they cost no
shadow passes. Shadow maps in the viewer update only when a light
or the sun changes, and motion clips render shadows once and freeze
them for the rest of the clip — re-rendering 14 cube maps every
frame would be 84 extra scene renders per frame. Renders take
longer with shadows on (a 1280×720 still with all 14 lights on is
roughly 13 seconds on the test machine, up from under a second).
0.3.6 also adds a `render_ms` attribute to each image entity: the
wall-clock milliseconds the service spent rendering that camera's
latest image (frames + encoding for clips), so you can see what the
shadows cost per camera. And 0.3.6 replaces the sample model with a
new 8-room house (14 lights, a TV driven by `scene.js`, one window
per room) plus an invisible shadow-casting ceiling — a mesh whose
material is named `ShadowOnly` renders as nothing but still casts
shadows, so the sun enters only through the windows. Meshes whose
materials are all transparent (glass) cast no shadow. 0.3.6 also
lets you pin the sun with `sun_elevation` + `sun_azimuth` in the
YAML — a fixed high sun instead of following `sun.sun`, handy in
winter when the real sun never gets high — adds door openings and a
ceiling fan (script-driven, spins when its light is on) to the
sample house, maps the TV as a light (`living_room_tv`, driven by
its mapped entity when the TV is off and by `scene.js` when it is
on), and fixes scene.js in the default backend: an SES import bug
had silently disabled user scripts under node-webgl, so scene.js
only ever ran under the Puppeteer fallback.

**0.3.7** makes shadows per-light soft: each point
light gets a shadow map size (512, 1024, or 2048) from a
deterministic hash of its name, so some lights cast soft shadows
and others crisp ones — stable across renders because the hash only
depends on the name. The panel viewer does the same one step
lighter (256/512/1024). 0.3.7 also fixes a shadow bug: a light the
script lights on its own (the TV glow while its mapped entity is
off) now shines and casts shadows — visibility and shadow casting
follow the light's effective intensity after the script runs, not
the mapped entity's on/off. Cameras can now be orthographic: `projection:
orthographic` + `ortho_size` (frustum height in metres, default:
fit the model) in `cameras.yaml`, and the panel viewer adopts the
projection when you select the camera. A camera with no
`background` now renders TRANSPARENT where no geometry is visible
(alpha 0) instead of opaque black — a hex `background` still gives
an opaque backdrop, and clips keep the transparency too. Sheer
curtains behave like the real thing: a `SheerCurtain` mesh casts a
dithered partial shadow (~45% of the sun gets through, broken up
like a weave), glows warm when the sun is on its side, and
`curtain_glow_*` lights (diffuse re-emission, never casting
shadows) are driven from the sun by `scene.js`. Sunlight bouncing
off the floor patch is emulated with one soft point light per
sunlit window — models mark their windows with empty
`window_<room>` nodes. The panel gains an Objects section (the fan
and TV screen, with their driving entities from the script's
`objectDrivers` export), clickable object markers in the 3D view, a
spinning fan, and a TV screen that shows/hides with the TV — and
the toggles are now emulation-only: flipping one sets a local
preview override in the viewer (marked "(preview)", cleared by
Reset preview) and never touches the real entity. A time-of-day
sun slider moves the viewer's sun to any time (computed from your
latitude/longitude), with a Live button to return to the real sun.
The panel also re-fetches its data when the frontend reconnects
after an HA restart, so a page loaded before the restart no longer
keeps a stale mapping or sun forever.

**0.3.8** adds an `objects` key to the YAML block: map model objects
to entities the same way `lights` maps lights (e.g. `ceiling_fan:
light.wizcolor1`) — mapped objects show in the panel's Objects
section with their driving entity and a toggle, and the integration
re-renders when a driver changes. A YAML object mapping wins over
the script's `objectDrivers` for the same object. 0.3.8 also
removes the `curtain_glow_*` lights 0.3.7 added: the curtain's glow
is its own material (warm emissive where the sun hits it) and the
room fill from a sunlit window is the bounce light — no separate
glow light sources, nothing to map. The sample model's TV light
moved to 4 cm in front of the screen face, so the glow reads as
coming from the screen itself. 0.3.8 also fixes the bounce lights
at a low sun: the patch is clamped to within 5 m of its window
(about one room) and the bounce fades to 0 as the patch approaches
that limit, so a low sun no longer throws the bounce into another
room — high-sun behaviour is unchanged. 0.3.8 also fixes point
lights leaking through thin interior walls: the point-light shadow
depth bias is gone (it punched through 0.10 m walls in the
perspective cube camera) and shadow acne is handled by the normal
bias alone.

## How lights are rendered

The scene script maps entities to lights (see [[Scene Scripting]]):
its `lightMapping` table says which entity drives each model light,
and its `update()` applies the table every frame — the bundled
`scene.example.js` has the standard apply logic, and a script that
only maps entities copies it verbatim. Each mapped entity is read as:

| Render parameter | From the entity |
| --- | --- |
| `on` | state is `on` (`unavailable` / `unknown` / `off` all render as off) |
| `brightness` (0–1) | `brightness` attribute / 255; absent for on/off-only lights (treated as 1.0) |
| `color` (RGB) | `rgb_color`, else `hs_color` converted, else `xy_color` converted |
| `color_temp_k` | `color_temp_kelvin`, else legacy `color_temp` mireds converted |

`color_mode` decides the priority when both a color and a temperature are present: `color_temp` mode uses the temperature, `hs` / `xy` / `rgb` modes use the color.

The script applies the parameters on top of the **model's base values**: the model's `KHR_lights_punctual` intensity is the "full brightness" look and its color is the default color.

- intensity = model base intensity × brightness (0 when off)
- color = entity color, else Kelvin→RGB of `color_temp_k`, else model color

A light not in `lightMapping` renders OFF — the script sets absolute
values for every light every frame, so nothing is ever left at the
model's base intensity by accident. (A script with no `lightMapping`
at all leaves every light at base — the old behaviour — until the
table is added.) One approximation to know about: in RGB color modes the brightness lives partly in the color itself (HA docs), so a natively-RGB light with a dark color renders slightly dimmer than its brightness value alone would suggest.

A light the user script lights on its own shines and casts shadows: after the script runs, each light's visibility and shadow casting follow its effective intensity (`visible = castShadow = intensity > 0`), not the mapped entity's on/off — so the TV glow shines and casts while its mapped entity is off (three.js skips invisible lights entirely, so syncing the shadow flag alone left a script-lit light dark). Each point light's shadow map size (512, 1024, or 2048) comes from a deterministic hash of its name, so some lights cast soft shadows and others crisp ones.

## Light positions in the image

Each image entity carries a `lights` attribute: the service projects every model light through that camera and the integration adds the mapped entity id and live state. One entry per model light:

| Field | Meaning |
| --- | --- |
| `name` | Model light name (e.g. `living_room_1`) |
| `entity_id` | Mapped HA entity, or `null` when unmapped |
| `state` | The entity's live state (`on`, `off`, `unavailable`, …), or `null` |
| `brightness` | The entity's live brightness, 0–1, or `null` |
| `x_px` / `y_px` | Position in the image, in pixels at the camera's configured resolution |
| `x_pct` / `y_pct` | Same position as percentages of the image size |
| `visible` | `true` when the light is in front of the camera and inside the frame |

The percentages are the stable values if the image is displayed scaled; the pixels refer to the image at its native resolution. A light in front of the camera but outside the frame reports its real projected position (outside 0–100%); a light behind the camera reports `null` coordinates. Positions are computed once per render (not per clip frame) from the camera the image was rendered with, including any `cameras.yaml` overrides. Occlusion is not detected: a light behind a wall from this camera still projects to its position in the image.

Use it to overlay markers or controls on the render — e.g. a picture-elements card with a `state-icon` per light positioned with `top`/`left` from `x_pct`/`y_pct`, or a template that reads the attributes. The attributes update on every render, so an automation that needs them should trigger on the image entity's state change.

Each image entity also carries a `render_ms` attribute: the wall-clock milliseconds the render service spent rendering that camera's latest image (frames + WebP encoding for clips). Useful to see what the shadows cost, or to spot a camera that renders slowly.

## The sun

With sun enabled, the service adds a directional light from `sun.sun`'s `azimuth` and `elevation` attributes: position, warm-to-neutral color by elevation, and intensity ramping in over the first 30° above the horizon. Below the horizon the sun is off and the interior lights carry the scene. Every light casts shadows — the sun and each model light (point lights use cube shadow maps); off lights cast nothing. Shadow maps in the panel viewer update only when a light or the sun changes, and motion clips render shadows once and freeze them for the rest of the clip.

Sheer curtains (`SheerCurtain` material) cast a dithered partial shadow — about 45% of the sun gets through, broken up like a weave — and glow warm when the sun is on their side (the glow is the curtain material's own emissive, where the sun hits it — there is no separate glow light). Sunlight bouncing off the floor patch is emulated with one soft point light per sunlit window (models mark their windows with empty `window_<room>` nodes); the bounce light never casts shadows — it is diffuse re-emission, not a point source. The patch stays within 5 m of its window (about one room) and the bounce fades to 0 as the patch approaches that limit, so a low sun never throws the bounce into another room. See [[Creating Your Own Scene]] for the conventions.

## Moonlight

At night the service adds a dim cool directional moonlight (see [[Sample Scene]] for the tuning). The coordinator computes the moon's position from a low-precision lunar ephemeris (Schlyter's algorithm, ~0.3°) using the home's latitude/longitude from the HA config and the current time, and passes it in the render payload as `moon: {elevation, azimuth}` — exactly like the `sun` field — and in `panel_data` for the sidebar viewer. The renderer's moon intensity keys off the *effective* sun elevation (the sun after any script or fixed-sun override): 0 while the sun is up, ramping to full as the sun drops to 12° below the horizon, 0 when the moon itself is below the horizon. Two interactions to know:

- **Fixed sun (`sun_elevation` + `sun_azimuth`):** a pinned daytime sun keeps the moon off all night, because the fade keys off the pinned elevation, not the real one. A pinned *night* sun (elevation below 0) lets the moon shine — with the real moon position for the current time.
- **Sun disabled (`sun_entity: null`):** the moon is off too — no sun state means no fade reference, so the coordinator sends no moon and the renderer falls back to the ambient `night` floor alone. The panel viewer behaves the same way.

The moon needs no re-render trigger of its own: the sun's 5° quantization already re-renders through the night (~every 20 min), refreshing the moon, which moves ~0.5°/hour. An older integration that sends no `moon` field renders exactly as if the moon were down (ambient floor only) — the field is optional.

Renders are debounced (~1 s after a light change), serialized, and at most one every ~2 s. The sun re-renders when its elevation crosses a 5° step, on sunrise/sunset, or at most every 15 minutes while it is up.

### Pinning the sun

In winter the real sun stays low all day, which makes for long raking
shadows and a dim interior. `sun_elevation` + `sun_azimuth` fix the
sun at one position instead of following `sun.sun`:

```yaml
scene_renderer:
  sun_elevation: 60
  sun_azimuth: 180
```

Both keys together or neither (one alone fails the config check).
Elevation is 0–90°, azimuth 0–360° (0 = north, 180 = south). A fixed
sun never changes, so the integration stops re-rendering on sun
updates; the panel viewer shows the same fixed sun, and the status
sensor reports `sun_elevation`, `sun_azimuth` and `sun_fixed: true`.
`sun.sun` is still sent to `scene.js` if the script reads it.

### North offset

The model is laid out with its north side facing true north: in
model coordinates north is −Z, east is +X, south is +Z, and azimuths
follow the HA convention (0° = north, 90° = east, 180° = south,
clockwise). If the real house is rotated relative to that — the
model's north side faces true east, say — the sun would shine
through the wrong windows. `north_offset` rotates the sun (and the
moon) into the model frame: set it to the true-north azimuth the
model's north side faces, in degrees (0–360, default 0 = the model
is laid out true-north-up):

```yaml
scene_renderer:
  north_offset: 90   # the model's north side faces true east
```

The offset applies everywhere the sun and moon are placed: the live
sun, the fixed sun pin above (the pin is a true-north azimuth, so it
rotates too), the moon, and the panel viewer (sun slider, sun marker,
curtain glow, bounce lights) — so the renders and the panel always
agree. The scene script sees model-frame azimuths: `scene.getSun()`
returns the azimuth *after* the offset is applied (see [[Scene
Scripting]]). 0 leaves everything exactly as before.

## Where your files live

All user files live under `/share/scene-renderer/` on the HA host (the app maps `share:rw`):

| Path | What it is |
| --- | --- |
| `/share/scene-renderer/models/*.glb` | Your own models — set the app's `model` option to the file name |
| `/share/scene-renderer/cameras.yaml` | Per-camera overrides (optional, hot-reloaded) |
| `/share/scene-renderer/scene.js` | Your scene script (optional, hot-reloaded) |

## Per-camera configuration (`cameras.yaml`)

Optionally, place a `cameras.yaml` in `/share/scene-renderer/` to override per-camera properties. Keys are camera names as enumerated by `GET /cameras` (model cameras and built-in virtual cameras alike). A commented example ships in the repo as `scene-renderer/cameras.example.yaml` — copy it to `/share/` and edit.

```yaml
overview:
  width: 1280
  height: 720
  fov: 50              # perspective only: override model's vertical FOV (degrees)
  projection: perspective  # or orthographic (see below)
  ortho_size: 17.18    # orthographic only: frustum height in metres (default: fit the model)
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

A camera with no `background` (null, or the key absent) renders
TRANSPARENT where no geometry is visible — alpha 0 — instead of an
opaque color; a hex value still gives an opaque backdrop, and clips
keep the transparency too. An orthographic camera renders with a
parallel projection: `ortho_size` is the frustum height in metres
(the width follows from the aspect ratio), defaulting to the model's
bounding-sphere diameter so the whole model fits. A native
orthographic glTF camera keeps its own frustum unless `ortho_size`
is set. The panel viewer adopts a camera's projection when you select
it.

All fields are optional. Merge precedence: **file value > model value** (FOV / near / far / position / target from the glTF camera or the computed virtual camera) **> global default** (width/height from the app options; background = scene default; exposure = 1.0). `GET /cameras` returns the effective merged config per camera.

The sample model's `overview` camera is an angled 3/4 aerial from the south-west (glTF (-12, 14, 12), ~39.5° elevation) — a dollhouse view instead of a flat plan. To get the old straight top-down view back, pin the position in `cameras.yaml`:

```yaml
overview:
  position: [0, 18, 0]
  target: [0, 0, 0]
```

The file is hot-reloaded: the app watches it and picks up changes without a restart (the log says whether the reload succeeded). It never breaks rendering: an unknown camera name is logged and ignored, invalid values for one camera fall back to defaults for that camera only, and a malformed file keeps the last good config. One exception: an invalid `clip:` entry (duration 0.5–30, fps 1–30 as an integer, 2–300 frames total) drops the **whole camera entry** to defaults — check the log for `cameras.yaml` errors if a clip camera renders a still.

See [[Motion Clips]] for what `clip:` does.

## Render service API

The app listens on port 3000 inside the container (no host port mapping needed — HA reaches it on the internal network).

- `GET /health` — status, backend, model, scene lights, cameras, animations, user-script status, uptime, render count.
- `GET /lights` — scene lights from the loaded model: `name`, `type` (`point` / `spot` / `directional`), `position`, `color` (hex), `intensity` (base, candela).
- `GET /cameras` — scene cameras with their effective config (model + `cameras.yaml` + defaults merged): `name`, `type` (`perspective` / `orthographic`), `fov`, `near`, `far`, `position`, `target`, `width`, `height`, `background`, `exposure`, `clip` (`{duration, fps, frames}` or `null`), `source` (`model` / `builtin`), `projection` (effective projection, `perspective` / `orthographic`), `ortho_size` (frustum height in metres for orthographic cameras, or `null`).
- `GET /script` — user-script status: `present`, `hash`, `subscribe`, `object_drivers` (model object name → driving entity), `status` (`none` / `ok` / `error`), `error`, `last_error`, `error_count`.
- `GET /model` — the loaded model GLB bytes (used by the sidebar panel through the integration's proxy; alias of `/model.glb`, which the Puppeteer render page uses).
- `POST /render` — JSON body, returns one image per requested camera (PNG still, or animated WebP for clip cameras) plus the projected light positions per camera and the script status:

```json
{
  "lights": {
    "living_room_1": {
      "on": true, "brightness": 0.8,
      "color": [255, 180, 120], "color_temp_k": null
    }
  },
  "sun": {"azimuth": 210, "elevation": 35},
  "moon": {"azimuth": 90, "elevation": 30},
  "north_offset": 90,
  "weather": "rainy",
  "entities": {
    "sun.sun": {"state": "above_horizon", "attributes": {"elevation": 35, "azimuth": 210}}
  },
  "cameras": ["overview", "living_room"]
}
```

Response: `{"renders": {"overview": {"data": "<base64>", "content_type": "image/png", "lights": [{"name": "living_room_1", "x_px": 606, "y_px": 212, "x_pct": 47.3, "y_pct": 29.4, "visible": true}]}, "living_room": {"data": "<base64>", "content_type": "image/webp", "lights": [...]}}, "script": {...}}`. `lights` is the per-camera projection of the model lights into image coordinates (see Light positions above): computed once per render, `visible` when the light is in frame, `null` coordinates when it is behind the camera. `render_ms` is the wall-clock milliseconds that camera's render took (frames + encoding for clips). Any of `lights`, `sun`, `moon`, `north_offset`, `weather`, `entities`, `cameras` may be omitted; omitting `cameras` renders all cameras. `sun: null` disables the sun for that render; omitting `moon` (or `moon: null`) renders with no moonlight. `north_offset` (degrees, default 0) rotates the true-north sun/moon azimuths into the model frame (see North offset above). `weather` is one of `sunny` (default), `overcast`, `rainy`, `snowy` — a preset that dims the sun, flattens the hemisphere fill, tints the clear color, and (for rain and snow) adds falling particles outside the house; an unknown name falls back to `sunny`. The integration never sends `weather`, so renders are always sunny unless you call the API directly. Unknown camera names are ignored; a request with no known cameras returns HTTP 400. Per-camera size, FOV, position, background, exposure, and clip come from the effective camera config (see `cameras.yaml` above), not the request.
