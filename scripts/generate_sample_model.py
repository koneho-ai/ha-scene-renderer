#!/usr/bin/env python3
"""Generate the sample apartment model for HA Scene Renderer.

Builds a small, clean, dollhouse-style apartment (4 rooms, simple box
furniture) and writes it as a binary glTF file (.glb) with named
KHR_lights_punctual lights, named glTF cameras, and a ceiling fan with a
rotation keyframe animation. The light names are the identifiers the HA
integration maps to light entities, and the camera names are the
identifiers for the image entities — both follow the snake_case naming
convention:

    lights:  living_room_ceiling, kitchen_counter, bedroom_ceiling,
             bathroom_ceiling, living_room_lamp
    cameras: overview, living_room
    animated: ceiling_fan (3 s per full turn, matching the default clip
              duration, so a 3 s clip loops seamlessly)

The fan is a group node (hub + 4 blades as children) with a rotation
animation about Y; the downrod is static. A `blinds` group node hangs
over the living-room window for the scene.js example (the script moves
it with the sun elevation). Group nodes carry real transforms, so the
scene.js API reads/writes their position — unlike furniture boxes, whose
position is baked into the geometry.

Camera names are set on BOTH the camera definition and the node that
references it: three.js names a loaded camera from the definition's
name, while model authors see the node name.

Pure standard library — no dependencies. Run:

    python3 scripts/generate_sample_model.py
    python3 scripts/generate_sample_model.py --out scene-renderer/models/sample-apartment.glb
    python3 scripts/generate_sample_model.py --no-cameras --out /tmp/model-no-cameras.glb

Layout (metres, glTF Y-up, x: 0-12, z: 0-8, walls 2.6 high):

    +-----------+-----------+
    |           |           |
    |  Living   |  Kitchen  |
    |  0-7,0-5  |  7-12,0-5 |
    +-----------+-----------+
    |           |           |
    |  Bedroom  | Bathroom  |
    |  0-7,5-8  |  7-12,5-8 |
    +-----------+-----------+

No ceiling: the dollhouse view needs to see inside.
"""

from __future__ import annotations

import argparse
import json
import math
import struct
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Box geometry
# ---------------------------------------------------------------------------

# Each face: 4 corners, CCW when viewed from outside the box, with the
# outward normal. Triangles are (0, 1, 2) and (0, 2, 3).
_FACES = [
    # +Z (front)
    ([(-1, -1, 1), (1, -1, 1), (1, 1, 1), (-1, 1, 1)], (0, 0, 1)),
    # -Z (back)
    ([(1, -1, -1), (-1, -1, -1), (-1, 1, -1), (1, 1, -1)], (0, 0, -1)),
    # +X (right)
    ([(1, -1, 1), (1, -1, -1), (1, 1, -1), (1, 1, 1)], (1, 0, 0)),
    # -X (left)
    ([(-1, -1, -1), (-1, -1, 1), (-1, 1, 1), (-1, 1, -1)], (-1, 0, 0)),
    # +Y (top)
    ([(-1, 1, 1), (1, 1, 1), (1, 1, -1), (-1, 1, -1)], (0, 1, 0)),
    # -Y (bottom)
    ([(-1, -1, -1), (1, -1, -1), (1, -1, 1), (-1, -1, 1)], (0, -1, 0)),
]


# ---------------------------------------------------------------------------
# Look-at quaternion (for camera nodes)
# ---------------------------------------------------------------------------

def _normalize(v: tuple[float, float, float]) -> tuple[float, float, float]:
    n = math.sqrt(sum(x * x for x in v))
    return (v[0] / n, v[1] / n, v[2] / n)


def _cross(a: tuple[float, float, float],
           b: tuple[float, float, float]) -> tuple[float, float, float]:
    return (a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0])


