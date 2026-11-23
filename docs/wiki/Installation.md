# Installation

## Requirements

- Home Assistant with the **Supervisor** (Home Assistant OS or Supervised) — the render service runs as an add-on.
- **HACS** (or Settings → Marketplace on HA 2026.11+) for the integration.
- Home Assistant **2025.1.0** or newer (per the integration manifest).

## Install order matters: add-on first

The integration's setup flow reads the model's lights from the render service, so the add-on must be installed and running **before** you add the integration. If it isn't, setup stops at step 1 with an error telling you to install and start the add-on first.

## Step 1 — the add-on

1. Settings → Add-ons → Add-on Store → ⋮ → **Repositories**, add `https://github.com/koneho-ai/ha-scene-renderer`.
2. Install **HA Scene Renderer**, then **Start** it.
3. The add-on log should say `ready (backend: node-webgl, 5 scene lights, 2 cameras)`.

The add-on image is `ghcr.io/koneho-ai/ha-scene-renderer` (multi-arch: amd64 + aarch64, Cosign-signed), published by CI on each release. The package is public, so the Supervisor pulls it without credentials.

Add-on options (all optional — the defaults render the sample apartment):

| Option | Default | Notes |
| --- | --- | --- |
| `model` | `sample-apartment.glb` | File name in `/share/scene-renderer/models/`, a bundled model, or a literal path |
| `width` / `height` | `1280` / `720` | Default render size for all cameras (320–3840 × 240–2160); per-camera overrides in `cameras.yaml` |
| `log_level` | `info` | `trace` … `fatal` |

The service listens on port 3000 inside the container. Home Assistant reaches it on the internal network, so no host port mapping is needed — the port is offered in the Network panel for debugging only. The add-on maps `share:rw`, so it can read your files under `/share/scene-renderer/`.

## Step 2 — the integration

1. HACS (or Settings → Marketplace on HA 2026.11+) → ⋮ → **Custom repositories**, add `https://github.com/koneho-ai/ha-scene-renderer` (category: **Integration**), then install **HA Scene Renderer** and restart Home Assistant.
2. Settings → Devices & Services → **Add Integration** → **HA Scene Renderer**.

Setup is three steps, no free text — see [[Configuration]].

## What you get in Home Assistant

- `image.<name>_<camera>` — one image entity per selected camera (e.g. `image.scene_renderer_overview`), each serving that camera's latest render.
- `sensor.<name>_render_status` (diagnostic) — `idle`, `rendering`, `ok`, or `error`, with last render time, render count, last render duration, last error, service URL, cameras, mapped light count, and the user script's status.
- `button.<name>_re_render` (diagnostic) — force a re-render.
