# HA Scene Renderer

Renders a 3D model of your home, lit by your real Home Assistant lights and the real sun, and exposes the render as a live image in Home Assistant. Turn a light on, change its brightness or color — the render follows within a second or two.

## How it works

Two parts, one repository:

| Part | What it is | Installed via |
| --- | --- | --- |
| **Add-on** (`scene-renderer/`) | Node.js + three.js render service in a container, managed by the Supervisor like Node-RED | Add-on store (custom repository) |
| **Integration** (`custom_components/scene_renderer/`) | Watches your lights + `sun.sun`, sends their state to the add-on, exposes the render | HACS / Marketplace (custom repository) |

The integration normalizes each mapped light entity into on/brightness/color/color-temperature parameters, sends them (plus the sun and any entities your `scene.js` subscribes to) to the add-on in one batch render request, and the add-on returns one image per camera — a PNG still, or a looping animated WebP clip for cameras with a `clip:` entry. Each camera is its own image entity in Home Assistant.

## Pages

- [[Installation]] — add-on first, then the integration, in that order
- [[Configuration]] — the three-step setup flow, the options flow, and `cameras.yaml`
- [[Sample Scene]] — the bundled apartment model: rooms, lights, cameras, fan, blinds
- [[Creating Your Own Scene]] — build a GLB, name its lights and cameras, drop it in
- [[Scene Scripting]] — drive the scene from any HA entity with `scene.js`
- [[Motion Clips]] — looping animated WebP renders, per camera
- [[Troubleshooting]] — the errors you'll actually hit, and what fixes them

The repo README covers the same ground in condensed form; this wiki is the long version. Current version: **0.2.0**.
