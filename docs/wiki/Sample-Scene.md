# Sample Scene

The bundled sample model is a small house built in Blender (`scripts/generate_sample_model_blender.py` in the repo, with the source `scripts/house-v2.blend`). It is a draft on purpose: the room layout is a simple grid and the furniture is low-poly boxes, so the focus is on the number of entities and the lighting behaviour, not on realism. Room shapes come later.

## Layout

8 rooms in a 4×2 grid, 15 × 8 m footprint, 2.5 m walls, no visible roof (dollhouse style):

| Row | Rooms (left → right) |
| --- | --- |
| North | living room 5×4 m, dining 4×4 m, kitchen 3×4 m, office 3×4 m |
| South | bedroom 5×4 m, kids' bedroom 4.5×4 m, bathroom 1 2.75×4 m, bathroom 2 2.75×4 m |

Every room has one window opening (1.2 × 1.2 m, sill 0.9 m) on its exterior wall — a real hole in the wall, no glass yet. Door openings (0.9 × 2.1 m, with lintels) connect every pair of adjacent rooms, and a front door with a closed slab sits in the middle of the south facade. A ceiling fan (`ceiling_fan` group: hub + 4 blades) hangs in the living room; `scene.js` spins it when its light is on. Furniture is simple boxes: couch + TV in the living room, beds in the bedrooms, table + 4 chairs in the dining room, desk + chair in the office, counter + fridge in the kitchen, tub + sink in each bathroom. 178 meshes, 2,216 triangles.

## The invisible ceiling

The model has a ceiling slab over the whole footprint at 2.5 m, in its own `ShadowCeiling` collection, with a material named `ShadowOnly`. It renders as nothing — the top-down view stays open — but it casts shadows, so the sun can only enter through the windows. See [[Creating Your Own Scene]] for the convention. (The live deployment on 0.3.4 runs a no-ceiling variant, because the ceiling handling ships with the next release.)

## The 14 named lights

One light per room light, with generic names — no HA entity names are baked into the model. The bathrooms have no lights (there are no bathroom lights in Home Assistant to map them to).

| Name | Room | Position (m) | Color | Intensity |
| --- | --- | --- | --- | --- |
| `living_room_1` | Living room | (-6.5, 2.3, -1) | warm white #fff3e1 | 45 |
| `living_room_2` | Living room | (-3.5, 2.3, -1) | warm white #fff3e1 | 45 |
| `living_room_3` | Living room | (-6.5, 2.3, -3) | warm white #fff3e1 | 45 |
| `living_room_4` | Living room | (-3.5, 2.3, -3) | warm white #fff3e1 | 45 |
| `kitchen_1` | Kitchen | (3, 2.3, -2) | near white #fffcf3 | 40 |
| `dining_1` | Dining | (-0.5, 2.3, -2) | warm white #fff3e1 | 40 |
| `bedroom_1` | Bedroom | (-5, 2.3, 2) | warm #fff1da | 35 |
| `kids_bedroom_1` | Kids' bedroom | (-1.5, 2.3, 1) | warm #fff1da | 35 |
| `kids_bedroom_2` | Kids' bedroom | (1, 2.3, 1) | warm #fff1da | 35 |
| `kids_bedroom_3` | Kids' bedroom | (-1.5, 2.3, 3) | warm #fff1da | 35 |
| `kids_bedroom_4` | Kids' bedroom | (1, 2.3, 3) | warm #fff1da | 35 |
| `office_1` | Office | (5.5, 2.3, -1.2) | warm white #fff9f1 | 35 |
| `office_2` | Office | (6.5, 2.3, -2.8) | warm white #fff9f1 | 35 |
| `living_room_tv` | Living room (TV glow) | (-3.16, 1.1, -2) | white | 14 (mapped as a light; script animates it when the TV is on) |

All point lights at ceiling height (2.3 m), except the TV light, which sits 0.5 m in front of the TV screen at 1.1 m. Intensities are candela (physical units, three.js r155+ default).

## The TV

The living room TV is a dark body (1.3 × 0.75 m) against the east wall with a separate `tv_screen` mesh (pale blue-white emissive material) and the `living_room_tv` point light in front of it. The light is mapped as a light in the YAML, so its entity drives the glow when the TV is off; the bundled `scene.example.js` takes over when the TV is on (Plex client playing/paused/idle): screen visible + light glowing in slowly shifting colors; TV off → screen dark, light back to its mapped value. See [[Scene Scripting]].

## The 2 named cameras

| Name | Position (m) | FOV | Framing |
| --- | --- | --- | --- |
| `overview` | (0, 11.5, 13.5) | 32° | Isometric dollhouse view from the south |
| `living_room` | (-7.05, 2.2, -0.25) | 32° | Inside the living room, facing the TV |

Each camera is its own image entity in Home Assistant (e.g. `image.scene_renderer_overview`).

## Regenerating the model

```bash
blender --background --python scripts/generate_sample_model_blender.py
```

All dimensions live in the `PARAMETERS` block at the top of the script. The script exports two files: `house-v2.glb` (with the shadow ceiling — the repo sample) and `house-v2-noceiling.glb` (without it, for app versions before the ceiling handling).
