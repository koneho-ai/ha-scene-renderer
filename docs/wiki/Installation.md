# Installation

> **Note:** Home Assistant renamed add-ons to apps in a recent release. If your Home Assistant still shows "Add-ons" / "Add-on Store", it's the same thing.

## Requirements

- Home Assistant with the **Supervisor** (Home Assistant OS or Supervised) — the render service runs as an app.
- **HACS** (or Settings → Marketplace on HA 2026.11+) for the integration.
- Home Assistant **2025.1.0** or newer (per the integration manifest).

## Install order matters: app first

The integration discovers the app through the Supervisor at startup, so the app must be installed and running **before** Home Assistant starts with the YAML block. If it isn't, setup fails with an error in the log telling you to install and start the app first (or set `service_url` in the YAML block).

## Step 1 — the app

1. Settings → Apps → App Store → ⋮ → **Repositories**, add `https://github.com/koneho-ai/ha-scene-renderer`.
2. Install **HA Scene Renderer**, then **Start** it.
3. The app log should say `ready (backend: node-webgl, 5 scene lights, 2 cameras)`.

The app image is `ghcr.io/koneho-ai/ha-scene-renderer` (multi-arch: amd64 + aarch64, Cosign-signed), published by CI on each release. The package is public, so the Supervisor pulls it without credentials.

App options (all optional — the defaults render the sample apartment):

| Option | Default | Notes |
| --- | --- | --- |
| `model` | `sample-apartment.glb` | File name in `/share/scene-renderer/models/`, a bundled model, or a literal path |
| `width` / `height` | `1280` / `720` | Default render size for all cameras (320–3840 × 240–2160); per-camera overrides in `cameras.yaml` |
| `log_level` | `info` | `trace` … `fatal` |

The service listens on port 3000 inside the container. Home Assistant reaches it on the internal network, so no host port mapping is needed — the port is offered in the Network panel for debugging only. The app maps `share:rw`, so it can read your files under `/share/scene-renderer/`.

## Step 2 — the integration

1. HACS (or Settings → Marketplace on HA 2026.11+) → ⋮ → **Custom repositories**, add `https://github.com/koneho-ai/ha-scene-renderer` (category: **Integration**), then install **HA Scene Renderer** and restart Home Assistant.

## Step 3 — YAML configuration

The integration is YAML-only — there is no UI setup flow. Add a `scene_renderer` block to `configuration.yaml` and restart Home Assistant:

```yaml
scene_renderer:
  entities:
    - light.living_room
    - light.kitchen
```

Every key is optional — a bare `scene_renderer:` line works. The YAML
only lists the entities to subscribe to; the light→entity mapping
lives in the scene script (`scene.js`) as a `lightMapping` table —
see [[Configuration]] for the full reference and the 0.2.x migration
notes.

## What you get in Home Assistant

- `image.<name>_<camera>` — one image entity per selected camera (e.g. `image.scene_renderer_overview`), each serving that camera's latest render.
- `sensor.<name>_render_status` (diagnostic) — `idle`, `rendering`, `ok`, or `error`, with last render time, render count, last render duration, last error, service URL, cameras, mapped light count, and the user script's status.
- `button.<name>_re_render` (diagnostic) — force a re-render.
