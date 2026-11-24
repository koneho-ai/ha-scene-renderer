# Sample Scene

The bundled sample model is a small house built in Blender (`scripts/generate_sample_model_blender.py` in the repo, with the source `scripts/house-v2.blend`). It is a draft on purpose: the room layout is a simple grid and the furniture is low-poly boxes, so the focus is on the number of entities and the lighting behaviour, not on realism. Room shapes come later.

## Layout

8 rooms in a 4×2 grid, 15 × 8 m footprint, 2.5 m walls, no visible roof (dollhouse style):

| Row | Rooms (left → right) |
| --- | --- |
| North | living room 5×4 m, dining 4×4 m, kitchen 3×4 m, office 3×4 m |
| South | bedroom 5×4 m, kids' bedroom 4.5×4 m, bathroom 1 2.75×4 m, bathroom 2 2.75×4 m |

Every room has one window opening (1.2 × 1.2 m, sill 0.9 m) on its exterior wall — a real hole in the wall, no glass yet. Door openings (0.9 × 2.1 m, with lintels) connect every pair of adjacent rooms, each closed by a wood slab (0.94 × 2.12 m) with frame and handle, so rooms are light-tight; a front door with a closed slab sits in the middle of the south facade. A ceiling fan (`ceiling_fan` group: hub + 4 blades) hangs in the living room; `scene.js` spins it when its light is on. Furniture is simple boxes: couch + TV in the living room, beds in the bedrooms, table + 4 chairs in the dining room, desk + chair in the office, counter + fridge in the kitchen, tub + sink in each bathroom. 284 meshes, 4,272 triangles. Surfaces are textured (6 Poly Haven CC0 sets — wood plank floors, plaster walls, tiled bathrooms, fabric couch and beds, wood furniture, marble kitchen counter; credits in `scripts/TEXTURES.md`).

## The invisible ceiling

The model has a ceiling slab over the whole footprint at 2.5 m, in its own `ShadowCeiling` collection, with a material named `ShadowOnly`. It renders as nothing — the top-down view stays open — but it casts shadows, so the sun can only enter through the windows. See [[Creating Your Own Scene]] for the convention.

## Window treatments

Each window has a treatment, west to east: sheer curtains (living room, bedroom), horizontal blinds semi-open (dining, kids' bedroom), vertical blinds semi-open (kitchen, bathroom 1), nothing (office, bathroom 2). The curtains use the `SheerCurtain` material — warm cream at alpha 0.8, deep rounded folds, a baked weave normal map — mostly opaque, translucent only where a single thin layer is backlit. They cast a dithered partial shadow (~46% of the sun gets through, broken up like a weave) and glow warm when the sun is on their side — see [[Creating Your Own Scene]] for the convention.

Empty `window_<room>` nodes at each window center let the renderer place one soft bounce light per sunlit window (the floor patch re-illuminating the room).

## The 14 named lights

One light per room light, with generic names — no HA entity names are baked into the model. The bathrooms have no lights (there are no bathroom lights in Home Assistant to map them to). Room-light intensities are randomized per light (seed 19, 27.8–49.1) so some read soft and others hard.

| Name | Room | Position (m) | Color | Intensity |
| --- | --- | --- | --- | --- |
| `living_room_1` | Living room | (-6.5, 2.3, -1) | warm white #fff5e0 | 49.11 |
| `living_room_2` | Living room | (-3.5, 2.3, -1) | warm white #fff2e7 | 45.37 |
| `living_room_3` | Living room | (-6.5, 2.3, -3) | warm white #fff1dc | 40.36 |
| `living_room_4` | Living room | (-3.5, 2.3, -3) | warm white #fff2dc | 39.71 |
| `kitchen_1` | Kitchen | (3, 2.3, -2) | near white #fffaf0 | 32.33 |
| `dining_1` | Dining | (-0.5, 2.3, -2) | warm white #fff1da | 41.61 |
| `bedroom_1` | Bedroom | (-5, 2.3, 2) | warm #fff1d7 | 29.61 |
| `kids_bedroom_1` | Kids' bedroom | (-1.5, 2.3, 1) | warm #fff3d8 | 38.85 |
| `kids_bedroom_2` | Kids' bedroom | (1, 2.3, 1) | warm #fff2dc | 27.82 |
| `kids_bedroom_3` | Kids' bedroom | (-1.5, 2.3, 3) | warm #fff2d6 | 32.98 |
| `kids_bedroom_4` | Kids' bedroom | (1, 2.3, 3) | warm #fff3dd | 42.00 |
| `office_1` | Office | (5.5, 2.3, -1.2) | warm white #fff7f1 | 42.68 |
| `office_2` | Office | (6.5, 2.3, -2.8) | warm white #fffbef | 38.81 |
| `living_room_tv` | Living room (TV glow) | (-2.70, 1.1, -2) | white | 14 (mapped as a light; script animates it when the TV is on) |

Room lights sit at ceiling height (2.3 m); the TV light sits 4 cm in front of the TV screen at 1.1 m, so the glow reads as coming from the screen itself. Intensities are candela (physical units, three.js r155+ default).

## The TV

The living room TV is a dark body (1.3 × 0.75 m) against the east wall with a separate `tv_screen` mesh (pale blue-white emissive material) and the `living_room_tv` point light in front of it. The light is mapped as a light in the YAML, so its entity drives the glow when the TV is off; the bundled `scene.example.js` takes over when the TV is on (Plex client playing/paused/idle): screen visible + light glowing in slowly shifting colors; TV off → screen dark, light back to its mapped value. See [[Scene Scripting]].

## The 2 named cameras

| Name | Position (m) | FOV | Framing |
| --- | --- | --- | --- |
| `overview` | (0, 18, 0) | 32° | Top-down view of the whole house (switchable to orthographic per camera in `cameras.yaml`) |
| `living_room` | (-7.05, 2.2, -0.25) | 32° | Inside the living room, facing the TV |

Each camera is its own image entity in Home Assistant (e.g. `image.scene_renderer_overview`).

## Regenerating the model

```bash
blender --background --python scripts/generate_sample_model_blender.py
```

All dimensions live in the `PARAMETERS` block at the top of the script. The script writes its outputs next to itself in `scripts/`: `house-v2.glb` (with the shadow ceiling — copy it to `scene-renderer/models/sample-apartment.glb` to update the bundled sample) and `house-v2-noceiling.glb` (without it, for app versions before the ceiling handling). Textures live in `scripts/textures/` (Poly Haven CC0, see `scripts/TEXTURES.md`); the curtain weave normal map is generated by `scripts/make_weave_normal.py`.