def look_at_quaternion(position: tuple[float, float, float],
                       target: tuple[float, float, float],
                       up: tuple[float, float, float] = (0.0, 1.0, 0.0)
                       ) -> tuple[float, float, float, float]:
    """Quaternion (x, y, z, w) rotating a camera to face target.

    glTF cameras look down their local -Z axis, so the rotation matrix
    columns are [right, true_up, -forward]. Falls back to a different up
    vector when looking straight up/down.
    """
    forward = _normalize(tuple(t - p for t, p in zip(target, position)))
    right_raw = _cross(forward, up)
    if math.sqrt(sum(x * x for x in right_raw)) < 1e-6:
        up = (0.0, 0.0, -1.0)
        right_raw = _cross(forward, up)
    right = _normalize(right_raw)
    true_up = _cross(right, forward)
    # Rotation matrix, row-major: columns are right, true_up, -forward.
    m00, m01, m02 = right[0], true_up[0], -forward[0]
    m10, m11, m12 = right[1], true_up[1], -forward[1]
    m20, m21, m22 = right[2], true_up[2], -forward[2]
    # Matrix -> quaternion (standard Shepperd method).
    trace = m00 + m11 + m22
    if trace > 0:
        s = math.sqrt(trace + 1.0) * 2
        return ((m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s)
    if m00 > m11 and m00 > m22:
        s = math.sqrt(1.0 + m00 - m11 - m22) * 2
        return (0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s)
    if m11 > m22:
        s = math.sqrt(1.0 + m11 - m00 - m22) * 2
        return ((m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s)
    s = math.sqrt(1.0 + m22 - m00 - m11) * 2
    return ((m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s)


class GlbBuilder:
    """Minimal glTF 2.0 builder: boxes + materials + punctual lights."""

    def __init__(self) -> None:
        self.positions: list[float] = []
        self.normals: list[float] = []
        self.indices: list[int] = []
        self.materials: list[dict] = []
        self._material_index: dict[tuple, int] = {}
        self.meshes: list[dict] = []
        self.nodes: list[dict] = []
        self.lights: list[dict] = []
        self.cameras: list[dict] = []
        self.animations: list[dict] = []
        # Node translations, parallel to self.nodes (None = identity).
        # Used to place child boxes in a group node's local frame.
        self._node_translations: list[tuple[float, float, float] | None] = []

    # -- materials ------------------------------------------------------
    def material(self, name: str, rgb: tuple[float, float, float],
                 roughness: float = 0.9, metalness: float = 0.0) -> int:
        key = (name, rgb, roughness, metalness)
        if key in self._material_index:
            return self._material_index[key]
        idx = len(self.materials)
        self.materials.append({
            "name": name,
            "pbrMetallicRoughness": {
                "baseColorFactor": [rgb[0], rgb[1], rgb[2], 1.0],
                "metallicFactor": metalness,
                "roughnessFactor": roughness,
            },
        })
        self._material_index[key] = idx
        return idx

    # -- geometry -------------------------------------------------------
    def box(self, name: str, center: tuple[float, float, float],
            size: tuple[float, float, float], material: int,
            parent: int | None = None) -> int:
        """Add an axis-aligned box. Returns the node index.

        `center` is in world coordinates; when `parent` is given, the
        vertices are placed in the parent node's local frame and the box
        node becomes a child of the parent (callers must NOT also add it
        to the root children).
        """
        if parent is not None:
            pt = self._node_translations[parent] or (0.0, 0.0, 0.0)
            center = (center[0] - pt[0], center[1] - pt[1], center[2] - pt[2])
        cx, cy, cz = center
        hx, hy, hz = size[0] / 2, size[1] / 2, size[2] / 2
        base_vertex = len(self.positions) // 3
        base_index = len(self.indices)
        for corners, normal in _FACES:
            for (sx, sy, sz) in corners:
                self.positions += [cx + sx * hx, cy + sy * hy, cz + sz * hz]
                self.normals += [normal[0], normal[1], normal[2]]
            # Indices are LOCAL to this mesh: each mesh gets its own
            # POSITION accessor window (24 vertices), and glTF indices
            # address elements of that window (0..23). Global indices
            # would point past the end of the window and render garbage.
            f = len(self.positions) // 3 - 4 - base_vertex
            self.indices += [f, f + 1, f + 2, f, f + 2, f + 3]
        mesh_index = len(self.meshes)
        self.meshes.append({
            "name": name,
            "primitives": [{
                "attributes": {"POSITION": mesh_index * 2, "NORMAL": mesh_index * 2 + 1},
                "indices": mesh_index,
                "material": material,
                "mode": 4,  # TRIANGLES
            }],
            "_vertex_base": base_vertex,
            "_index_base": base_index,
        })
        node_index = len(self.nodes)
        self.nodes.append({"name": name, "mesh": mesh_index})
        self._node_translations.append(None)
        if parent is not None:
            self.nodes[parent].setdefault("children", []).append(node_index)
        return node_index

    # -- groups ---------------------------------------------------------
    def group(self, name: str,
              translation: tuple[float, float, float]) -> int:
        """Add an empty group node at a translation. Returns its index.

        Children (boxes with parent=) are placed in this node's local
        frame. The node carries a real transform, so animations and the
        scene.js API can move/rotate it.
        """
        node_index = len(self.nodes)
        self.nodes.append({
            "name": name,
            "translation": [translation[0], translation[1], translation[2]],
            "children": [],
        })
        self._node_translations.append(translation)
        return node_index

    # -- animations -----------------------------------------------------
    def rotation_animation(self, name: str, node_index: int,
                           times: list[float],
                           quaternions: list[tuple[float, float, float, float]]) -> None:
        """Add a rotation keyframe animation for a node.

        A full 360-degree turn needs intermediate keyframes: the start
        and end quaternions describe the same orientation, and slerp
        between them takes the zero-length path. Use 90-degree steps.
        """
        assert len(times) == len(quaternions) and len(times) >= 2
        self.animations.append({
            "name": name, "node": node_index,
            "times": list(times),
            "rotations": [list(q) for q in quaternions],
        })

    # -- lights ---------------------------------------------------------
    def light(self, name: str, position: tuple[float, float, float],
              color: tuple[float, float, float], intensity: float,
              light_type: str = "point") -> int:
        """Add a named KHR_lights_punctual light. Returns the node index."""
        light_index = len(self.lights)
        self.lights.append({
            "name": name,
            "type": light_type,
            "color": [color[0], color[1], color[2]],
            "intensity": intensity,
        })
        node_index = len(self.nodes)
        self.nodes.append({
            "name": name,
            "translation": [position[0], position[1], position[2]],
            "extensions": {"KHR_lights_punctual": {"light": light_index}},
        })
        self._node_translations.append(position)
        return node_index

    # -- cameras --------------------------------------------------------
    def camera(self, name: str, position: tuple[float, float, float],
               target: tuple[float, float, float], yfov_deg: float,
               aspect: float = 16 / 9, znear: float = 0.1,
               zfar: float = 100.0) -> int:
        """Add a named perspective glTF camera aimed at target.

        The name is set on BOTH the camera definition and the node:
        three.js names the loaded camera from the definition, and the
        node name is what model authors see. Returns the node index.
        """
        cam_index = len(self.cameras)
        self.cameras.append({
            "name": name,
            "type": "perspective",
            "perspective": {
                "yfov": math.radians(yfov_deg),
                "aspectRatio": aspect,
                "znear": znear,
                "zfar": zfar,
            },
        })
        node_index = len(self.nodes)
        self.nodes.append({
            "name": name,
            "camera": cam_index,
            "translation": [position[0], position[1], position[2]],
            "rotation": list(look_at_quaternion(position, target)),
        })
        self._node_translations.append(position)
        return node_index

    # -- output ---------------------------------------------------------
    def build(self, root_children: list[int]) -> bytes:
        """Serialise to a GLB byte string."""
        # Root node groups everything.
        self.nodes.append({"name": "apartment", "children": root_children})
        self._node_translations.append(None)

        position_bytes = struct.pack(f"<{len(self.positions)}f", *self.positions)
        normal_bytes = struct.pack(f"<{len(self.normals)}f", *self.normals)
        index_bytes = struct.pack(f"<{len(self.indices)}I", *self.indices)

        blob = bytearray()
        buffer_views = []
        accessors = []

        def add_view(data: bytes, target: int | None) -> int:
            idx = len(buffer_views)
            view: dict = {
                "buffer": 0, "byteOffset": len(blob),
                "byteLength": len(data),
            }
            if target is not None:
                view["target"] = target
            buffer_views.append(view)
            blob.extend(data)
            while len(blob) % 4:  # keep every view 4-byte aligned
                blob.append(0)
            return idx

        pos_view = add_view(position_bytes, 34962)   # ARRAY_BUFFER
        nor_view = add_view(normal_bytes, 34962)     # ARRAY_BUFFER
        idx_view = add_view(index_bytes, 34963)      # ELEMENT_ARRAY_BUFFER

        for mesh in self.meshes:
            v_base = mesh.pop("_vertex_base")
            i_base = mesh.pop("_index_base")
            pos_acc = len(accessors)
            accessors.append({
                "bufferView": pos_view, "byteOffset": v_base * 12,
                "componentType": 5126, "count": 24, "type": "VEC3",
                "max": [0, 0, 0], "min": [0, 0, 0],  # filled below
            })
            nor_acc = len(accessors)
            accessors.append({
                "bufferView": nor_view, "byteOffset": v_base * 12,
                "componentType": 5126, "count": 24, "type": "VEC3",
            })
            idx_acc = len(accessors)
            accessors.append({
                "bufferView": idx_view, "byteOffset": i_base * 4,
                "componentType": 5125, "count": 36, "type": "SCALAR",
            })
            prim = mesh["primitives"][0]
            prim["attributes"] = {"POSITION": pos_acc, "NORMAL": nor_acc}
            prim["indices"] = idx_acc
            # POSITION min/max (required by the spec).
            xs = self.positions[v_base * 3:(v_base + 24) * 3:3]
            ys = self.positions[v_base * 3 + 1:(v_base + 24) * 3:3]
            zs = self.positions[v_base * 3 + 2:(v_base + 24) * 3:3]
            accessors[pos_acc]["min"] = [min(xs), min(ys), min(zs)]
            accessors[pos_acc]["max"] = [max(xs), max(ys), max(zs)]

        # Animation samplers (time + rotation keyframes per animation).
        animations_json: list[dict] = []
        for anim in self.animations:
            times = anim["times"]
            rots = anim["rotations"]
            time_view = add_view(struct.pack(f"<{len(times)}f", *times), None)
            flat_rots = [c for q in rots for c in q]
            rot_view = add_view(struct.pack(f"<{len(flat_rots)}f", *flat_rots), None)
            time_acc = len(accessors)
            accessors.append({
                "bufferView": time_view,
                "componentType": 5126, "count": len(times), "type": "SCALAR",
                "min": [min(times)], "max": [max(times)],
            })
            rot_acc = len(accessors)
            accessors.append({
                "bufferView": rot_view,
                "componentType": 5126, "count": len(rots), "type": "VEC4",
                "min": [min(flat_rots[0::4]), min(flat_rots[1::4]),
                        min(flat_rots[2::4]), min(flat_rots[3::4])],
                "max": [max(flat_rots[0::4]), max(flat_rots[1::4]),
                        max(flat_rots[2::4]), max(flat_rots[3::4])],
            })
            animations_json.append({
                "name": anim["name"],
                "samplers": [{
                    "input": time_acc, "interpolation": "LINEAR",
                    "output": rot_acc,
                }],
                "channels": [{
                    "sampler": 0,
                    "target": {"node": anim["node"], "path": "rotation"},
                }],
            })

        gltf = {
            "asset": {"version": "2.0",
                      "generator": "ha-scene-renderer generate_sample_model.py"},
            "scene": 0,
            "scenes": [{"nodes": [len(self.nodes) - 1]}],
            "nodes": self.nodes,
            "meshes": self.meshes,
            "materials": self.materials,
            "accessors": accessors,
            "bufferViews": buffer_views,
            "buffers": [{"byteLength": len(blob)}],
            "extensionsUsed": ["KHR_lights_punctual"],
            "extensions": {"KHR_lights_punctual": {"lights": self.lights}},
        }
        if self.cameras:
            gltf["cameras"] = self.cameras
        if animations_json:
            gltf["animations"] = animations_json

        json_bytes = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
        json_bytes += b" " * (-len(json_bytes) % 4)
        bin_bytes = bytes(blob)
        bin_bytes += b"\x00" * (-len(bin_bytes) % 4)

        total = 12 + 8 + len(json_bytes) + 8 + len(bin_bytes)
        out = struct.pack("<III", 0x46546C67, 2, total)
        out += struct.pack("<II", len(json_bytes), 0x4E4F534A) + json_bytes
        out += struct.pack("<II", len(bin_bytes), 0x004E4942) + bin_bytes
        return out


# ---------------------------------------------------------------------------
# The apartment
# ---------------------------------------------------------------------------

WALL_H = 2.6
WALL_T = 0.15


def build_apartment(include_cameras: bool = True) -> tuple[GlbBuilder, list[int]]:
    b = GlbBuilder()
    children: list[int] = []

    # Materials
    wall = b.material("wall", (0.92, 0.90, 0.85))
    floor_wood = b.material("floor_wood", (0.72, 0.53, 0.33), roughness=0.7)
    floor_tile = b.material("floor_tile", (0.82, 0.82, 0.80), roughness=0.4)
    floor_carpet = b.material("floor_carpet", (0.60, 0.50, 0.42))
    floor_bath = b.material("floor_bath", (0.65, 0.72, 0.78), roughness=0.4)
    wood_dark = b.material("wood_dark", (0.45, 0.30, 0.18), roughness=0.7)
    wood_light = b.material("wood_light", (0.80, 0.62, 0.40), roughness=0.7)
    fabric_blue = b.material("fabric_blue", (0.30, 0.45, 0.65))
    fabric_red = b.material("fabric_red", (0.65, 0.25, 0.22))
    fabric_green = b.material("fabric_green", (0.35, 0.55, 0.40))
    white = b.material("white", (0.95, 0.95, 0.95), roughness=0.5)
    black = b.material("black", (0.10, 0.10, 0.10), roughness=0.3)
    metal = b.material("metal", (0.75, 0.75, 0.78), roughness=0.3, metalness=0.8)
    glass = b.material("glass", (0.75, 0.85, 0.90), roughness=0.1, metalness=0.1)

    def box(name, center, size, mat):
        children.append(b.box(name, center, size, mat))

    # -- floors (top surface at y = 0.1) --
    box("floor_living", (3.5, 0.05, 2.5), (7, 0.1, 5), floor_wood)
    box("floor_kitchen", (9.5, 0.05, 2.5), (5, 0.1, 5), floor_tile)
    box("floor_bedroom", (3.5, 0.05, 6.5), (7, 0.1, 3), floor_carpet)
    box("floor_bathroom", (9.5, 0.05, 6.5), (5, 0.1, 3), floor_bath)

    # -- exterior walls --
    box("wall_north", (6, WALL_H / 2, 0), (12.3, WALL_H, WALL_T), wall)
    box("wall_south", (6, WALL_H / 2, 8), (12.3, WALL_H, WALL_T), wall)
    box("wall_west", (0, WALL_H / 2, 4), (WALL_T, WALL_H, 8), wall)
    box("wall_east", (12, WALL_H / 2, 4), (WALL_T, WALL_H, 8), wall)

    # -- interior wall x=7 (door gap at z 2.05-2.95, 2.1 high) --
    box("wall_mid_v1", (7, WALL_H / 2, 1.025), (WALL_T, WALL_H, 2.05), wall)
    box("wall_mid_v2", (7, WALL_H / 2, 5.475), (WALL_T, WALL_H, 5.05), wall)
    box("wall_mid_v_lintel", (7, 2.35, 2.5), (WALL_T, 0.5, 0.9), wall)

    # -- interior wall z=5 (door gaps at x 3.05-3.95 and x 9.05-9.95) --
    box("wall_mid_h1", (1.525, WALL_H / 2, 5), (3.05, WALL_H, WALL_T), wall)
    box("wall_mid_h2", (6.5, WALL_H / 2, 5), (5.1, WALL_H, WALL_T), wall)
    box("wall_mid_h3", (10.975, WALL_H / 2, 5), (2.05, WALL_H, WALL_T), wall)
    box("wall_mid_h_lintel1", (3.5, 2.35, 5), (0.9, 0.5, WALL_T), wall)
    box("wall_mid_h_lintel2", (9.5, 2.35, 5), (0.9, 0.5, WALL_T), wall)

    # -- living room furniture --
    box("sofa_base", (2.0, 0.32, 1.2), (2.2, 0.45, 0.9), fabric_blue)
    box("sofa_back", (2.0, 0.75, 0.78), (2.2, 0.8, 0.22), fabric_blue)
    box("sofa_arm_l", (0.95, 0.55, 1.2), (0.2, 0.7, 0.9), fabric_blue)
    box("sofa_arm_r", (3.05, 0.55, 1.2), (0.2, 0.7, 0.9), fabric_blue)
    box("sofa_cushion_l", (1.5, 0.58, 1.2), (0.9, 0.18, 0.8), fabric_green)
    box("sofa_cushion_r", (2.5, 0.58, 1.2), (0.9, 0.18, 0.8), fabric_green)
    box("coffee_table", (2.0, 0.35, 2.6), (1.2, 0.08, 0.6), wood_dark)
    box("coffee_table_base", (2.0, 0.2, 2.6), (0.9, 0.3, 0.45), wood_dark)
    box("rug", (2.0, 0.11, 2.4), (3.0, 0.02, 2.0), fabric_red)
    box("tv_stand", (2.0, 0.3, 4.6), (1.8, 0.4, 0.4), wood_dark)
    box("tv", (2.0, 1.15, 4.55), (1.6, 0.9, 0.06), black)
    box("bookshelf", (0.45, 1.1, 3.5), (0.35, 2.0, 1.2), wood_light)
    box("books_1", (0.45, 0.7, 3.3), (0.25, 0.3, 0.4), fabric_red)
    box("books_2", (0.45, 1.3, 3.7), (0.25, 0.3, 0.4), fabric_green)
    box("lamp_pole", (5.8, 0.85, 1.0), (0.06, 1.5, 0.06), metal)
    box("lamp_shade", (5.8, 1.55, 1.0), (0.4, 0.3, 0.4), fabric_red)
    box("lamp_base", (5.8, 0.13, 1.0), (0.3, 0.06, 0.3), metal)

    # -- ceiling fan (living room): a group node so the rotation
    # animation can spin it. The downrod is static (not part of the
    # group). One full turn per 3 s — the default clip duration, so a
    # 3 s clip loops seamlessly.
    box("fan_downrod", (3.5, 2.4, 2.5), (0.06, 0.4, 0.06), metal)
    fan = b.group("ceiling_fan", (3.5, 2.2, 2.5))
    children.append(fan)
    b.box("fan_hub", (3.5, 2.2, 2.5), (0.25, 0.12, 0.25), metal, parent=fan)
    for i, (dx, dz, size) in enumerate([
        (0.6, 0.0, (1.1, 0.03, 0.18)),
        (-0.6, 0.0, (1.1, 0.03, 0.18)),
        (0.0, 0.6, (0.18, 0.03, 1.1)),
        (0.0, -0.6, (0.18, 0.03, 1.1)),
    ]):
        b.box(f"fan_blade_{i}", (3.5 + dx, 2.2, 2.5 + dz), size,
              wood_dark, parent=fan)
    # Rotation keyframes about Y in 90-degree steps (a 360-degree turn
    # cannot be keyframed with start/end alone — slerp takes the
    # zero-length path between identical orientations).
    fan_times = [0.0, 0.75, 1.5, 2.25, 3.0]
    fan_rots = []
    for deg in (0, 90, 180, 270, 360):
        half = math.radians(deg) / 2
        fan_rots.append((0.0, math.sin(half), 0.0, math.cos(half)))
    b.rotation_animation("ceiling_fan_spin", fan, fan_times, fan_rots)

    # -- living-room window + blinds (north wall). The blinds are a
    # group node so scene.js can move them (position.y) with the sun.
    box("window_glass", (2.0, 1.7, 0.09), (1.8, 1.4, 0.03), glass)
    blinds = b.group("blinds", (2.0, 1.8, 0.14))
    children.append(blinds)
    b.box("blinds_panel", (2.0, 1.8, 0.14), (1.6, 1.2, 0.05), white,
          parent=blinds)

    # -- kitchen furniture --
    box("counter", (11.5, 0.55, 2.5), (0.7, 0.9, 4.0), white)
    box("counter_top", (11.5, 1.02, 2.5), (0.75, 0.06, 4.0), wood_dark)
    box("cabinet_upper", (11.6, 2.0, 2.5), (0.4, 0.8, 3.0), white)
    box("fridge", (8.0, 1.05, 0.55), (0.9, 1.9, 0.75), metal)
    box("dining_table", (9.0, 0.55, 3.8), (1.6, 0.08, 0.9), wood_light)
    box("dining_table_leg_l", (8.3, 0.3, 3.8), (0.08, 0.5, 0.8), wood_dark)
    box("dining_table_leg_r", (9.7, 0.3, 3.8), (0.08, 0.5, 0.8), wood_dark)
    for i, (cx, cz) in enumerate([(8.4, 3.0), (9.6, 3.0), (8.4, 4.6), (9.6, 4.6)]):
        box(f"chair_{i}_seat", (cx, 0.32, cz), (0.45, 0.06, 0.45), wood_light)
        box(f"chair_{i}_back", (cx, 0.6, cz + (0.2 if cz < 3.8 else -0.2)),
            (0.45, 0.55, 0.06), wood_light)

    # -- bedroom furniture --
    box("bed_frame", (2.0, 0.25, 6.6), (1.9, 0.3, 2.2), wood_dark)
    box("mattress", (2.0, 0.48, 6.6), (1.8, 0.18, 2.1), white)
    box("blanket", (2.0, 0.55, 6.9), (1.8, 0.08, 1.3), fabric_green)
    box("pillow_l", (1.55, 0.6, 5.75), (0.7, 0.12, 0.4), white)
    box("pillow_r", (2.45, 0.6, 5.75), (0.7, 0.12, 0.4), white)
    box("headboard", (2.0, 0.9, 5.45), (1.9, 0.9, 0.08), wood_dark)
    box("wardrobe", (5.5, 1.2, 7.6), (2.2, 2.2, 0.6), wood_light)
    box("nightstand", (3.3, 0.35, 5.7), (0.5, 0.5, 0.4), wood_dark)

    # -- bathroom furniture --
    box("tub", (8.2, 0.35, 7.4), (1.7, 0.55, 0.75), white)
    box("tub_inner", (8.2, 0.55, 7.4), (1.5, 0.1, 0.55), glass)
    box("vanity", (11.4, 0.5, 6.2), (0.6, 0.8, 0.9), wood_dark)
    box("sink", (11.4, 0.92, 6.2), (0.5, 0.08, 0.7), white)
    box("mirror", (11.85, 1.7, 6.2), (0.05, 0.8, 0.7), glass)
    box("toilet_base", (9.5, 0.3, 7.5), (0.45, 0.4, 0.6), white)
    box("toilet_tank", (9.5, 0.7, 7.75), (0.45, 0.6, 0.15), white)

    # -- named lights (KHR_lights_punctual) --
    # Intensities are candela (physical units, three.js r155+ default).
    lights = [
        ("living_room_ceiling", (3.5, 2.4, 2.5), (1.0, 0.90, 0.75), 45.0),
        ("kitchen_counter", (9.5, 2.4, 2.5), (1.0, 0.97, 0.90), 40.0),
        ("bedroom_ceiling", (3.5, 2.4, 6.5), (1.0, 0.88, 0.70), 35.0),
        ("bathroom_ceiling", (9.5, 2.4, 6.5), (0.95, 0.98, 1.0), 30.0),
        ("living_room_lamp", (5.8, 1.5, 1.0), (1.0, 0.80, 0.55), 12.0),
    ]
    for name, pos, color, intensity in lights:
        children.append(b.light(name, pos, color, intensity))

    # -- named cameras (glTF cameras) --
    if include_cameras:
        cameras = [
            # Isometric dollhouse overview, matching the old builtin view.
            ("overview", (15.0, 12.0, 13.0), (6.0, 0.8, 4.0), 45.0),
            # Inside the living room, looking at the sofa + coffee table.
            ("living_room", (6.2, 2.0, 4.4), (1.8, 0.6, 1.6), 55.0),
        ]
        for name, pos, target, yfov in cameras:
            children.append(b.camera(name, pos, target, yfov))

    return b, children


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate the sample apartment GLB.")
    parser.add_argument("--out", default=None,
                        help="Output path (default: scene-renderer/models/sample-apartment.glb "
                             "relative to the repo root)")
    parser.add_argument("--no-cameras", action="store_true",
                        help="Omit the glTF cameras (tests the built-in "
                             "virtual camera fallback)")
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parent.parent
    out = Path(args.out) if args.out else repo_root / "scene-renderer" / "models" / "sample-apartment.glb"

    builder, children = build_apartment(include_cameras=not args.no_cameras)
    data = builder.build(children)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(data)

    print(f"Wrote {out} ({len(data)} bytes)")
    print(f"  meshes: {len(builder.meshes)}, materials: {len(builder.materials)}, "
          f"vertices: {len(builder.positions) // 3}, triangles: {len(builder.indices) // 3}")
    print("  lights:")
    for light in builder.lights:
        print(f"    - {light['name']} ({light['type']}, intensity {light['intensity']})")
    print("  cameras:")
    for cam in builder.cameras:
        print(f"    - {cam['name']} ({cam['type']}, yfov {math.degrees(cam['perspective']['yfov']):.0f}°)")
    print("  animations:")
    for anim in builder.animations:
        print(f"    - {anim['name']} (node {anim['node']}, {len(anim['times'])} keyframes, {anim['times'][-1]}s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
