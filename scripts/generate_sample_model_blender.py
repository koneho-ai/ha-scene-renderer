# build_house_v2.py — HA Scene Renderer sample house v2 (DRAFT).
#
# 8 rooms in a 4x2 grid, 16 named point lights (14 room + 2 curtain-glow
# at base 0, script-driven), one window per room (with a window_<room>
# marker empty at each window's center for the renderer's bounce lights),
# TV + couch + ceiling fan in the living room, door openings in every
# interior wall plus a closed front door on the south facade, and an
# invisible shadow-only ceiling slab. Each window has a treatment —
# sheer curtains, horizontal blinds, vertical blinds, or nothing —
# same pattern west->east on both sides of the house.
# Room shapes/positions are placeholders; light names/counts, windows
# and the TV are the contract.
#
# Textures: PBR sets from Poly Haven (CC0, see TEXTURES.md), 1K albedo
# + 512 normal/roughness, in ./textures/. UVs are world-space tri-planar
# (see world_uvs): one texture repeat per N metres, so planks/tiles
# line up across every wall and floor. Geometry, lights, cameras and
# object names are untouched by the texturing pass.
#
# Run: ./blender --background --factory-startup --python build_house_v2.py --python-exit-code 1
# Outputs (OUT dir): house-v2.blend, house-v2.glb (with shadow ceiling),
# house-v2-noceiling.glb (without), preview-*.png renders.
import bpy
import math
import os
import random
from mathutils import Vector

OUT = os.path.dirname(os.path.abspath(__file__))
TEXDIR = os.path.join(OUT, "textures")
os.makedirs(OUT, exist_ok=True)

# ---------------------------------------------------------------- parameters
WALL_H = 2.5          # wall height (m)
WALL_T_EXT = 0.15     # exterior wall thickness
WALL_T_INT = 0.10     # interior wall thickness
WIN_W, WIN_H, WIN_SILL = 1.2, 1.2, 0.9
DOOR_W, DOOR_H = 0.9, 2.1   # interior + front door openings
LIGHT_Z = 2.3         # point lights just below the ceiling
# The front door sits at x=0 on the south (kids bedroom) wall, which
# would overlap that room's window (centered at x=-0.25, spanning
# -0.85..0.35). Shift the window left so both openings fit.
WINDOW_CX_OVERRIDE = {"kids_bedroom": -1.6}

# Rooms: name -> (x0, x1, y0, y1, floor material). Footprint 15 x 8 m,
# X -7.5..7.5, Y -4..4. North (+Y) row on top, south row at the bottom.
ROOMS = {
    "living_room":  (-7.5, -2.5, 0.0, 4.0, "wood"),
    "dining":       (-2.5,  1.5, 0.0, 4.0, "wood"),
    "kitchen":      ( 1.5,  4.5, 0.0, 4.0, "tile"),
    "office":       ( 4.5,  7.5, 0.0, 4.0, "wood"),
    "bedroom":      (-7.5, -2.5, -4.0, 0.0, "wood"),
    "kids_bedroom": (-2.5,  2.0, -4.0, 0.0, "wood"),
    "bathroom_1":   ( 2.0, 4.75, -4.0, 0.0, "tile"),
    "bathroom_2":   (4.75,  7.5, -4.0, 0.0, "tile"),
}
# Windows: room -> exterior wall ("N" or "S").
WINDOWS = {r: ("N" if ROOMS[r][2] >= 0 else "S") for r in ROOMS}

# Lights: name -> (x, y, watts, (r, g, b)).
# glTF intensity ~= watts * 683 / (4*pi) ~= watts * 54.35 (SPEC mode).
# Targets: living 45, kitchen/dining 40, bedroom/kids/office 35, tv 14.
# Colors are explicit linear RGB matching the old sample model — do NOT
# use use_temperature here: the exporter turns a 2700 K blackbody into
# an over-saturated (1.94, 0.80, 0.19) that renders deep orange.
LIGHTS = {
    "living_room_1":  (-6.5, 1.0, 0.83, (1.0, 0.90, 0.75)),
    "living_room_2":  (-3.5, 1.0, 0.83, (1.0, 0.90, 0.75)),
    "living_room_3":  (-6.5, 3.0, 0.83, (1.0, 0.90, 0.75)),
    "living_room_4":  (-3.5, 3.0, 0.83, (1.0, 0.90, 0.75)),
    "kitchen_1":      ( 3.0, 2.0, 0.74, (1.0, 0.97, 0.90)),
    "dining_1":       (-0.5, 2.0, 0.74, (1.0, 0.90, 0.75)),
    "bedroom_1":      (-5.0, -2.0, 0.64, (1.0, 0.88, 0.70)),
    "kids_bedroom_1": (-1.5, -1.0, 0.64, (1.0, 0.88, 0.70)),
    "kids_bedroom_2": ( 1.0, -1.0, 0.64, (1.0, 0.88, 0.70)),
    "kids_bedroom_3": (-1.5, -3.0, 0.64, (1.0, 0.88, 0.70)),
    "kids_bedroom_4": ( 1.0, -3.0, 0.64, (1.0, 0.88, 0.70)),
    "office_1":       ( 5.5, 1.2, 0.64, (1.0, 0.95, 0.88)),
    "office_2":       ( 6.5, 2.8, 0.64, (1.0, 0.95, 0.88)),
    "living_room_tv": (-2.70, 2.0, 0.2576, (1.0, 1.0, 1.0)),  # base 14: mappable as a light; the script animates it when the TV is on — sits 4 cm in front of the screen face (-2.66), so the screen itself reads as the light source
}
TV_LIGHT_Z = 1.1

# Light variation (user request): deterministic jitter so some lights
# read soft and others harder. Fixed seed 19 — rebuilds are stable and
# the total stays within 1% of the unjittered total (weighted ratio
# 0.994), with per-light factors spanning 0.80..1.23. Wattage varies
# +/-25%; color gets a slight warmth jitter (green +/-3%, blue +/-7%,
# red pinned at 1.0). The TV glow is NOT jittered (base 14).
_jitter = random.Random(19)
_jittered = {}
for _name, (_x, _y, _w, _c) in LIGHTS.items():
    if _name == "living_room_tv":
        _jittered[_name] = (_x, _y, _w, _c)
        continue
    _wf = _jitter.uniform(0.75, 1.25)
    _gf = _jitter.uniform(0.97, 1.03)
    _bf = _jitter.uniform(0.93, 1.07)
    _nw = _w * _wf
    _nc = (1.0, min(1.0, _c[1] * _gf), min(1.0, _c[2] * _bf))
    _jittered[_name] = (_x, _y, _nw, _nc)
    print(f"light jitter: {_name} {_w:.4f}W -> {_nw:.4f}W (x{_wf:.3f}) "
          f"color {_c} -> ({_nc[0]:.3f}, {_nc[1]:.3f}, {_nc[2]:.3f})")
