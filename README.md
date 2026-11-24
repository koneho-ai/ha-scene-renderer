# HA Scene Renderer

Renders a 3D model of your home, lit by your real Home Assistant lights
and the real sun, and exposes the render as a live image in Home Assistant.
Turn a light on, change its brightness or color — the render follows within
a second or two.

Two parts, one repository:

| Part | What it is | Installed via |
| --- | --- | --- |
| **App** (`scene-renderer/`) | Node.js + three.js render service in a container, managed by the Supervisor like Node-RED | App store (custom repository) |
| **Integration** (`custom_components/scene_renderer/`) | Watches your lights + `sun.sun`, sends their state to the app, exposes the render | HACS / Marketplace (custom repository) |

```
Home Assistant host
┌──────────────────────────────────────────────────────────────────┐
│  ┌────────────────────────┐    HTTP     ┌──────────────────────┐ │
│  │ HA Core                │  ─────────► │ scene-renderer       │ │
│  │  scene_renderer        │  {lights +  │ add-on (Node.js)     │ │
│  │  integration           │   sun +     │  three.js render     │ │
│  │  image entities+status │  entities + │  service             │ │
│  └────────────────────────┘  cameras}   │  (+ scene.js script) │ │
│                          ◄────────── └──────────────────────┘ │
│              images, one per camera (PNG still or WebP clip)     │
└──────────────────────────────────────────────────────────────────┘
```

## Install (in this order)

> **Note:** Home Assistant renamed add-ons to apps in a recent release. If your Home Assistant still shows "Add-ons" / "Add-on Store", it's the same thing.

**1. The app first.** The integration cannot be set up until the
app is running — it discovers the app through the Supervisor.

- Settings → Apps → App Store → ⋮ → Repositories, add
  `https://github.com/koneho-ai/ha-scene-renderer`
- Install **HA Scene Renderer**, then **Start** it. The log should say
  `ready (backend: node-webgl, 5 scene lights, 2 cameras)`.

**2. Then the integration.**

- HACS (or Settings → Marketplace on HA 2026.11+) → ⋮ → Custom
  repositories, add `https://github.com/koneho-ai/ha-scene-renderer`
  (category: Integration), then install **HA Scene Renderer** and
  restart Home Assistant.

**3. Configure it in YAML.** The integration is YAML-only — there is
no UI setup flow. Add a `scene_renderer` block to
`configuration.yaml` and restart Home Assistant:

```yaml
scene_renderer:
  lights:
    living_room_1: light.living_room
    kitchen_1: light.kitchen
```

Every key is optional — a bare `scene_renderer:` line works, and the
app is discovered automatically. Only the lights you map follow live
state; unmapped lights render at their model defaults (full
brightness, model color), so the demo model needs no onboarding at
all.

| Key | Default | Notes |
| --- | --- | --- |
| `service_url` | discovered | Base URL of the render service. Only needed if Supervisor discovery fails (e.g. the app runs outside the Supervisor); usually something like `http://a1b2c3d4-scene-renderer:3000` |
| `sun_entity` | `sun.sun` | Sun entity to follow; set to `null` to disable the sun |
| `name` | `Scene Renderer` | Scene name, used for the device and entities |
| `lights` | `{}` | Mapping of model light names (e.g. `living_room_1`) to HA light entity ids |
| `objects` | `{}` | Mapping of model object names (e.g. `ceiling_fan`) to HA entity ids — the panel's Objects section lists them with their driving entity and a toggle |
| `cameras` | all | Camera names to expose, one image entity each; omit to expose every camera the app offers |

Changing the YAML needs a Home Assistant restart (standard for
YAML-only integrations). To remove the integration, delete the block
and restart.

