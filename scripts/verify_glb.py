#!/usr/bin/env python3
"""Verify the rebuilt house-v2 GLB by parsing its JSON chunk directly
(no image decoding needed, so no three.js/DOM workarounds).
Checks: 16 lights (14 room with jittered values + 2 curtain glow at 0),
2 cameras (overview top-down), ceiling_shadow + ShadowOnly material,
fan/TV/door nodes, 8 window_* marker empties, SheerCurtain alpha 0.8
BLEND + weave normal map, textures intact (13 images / 28 textures).
Usage: verify_glb.py <path-to-glb> [expect-ceiling: yes|no]"""
import json
import struct
import sys

path = sys.argv[1]
expect_ceiling = (len(sys.argv) < 3 or sys.argv[2] != "no")

with open(path, "rb") as f:
    magic, version, length = struct.unpack("<III", f.read(12))
    assert magic == 0x46546C67, "not a GLB"
    chunk_len, chunk_type = struct.unpack("<II", f.read(8))
    assert chunk_type == 0x4E4F534A, "first chunk is not JSON"
    gltf = json.loads(f.read(chunk_len))

nodes = gltf.get("nodes", [])
meshes = gltf.get("meshes", [])
mats = gltf.get("materials", [])
images = gltf.get("images", [])
textures = gltf.get("textures", [])
lights = gltf.get("extensions", {}).get("KHR_lights_punctual", {}).get("lights", [])
cameras = gltf.get("cameras", [])

errors = []
by_name = {n.get("name"): n for n in nodes}

# --- lights: 16, jittered values, TV at base 14, glow at 0 ---
print(f"lights ({len(lights)}):")
total = 0.0
for li in lights:
    name = li["name"]
    inten = li["intensity"]
    color = li.get("color", [1, 1, 1])
    watts = inten / 54.35
    if name != "living_room_tv" and not name.startswith("curtain_glow_"):
        total += watts
    print(f"  {name:16s} intensity {inten:7.2f}  ~{watts:.4f}W  "
          f"color ({color[0]:.3f}, {color[1]:.3f}, {color[2]:.3f})")
if len(lights) != 16:
    errors.append(f"expected 16 lights, got {len(lights)}")
tv = next((li for li in lights if li["name"] == "living_room_tv"), None)
if tv is None or abs(tv["intensity"] - 14.0) > 0.5:
    errors.append("living_room_tv not at base 14")
# curtain glow lights: base 0, warm white (1.0, 0.95, 0.85), at the
# curtained windows (Blender (x, y, z) -> glTF (x, z, -y)).
GLOW_EXPECTED = {
    "curtain_glow_living_room": (-5.0, 1.5, -3.525),
    "curtain_glow_bedroom": (-5.0, 1.5, 3.525),
}
for gname, gpos in GLOW_EXPECTED.items():
    gl = next((li for li in lights if li["name"] == gname), None)
    if gl is None:
        errors.append(f"{gname} missing from KHR_lights_punctual")
        continue
    if abs(gl["intensity"]) > 0.01:
        errors.append(f"{gname} intensity {gl['intensity']}, expected 0")
    gc = gl.get("color", [1, 1, 1])
    if any(abs(a - b) > 0.01 for a, b in zip(gc, (1.0, 0.95, 0.85))):
        errors.append(f"{gname} color {gc}, expected (1.0, 0.95, 0.85)")
    gnode = by_name.get(gname, {})
    gt = gnode.get("translation")
    if gt is None:
        errors.append(f"{gname} node has no translation")
    elif any(abs(a - b) > 0.01 for a, b in zip(gt, gpos)):
        errors.append(f"{gname} at glTF {gt}, expected {gpos}")
    else:
        print(f"  {gname}: intensity 0, color (1.0, 0.95, 0.85), "
              f"glTF pos ({gt[0]:.3f}, {gt[1]:.3f}, {gt[2]:.3f})")
print(f"  room-light total (excl. TV, excl. glow): {total:.4f}W (was 9.2800W, "
      f"ratio {total / 9.28:.4f})")
# spread check: softest vs hardest room light (glow excluded — they are 0)
room = [li["intensity"] for li in lights
        if li["name"] != "living_room_tv"
        and not li["name"].startswith("curtain_glow_")]
print(f"  intensity spread: min {min(room):.1f}  max {max(room):.1f}")

