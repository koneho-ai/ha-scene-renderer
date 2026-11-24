#!/usr/bin/env python3
"""Generate a tileable plain-weave normal map for the sheer curtains.

Real voile/sheers show a fine over-under thread weave up close (see
references/sheer-voile-folds.webp). A procedural Blender texture node
would NOT survive the glTF export (the exporter only embeds image
textures), so the weave is baked here into a real PNG normal map and
wired into the SheerCurtain material as an image texture.

Plain weave: 32x32 thread cells per tile; in each cell either the warp
(vertical) or the weft (horizontal) thread rides on top, alternating in
a checkerboard. Each thread is a rounded ridge (sin^0.7 profile); the
thread underneath shows through at 25% height. The heightfield is
continuous at cell edges (profiles go to 0 there), so the tile is
seamless. Normals are OpenGL convention (green = +v, v up), matching
the Poly Haven normal maps already in this project.

Output: textures/weave_normal.png (256x256). With the SheerCurtain
UV_REPEAT of 0.1 m the tile repeats every 10 cm, so each thread cell
is ~3 mm — fine weave at the living-room camera's distance.
Usage: python3 make_weave_normal.py
"""
import numpy as np
from PIL import Image
import os

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   "textures", "weave_normal.png")
SIZE = 256
CELLS = 32  # thread cells per tile edge

# Grid: rows = v (0 at bottom), cols = u. Tileable via periodic math.
v = np.arange(SIZE) / SIZE
u = np.arange(SIZE) / SIZE
uu, vv = np.meshgrid(u, v)  # uu, vv shape (SIZE, SIZE), row = v

# Position within a cell, 0..1, and cell indices.
cu = (uu * CELLS) % 1.0
cv = (vv * CELLS) % 1.0
ci = (uu * CELLS).astype(int) % CELLS
cj = (vv * CELLS).astype(int) % CELLS

# Rounded thread profile: 0 at the cell edges, 1 mid-thread.
prof = lambda t: np.sin(np.pi * np.clip(t, 0, 1)) ** 0.7
pu = prof(cu)  # ridge across u (vertical thread cross-section)
pv = prof(cv)  # ridge across v (horizontal thread cross-section)

# Plain weave: warp (vertical thread) on top where (i+j) is even,
# weft (horizontal) on top where odd. The lower thread shows at 25%.
warp_on_top = ((ci + cj) % 2 == 0)
h = np.where(warp_on_top, pu + 0.25 * pv, pv + 0.25 * pu)

# Normals from the heightfield, central differences with wraparound
# (tileable). The per-pixel central difference peaks at ~0.22 for this
# profile; a multiplier of 4 puts the max slope at ~0.9, and the
# 0.4 Normal Map node strength in Blender brings the effective tilt
# to ~19 deg — visible up close, subtle at room distance.
s = 4.0
dhdu = (np.roll(h, -1, axis=1) - np.roll(h, 1, axis=1)) / 2.0 * s
dhdv = (np.roll(h, -1, axis=0) - np.roll(h, 1, axis=0)) / 2.0 * s
nx = -dhdu
ny = -dhdv
nz = np.ones_like(h)
inv = 1.0 / np.sqrt(nx * nx + ny * ny + nz * nz)
nx, ny, nz = nx * inv, ny * inv, nz * inv

rgb = np.stack([(nx * 0.5 + 0.5), (ny * 0.5 + 0.5), (nz * 0.5 + 0.5)],
               axis=-1)
# PIL row 0 = image top = v=1; our rows have v increasing downward in
# the array (row 0 = v=0), so flip vertically on save.
rgb = np.flipud(rgb)
img = Image.fromarray((np.clip(rgb, 0, 1) * 255).astype(np.uint8), "RGB")
os.makedirs(os.path.dirname(OUT), exist_ok=True)
img.save(OUT)
print(f"wrote {OUT} ({SIZE}x{SIZE}, {CELLS}x{CELLS} thread cells)")
print(f"  normal range: R {rgb[:,:,0].min():.3f}..{rgb[:,:,0].max():.3f}, "
      f"G {rgb[:,:,1].min():.3f}..{rgb[:,:,1].max():.3f}, "
      f"B {rgb[:,:,2].min():.3f}..{rgb[:,:,2].max():.3f}")