LIGHTS = _jittered

# NOTE (2026-11-24): curtain glow lights REMOVED at the user's request —
# he never asked for separate light sources for the curtains. The
# curtain glow comes from the SheerCurtain material itself (renderer
# emissive, sun-driven) and room re-emission comes from the patch
# bounce lights (renderer, window_* markers). Do not re-add them.

CAMERAS = {
    # overview is an ANGLED 3/4 aerial view (0.3.9, user request):
    # from the south-west, ~39.5 deg elevation, so the house reads
    # as a dollhouse instead of a flat plan. Blender (-12, -12, 14)
    # = glTF (-12, 14, 12); the camera looks at the model center.
    # Chosen over the south-east (living room pushed far-left), the
    # east-south-east (house reads rotated, wastes the frame) and
    # the north-east (near north facade is a huge black wall) —
    # see tests-0.3.0/feature-b/angle_probe.mjs + the
    # angled-candidate-*.png proofs (2026-11-24). The topdown check
    # camera below keeps the straight-above view for verification.
    "overview":    {"loc": (-12.0, -12.0, 14.0), "target": (0.0, 0.0, 0.0), "lens": 35},
    "living_room": {"loc": (-7.05, 0.25, 2.2), "target": (-2.8, 2.1, 0.9), "lens": 35},
    "topdown":     {"loc": (0.0, 0.0, 18.0), "target": (0.0, 0.0, 0.0), "lens": 35},
}

# ---------------------------------------------------------------- helpers
def clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()
    for coll in list(bpy.data.collections):
        bpy.data.collections.remove(coll)


def make_material(name, color, roughness=0.85, metallic=0.0,
                  emission=None, emission_strength=0.0):
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    if emission is not None:
        bsdf.inputs["Emission Color"].default_value = (*emission, 1.0)
        bsdf.inputs["Emission Strength"].default_value = emission_strength
    return mat


def load_image(fname, non_color=False):
    """Load a texture from TEXDIR, sharing the datablock on repeat loads
    so the glTF exporter embeds each image once."""
    img = bpy.data.images.load(os.path.join(TEXDIR, fname),
                               check_existing=True)
    if non_color:
        img.colorspace_settings.name = "Non-Color"
    return img


def pbr_material(name, tint=(1.0, 1.0, 1.0), roughness=0.8, metallic=0.0,
                 diffuse=None, normal=None, normal_strength=1.0,
                 rough_map=None):
    """Principled BSDF + PBR texture maps. `tint` multiplies the albedo
    texture (glTF baseColorFactor); with a rough map linked, keep the
    scalar roughness at 1.0 so the map drives it. Non-color maps get
    the Non-Color colorspace or their values shift in three.js."""
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    bsdf = nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*tint, 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    if diffuse is not None:
        tex = nodes.new("ShaderNodeTexImage")
        tex.image = load_image(diffuse)
        tex.extension = "REPEAT"
        links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    if rough_map is not None:
        rtex = nodes.new("ShaderNodeTexImage")
        rtex.image = load_image(rough_map, non_color=True)
        rtex.extension = "REPEAT"
        links.new(rtex.outputs["Color"], bsdf.inputs["Roughness"])
    if normal is not None:
        ntex = nodes.new("ShaderNodeTexImage")
        ntex.image = load_image(normal, non_color=True)
        ntex.extension = "REPEAT"
        nmap = nodes.new("ShaderNodeNormalMap")
        nmap.inputs["Strength"].default_value = normal_strength
        links.new(ntex.outputs["Color"], nmap.inputs["Color"])
        links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])
    return mat


def box(name, cx, cy, cz, sx, sy, sz, mat, collection=None):
    """Axis-aligned box centred at (cx, cy, cz) with size (sx, sy, sz)."""
    bpy.ops.mesh.primitive_cube_add(location=(cx, cy, cz))
    obj = bpy.context.active_object
    obj.name = name
    obj.dimensions = (sx, sy, sz)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if mat is not None:
        obj.data.materials.append(mat)
    if collection is not None:
        collection.objects.link(obj)
        bpy.context.scene.collection.objects.unlink(obj)
    return obj


def aim(obj, target):
    d = Vector(target) - obj.location
    obj.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()


# ---------------------------------------------------------------- build
clear_scene()
# --- materials: PBR textures where the surface reads, flat where not ---
# Wood floor: 16 plank rows per tile, repeat 2.4 m -> ~15 cm planks.
# Tile: 25 mosaic tiles per tile, repeat 2.5 m -> ~10 cm tiles.
# Fabric tints are lightened vs the old flat colors: the albedo texture
# multiplies the tint, so the old values would come out too dark.
# Furniture wood tint is white: the dark walnut albedo IS the color.
M = {
    "wall":   pbr_material("WallPaint", (0.92, 0.90, 0.85), 0.9,
                          diffuse="painted_plaster_wall_diffuse_1k.jpg",
                          normal="painted_plaster_wall_nor_gl_512.png",
                          normal_strength=0.6),
    "wood":   pbr_material("WoodFloor", (1.0, 1.0, 1.0), 1.0,
                          diffuse="wooden_floor_02_diffuse_1k.jpg",
                          normal="wooden_floor_02_nor_gl_512.png",
                          rough_map="wooden_floor_02_rough_512.jpg"),
    "tile":   pbr_material("TileFloor", (1.0, 1.0, 1.0), 1.0,
                          diffuse="marble_tiles_diffuse_1k.jpg",
                          normal="marble_tiles_nor_gl_512.png",
                          rough_map="marble_tiles_rough_512.jpg"),
    "frame":  make_material("WindowFrame", (0.96, 0.96, 0.94), 0.6),
    "blind":  make_material("BlindSlat", (0.93, 0.92, 0.88), 0.7),
    "shadow": make_material("ShadowOnly", (1.0, 0.0, 1.0), 1.0),
    "couch":  pbr_material("CouchFabric", (0.45, 0.62, 0.72), 0.95,
                          diffuse="cotton_jersey_diffuse_1k.jpg"),
    "cushion": pbr_material("Cushion", (0.52, 0.70, 0.80), 0.95,
                          diffuse="cotton_jersey_diffuse_1k.jpg"),
    "tvbody": make_material("TVBody", (0.05, 0.05, 0.05), 0.4, 0.2),
    "tvscreen": make_material("TVScreen", (0.02, 0.02, 0.03), 0.3,
                              emission=(0.80, 0.90, 1.0), emission_strength=2.0),
    "stand":  pbr_material("TVStand", (1.0, 1.0, 1.0), 0.7,
                          diffuse="wood_table_001_diffuse_1k.jpg",
                          normal="wood_table_001_nor_gl_512.png"),
    "bedwood": pbr_material("BedWood", (1.0, 1.0, 1.0), 0.7,
                          diffuse="wood_table_001_diffuse_1k.jpg",
                          normal="wood_table_001_nor_gl_512.png"),
    "bedding": pbr_material("Bedding", (0.95, 0.94, 0.90), 0.95,
                          diffuse="cotton_jersey_diffuse_1k.jpg"),
    "pillow": pbr_material("Pillow", (1.0, 1.0, 0.98), 0.95,
                          diffuse="cotton_jersey_diffuse_1k.jpg"),
    "table":  pbr_material("TableWood", (1.0, 1.0, 1.0), 0.6,
                          diffuse="wood_table_001_diffuse_1k.jpg",
                          normal="wood_table_001_nor_gl_512.png"),
    "chair":  pbr_material("ChairWood", (1.0, 1.0, 1.0), 0.65,
                          diffuse="wood_table_001_diffuse_1k.jpg",
                          normal="wood_table_001_nor_gl_512.png"),
    "desk":   pbr_material("DeskWood", (1.0, 1.0, 1.0), 0.6,
                          diffuse="wood_table_001_diffuse_1k.jpg",
                          normal="wood_table_001_nor_gl_512.png"),
    "counter": make_material("Counter", (0.70, 0.70, 0.68), 0.5),
    "countertop": pbr_material("CounterTop", (1.0, 1.0, 1.0), 0.3,
                          diffuse="marble_01_diffuse_1k.jpg"),
    "ceramic": make_material("Ceramic", (0.97, 0.97, 0.96), 0.2),
    "water":  make_material("BathWater", (0.55, 0.75, 0.85), 0.1),
    "fridge": make_material("Fridge", (0.82, 0.83, 0.85), 0.35, 0.6),
    "door":   pbr_material("FrontDoor", (1.0, 1.0, 1.0), 0.6,
                          diffuse="wood_table_001_diffuse_1k.jpg",
                          normal="wood_table_001_nor_gl_512.png"),
    "fanmetal": make_material("FanMetal", (0.15, 0.15, 0.15), 0.5, 0.6),
    "fanblade": pbr_material("FanBlade", (1.0, 1.0, 1.0), 0.65,
                          diffuse="wood_table_001_diffuse_1k.jpg",
                          normal="wood_table_001_nor_gl_512.png"),
}

