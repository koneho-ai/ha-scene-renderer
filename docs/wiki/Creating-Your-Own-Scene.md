# Creating Your Own Scene

## Format: GLB

Models are **glTF 2.0 binary (.glb)**. Build one however you like — export from Blender (File → Export → glTF 2.0, format **GLB**), generate one in code (the sample house is built headless in Blender by `scripts/generate_sample_model_blender.py` in the repo), or convert from another format. Any GLB with named `KHR_lights_punctual` lights works.

## The naming conventions the integration relies on

**Lights.** Lights are glTF `KHR_lights_punctual` lights with a unique `snake_case` `name` (e.g. `living_room_1`). That name is the identifier the integration maps to an HA entity in the setup flow — every named punctual light in the model is an enumerable scene light, shown as one entity picker. Types supported: `point`, `spot`, `directional`. The model's intensity is the "full brightness" look and its color is the default color; the entity's brightness and color scale on top of them (see [[Configuration]]). Intensities are candela (physical units, three.js r155+ default).

In Blender, punctual lights export as `KHR_lights_punctual` when the exporter option is enabled (it is by default for point/spot/sun lights in recent Blender versions) — name the light object in Blender and the name carries into the glTF.

**Cameras.** Cameras are glTF cameras with a unique `snake_case` name set on **both** the camera definition and its node (e.g. `overview`, `living_room`). Three.js names a loaded camera from the definition's name, while model authors see the node name — set both so they agree. Position, look-at target, FOV, and clip planes come from the model, and can be overridden per camera in `cameras.yaml`. A camera can be orthographic instead of perspective: either a native orthographic glTF camera, or `projection: orthographic` + `ortho_size` (frustum height in metres, default: fit the model) in `cameras.yaml` — the panel viewer adopts the projection when you select the camera.

**If the model has no cameras**, you get three built-in virtual cameras computed from the model's bounding box, so they adapt to any size:

| Name | Framing |
| --- | --- |
| `overview` | Isometric dollhouse |
| `topdown` | Straight down, north up |
| `front` | Low front elevation |

**Objects for scripting.** Any named node (mesh, group, camera) can be moved, rotated, scaled, or hidden from `scene.js` via `scene.getObject(name)`. Note that only nodes with real transforms are usefully animatable: a group node carries a transform, while a mesh whose position is baked into its geometry does not. See [[Scene Scripting]]. To show an object in the panel's Objects section (with a marker in the 3D view), declare its driving entity in the script's `objectDrivers` export — `export const objectDrivers = { ceiling_fan: "light.wizcolor1" }` — and the panel lists it with a toggle for that entity.

**ShadowOnly material.** A mesh whose material is named `ShadowOnly` is invisible in the render but still casts shadows — the convention for a ceiling slab over a roofless dollhouse model, so the sun enters only through the windows while the top-down view stays open. Give the ceiling its own material named exactly `ShadowOnly` (in Blender: a material slot on the ceiling mesh with that name; the material's own color/roughness do not matter). The same rule applies in the sidebar panel viewer.

**Glass.** A mesh whose materials are all transparent (a glass pane) casts no shadow — transparent things do not block light. A mesh with any opaque material still casts. So window glass can be a real pane: it reads as glass in the render and lets the sun through.

**Sheer curtains.** A mesh whose material is named `SheerCurtain` is a sheer curtain: it casts a dithered partial shadow (about 45% of the sun gets through, broken up like a weave, instead of passing straight through like glass) and glows warm when the sun is on its side. The facing is derived from the mesh — its local +Z axis, signed away from the model center — so orient the curtain plane with +Z toward the outside (or the inside; the sign is derived, not assumed). In Blender, set the Alpha socket of the Principled BSDF to get `alphaMode: BLEND` on export — alpha only in the Base Color is ignored by the exporter and the curtain comes out opaque.

**Curtain glow lights.** Point lights named `curtain_glow_*` (e.g. `curtain_glow_living_room`, base intensity 0, placed just inside a curtained window) are the curtain's re-emitted light: they never cast shadows, and the bundled `scene.example.js` drives them from the sun — intensity from the sun's alignment with the window's side, warm color, 0 at night. The panel viewer drives them the same way. Guard with `hasLight` in your own script so models without them run clean.

**Window markers (bounce lights).** Empty nodes named `window_<room>` (one per window, at the window center) mark the windows for emulated indirect illumination: when the sun shines through a window, the renderer places one soft point light about 1 m above the bright patch on the floor, re-illuminating the room. The light never casts shadows, has a short range, and its intensity follows the sun × the window's transmission (bare 1.0, blinds ~0.5, sheer curtain ~0.35, by room) × the floor albedo. A model without markers gets no bounce, silently — nothing else changes.

## Installing your model

1. Put the `.glb` in `/share/scene-renderer/models/` on the HA host (create the folder if needed).
2. Set the app's `model` option to the file name and restart the app. (The option also accepts a bundled model name or a literal path.)
3. Update the `lights` mapping in the YAML block to the new model's light names (and the `cameras` list if you want to limit which cameras get image entities), then restart Home Assistant — the integration re-reads the light and camera lists from the app at startup.

## Tips

- Keep the model small and low-poly: rendering is software (CPU) on hosts without a GPU, and every render re-renders the whole scene.
- Leave the ceiling off (dollhouse style) if you want an overview camera to see inside — the sample apartment has no visible ceiling for exactly this reason. If you still want the sun to come only through the windows, add a ceiling slab with the `ShadowOnly` material (above): it blocks the sun from above without showing in the render.
- Model units are metres by convention; `cameras.yaml` positions and targets are in model units.
- If you want motion in clips, add glTF animations to the model, or animate lights/objects from `scene.js` with the `time`/`loop` parameters (the sample's TV glow does this) — see [[Motion Clips]] and [[Scene Scripting]].
