# Changelog

## 0.3.11 — 2026-11-25
- Render-service restarts fixed (root cause: the kernel OOM killer): the service grew to ~750 MB RSS after its first render and the host killed it mid-render, so renders failed and images went stale — point-light shadow maps are now capped at 1024 px (was up to 2048, 96 MB per light; worst case 426 MB → 210 MB) and a light's shadow map is freed when it turns off, so memory tracks the lights actually on; sun/moon maps 2048 → 1024 px
- Objects section unlinked too: object rows show only the object name, live state and toggle — no driver entity underneath, and the marker-click info line shows no entity either
- Sidebar spacing: section titles were rendering at the browser-default 24 px with almost no gap above them (a stray duplicate `aside` block in the panel CSS swallowed the `aside h2` rule, and `aside h2:first-child` was also zeroing the top margin of every section title) — titles are 14 px uppercase again with 24 px above them, rows are roomier (8 px padding)

## 0.3.10 — 2026-11-25
- Panel shadow fix: the sun/moon shadow-camera projection matrix could freeze at the three.js default ±5 m frustum when a state update landed during the model load, so the sun's shadows covered only a 10×10 m box (random per reload) — the panel now calls `updateProjectionMatrix()` after setting the sun/moon and point-light shadow cameras
- Panel sidebar redesign: Entities on top with REAL controls (toggle calls the HA service, brightness slider calls `light.turn_on` on drag end); Lights below as debug-only model-light toggles (local preview, "(preview)" mark, Reset preview); the panel no longer shows which entity drives which light — the mapping lives in code

## 0.3.9 — 2026-11-24
- YAML `north_offset` (0–360°): rotate the sun and moon to match the real house orientation (renders + panel; the script sees model-frame azimuths)
- Panel season slider (day-of-year, 1–365) next to the time-of-day sun slider; Live resets both
- Panel weather emulator: sunny / overcast / rainy / snowy presets (sun dim, hemisphere, clear tint; real rain/snow particles outside the house, never inside); `weather` field on POST /render (service default sunny)
- Overview camera is now an angled 3/4 aerial view instead of top-down (still orthographic)
- Light→entity mapping moved from YAML `lights:` into scene.js (`lightMapping` table); YAML holds a flat `entities:` subscription list; panel gains an Entities section (real toggles since 0.3.10)
- Moonlight: dim cool directional moon (Schlyter ephemeris), fading in as the sun sets; ambient `night` floor keeps rooms dimly visible
- Soft shadows: PCFSoft → PCFShadowMap, per-light shadow blur radius (TV 16, others 1)
- `ha_light` glTF extras: area lights (TV screen as a RectAreaLight + point light for shadows) and ambient lights (day/night values)

## 0.3.8 — 2026-11-24
- YAML `objects` mapping (model objects → entities; YAML wins over script `objectDrivers`)
- Removed the `curtain_glow_*` lights (curtain glow is emissive only; room fill is the bounce light)
- Bounce patch clamped to 5 m from its window, fades to 0 between 3–5 m
- Point-light shadow leak fix: depth bias replaced by normal bias (no more light through 0.10 m walls)
- Closed-door house-v2 model (284 meshes, 4,272 triangles)

## 0.3.7 — 2026-11-24
- Script-lit lights (TV glow) now shine and cast shadows
- Per-light shadow map sizes by name hash (512/1024/2048; panel 256/512/1024)
- Panel Objects section (TV, fan), clickable markers, spinning fan
- Emulation-only panel toggles ("(preview)", Reset preview)
- Time-of-day sun slider (NOAA solar position, Live button)
- Orthographic cameras (`projection`, `ortho_size` in cameras.yaml)
- Sheer curtains: dithered partial shadow (~46% transmission), warm sun glow, `curtain_glow_*` lights
- Floor-patch bounce lights per `window_<room>` marker
- Transparent backgrounds (`background: null`)
- Panel re-fetches data on reconnect
- House-v2 sample model (curtains reworked, 8 window markers, 16 lights, textures; 234 meshes, 3,672 triangles)

## 0.3.6 — 2026-11-24
- Every light casts shadows (service + viewer); off lights cast nothing
- `render_ms` attribute per image entity
- ShadowOnly ceiling (sun enters only through windows); glass casts no shadow
- Fixed sun pin (`sun_elevation` + `sun_azimuth`)
- New 8-room sample house (14 lights, TV, fan, door openings)
- Fixed scene.js silently disabled under node-webgl (SES import bug)

## 0.3.5 — 2026-11-24
- Abandoned, never released (content shipped as 0.3.6)

## 0.3.4 — 2026-11-24
- Panel JS cache-busted by version query string
- Panel viewer uses real lighting (mapped entities + `sun.sun`)

## 0.3.3 — 2026-11-24
- Entity migration renames bare ids in place (0.3.1/0.3.2 removal was undone by HA's deleted-entities restore)

## 0.3.2 — 2026-11-24
- Fixed HA startup crash (`homeassistant.util.slugify` import)

## 0.3.1 — 2026-11-24
- Scene-prefixed entity ids (`image.scene_renderer_*`, …), auto-migrated from bare ids
- Panel black-gap fix (fills viewport)
- Per-light toggles in the panel

## 0.3.0 — 2026-11-23
- Sidebar panel: interactive 3D viewer (light/camera/sun markers)
- `lights` attribute on image entities (per-light pixel positions)
- YAML-only config, config flow removed (breaking change; delete the 0.2.x entry first when upgrading)
- Brand icon/logo; author Koneho; service `GET /model`

## 0.2.1 — 2026-11-23
- Fixed sharp native binary missing in the node-webgl image (startup crash loop)
- Render debounce max wait (5 s)
- Docs: "apps" (HA renamed add-ons)

## 0.2.0 — 2026-11-23
- Scene scripting (`scene.js`, SES sandbox, `update({ entities, scene, time, loop })`)
- Motion clips (per-camera `clip: {duration, fps}`, animated WebP)
- Sample model: ceiling fan + blinds

## 0.1.0 — 2026-11-23
- First release: HACS integration + Supervisor app, three.js renders lit by real lights and sun
- Multi-camera renders, cameras.yaml, light-mapping UI, sample apartment (5 lights)
