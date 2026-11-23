# Panel

The integration adds a **Scene Renderer** entry to the Home Assistant sidebar: a full-page interactive 3D view of the model, rendered in your browser with three.js. No extra setup — it appears once the integration is configured from YAML, and doesn't appear if the YAML block is removed.

## What you see

- **The model** — the same GLB the app renders, loaded from the app through the integration (the browser cannot reach the app directly). Drag to orbit, scroll to zoom, right-drag to pan.
- **Light markers** — one marker at each model light's position, colored by the light's live state: on lights show their current color and brightness, off/unavailable lights are dim gray, unmapped lights are neutral white. Markers update live as entities change.
- **Camera markers** — where each camera sits and where it points. Click one to see that camera's latest render. The side list shows every camera with its effective resolution.
- **Sun marker** — the sun's position from `sun.sun`, hidden while the sun is below the horizon.
- **Side list** — every light (model name, mapped entity, live state) and every camera.

## How it works

The panel is a custom element registered by the integration (`frontend.async_register_built_in_panel` with `component_name="custom"`). It runs inside the Home Assistant frontend, so it has the live `hass` object — light states come straight from the state machine, no polling.

Data comes from the integration, not the app: the app doesn't know the light mapping (it lives in the integration's YAML config), so the panel asks the integration over the websocket API:

- `scene_renderer/panel_entries` — the configured scenes (YAML-only: exactly one).
- `scene_renderer/panel_data` — for one scene: the light mapping (model light name → entity id), the cameras with their effective config, and the image entity id per camera.

The model itself comes from the app's `GET /model` endpoint, proxied by the integration at `/api/scene_renderer/<entry_id>/model` — the browser can't reach the app's internal address. The camera previews use the standard image proxy (`/api/image_proxy/<entity_id>`).

Three.js is vendored into the integration (`custom_components/scene_renderer/frontend/` — `three.module.js`, `OrbitControls.js`, `GLTFLoader.js` from the three package the app uses), so the panel works with no build step and no CDN.

## If the panel is empty or shows an error

- **"Not configured"** — no `scene_renderer` block in `configuration.yaml` yet. Add one (see [[Configuration]]) and restart Home Assistant.
- **"Render service unreachable"** — the app is down or its URL changed. Check the app is running (Settings → Apps → HA Scene Renderer) and the `service_url` in the YAML block (or that Supervisor discovery can find the app).
- **The panel entry is missing from the sidebar** — the panel registers when the integration is set up from YAML. Restart Home Assistant and check the sidebar again. A browser hard refresh (Ctrl+Shift+R) clears a stale frontend cache.
- **The model loads but markers are wrong** — markers come from the model the app currently has loaded. If you changed the app's `model` option, restart the app, then restart Home Assistant so the mapping matches the new model.