# Sheer curtain fabric: mostly opaque warm cream (alpha 0.8), matching
# the reference photos in references/ — real voile reads as fabric with
# deep folds and a fine weave, translucent only where a single thin
# layer is backlit (alpha 0.5 looked like glass, user feedback). It
# exports as glTF alphaMode BLEND; the renderer gives SheerCurtain a
# dithered partial shadow (~46% sun transmission) plus a warm emissive
# glow on the sunlit parts, and the patch bounce lights re-emit sun
# into the room — so the alpha controls the LOOK (fabric vs glass)
# while the shadow behavior lives in the renderer. The alpha lives on the Principled BSDF
# *Alpha socket*: Blender 5.3's exporter derives alphaMode from that
# socket (not from the Base Color's 4th component, which it ignores,
# and not from blend_method). verify_glb.py checks the exported alphaMode.
# Weave: a baked normal map (textures/weave_normal.png, generated by
# make_weave_normal.py — a procedural node texture would NOT survive
# the glTF export, only image textures do), 0.1 m repeat via the
# curtain panels' own planar UVs. Strength 0.4: visible up close,
# subtle at room distance.
_sheer = bpy.data.materials.new(name="SheerCurtain")
_sheer.use_nodes = True
_sheer_bsdf = _sheer.node_tree.nodes["Principled BSDF"]
_sheer_bsdf.inputs["Base Color"].default_value = (0.97, 0.93, 0.83, 1.0)
_sheer_bsdf.inputs["Alpha"].default_value = 0.8
_sheer_bsdf.inputs["Roughness"].default_value = 0.9
_sheer_ntex = _sheer.node_tree.nodes.new("ShaderNodeTexImage")
_sheer_ntex.image = load_image("weave_normal.png", non_color=True)
_sheer_ntex.extension = "REPEAT"
_sheer_nmap = _sheer.node_tree.nodes.new("ShaderNodeNormalMap")
_sheer_nmap.inputs["Strength"].default_value = 0.4
_sheer.node_tree.links.new(_sheer_ntex.outputs["Color"],
                           _sheer_nmap.inputs["Color"])
_sheer.node_tree.links.new(_sheer_nmap.outputs["Normal"],
                           _sheer_bsdf.inputs["Normal"])
try:
    _sheer.surface_render_method = "BLENDED"
except (AttributeError, TypeError):
    pass
M["sheer"] = _sheer

# --- floors (one slab per room, top at z=0) ---
for room, (x0, x1, y0, y1, fmat) in ROOMS.items():
    box(f"floor_{room}", (x0 + x1) / 2, (y0 + y1) / 2, -0.05,
        x1 - x0, y1 - y0, 0.1, M[fmat])

# --- walls with openings (windows / doors), built from segments ---
def wall_run(name, axis, fixed, a0, a1, openings, t, mat):
    """A straight wall with rectangular openings, built from boxes.

    axis "x": the wall runs along X at fixed y. axis "y": it runs along
    Y at fixed x. The wall spans a0..a1 on its axis, z -0.05..WALL_H.
    openings: list of (o0, o1, oz0, oz1) — gaps along the axis, from
    height oz0 to oz1. An opening reaching the wall base (oz0=-0.05)
    gets no sill piece; one reaching the top gets no header.
    """
    z0, z1 = -0.05, WALL_H
    ops = sorted(openings)
    edges = [a0] + [c for op in ops for c in (op[0], op[1])] + [a1]
    for i in range(0, len(edges), 2):
        a, b = edges[i], edges[i + 1]
        if b - a <= 0.001:
            continue
        c = (a + b) / 2
        if axis == "x":
            box(f"{name}_seg{i // 2}", c, fixed, (z0 + z1) / 2, b - a, t, z1 - z0, mat)
        else:
            box(f"{name}_seg{i // 2}", fixed, c, (z0 + z1) / 2, t, b - a, z1 - z0, mat)
    for j, (o0, o1, oz0, oz1) in enumerate(ops):
        c = (o0 + o1) / 2
        w = o1 - o0
        if oz0 > z0 + 0.001:
            if axis == "x":
                box(f"{name}_below{j}", c, fixed, (z0 + oz0) / 2, w, t, oz0 - z0, mat)
            else:
                box(f"{name}_below{j}", fixed, c, (z0 + oz0) / 2, t, w, oz0 - z0, mat)
        if oz1 < z1 - 0.001:
            if axis == "x":
                box(f"{name}_above{j}", c, fixed, (oz1 + z1) / 2, w, t, z1 - oz1, mat)
            else:
                box(f"{name}_above{j}", fixed, c, (oz1 + z1) / 2, t, w, z1 - oz1, mat)