# --- cameras: exactly 2, overview top-down ---
print(f"cameras ({len(cameras)}):")
cam_nodes = {}
for n in nodes:
    if "camera" in n:
        cam_nodes[n["name"]] = (n, cameras[n["camera"]])
for name, (n, c) in sorted(cam_nodes.items()):
    t = n.get("translation", [0, 0, 0])
    print(f"  {name}: type {c['type']}, pos "
          f"({t[0]:.2f}, {t[1]:.2f}, {t[2]:.2f}), yfov {c.get('yfov')}")
if sorted(cam_nodes) != ["living_room", "overview"]:
    errors.append(f"expected cameras [living_room, overview], got {sorted(cam_nodes)}")
ov = cam_nodes.get("overview")
if ov:
    t = ov[0].get("translation", [0, 0, 0])
    # glTF camera looks down its local -Z; Blender (0,0,18) -> glTF (0,18,0)
    if abs(t[0]) > 0.01 or abs(t[1] - 18.0) > 0.01 or abs(t[2]) > 0.01:
        errors.append(f"overview not top-down at (0,18,0) in glTF coords: {t}")
    else:
        print("  overview is top-down at glTF (0, 18, 0)")

# --- required nodes ---
for need in ["ceiling_fan", "tv_screen", "living_room_tv", "front_door",
             "tv_body", "fan_downrod"]:
    if need not in by_name:
        errors.append(f"missing node {need}")
fan = by_name.get("ceiling_fan", {})
if len(fan.get("children", [])) < 2:
    errors.append("ceiling_fan has <2 children (hub + blades)")
else:
    print(f"  ceiling_fan children: {len(fan['children'])} (hub + blades)")

# --- ceiling slab + ShadowOnly material ---
shadow_mats = [m for m in mats if m.get("name") == "ShadowOnly"]
print(f"  ShadowOnly materials: {len(shadow_mats)}")
if expect_ceiling:
    if "ceiling_shadow" not in by_name:
        errors.append("ceiling_shadow node missing (expected WITH ceiling)")
    if not shadow_mats:
        errors.append("ShadowOnly material missing")
else:
    if "ceiling_shadow" in by_name:
        errors.append("ceiling_shadow present (expected NO ceiling)")

# --- window treatments: one per window, same pattern both sides ---
TREATMENTS = {
    "living_room": "curtain", "dining": "blinds_h",
    "kitchen": "blinds_v", "office": None,
    "bedroom": "curtain", "kids_bedroom": "blinds_h",
    "bathroom_1": "blinds_v", "bathroom_2": None,
}
for room, prefix in TREATMENTS.items():
    have = [n for n in by_name if n.startswith(f"{prefix}_{room}_")] if prefix else []
    if prefix is None:
        continue
    print(f"  treatment {room}: {prefix} ({len(have)} nodes)")
    if not have:
        errors.append(f"no treatment nodes for {room} (expected {prefix})")
hb = [n for n in by_name if n.startswith("blinds_h_")]
vb = [n for n in by_name if n.startswith("blinds_v_")]
# curtain panels + rods only — the curtain_glow_* light nodes share the
# "curtain_" prefix and must not be counted here.
cu = [n for n in by_name
      if n.startswith("curtain_") and not n.startswith("curtain_glow_")]
print(f"  blinds_h nodes: {len(hb)} (expect 26: 2 rooms x 12 slats + 2 headrails)")
print(f"  blinds_v nodes: {len(vb)} (expect 24: 2 rooms x 11 slats + 2 headrails)")
print(f"  curtain nodes: {len(cu)} (expect 6: 2 rooms x 2 panels + 2 rods)")
if len(hb) != 26:
    errors.append(f"expected 26 horizontal-blind nodes, got {len(hb)}")
if len(vb) != 24:
    errors.append(f"expected 24 vertical-blind nodes, got {len(vb)}")
if len(cu) != 6:
    errors.append(f"expected 6 curtain nodes, got {len(cu)}")
sheer = [m for m in mats if m.get("name") == "SheerCurtain"]
if len(sheer) != 1:
    errors.append(f"expected 1 SheerCurtain material, got {len(sheer)}")
