# Textures — house-v2

All textures are CC0 from [Poly Haven](https://polyhaven.com/), downloaded
via https://api.polyhaven.com (no key needed). 1K albedo + 512 normal /
roughness (downscaled with PIL to keep the GLB small). Attribution is not
required for CC0, but recorded here for provenance.

| Asset | Poly Haven page | Used for |
|---|---|---|
| wooden_floor_02 | https://polyhaven.com/a/wooden_floor_02 | Wood plank floors (living, dining, bedrooms, office). 16 plank rows/tile, 2.4 m repeat → ~15 cm planks |
| painted_plaster_wall | https://polyhaven.com/a/painted_plaster_wall | Painted walls (all rooms), 2.0 m repeat |
| marble_tiles | https://polyhaven.com/a/marble_tiles | Bathroom floors + bathroom-facing wall faces. 25 mosaic tiles/tile, 2.5 m repeat → ~10 cm tiles |
| cotton_jersey | https://polyhaven.com/a/cotton_jersey | Couch, cushions, bedding, pillows (tinted per material), 0.6 m repeat |
| wood_table_001 | https://polyhaven.com/a/wood_table_001 | Dining table, chairs, desk, bed frames, TV stand, front door, fan blades, 1.0 m repeat |
| marble_01 | https://polyhaven.com/a/marble_01 | Kitchen countertop, 1.2 m repeat |

Rejected during selection: white_plaster_rough_01 + white_plaster_02
(albedos too dark/grey-green for interior paint), tiled_floor_001
(brown terracotta — bathrooms asked for light tile).

UVs are world-space tri-planar (see `world_uvs` in build_house_v2.py), so
textures align across wall segments and floor slabs.