def door_opening(c):
    """A 0.9 x 2.1 door gap centred at c, reaching the floor."""
    return (c - DOOR_W / 2, c + DOOR_W / 2, -0.05, DOOR_H)


# --- exterior walls with window openings (built from segments) ---
def window_wall(room):
    x0, x1, y0, y1, _ = ROOMS[room]
    side = WINDOWS[room]
    yc = 4.0 if side == "N" else -4.0
    cx = WINDOW_CX_OVERRIDE.get(room, (x0 + x1) / 2)
    wx0, wx1 = cx - WIN_W / 2, cx + WIN_W / 2
    t = WALL_T_EXT
    openings = [(wx0, wx1, WIN_SILL, WIN_SILL + WIN_H)]
    if room == "kids_bedroom":
        # front door: 0.9 x 2.1 opening at facade center (x=0)
        openings.append(door_opening(0.0))
    wall_run(f"wall_{room}", "x", yc, x0, x1, openings, t, M["wall"])
    # thin frame around the window opening, slightly proud of both faces
    fz = WIN_SILL + WIN_H / 2
    ft = t + 0.05
    fw = 0.07
    box(f"frame_{room}_L", wx0 - fw / 2, yc, fz, fw, ft, WIN_H + 2 * fw, M["frame"])
    box(f"frame_{room}_R", wx1 + fw / 2, yc, fz, fw, ft, WIN_H + 2 * fw, M["frame"])
    box(f"frame_{room}_B", cx, yc, WIN_SILL - fw / 2, WIN_W + 2 * fw, ft, fw, M["frame"])
    box(f"frame_{room}_T", cx, yc, WIN_SILL + WIN_H + fw / 2, WIN_W + 2 * fw, ft, fw, M["frame"])

for room in ROOMS:
    window_wall(room)

# --- front door: closed slab + frame in the south-wall opening at x=0 ---
box("front_door", 0.0, -4.0, DOOR_H / 2, DOOR_W, 0.05, DOOR_H, M["door"])
dt = WALL_T_EXT + 0.05
dw = 0.07
box("frame_frontdoor_L", -DOOR_W / 2 - dw / 2, -4.0, DOOR_H / 2,
    dw, dt, DOOR_H + dw, M["frame"])
box("frame_frontdoor_R", DOOR_W / 2 + dw / 2, -4.0, DOOR_H / 2,
    dw, dt, DOOR_H + dw, M["frame"])
box("frame_frontdoor_T", 0.0, -4.0, DOOR_H + dw / 2,
    DOOR_W + 2 * dw, dt, dw, M["frame"])
box("front_door_handle", 0.32, -4.06, 1.0, 0.14, 0.08, 0.03, M["fanmetal"])

# --- window treatments: one per window, same pattern both sides ---
# West->east on each side: curtains, horizontal blinds, vertical blinds,
# nothing. Mounted just inside the opening (room side), sized to it.
# Window openings, walls, lights, cameras, doors, fan, TV and ceiling
# are untouched by this pass.
TREATMENTS = {
    "living_room": "curtains", "dining": "hblinds",
    "kitchen": "vblinds", "office": None,
    "bedroom": "curtains", "kids_bedroom": "hblinds",
    "bathroom_1": "vblinds", "bathroom_2": None,
}
TREAT_MOUNT_INSET = 0.16  # mount this far inside the inner wall face


def window_geom(room):
    """(cx, wall_y, side) for a room's window, same math as window_wall."""
    x0, x1, y0, y1, _ = ROOMS[room]
    side = WINDOWS[room]
    yc = 4.0 if side == "N" else -4.0
    cx = WINDOW_CX_OVERRIDE.get(room, (x0 + x1) / 2)
    return cx, yc, side


def tilted_box(name, loc, dims, rotation, mat):
    """Box created already rotated, transforms applied (keeps the
    world_uvs identity-rotation assumption true)."""
    bpy.ops.mesh.primitive_cube_add(location=loc, rotation=rotation)
    obj = bpy.context.active_object
    obj.name = name
    obj.dimensions = dims
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    obj.data.materials.append(mat)
    return obj


def horizontal_blinds(room, cx, my):
    """12 thin slats across the opening, tilted 45 deg (semi-open),
    0.1 m pitch: the 0.08 m chord leaves ~0.04 m gaps so the sun comes
    through in stripes. Opaque slats cast striped shadows.
    Tilt sign matters: the slats angle DOWN toward the room (outside
    edge up), so their plane runs nearly parallel to the southern sun's
    rays (60 deg elevation) and ~58% of the light slips through the
    gaps. Tilted the other way the slats sit almost perpendicular to
    those rays and block the sun nearly completely (verified: a +45 deg
    tilt left a single thin stripe in the kids bedroom)."""
    for i in range(12):
        z = WIN_SILL + 0.05 + 0.1 * i
        tilted_box(f"blinds_h_{room}_slat_{i:02d}", (cx, my, z),
                   (WIN_W, 0.08, 0.015), (math.radians(-45), 0, 0),
                   M["blind"])
    box(f"blinds_h_{room}_headrail", cx, my, WIN_SILL + WIN_H + 0.03,
        WIN_W + 0.04, 0.06, 0.05, M["blind"])


def vertical_blinds(room, cx, my, z_bottom=WIN_SILL):
    """11 vertical slats, 0.09 m chord tilted 45 deg about Z (semi-open),
    0.11 m pitch along X. Kitchen hangs above the counter (z_bottom 0.96)
    so the slats clear the countertop."""
    h = WIN_SILL + WIN_H - z_bottom
    zc = z_bottom + h / 2
    for i in range(11):
        x = cx - 0.55 + 0.11 * i
        tilted_box(f"blinds_v_{room}_slat_{i:02d}", (x, my, zc),
                   (0.015, 0.09, h), (0, 0, math.radians(45)),
                   M["blind"])
    box(f"blinds_v_{room}_headrail", cx, my, WIN_SILL + WIN_H + 0.03,
        WIN_W + 0.04, 0.06, 0.05, M["blind"])