else:
    m = sheer[0]
    alpha = m.get("alphaMode", "OPAQUE")
    bcf = m.get("pbrMetallicRoughness", {}).get("baseColorFactor", [1, 1, 1, 1])
    nt = m.get("normalTexture", {})
    print(f"  SheerCurtain: alphaMode={alpha}, baseColor alpha={bcf[3]}, "
          f"baseColor=({bcf[0]:.3f}, {bcf[1]:.3f}, {bcf[2]:.3f}), "
          f"normalTexture index={nt.get('index')}, scale={nt.get('scale')}")
    if alpha != "BLEND":
        errors.append(f"SheerCurtain alphaMode is {alpha}, expected BLEND")
    if abs(bcf[3] - 0.8) > 0.01:
        errors.append(f"SheerCurtain baseColor alpha is {bcf[3]}, expected 0.8")
    if any(abs(a - b) > 0.01 for a, b in zip(bcf[:3], (0.97, 0.93, 0.83))):
        errors.append(f"SheerCurtain baseColor {bcf[:3]}, expected warm cream (0.97, 0.93, 0.83)")
    if m.get("doubleSided") is not True:
        errors.append("SheerCurtain is not doubleSided")
    if "index" not in nt:
        errors.append("SheerCurtain has no normalTexture (weave map missing)")
    elif abs(nt.get("scale", 1.0) - 0.4) > 0.01:
        errors.append(f"SheerCurtain normal scale {nt.get('scale')}, expected 0.4")
blind = [m for m in mats if m.get("name") == "BlindSlat"]
if len(blind) != 1:
    errors.append(f"expected 1 BlindSlat material, got {len(blind)}")
elif blind[0].get("alphaMode", "OPAQUE") != "OPAQUE":
    errors.append("BlindSlat is not opaque")

# --- window markers: 8 bare empties at the window centers ---
# Blender (x, y, z) -> glTF (x, z, -y); window center height 1.5 m.
MARKER_EXPECTED = {
    "window_living_room": (-5.0, 1.5, -4.0),
    "window_dining": (-0.5, 1.5, -4.0),
    "window_kitchen": (3.0, 1.5, -4.0),
    "window_office": (6.0, 1.5, -4.0),
    "window_bedroom": (-5.0, 1.5, 4.0),
    "window_kids_bedroom": (-1.6, 1.5, 4.0),
    "window_bathroom_1": (3.375, 1.5, 4.0),
    "window_bathroom_2": (6.125, 1.5, 4.0),
}
markers = [n for n in nodes if n.get("name", "").startswith("window_")]
print(f"  window markers: {len(markers)} (expect 8)")
if len(markers) != 8:
    errors.append(f"expected 8 window_* markers, got {len(markers)}")
for mname, mpos in MARKER_EXPECTED.items():
    mn = by_name.get(mname)
    if mn is None:
        errors.append(f"missing marker {mname}")
        continue
    if any(k in mn for k in ("mesh", "camera", "light",
                             "extensions")):
        errors.append(f"marker {mname} is not a bare empty node: "
                      f"{sorted(mn.keys())}")
    mt = mn.get("translation")
    if mt is None:
        errors.append(f"marker {mname} has no translation")
    elif any(abs(a - b) > 0.01 for a, b in zip(mt, mpos)):
        errors.append(f"marker {mname} at glTF {mt}, expected {mpos}")
    else:
        print(f"  {mname}: glTF ({mt[0]:.3f}, {mt[1]:.3f}, {mt[2]:.3f})")

# --- textures intact (12 PBR + 1 weave normal map) ---
print(f"  meshes: {len(meshes)}, materials: {len(mats)}, "
      f"images: {len(images)}, textures: {len(textures)}")
if len(images) != 13:
    errors.append(f"expected 13 embedded images, got {len(images)}")
if len(textures) != 28:
    errors.append(f"expected 28 textures, got {len(textures)}")

# --- door openings: wall segment count sanity (doors add segments) ---
wall_nodes = [n for n in nodes if n.get("name", "").startswith("wall_")]
print(f"  wall segment nodes: {len(wall_nodes)}")
if len(wall_nodes) < 60:
    errors.append(f"too few wall segments ({len(wall_nodes)}) — doors may be lost")

if errors:
    print("\nFAILED:")
    for e in errors:
        print("  -", e)
    sys.exit(1)
print("\nGLB VERIFY PASSED:", path)