> **Upgrading from 0.2.x?** The config flow is gone in 0.3.0: delete
> the old integration entry first (Settings → Devices & Services → HA
> Scene Renderer → ⋮ → Delete), then add the YAML block above with
> your light mapping and restart. Deleting first frees up the entity
> ids (`image.<name>_<camera>` etc.), so the YAML setup reuses them;
> if the old entry still exists when the YAML setup runs, the new
> entities get `_2` suffixes instead.
>
> **Upgrading from 0.3.0?** 0.3.0 registered bare entity ids
> (`image.overview`, `sensor.render_status`, `button.re_render`)
> because no device attaches to a YAML-only setup. 0.3.1 renames them
> to the scene-prefixed ids (`image.scene_renderer_overview`, …)
> automatically on the first restart after updating — no action
> needed, unless you built automations or dashboards on the bare ids,
> in which case update them to the new ids. 0.3.1 also fixes the
> sidebar panel leaving a black gap at the bottom of the page, and
> adds a toggle switch to each mapped light in the panel's light list
> so the render can be tested from the panel itself.
>
> **0.3.2** fixes a startup crash in 0.3.1 (`No module named
> 'homeassistant.util.slugify'` — the migration imported slugify from
> a submodule that doesn't exist in HA; it lives in
> `homeassistant.util`). If 0.3.1 left the entities unavailable and
> the panel missing, update to 0.3.2 and restart — the migration runs
> on setup and everything comes back under the new ids.
>
> **0.3.3** fixes the migration itself: 0.3.1/0.3.2 removed the bare
> registry entries, but HA stashes removed entries in
> `deleted_entities` and restores the old id when the entity is
> re-added, so the bare ids came straight back. 0.3.3 renames the
> entries in place instead, which sticks.
>
> **0.3.4** fixes the panel showing stale code after an update: the
> panel JS was served at a fixed URL, so browsers kept running the
> old cached copy (no toggles, black gap at the bottom) until a
> manual hard refresh. The module URL now carries the integration
> version, so every release loads fresh. 0.3.4 also makes the panel's
> 3D viewer use the real lighting: the model's lights now follow
> their mapped HA entities (on/off, brightness, color) and the sun
> follows `sun.sun`, mirroring the rendered images — previously the
> viewer showed every light at full base brightness under a strong
> fixed ambient, no matter what HA said.
>
> **0.3.6** makes every light cast shadows, in the rendered images and
> in the panel's 3D viewer: each model light renders a shadow map
> (point lights use cube maps), the sun casts too, and every model
> mesh casts and receives. Off lights cast nothing, so they cost no
> shadow passes. Shadow maps in the viewer update only when a light
> or the sun changes, and motion clips render shadows once and freeze
> them for the rest of the clip — re-rendering 14 cube maps every
> frame would be 84 extra scene renders per frame. Renders take
> longer with shadows on (a 1280×720 still with all 14 lights on is
> roughly 13 seconds on the test machine, up from under a second).
> 0.3.6 also adds a `render_ms` attribute to each image entity: the
> wall-clock milliseconds the service spent rendering that camera's
> latest image (frames + encoding for clips), so you can see what the
> shadows cost per camera. And 0.3.6 replaces the sample model with a
> new 8-room house (14 lights, a TV driven by `scene.js`, one window
> per room) plus an invisible shadow-casting ceiling — a mesh whose
> material is named `ShadowOnly` renders as nothing but still casts
> shadows, so the sun enters only through the windows. Meshes whose
> materials are all transparent (glass) cast no shadow. 0.3.6 also
> lets you pin the sun with `sun_elevation` + `sun_azimuth` in the
> YAML — a fixed high sun instead of following `sun.sun`, handy in
> winter when the real sun never gets high — adds door openings and a
> ceiling fan (script-driven, spins when its light is on) to the
> sample house, maps the TV as a light (`living_room_tv`, driven by
> its mapped entity when the TV is off and by `scene.js` when it is
> on), and fixes scene.js in the default backend: an SES import bug
> had silently disabled user scripts under node-webgl, so scene.js
> only ever ran under the Puppeteer fallback.
>
> **0.3.7** makes shadows per-light soft: each point
> light gets a shadow map size (512, 1024, or 2048) from a
> deterministic hash of its name, so some lights cast soft shadows
> and others crisp ones — stable across renders because the hash only
> depends on the name. The panel viewer does the same one step
> lighter (256/512/1024). 0.3.7 also fixes a shadow bug: a light the
> script lights on its own (the TV glow while its mapped entity is
> off) now shines and casts shadows — visibility and shadow casting
> follow the light's effective intensity after the script runs, not
> the mapped entity's on/off. Cameras can now be orthographic: `projection:
> orthographic` + `ortho_size` (frustum height in metres, default:
> fit the model) in `cameras.yaml`, and the panel viewer adopts the
> projection when you select the camera. A camera with no
> `background` now renders TRANSPARENT where no geometry is visible
> (alpha 0) instead of opaque black — a hex `background` still gives
> an opaque backdrop, and clips keep the transparency too. Sheer
> curtains behave like the real thing: a `SheerCurtain` mesh casts a
> dithered partial shadow (~45% of the sun gets through, broken up
> like a weave), glows warm when the sun is on its side, and
> `curtain_glow_*` lights (diffuse re-emission, never casting
> shadows) are driven from the sun by `scene.js`. Sunlight bouncing
> off the floor patch is emulated with one soft point light per
> sunlit window — models mark their windows with empty
> `window_<room>` nodes. The panel gains an Objects section (the fan
> and TV screen, with their driving entities from the script's
> `objectDrivers` export), clickable object markers in the 3D view, a
> spinning fan, and a TV screen that shows/hides with the TV — and
> the toggles are now emulation-only: flipping one sets a local
> preview override in the viewer (marked "(preview)", cleared by
> Reset preview) and never touches the real entity. A time-of-day
> sun slider moves the viewer's sun to any time (computed from your
> latitude/longitude), with a Live button to return to the real sun.
> The panel also re-fetches its data when the frontend reconnects
> after an HA restart, so a page loaded before the restart no longer
> keeps a stale mapping or sun forever.
>
> **0.3.8** adds an `objects` key to the YAML block: map model objects
> to entities the same way `lights` maps lights (e.g. `ceiling_fan:
> light.wizcolor1`) — mapped objects show in the panel's Objects
> section with their driving entity and a toggle, and the integration
> re-renders when a driver changes. A YAML object mapping wins over
> the script's `objectDrivers` for the same object. 0.3.8 also
> removes the `curtain_glow_*` lights 0.3.7 added: the curtain's glow
> is its own material (warm emissive where the sun hits it) and the
> room fill from a sunlit window is the bounce light — no separate
> glow light sources, nothing to map. The sample model's TV light
> moved to 4 cm in front of the screen face, so the glow reads as
> coming from the screen itself. 0.3.8 also fixes the bounce lights
> at a low sun: the patch is clamped to within 5 m of its window
> (about one room) and the bounce fades to 0 as the patch approaches
> that limit, so a low sun no longer throws the bounce into another
> room — high-sun behaviour is unchanged. 0.3.8 also fixes point
> lights leaking through thin interior walls: the point-light shadow
> depth bias is gone (it punched through 0.10 m walls in the
> perspective cube camera) and shadow acne is handled by the normal
> bias alone.

## What you get in Home Assistant

- `image.<name>_<camera>` — one image entity per selected camera
  (e.g. `image.scene_renderer_overview`), each serving that camera's
  latest render — a PNG still, or a looping animated WebP clip for
  cameras with a `clip:` entry in `cameras.yaml`. Each image entity
  also carries a `lights` attribute: every model light's position in
  that camera's image (pixels + percentages + in-frame flag), with the
  mapped entity id and live state — see Light positions below.
- **Scene Renderer** in the sidebar — an interactive 3D view of the
  model with live light and camera markers (see Sidebar panel below).
- `sensor.<name>_render_status` (diagnostic) — `idle`, `rendering`,
  `ok`, or `error`, with last render time, render count, last render
  duration, last error, service URL, cameras, mapped light count, and
  the user script's status (hash, subscriptions, last error).
- `button.<name>_re_render` (diagnostic) — force a re-render.

Each update is one batch render request (lights + sun + subscribed
entities + cameras) that returns one image per camera. Renders are
debounced (~1 s after a light change), serialized, and at most one
every ~2 s. The sun re-renders when its elevation crosses a 5° step,
on sunrise/sunset, or at most every 15 minutes while it is up. A
camera with a `clip:` entry renders a looping animated WebP instead of
a still (see Motion clips below); the old clip keeps looping while the
new one renders.

## Sidebar panel

The integration adds a **Scene Renderer** entry to the sidebar: a
full-page interactive 3D view of the model, rendered in your browser
with three.js. No extra setup — it appears once the integration is
configured (and disappears if the integration is removed).

- **Orbit the model** — drag to rotate, scroll to zoom, right-drag to
  pan. The model is the same GLB the app renders.
- **Light markers** sit at each model light's position, colored by the
  light's live state: on lights show their current color and
  brightness, off/unavailable lights are dim gray, unmapped lights are
  neutral white. The markers update live as entities change.
- **Camera markers** show where each camera sits and where it points.
  Click one to jump the 3D viewer to that camera's viewpoint (adopting
  its projection — an orthographic camera views orthographic) and see
  its latest render. The side list shows every camera with its
  effective resolution.
- **Object markers** (purple) sit on the script-driven objects — the
  ceiling fan and the TV screen — so they are findable in the viewer.
  Click one for its driving entity and state.
- **Sun marker** — the sun's position from `sun.sun`, hidden below the
  horizon.
- **Side list** — every light (model name, mapped entity, live state),
  every script-driven object (object name, driving entity, live
  state), and every camera.
- **Emulation-only toggles** — the light and object toggles do NOT
  call any HA service: flipping one sets a local preview override in
  the viewer only, so you can try "what if this light were on" without
  touching the real house. Overridden rows are marked "(preview)";
  **Reset preview** (next to the Lights heading) clears all overrides
  and returns the viewer to the real entity states. Overrides are
  session-local (gone on reload) and never affect the renders. The fan
  spins in the viewer while its emulated state is on, and the TV toggle
  shows/hides the TV screen plus its light.
- **Time-of-day sun slider** — a Sun section with a 00:00–24:00 slider
  moves the viewer's sun to the chosen time (computed from your
  latitude/longitude, shown with its elevation/azimuth). **Live**
  returns to the real sun. Viewer-only: it never affects the renders
  or the real sun.

The panel gets the model from the app (through the integration — the
browser cannot reach the app directly) and the light mapping from the
integration, which is the only place that knows it. If the app is
unreachable the panel says so instead of showing a blank page. The
panel re-fetches its data (mapping, sun, cameras, script entities)
when the frontend reconnects after an HA restart, so a page loaded
before the restart picks up the new data without a manual reload.

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
Every light casts shadows — the sun and each model light (point lights
use cube shadow maps); off lights cast nothing. Each point light's shadow
map size (512, 1024, or 2048) comes from a deterministic hash of its name,
so some lights cast soft shadows and others crisp ones. Shadow maps in the
panel viewer update only when a light or the sun changes, and motion clips
render shadows once and freeze them for the rest of the clip.

Sheer curtains (`SheerCurtain` material) cast a dithered partial shadow —
about 45% of the sun gets through, broken up like a weave — and glow warm
when the sun is on their side (the glow is the curtain material's own
emissive, where the sun hits it — there is no separate glow light).
Sunlight bouncing off the floor patch is emulated with one soft point
light per sunlit window (models mark their windows with empty
`window_<room>` nodes); the bounce light never casts shadows — it is
diffuse re-emission, not a point source. The patch stays within 5 m
of its window (about one room) and the bounce fades to 0 as the patch
approaches that limit, so a low sun never throws the bounce into
another room. See
Creating Your Own Scene in the wiki for the conventions.

## Models

- Format: **GLB**. v1 ships a bundled sample house
  (`scene-renderer/models/sample-apartment.glb`, 8 rooms, 14 named
  lights, 2 named cameras, a TV driven by `scene.js`, and an invisible
  shadow-casting ceiling), built in Blender by
  `scripts/generate_sample_model_blender.py` (source
  `scripts/house-v2.blend` — re-run it to regenerate).
- **Naming convention:** lights are glTF `KHR_lights_punctual` lights
  with a unique `snake_case` `name` (e.g. `living_room_1`). That
  name is the identifier the integration maps to an HA entity. Every
  named punctual light in the model is an enumerable scene light.
  Cameras are glTF cameras with a unique `snake_case` name on both the
  camera definition and its node (e.g. `overview`, `living_room`).
- **Your own model:** put the `.glb` in `/share/scene-renderer/models/`
  on the HA host and set the app's `model` option to its file name,
  then restart the app. (The app maps `share:rw`.) Any GLB with
  named `KHR_lights_punctual` lights works; a model without cameras
  gets the three built-in virtual cameras (see below).
- The bundled sample has no visible ceiling (dollhouse style) so the
  overview camera sees inside — but it does have an invisible ceiling
  slab (material `ShadowOnly`) that casts shadows, so the sun enters
  only through the windows.

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

Which cameras render is chosen in the YAML `cameras` list — all
cameras by default.

### Light positions in the image

Each image entity carries a `lights` attribute: the service projects
every model light through that camera and the integration adds the
mapped entity id and live state. One entry per model light:

| Field | Meaning |
| --- | --- |
| `name` | Model light name (e.g. `living_room_1`) |
| `entity_id` | Mapped HA entity, or `null` when unmapped |
| `state` | The entity's live state (`on`, `off`, `unavailable`, …), or `null` |
| `brightness` | The entity's live brightness, 0–1, or `null` |
| `x_px` / `y_px` | Position in the image, in pixels at the camera's configured resolution |
| `x_pct` / `y_pct` | Same position as percentages of the image size |
| `visible` | `true` when the light is in front of the camera and inside the frame |

The percentages are the stable values if the image is displayed scaled;
the pixels refer to the image at its native resolution. A light in
front of the camera but outside the frame reports its real projected
position (outside 0–100%); a light behind the camera reports `null`
coordinates. Positions are computed once per render (not per clip
frame) from the camera the image was rendered with, including any
`cameras.yaml` overrides. Occlusion is not detected: a light behind a
wall from this camera still projects to its position in the image.

Use it to overlay markers or controls on the render — e.g. a
picture-elements card with a `state-icon` per light positioned with
`top`/`left` from `x_pct`/`y_pct`, or a template that reads the
attributes. (The attributes update on every render, so an automation
that needs them should trigger on the image entity's state change.)

Each image entity also carries a `render_ms` attribute: the wall-clock
milliseconds the render service spent rendering that camera's latest
image (frames + WebP encoding for clips). Useful to see what the
shadows cost, or to spot a camera that renders slowly.

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

All fields are optional. Merge precedence: **file value > model value**
(FOV / near / far / position / target from the glTF camera or the
computed virtual camera) **> global default** (width/height from the
app options; background = scene default; exposure = 1.0).
`GET /cameras` returns the effective merged config per camera.

The file is hot-reloaded: the app watches it and picks up changes
without a restart (the log says whether the reload succeeded). It
never breaks rendering: an unknown camera name is logged and ignored,
invalid values for one camera fall back to defaults for that camera
only, and a malformed file keeps the last good config.

### Motion clips

A camera with a `clip:` entry renders a looping animated WebP clip
instead of a still: `duration` × `fps` frames per loop (2..300 frames;
duration 0.5..30 s, fps 1..30). The clip uses the camera's configured
resolution, and the image entity serves it as `image/webp`. What moves
in a clip: glTF animations in the model (the sample apartment's
ceiling fan does one full turn per 3 s, so a 3 s clip loops seamlessly)
and anything `scene.js` animates (below). The state snapshot is frozen
for the whole clip — every frame sees the same light and entity state,
only the time changes — and a state change mid-clip aborts the frame
loop early so the new state renders instead. Cost: a 3 s clip at
10 fps is 30 frame renders (~6 s at 720p on a Pi-class host), so keep
clips short, small, and only where motion matters.

### Scripting (`scene.js`)

Optionally, place a `scene.js` in `/share/scene-renderer/` to drive
the scene from your Home Assistant entities. A commented example ships
as `scene-renderer/scene.example.js` (the sample model's TV follows the
Samsung TV's Plex client: on → screen visible + colorful glow, off →
dark). The file is hot-reloaded and can never
break rendering: a script that fails to compile keeps the last good
script running, and a throwing script only skips its own changes for
that frame; both show up in `/health`, `GET /script`, and the Render
status sensor.

```js
export const subscribe = ["media_player.plex_plex_for_samsung_tv_2023"];
export const objectDrivers = {
  tv_screen: "media_player.plex_plex_for_samsung_tv_2023",
  ceiling_fan: "light.wizcolor1",
};
export default function update({ entities, scene, time = 0 }) {
  const tv = entities["media_player.plex_plex_for_samsung_tv_2023"];
  const on = tv && (tv.state === "playing" || tv.state === "paused");
  scene.getObject("tv_screen").visible = !!on;
  const light = scene.getLight("living_room_tv");
  light.visible = !!on;
  light.intensity = on ? 14 : 0;
}
```

`subscribe` lists the entities the script reads (IDs, domains like
`light.*`, globs like `sensor.*_temperature`); the integration sends
only those (plus the mapped lights and `sun.sun`) and re-renders when
one changes. `objectDrivers` maps model object names to the entity
driving each one — the panel lists those objects in its Objects section
(with markers in the 3D view) and the integration re-renders when a
driver entity changes, even if it is not in `subscribe`. `time`
(seconds since the clip started) and `loop` (0..1 across one loop) are
optional — destructure only what you use. The script runs once per
frame, after the built-in mapping, sun, and glTF animations, and sets
**absolute** values (no `dt` parameter — a clip loops seamlessly when
every animated value is periodic over the loop). A light the script
lights on its own shines and casts shadows: after the script runs,
each light's visibility and shadow casting follow its effective
intensity, so setting `intensity` alone is enough. The scene API:
`getLight(name)` (`visible`, `intensity`, `color`),
`getObject(name)` (`position`, `rotation`, `scale`, `visible`,
`lookAt`), `getSun()`, `setMorph(object, morph, weight)`,
`kelvinToRgb(k)`, plus `hasLight` / `hasObject` / `listLights` /
`listObjects`. The script runs sandboxed in a SES Compartment: no
`process`, no `require`, no network, no imports, no `eval`.

## Render service API

The app listens on port 3000 inside the container (no host port
mapping needed — HA reaches it on the internal network).

- `GET /health` — status, backend, model, scene lights, cameras,
  animations, user-script status, uptime, render count.
- `GET /lights` — scene lights from the loaded model: `name`, `type`
  (`point` / `spot` / `directional`), `position`, `color` (hex),
  `intensity` (base, candela).
- `GET /cameras` — scene cameras with their effective config (model +
  `cameras.yaml` + defaults merged): `name`, `type`
  (`perspective` / `orthographic`), `fov`, `near`, `far`, `position`,
  `target`, `width`, `height`, `background`, `exposure`, `clip`
  (`{duration, fps, frames}` or `null`), `source`
  (`model` / `builtin`), `projection` (effective projection,
  `perspective` / `orthographic`), `ortho_size` (frustum height in
  metres for orthographic cameras, or `null`).
- `GET /script` — user-script status: `present`, `hash`, `subscribe`,
  `object_drivers` (model object name → driving entity), `status`
  (`none` / `ok` / `error`), `error`, `last_error`, `error_count`.
- `GET /model` — the loaded model GLB bytes (used by the sidebar panel
  through the integration's proxy; alias of `/model.glb`, which the
  Puppeteer render page uses).
- `POST /render` — JSON body, returns one image per requested camera
  (PNG still, or animated WebP for clip cameras) plus the projected
  light positions per camera and the script status:
  ```json
  {
    "lights": {
      "living_room_1": {
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
  Response:
  `{"renders": {"overview": {"data": "<base64>", "content_type": "image/png", "lights": [{"name": "living_room_1", "x_px": 606, "y_px": 212, "x_pct": 47.3, "y_pct": 29.4, "visible": true}]}, "living_room": {"data": "<base64>", "content_type": "image/webp", "lights": [...]}}, "script": {...}}`.
  `lights` is the per-camera projection of the model lights into image
  coordinates (see Light positions above): computed once per render,
  `visible` when the light is in frame, `null` coordinates when it is
  behind the camera.
  Any of `lights`, `sun`, `entities`, `cameras` may be omitted;
  omitting `cameras` renders all cameras. `sun: null` disables the sun
  for that render. Unknown camera names are ignored; a request with no
  known cameras returns HTTP 400. Per-camera size, FOV, position,
  background, exposure, and clip come from the effective camera config
  (see `cameras.yaml` above), not the request.

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

## App options

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
│   ├── brand/                              # integration icon + logo
│   ├── panel.py, frontend/             # sidebar panel (registration,
│   │                                   # model proxy, websocket API, viewer)
├── scene-renderer/                     # the add-on
│   ├── config.yaml, Dockerfile, run.sh # Supervisor packaging
│   ├── server.mjs, scene.mjs           # render service + shared three.js logic
│   ├── camera-config.mjs               # cameras.yaml hot-reload + merge
│   ├── cameras.example.yaml            # commented per-camera config example
│   ├── script.mjs, script-store.mjs    # scene.js sandbox + hot-reload
│   ├── clip-encode.mjs                 # animated WebP encoding (sharp)
│   ├── scene.example.js                # commented scene.js example
│   ├── backends/                       # node-webgl + puppeteer backends
│   ├── models/sample-apartment.glb     # bundled sample model
│   └── rootfs/                         # S6 service definition
└── scripts/generate_sample_model_blender.py  # sample model generator (Blender)
```

## Releasing

The app image is built and published by GitHub Actions
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
the image. Also note `config.yaml` already declares `image:`, so app
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

- The integration was tested against stubbed HA modules (light-state
  normalization, coordinator render loop, sun quantization, script
  subscriptions, clip content types) and end to end against a live
  render service — it has not run against a live Home Assistant yet.
  First install is the real test. In particular, an image entity
  serving an animated WebP has not been seen animating in the HA
  frontend yet.
- The render service was verified on a dev VM via the Puppeteer
  backend (Chromium + SwiftShader): `/health`, `/lights`, `/cameras`,
  `/script`, batch `/render` (PNG stills + animated WebP clips, frame
  counts and delays checked), `scene.js` hot-reload (including
  compile-error and throwing-script handling), and abort-on-new-state
  mid-clip. The `cameras.yaml` merge/validation, hot-reload watch, and
  malformed-file handling were verified live too. The node-webgl
  backend (the default) could not be installed on the dev VM and is
  validated by the app image build on real HA hardware.
- The app image build itself (Docker) was not run here — no Docker
  on the dev VM. The Dockerfile follows the current (post-April-2026
  BuildKit migration) conventions: base image pinned in the Dockerfile,
  no `build.yaml`, S6 service under `rootfs/`.

## License

MIT.