def curtain_panel(name, cx0, cx1, my, mat):
    """One sheer panel with deep rounded sine folds (wavelength 0.22 m,
    ~3 folds per panel), amplitude growing toward the bottom like a
    hanging drape (0.04 m at the top, 0.07 m at the hem) — the old
    0.155 m / 0.03-0.05 m folds read flat against the reference photos.
    Folds are a function of absolute X so the pattern runs continuously
    across both panels of a window. Carries its own planar UVs
    (u = x, v = z, 0.1 m weave repeat): apply_world_uvs skips
    SheerCurtain meshes because the steep fold flanks would flip its
    dominant-axis projection and tear the weave."""
    nx, nz = 32, 3
    z_top, z_bot = WIN_SILL + WIN_H + 0.03, WIN_SILL - 0.02
    verts = []
    for j in range(nz + 1):
        z = z_bot + (z_top - z_bot) * j / nz
        amp = 0.04 + 0.03 * (1 - (z - z_bot) / (z_top - z_bot))
        for i in range(nx + 1):
            x = cx0 + (cx1 - cx0) * i / nx
            y = my + amp * math.sin(2 * math.pi * x / 0.22)
            verts.append((x, y, z))
    faces = []
    for j in range(nz):
        for i in range(nx):
            a = j * (nx + 1) + i
            faces.append((a, a + 1, a + nx + 2, a + nx + 1))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    uv_layer = mesh.uv_layers.new(name="UVMap")
    for loop in mesh.loops:
        co = mesh.vertices[loop.vertex_index].co
        uv_layer.data[loop.index].uv = (co.x / 0.1, co.z / 0.1)
    obj = bpy.data.objects.new(name, mesh)
    obj.data.materials.append(mat)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def curtains(room, cx, my):
    """Two sheer panels with a slight centre overlap + a rod above.
    The right panel sits 12 mm further into the room so the overlap
    layers like real curtains instead of z-fighting (both panels share
    one fold function of absolute X, so at the same y they coincide)."""
    inward = -0.012 if my > 0 else 0.012
    # Panels overlap the 1.2 m opening by 10 cm per side (not 2 cm):
    # the folds push the panel up to 7 cm off the wall, and at oblique
    # angles the sight line past a 2 cm overlap enters the opening and
    # shows the transparent background as a black sliver at the edge.
    curtain_panel(f"curtain_{room}_L", cx - 0.70, cx + 0.01, my, M["sheer"])
    curtain_panel(f"curtain_{room}_R", cx - 0.01, cx + 0.70,
                   my + inward, M["sheer"])
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=12, radius=0.015, depth=1.5,
        location=(cx, my, WIN_SILL + WIN_H + 0.08),
        rotation=(0, math.radians(90), 0))
    rod = bpy.context.active_object
    rod.name = f"curtain_rod_{room}"
    rod.data.materials.append(M["fanmetal"])


for _room, _kind in TREATMENTS.items():
    if _kind is None:
        print(f"treatment: {_room} = nothing")
        continue
    _cx, _yc, _side = window_geom(_room)
    _my = _yc - TREAT_MOUNT_INSET if _side == "N" else _yc + TREAT_MOUNT_INSET
    if _kind == "hblinds":
        horizontal_blinds(_room, _cx, _my)
    elif _kind == "vblinds":
        _z_bot = 0.96 if _room == "kitchen" else WIN_SILL
        vertical_blinds(_room, _cx, _my, _z_bot)
    elif _kind == "curtains":
        curtains(_room, _cx, _my)
    print(f"treatment: {_room} = {_kind} (cx={_cx}, mount_y={_my:.2f})")

# --- window markers: empty nodes at each window's center ---
# The renderer raycasts from these for its patch bounce lights (the sun
# patch on the floor re-emits diffuse light into the room). Names are a
# contract: `window_<room>`. Empties export as bare glTF nodes (no mesh,
# camera or light), so they never render. Position = the true window
# opening center: (cx, wall plane y, WIN_SILL + WIN_H/2), same math as
# window_wall via window_geom (so the kids_bedroom override applies).
for _room in ROOMS:
    _cx, _yc, _side = window_geom(_room)
    bpy.ops.object.empty_add(
        location=(_cx, _yc, WIN_SILL + WIN_H / 2))
    _marker = bpy.context.active_object
    _marker.name = f"window_{_room}"
    _marker.empty_display_size = 0.1
    print(f"window marker: window_{_room} at "
          f"({_cx:.3f}, {_yc:.3f}, {WIN_SILL + WIN_H / 2:.3f})")

# --- ambient marker: an empty declaring the time-of-day ambient light ---
# Same ha_light extras convention as the TV area light, but ambient has
# no geometry, so it lives on an empty at the house center (position is
# irrelevant for an ambient light — only the extras matter). The
# renderer creates a THREE.AmbientLight and drives its intensity from
# the sun elevation every frame: `day` at full daylight, fading to
# `night` below the horizon. `night` is the moonlit-sky floor: 0.2
# keeps rooms dimly visible at night (mean luminance ~12 — the
# directional moonlight adds the patches through the windows) without
# washing out the moonlight contrast — 0.0 made night perfectly
# black, which the user rejected, and 0.015 (the first guess) still
# measured 0.0 under ACES + the Lambertian /pi (moonlight verify,
# 2026-11-24: 0.15 -> ~8, 0.25 -> ~16). Night EXCEEDS day here on
# purpose: the daytime fill comes from the hemisphere (0.6), so the
# ambient day is only a subtle lift, while at night the ambient is
# the ONLY fill (hemisphere 0) and must carry the floor alone. The
# hemisphere fill follows the same ramp, so nothing else keeps the
# night lit. Day 0.05
# is a subtle cool lift on top of the 0.6 hemisphere — 0.1 compressed
# the curtain/bounce luminance ratios in the verify suite noticeably
# (curtain_verify's raw ratio hit 0.755 against a 0.75 threshold).
bpy.ops.object.empty_add(location=(0.0, 0.0, 1.25))
_ambient = bpy.context.active_object
_ambient.name = "ambient"
_ambient.empty_display_size = 0.1
_ambient["ha_light"] = {"type": "ambient", "color": "#bfd4e6",
                        "day": 0.05, "night": 0.2}
print("ambient marker: ambient at (0, 0, 1.25), day 0.05, night 0.2")

# --- exterior side walls (no windows) ---
box("wall_west", -7.5, 0.0, 1.225, WALL_T_EXT, 8.15, 2.55, M["wall"])
box("wall_east", 7.5, 0.0, 1.225, WALL_T_EXT, 8.15, 2.55, M["wall"])

# --- interior walls with door openings (0.9 x 2.1, lintel above) ---
# middle wall (y=0): one door per room pair, centered on each segment
wall_run("wall_middle", "x", 0.0, -7.5, 7.5,
         [door_opening(c) for c in (-5.0, -0.5, 3.0, 6.0)],
         WALL_T_INT, M["wall"])
# north dividers (living|dining|kitchen|office), door centered at y=2
for x in (-2.5, 1.5, 4.5):
    wall_run(f"wall_div_N_{x}", "y", x, -0.05, 4.05,
             [door_opening(2.0)], WALL_T_INT, M["wall"])
# south dividers (bedroom|kids|bath1|bath2), door centered at y=-2
for x in (-2.5, 2.0, 4.75):
    wall_run(f"wall_div_S_{x}", "y", x, -4.05, 0.05,
             [door_opening(-2.0)], WALL_T_INT, M["wall"])

