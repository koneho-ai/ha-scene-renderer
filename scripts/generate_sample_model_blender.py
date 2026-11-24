# build_house_v2.py — HA Scene Renderer sample house v2 (DRAFT).
#
# 8 rooms in a 4x2 grid, 14 named point lights, one window per room,
# TV + couch + ceiling fan in the living room, door openings in every
# interior wall plus a closed front door on the south facade, and an
# invisible shadow-only ceiling slab.
# Room shapes/positions are placeholders; light names/counts, windows
# and the TV are the contract.
#
# Run: ./blender --background --factory-startup --python build_house_v2.py --python-exit-code 1
# Outputs (OUT dir): house-v2.blend, house-v2.glb (with shadow ceiling),
# house-v2-noceiling.glb (without), preview-*.png renders.
import bpy
import math
import os
from mathutils import Vector

OUT = "/home/hatch/workspace/blender-probe/house-v2"
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
    "dining":       (-2.5,  1.5, 0.0, 4.0, "tile"),
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
    "living_room_tv": (-3.16, 2.0, 0.2576, (1.0, 1.0, 1.0)),  # base 14: mappable as a light; the script animates it when the TV is on
}
TV_LIGHT_Z = 1.1

CAMERAS = {
    "overview":    {"loc": (0.0, -13.5, 11.5), "target": (0.0, 0.0, 0.0), "lens": 35},
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
M = {
    "wall":   make_material("WallPaint", (0.92, 0.90, 0.85), 0.9),
    "wood":   make_material("WoodFloor", (0.55, 0.38, 0.24), 0.7),
    "tile":   make_material("TileFloor", (0.75, 0.78, 0.80), 0.4),
    "frame":  make_material("WindowFrame", (0.96, 0.96, 0.94), 0.6),
    "shadow": make_material("ShadowOnly", (1.0, 0.0, 1.0), 1.0),
    "couch":  make_material("CouchFabric", (0.30, 0.45, 0.55), 0.95),
    "cushion": make_material("Cushion", (0.36, 0.52, 0.62), 0.95),
    "tvbody": make_material("TVBody", (0.05, 0.05, 0.05), 0.4, 0.2),
    "tvscreen": make_material("TVScreen", (0.02, 0.02, 0.03), 0.3,
                              emission=(0.80, 0.90, 1.0), emission_strength=2.0),
    "stand":  make_material("TVStand", (0.25, 0.18, 0.12), 0.7),
    "bedwood": make_material("BedWood", (0.42, 0.28, 0.16), 0.7),
    "bedding": make_material("Bedding", (0.88, 0.87, 0.82), 0.95),
    "pillow": make_material("Pillow", (0.95, 0.95, 0.93), 0.95),
    "table":  make_material("TableWood", (0.50, 0.34, 0.20), 0.6),
    "chair":  make_material("ChairWood", (0.45, 0.30, 0.18), 0.65),
    "desk":   make_material("DeskWood", (0.48, 0.36, 0.24), 0.6),
    "counter": make_material("Counter", (0.70, 0.70, 0.68), 0.5),
    "countertop": make_material("CounterTop", (0.85, 0.85, 0.83), 0.3),
    "ceramic": make_material("Ceramic", (0.97, 0.97, 0.96), 0.2),
    "water":  make_material("BathWater", (0.55, 0.75, 0.85), 0.1),
    "fridge": make_material("Fridge", (0.82, 0.83, 0.85), 0.35, 0.6),
    "door":   make_material("FrontDoor", (0.42, 0.26, 0.14), 0.6),
    "fanmetal": make_material("FanMetal", (0.15, 0.15, 0.15), 0.5, 0.6),
    "fanblade": make_material("FanBlade", (0.45, 0.30, 0.18), 0.65),
}

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
box("tv_screen", -2.655, 2.0, 1.05, 0.01, 1.24, 0.69, M["tvscreen"])

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
