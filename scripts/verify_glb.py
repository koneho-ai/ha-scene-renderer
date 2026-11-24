#!/usr/bin/env python3
"""Verify the rebuilt house-v2 GLB by parsing its JSON chunk directly
(no image decoding needed, so no three.js/DOM workarounds).
Checks: 14 lights (13 room with jittered values + TV at base 14, no
curtain_glow_* lights — removed 2026-11-24 at the user's request),
2 cameras (overview angled 3/4 aerial from the south-west),
fan/TV/door nodes, 8 window_* marker empties, SheerCurtain alpha 0.8
BLEND + weave normal map, textures intact (13 images / 28 textures),
ha_light extras: tv_screen area light following living_room_tv +
ambient marker with day/night values.
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

# --- lights: 14, jittered values, TV at base 14 ---
# (No curtain_glow_* lights — removed 2026-11-24 at the user's request:
# the curtain glow comes from the SheerCurtain material itself and room
# re-emission from the bounce lights. None may exist.)
print(f"lights ({len(lights)}):")
total = 0.0
for li in lights:
    name = li["name"]
    inten = li["intensity"]
    color = li.get("color", [1, 1, 1])
    watts = inten / 54.35
    if name != "living_room_tv":
        total += watts
    print(f"  {name:16s} intensity {inten:7.2f}  ~{watts:.4f}W  "
          f"color ({color[0]:.3f}, {color[1]:.3f}, {color[2]:.3f})")
if len(lights) != 14:
    errors.append(f"expected 14 lights, got {len(lights)}")
tv = next((li for li in lights if li["name"] == "living_room_tv"), None)
if tv is None or abs(tv["intensity"] - 14.0) > 0.5:
    errors.append("living_room_tv not at base 14")
glow = [li["name"] for li in lights if li["name"].startswith("curtain_glow_")]
if glow:
    errors.append(f"curtain_glow_* lights must not exist, found {glow}")
glow_nodes = [n for n in by_name if n.startswith("curtain_glow_")]
if glow_nodes:
    errors.append(f"curtain_glow_* nodes must not exist, found {glow_nodes}")
print(f"  room-light total (excl. TV): {total:.4f}W (was 9.2800W, "
      f"ratio {total / 9.28:.4f})")
# spread check: softest vs hardest room light
room = [li["intensity"] for li in lights
        if li["name"] != "living_room_tv"]
print(f"  intensity spread: min {min(room):.1f}  max {max(room):.1f}")

# --- cameras: exactly 2, overview angled 3/4 aerial ---
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
    # glTF camera looks down its local -Z; Blender (-12,-12,14) ->
    # glTF (-12,14,12): the 0.3.9 angled 3/4 aerial from the
    # south-west (~39.5 deg elevation), chosen by angle_probe.mjs.
    if abs(t[0] + 12.0) > 0.01 or abs(t[1] - 14.0) > 0.01 or abs(t[2] - 12.0) > 0.01:
        errors.append(f"overview not angled at (-12,14,12) in glTF coords: {t}")
    else:
        print("  overview is angled at glTF (-12, 14, 12)")

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
# curtain panels + rods.
cu = [n for n in by_name if n.startswith("curtain_")]
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

# --- interior doors: 10 closed slabs (middle 4 + divN 3 + divS 3) ---
# Slabs are named door_<name>; handles are door_<name>_handle and
# frames are frame_door_<name>_*, so slabs = door_* minus handles.
slabs = [n for n in nodes
         if n.get("name", "").startswith("door_")
         and "_handle" not in n["name"]]
print(f"  interior door slabs: {len(slabs)} (expect 10)")
if len(slabs) != 10:
    errors.append(f"expected 10 interior door slabs, got {len(slabs)}")
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

# --- ha_light extras: model-declared lights glTF cannot express ---
# Private convention (see docs/wiki/Sample-Scene.md): a node with
# extras.ha_light declares a light the renderer creates. type "area":
# a RectAreaLight fitted to the mesh bounds, driven by a followed
# punctual light (follows) or a constant intensity; type "ambient":
# an AmbientLight on a bare empty, driven by sun elevation between
# day and night. A typo here silently does nothing in the renderer,
# so the validator checks every field.
import re
light_names = {li["name"] for li in lights}
ha_nodes = [(n.get("name"), n.get("extras", {}).get("ha_light"))
            for n in nodes
            if isinstance(n.get("extras", {}).get("ha_light"), dict)]
print(f"  ha_light nodes: {len(ha_nodes)} (expect 2: tv_screen area, "
      f"ambient ambient)")
for name, ha in ha_nodes:
    print(f"  {name}: {ha}")
    node = by_name.get(name, {})
    htype = ha.get("type")
    if htype not in ("area", "ambient"):
        errors.append(f"ha_light on {name}: type {htype!r}, "
                      f"expected 'area' or 'ambient'")
        continue
    if "color" in ha:
        if not isinstance(ha["color"], str) or not re.fullmatch(
                r"#(?:[0-9a-fA-F]{6})", ha["color"]):
            errors.append(f"ha_light on {name}: color {ha['color']!r}, "
                          f"expected '#rrggbb'")
    if htype == "area":
        if "mesh" not in node:
            errors.append(f"ha_light area on {name}: node has no mesh "
                          f"(area needs geometry to fit)")
        follows = ha.get("follows")
        inten = ha.get("intensity")
        if follows is not None and follows not in light_names:
            errors.append(f"ha_light area on {name}: follows {follows!r}, "
                          f"not a model light")
        if follows is None and inten is None:
            errors.append(f"ha_light area on {name}: needs 'follows' or "
                          f"'intensity'")
        if inten is not None and not isinstance(inten, (int, float)):
            errors.append(f"ha_light area on {name}: intensity "
                          f"{inten!r} is not a number")
        if "scale" in ha and not isinstance(ha["scale"], (int, float)):
            errors.append(f"ha_light area on {name}: scale {ha['scale']!r} "
                          f"is not a number")
        elif isinstance(ha.get("scale"), (int, float)) and ha["scale"] <= 0:
            errors.append(f"ha_light area on {name}: scale must be > 0")
    else:  # ambient
        if any(k in node for k in ("mesh", "camera")):
            errors.append(f"ha_light ambient on {name}: ambient has no "
                          f"geometry, declare it on a bare empty")
        for key in ("day", "night"):
            if key in ha and not isinstance(ha[key], (int, float)):
                errors.append(f"ha_light ambient on {name}: {key} "
                              f"{ha[key]!r} is not a number")
            elif isinstance(ha.get(key), (int, float)) and ha[key] < 0:
                errors.append(f"ha_light ambient on {name}: {key} must "
                              f"be >= 0")
        # NOTE: night > day is allowed (and is the sample model's
        # tuned state: night 0.2, day 0.05). The daytime fill comes
        # from the hemisphere (0.6), so the ambient day is only a
        # subtle lift, while at night the ambient is the ONLY fill
        # (hemisphere 0) and must carry the floor alone. An earlier
        # version of this check rejected night > day; the moonlight
        # tuning (2026-11-24) showed that assumption was wrong.
ha_by_name = dict(ha_nodes)
tv_ha = ha_by_name.get("tv_screen")
if tv_ha is None or tv_ha.get("type") != "area" or \
        tv_ha.get("follows") != "living_room_tv":
    errors.append("tv_screen must declare ha_light area following "
                  "living_room_tv")
# The sample model's tuned moonlit floor (see build_house_v2.py): night
# is dimly visible, not black, and the directional moonlight adds the
# patches. A rebuild that changes it must update this check too.
AMBIENT_NIGHT = 0.2
amb_ha = ha_by_name.get("ambient")
if amb_ha is None or amb_ha.get("type") != "ambient":
    errors.append("ambient marker must declare ha_light type ambient")
elif amb_ha.get("night") != AMBIENT_NIGHT:
    errors.append(f"ambient night is {amb_ha.get('night')}, expected "
                  f"{AMBIENT_NIGHT} (the tuned moonlit floor)")

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