# --- interior doors: CLOSED slabs in all 10 door openings ---
# The openings were left open, so a light in one room shone through
# the doorways into the next rooms (long diagonal bands across the
# dining room, bedroom and kids room — the user read it as the walls
# being transparent). Closed slabs make each room light-tight and the
# doors visible, like the front door. The slab is slightly larger
# than the opening (0.94 x 2.12 vs 0.9 x 2.1) so its edges sit inside
# the wall segments and no hairline of light leaks around it.
def interior_door(name, cx, cy, along_x):
    """Closed door slab + frame + handle, centred at (cx, cy).
    along_x: the wall runs along X (middle wall); else along Y."""
    dt = WALL_T_INT + 0.04
    dw = 0.07
    if along_x:
        box(f"door_{name}", cx, cy, DOOR_H / 2, 0.94, 0.05, 2.12, M["door"])
        box(f"frame_door_{name}_L", cx - 0.45 - dw / 2, cy, DOOR_H / 2,
            dw, dt, DOOR_H + dw, M["frame"])
        box(f"frame_door_{name}_R", cx + 0.45 + dw / 2, cy, DOOR_H / 2,
            dw, dt, DOOR_H + dw, M["frame"])
        box(f"frame_door_{name}_T", cx, cy, DOOR_H + dw / 2,
            DOOR_W + 2 * dw, dt, dw, M["frame"])
        box(f"door_{name}_handle", cx + 0.32, cy - 0.045, 1.0,
            0.14, 0.06, 0.03, M["fanmetal"])
    else:
        box(f"door_{name}", cx, cy, DOOR_H / 2, 0.05, 0.94, 2.12, M["door"])
        box(f"frame_door_{name}_L", cx, cy - 0.45 - dw / 2, DOOR_H / 2,
            dt, dw, DOOR_H + dw, M["frame"])
        box(f"frame_door_{name}_R", cx, cy + 0.45 + dw / 2, DOOR_H / 2,
            dt, dw, DOOR_H + dw, M["frame"])
        box(f"frame_door_{name}_T", cx, cy, DOOR_H + dw / 2,
            dt, DOOR_W + 2 * dw, dw, M["frame"])
        box(f"door_{name}_handle", cx - 0.045, cy + 0.32, 1.0,
            0.06, 0.14, 0.03, M["fanmetal"])

# middle wall (y=0): living|bedroom, dining|kids, kitchen|bath1, office|bath2
for i, cx in enumerate((-5.0, -0.5, 3.0, 6.0)):
    interior_door(f"middle_{i}", cx, 0.0, True)
# north dividers: living|dining, dining|kitchen, kitchen|office
for i, x in enumerate((-2.5, 1.5, 4.5)):
    interior_door(f"divN_{i}", x, 2.0, False)
# south dividers: bedroom|kids, kids|bath1, bath1|bath2
for i, x in enumerate((-2.5, 2.0, 4.75)):
    interior_door(f"divS_{i}", x, -2.0, False)

# --- shadow ceiling: invisible in the renderer, blocks top sunlight ---
shadow_coll = bpy.data.collections.new("ShadowCeiling")
bpy.context.scene.collection.children.link(shadow_coll)
box("ceiling_shadow", 0.0, 0.0, 2.56, 15.15, 8.15, 0.12, M["shadow"],
    collection=shadow_coll)

# --- living room: couch facing +X, TV against the east (dining) wall ---
# couch centred (-4.6, 2.0)
box("couch_base", -4.6, 2.0, 0.225, 0.9, 2.2, 0.45, M["couch"])
box("couch_back", -5.0, 2.0, 0.7, 0.25, 2.2, 0.55, M["couch"])
box("couch_arm_L", -4.6, 0.98, 0.55, 0.9, 0.18, 0.65, M["couch"])
box("couch_arm_R", -4.6, 3.02, 0.55, 0.9, 0.18, 0.65, M["couch"])
box("couch_cushion_L", -4.58, 1.5, 0.52, 0.8, 0.95, 0.15, M["cushion"])
box("couch_cushion_R", -4.58, 2.5, 0.52, 0.8, 0.95, 0.15, M["cushion"])
# TV stand + body + screen (screen is a separate mesh, script-toggled)
box("tv_stand", -2.68, 2.0, 0.225, 0.3, 1.5, 0.45, M["stand"])
box("tv_body", -2.62, 2.0, 1.05, 0.06, 1.3, 0.75, M["tvbody"])
_tv_screen = box("tv_screen", -2.655, 2.0, 1.05, 0.01, 1.24, 0.69, M["tvscreen"])
# ha_light extras (private convention, see docs/wiki/Sample-Scene.md):
# the screen mesh IS an area light. The renderer creates a
# RectAreaLight fitted to the mesh bounds, facing the followed point
# light (which sits 4 cm in front of the screen face), and drives its
# intensity = followed light's effective intensity x scale. The point
# light stays: RectAreaLight cannot cast shadows, so it carries the
# shadows while the area light carries the soft fill. Custom
# properties export as node extras (export_extras=True below) —
# verified with a probe export before this was added.
_tv_screen["ha_light"] = {"type": "area", "follows": "living_room_tv",
                          "scale": 5.0}

# --- ceiling fan (living room): a group node scene.js rotates ---
# The group is an empty at hub height; hub + 4 blades are its children.
# The downrod is static (NOT part of the group) so only hub + blades spin.
# No glTF animation: the script sets the group's rotation absolutely.
fan = bpy.data.objects.new("ceiling_fan", None)
fan.location = (-5.0, 2.0, 2.1)
bpy.context.scene.collection.objects.link(fan)
bpy.context.view_layer.update()
_fan_inv = fan.matrix_world.inverted()

def fan_child(obj):
    obj.parent = fan
    obj.matrix_parent_inverse = _fan_inv
    return obj

bpy.ops.mesh.primitive_cylinder_add(vertices=16, radius=0.08, depth=0.12,
                                    location=(-5.0, 2.0, 2.1))
hub = bpy.context.active_object
hub.name = "fan_hub"
hub.data.materials.append(M["fanmetal"])
fan_child(hub)
for i, (dx, dy, sx, sy) in enumerate([
        (0.355, 0.0, 0.55, 0.12), (-0.355, 0.0, 0.55, 0.12),
        (0.0, 0.355, 0.12, 0.55), (0.0, -0.355, 0.12, 0.55)]):
    blade = box(f"fan_blade_{i}", -5.0 + dx, 2.0 + dy, 2.06,
                sx, sy, 0.02, M["fanblade"])
    fan_child(blade)
# static downrod: ceiling to hub, NOT part of the group
bpy.ops.mesh.primitive_cylinder_add(vertices=12, radius=0.02, depth=0.4,
                                    location=(-5.0, 2.0, 2.3))
downrod = bpy.context.active_object
downrod.name = "fan_downrod"
downrod.data.materials.append(M["fanmetal"])

# --- bedroom: bed against the west wall ---
box("bed_frame", -6.4, -2.2, 0.15, 2.1, 1.6, 0.3, M["bedwood"])
box("bed_headboard", -7.35, -2.2, 0.5, 0.1, 1.6, 1.0, M["bedwood"])
box("bed_mattress", -6.4, -2.2, 0.42, 2.0, 1.5, 0.25, M["bedding"])
box("bed_pillow_L", -7.05, -2.6, 0.6, 0.4, 0.6, 0.12, M["pillow"])
box("bed_pillow_R", -7.05, -1.8, 0.6, 0.4, 0.6, 0.12, M["pillow"])

# --- kids bedroom: smaller bed ---
box("kids_bed_frame", -0.5, -2.6, 0.15, 1.9, 1.0, 0.3, M["bedwood"])
box("kids_bed_headboard", -1.4, -2.6, 0.5, 0.1, 1.0, 0.9, M["bedwood"])
box("kids_bed_mattress", -0.5, -2.6, 0.42, 1.8, 0.92, 0.25, M["bedding"])
box("kids_bed_pillow", -1.15, -2.6, 0.6, 0.35, 0.6, 0.12, M["pillow"])

# --- dining: table + 4 chairs ---
box("dining_table_top", -0.5, 2.0, 0.74, 1.8, 1.0, 0.05, M["table"])
for dx, dy in ((-0.8, -0.4), (0.8, -0.4), (-0.8, 0.4), (0.8, 0.4)):
    box(f"dining_table_leg_{dx}_{dy}", -0.5 + dx, 2.0 + dy, 0.36,
        0.08, 0.08, 0.72, M["table"])
for i, (cx, cy, rot) in enumerate([
        (-1.7, 2.0, 90), (0.7, 2.0, -90), (-0.5, 1.15, 0), (-0.5, 2.85, 180)]):
    # chair: seat + back + legs, rotated to face the table
    bpy.ops.mesh.primitive_cube_add(location=(cx, cy, 0.225))
    seat = bpy.context.active_object
    seat.name = f"dining_chair_{i}_seat"
    seat.dimensions = (0.42, 0.42, 0.05)
    seat.rotation_euler = (0, 0, math.radians(rot))
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    seat.data.materials.append(M["chair"])
    back_x = cx - 0.2 * math.cos(math.radians(rot))
    back_y = cy - 0.2 * math.sin(math.radians(rot))
    box(f"dining_chair_{i}_back", back_x, back_y, 0.65, 0.05, 0.42, 0.85, M["chair"])
    for dx, dy in ((-0.17, -0.17), (0.17, -0.17), (-0.17, 0.17), (0.17, 0.17)):
        box(f"dining_chair_{i}_leg_{dx}_{dy}", cx + dx, cy + dy, 0.1,
            0.05, 0.05, 0.2, M["chair"])

# --- office: desk against the north wall + chair ---
box("desk_top", 6.0, 3.55, 0.74, 1.6, 0.7, 0.05, M["desk"])
box("desk_side_L", 5.28, 3.55, 0.36, 0.05, 0.65, 0.72, M["desk"])
box("desk_side_R", 6.72, 3.55, 0.36, 0.05, 0.65, 0.72, M["desk"])
box("desk_chair_seat", 6.0, 2.85, 0.225, 0.45, 0.45, 0.05, M["chair"])
box("desk_chair_back", 6.0, 2.6, 0.65, 0.45, 0.05, 0.85, M["chair"])

# --- kitchen: counter along the north wall + fridge ---
box("kitchen_counter", 3.0, 3.67, 0.45, 2.4, 0.5, 0.9, M["counter"])
box("kitchen_countertop", 3.0, 3.67, 0.925, 2.45, 0.55, 0.05, M["countertop"])
box("kitchen_fridge", 1.75, 3.6, 0.95, 0.6, 0.6, 1.9, M["fridge"])

# --- bathrooms: tub + sink each ---
for i, (tx, sx) in enumerate([(2.0, 4.75), (4.75, 7.5)], start=1):
    box(f"bath{i}_tub", tx + 1.05, -3.55, 0.275, 1.7, 0.75, 0.55, M["ceramic"])
    box(f"bath{i}_water", tx + 1.05, -3.55, 0.5, 1.5, 0.55, 0.05, M["water"])
    box(f"bath{i}_sink_cab", tx + 2.35, -0.6, 0.4, 0.5, 0.6, 0.8, M["counter"])
    box(f"bath{i}_sink", tx + 2.35, -0.6, 0.85, 0.45, 0.55, 0.1, M["ceramic"])

# --- bathroom walls: tile the bathroom-facing side of every wall face ---
# Wall boxes are shared between rooms, so the tile goes on per-face:
# a vertical wall face whose centre sits on a bathroom rect edge and
# whose normal points INTO the bathroom gets the tile material. The
# other side of the same box stays painted. Draft note: the middle-wall
# segment spanning x -0.05..2.55 is one face whose centre is in the kids
# bedroom, so a 55 cm strip of bathroom_1's north wall stays painted.
def tile_bathroom_walls(tile_mat):
    rects = [ROOMS["bathroom_1"][:4], ROOMS["bathroom_2"][:4]]
    tiled = 0
    for obj in bpy.context.scene.objects:
        if obj.type != "MESH" or not obj.name.startswith("wall_"):
            continue
        mesh = obj.data
        tile_idx = None
        for poly in mesh.polygons:
            if abs(poly.normal.z) > 0.5:
                continue  # horizontal faces (wall tops) stay painted
            w = obj.matrix_world @ poly.center
            nx, ny = poly.normal.x, poly.normal.y
            faces_bathroom = False
            for (x0, x1, y0, y1) in rects:
                if ((abs(w.x - x0) < 0.1 and y0 - 0.1 <= w.y <= y1 + 0.1 and nx > 0.5)
                        or (abs(w.x - x1) < 0.1 and y0 - 0.1 <= w.y <= y1 + 0.1 and nx < -0.5)
                        or (abs(w.y - y0) < 0.1 and x0 - 0.1 <= w.x <= x1 + 0.1 and ny > 0.5)
                        or (abs(w.y - y1) < 0.1 and x0 - 0.1 <= w.x <= x1 + 0.1 and ny < -0.5)):
                    faces_bathroom = True
                    break
            if faces_bathroom:
                if tile_idx is None:
                    mesh.materials.append(tile_mat)
                    tile_idx = len(mesh.materials) - 1
                poly.material_index = tile_idx
                tiled += 1
    print("bathroom wall faces tiled:", tiled)

tile_bathroom_walls(M["tile"])

# --- UVs: world-space tri-planar projection ---
# Every textured mesh gets UVs from its world position, so one texture
# repeat covers exactly `repeat` metres and planks/tiles line up across
# wall segments and floor slabs (per-object origins would shift them).
# The dominant normal axis picks the projection plane; all objects here
# have identity rotation (transforms applied), so object-space normals
# are world-space normals. Texture repeat per material, in metres.
UV_REPEAT = {"WoodFloor": 2.4, "TileFloor": 2.5, "WallPaint": 2.0,
             "CouchFabric": 0.6, "Cushion": 0.6, "Bedding": 0.6,
             "Pillow": 0.6, "TableWood": 1.0, "ChairWood": 1.0,
             "DeskWood": 1.0, "BedWood": 1.0, "TVStand": 1.0,
             "FrontDoor": 1.0, "FanBlade": 1.0, "CounterTop": 1.2}


def world_uvs(obj, repeat):
    mesh = obj.data
    uv_layer = mesh.uv_layers.active or mesh.uv_layers.new(name="UVMap")
    mw = obj.matrix_world
    for poly in mesh.polygons:
        n = poly.normal
        ax = 0 if abs(n.x) >= abs(n.y) and abs(n.x) >= abs(n.z) else \
            (1 if abs(n.y) >= abs(n.z) else 2)
        for li in poly.loop_indices:
            v = mesh.vertices[mesh.loops[li].vertex_index].co
            w = mw @ v
            if ax == 0:
                u, vv = w.y, w.z
            elif ax == 1:
                u, vv = w.x, w.z
            else:
                u, vv = w.x, w.y
            uv_layer.data[li].uv = (u / repeat, vv / repeat)


def apply_world_uvs():
    bpy.context.view_layer.update()  # fan children need fresh matrices
    for obj in bpy.context.scene.objects:
        if obj.type != "MESH":
            continue
        mats = [m.name for m in obj.data.materials if m]
        if "SheerCurtain" in mats:
            continue  # curtain panels carry their own planar UVs
        if "TileFloor" in mats:
            repeat = 2.5  # bathroom walls: tile scale wins over plaster
        else:
            repeat = 1.0
            for m in mats:
                if m in UV_REPEAT:
                    repeat = UV_REPEAT[m]
                    break
        world_uvs(obj, repeat)
    print("world-space UVs applied to",
          sum(1 for o in bpy.context.scene.objects if o.type == "MESH"),
          "meshes")

apply_world_uvs()

# --- lights ---
light_objs = {}
for name, (x, y, watts, color) in LIGHTS.items():
    data = bpy.data.lights.new(name=name, type="POINT")
    data.energy = watts
    data.use_temperature = False
    data.color = color
    data.shadow_soft_size = 0.25
    obj = bpy.data.objects.new(name=name, object_data=data)
    z = TV_LIGHT_Z if name == "living_room_tv" else LIGHT_Z
    obj.location = (x, y, z)
    bpy.context.scene.collection.objects.link(obj)
    light_objs[name] = obj

# --- cameras ---
cam_objs = {}
for name, spec in CAMERAS.items():
    data = bpy.data.cameras.new(name=name)
    data.type = "PERSP"
    data.lens = spec["lens"]
    obj = bpy.data.objects.new(name=name, object_data=data)
    obj.location = spec["loc"]
    aim(obj, spec["target"])
    bpy.context.scene.collection.objects.link(obj)
    cam_objs[name] = obj

# ---------------------------------------------------------------- numeric checks
def mesh_stats():
    total_tris = 0
    bad = []
    for obj in bpy.context.scene.objects:
        if obj.type != "MESH":
            continue
        mesh = obj.data
        mesh.calc_loop_triangles()
        total_tris += len(mesh.loop_triangles)
    return total_tris

print("objects:", len(bpy.context.scene.objects))
print("meshes:", sum(1 for o in bpy.context.scene.objects if o.type == "MESH"))
print("triangles:", mesh_stats())
print("lights:", sorted(light_objs))
print("cameras:", sorted(cam_objs))

# ---------------------------------------------------------------- previews
# Boost the (physically tiny) light energies for Cycles and add a sun so
# the geometry reads; restore afterwards. Ceiling hidden: it is invisible
# in the renderer but opaque in Blender.
scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = 16
scene.cycles.use_denoising = False
scene.cycles.max_bounces = 6
scene.cycles.diffuse_bounces = 4
scene.render.resolution_x = 640
scene.render.resolution_y = 360
scene.render.resolution_percentage = 100

world = bpy.data.worlds["World"]
world.use_nodes = True
bg = world.node_tree.nodes["Background"]
bg.inputs["Color"].default_value = (0.25, 0.25, 0.25, 1.0)
bg.inputs["Strength"].default_value = 1.0

ceiling = bpy.data.objects["ceiling_shadow"]
ceiling.hide_render = True

saved_energies = {n: o.data.energy for n, o in light_objs.items()}
for name, obj in light_objs.items():
    if obj.data.energy > 0:
        obj.data.energy = obj.data.energy * 100.0

sun_data = bpy.data.lights.new(name="preview_sun", type="SUN")
sun_data.energy = 3.0
sun = bpy.data.objects.new(name="preview_sun", object_data=sun_data)
sun.rotation_euler = (math.radians(50), 0, math.radians(25))
bpy.context.scene.collection.objects.link(sun)

for cam_name in ("overview", "living_room", "topdown"):
    scene.camera = cam_objs[cam_name]
    scene.render.filepath = os.path.join(OUT, f"preview-{cam_name}.png")
    bpy.ops.render.render(write_still=True)
    print("rendered", scene.render.filepath)

# restore preview-only changes
for name, obj in light_objs.items():
    obj.data.energy = saved_energies[name]
bpy.data.objects.remove(sun, do_unlink=True)
bpy.data.lights.remove(sun_data)
ceiling.hide_render = False

# topdown is a check camera only: it must NOT reach the GLB (a third
# camera would create a third image entity in HA).
bpy.data.objects.remove(cam_objs["topdown"], do_unlink=True)
bpy.data.cameras.remove(bpy.data.cameras["topdown"])

# ---------------------------------------------------------------- exports
def export_gltf(path):
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        export_apply=True,
        export_yup=True,
        export_cameras=True,
        export_lights=True,
        export_extras=True,
        export_texcoords=True,
        export_normals=True,
        export_materials="EXPORT",
        export_import_convert_lighting_mode="SPEC",
        export_image_format="AUTO",
    )
    print("exported", path, os.path.getsize(path), "bytes")

export_gltf(os.path.join(OUT, "house-v2.glb"))
# no-ceiling variant: unlink the ceiling from the scene, export, re-link
shadow_coll.objects.unlink(ceiling)
export_gltf(os.path.join(OUT, "house-v2-noceiling.glb"))
shadow_coll.objects.link(ceiling)

bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, "house-v2.blend"))
print("BUILD DONE")
