# Människa från recept med MPFB (MakeHuman, CC0): spakar, låg kropp, ögon, hår och skelett. Argument: recept (JSON).
# Recept: {"macro": {...}, "proxy": "female1605", "hair": "ponytail01", "eyes": "low-poly", "rig": "default", "out": "<mapp>"}
# Skriver <out>/human.glb (kropp, ögon, hår, skelett) och en rad RESULT med JSON.
import json, os, sys
import bpy
from bl_ext.user_default.mpfb.services.assetservice import AssetService
from bl_ext.user_default.mpfb.services.humanservice import HumanService
from bl_ext.user_default.mpfb.services.targetservice import TargetService

r = json.loads(sys.argv[sys.argv.index("--") + 1])
os.makedirs(r["out"], exist_ok=True)
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o)
macro = TargetService.get_default_macro_info_dict()
macro.update(r.get("macro", {}))
base = HumanService.create_human(mask_helpers=True, detailed_helpers=False, extra_vertex_groups=True, feet_on_ground=True, scale=0.1, macro_detail_dict=macro)
# Finare spakar ur MakeHumans målbibliotek: {"torso/measure-waist-circ-decr": 0.5}.
TROOT = os.path.join(os.path.dirname(sys.modules[TargetService.__module__].__file__), "..", "data", "targets")
for name, w in r.get("targets", {}).items():
    TargetService.load_target(base, os.path.join(TROOT, name + ".target.gz"), weight=w, name=name.split("/")[-1])
bpy.context.view_layer.update()
rig = None
if r.get("rig"):
    rig = HumanService.add_builtin_rig(base, r["rig"], import_weights=True)
parts = {}
for kind, sub, atype, ext in (("proxy", "proxymeshes", "Proxymeshes", "proxy"), ("eyes", "eyes", "Eyes", "mhclo"), ("hair", "hair", "Hair", "mhclo")):
    name = r.get(kind)
    if name:
        path = AssetService.find_asset_absolute_path(f"{name}/{name}.{ext}", sub)
        ob = HumanService.add_mhclo_asset(path, base, asset_type=atype, subdiv_levels=0, material_type="GAMEENGINE")
        parts[kind] = ob.name if ob else None
bpy.context.view_layer.update()
dg = bpy.context.evaluated_depsgraph_get()
info = {}
for o in bpy.context.scene.objects:
    if o.type == "MESH":
        e = o.evaluated_get(dg).to_mesh()
        e.calc_loop_triangles()
        info[o.name] = {"verts": len(e.vertices), "tris": len(e.loop_triangles), "quads": sum(1 for p in e.polygons if len(p.vertices) == 4), "uv": bool(e.uv_layers)}
        o.evaluated_get(dg).to_mesh_clear()
# Bara kroppen syns: basen (med hjälpgeometrin) döljs om det finns en låg kropp.
if parts.get("proxy"):
    base.hide_set(True)
    base.hide_render = True
for o in bpy.context.scene.objects:
    o.select_set(not o.hide_get() and o.type in ("MESH", "ARMATURE"))
bpy.ops.export_scene.gltf(filepath=os.path.join(r["out"], "human.glb"), export_format="GLB", use_selection=True, export_apply=True, export_animations=False, export_skins=True, export_vertex_color="NONE")
# Samma figur i referensens pose, utan skelett: armarna sänks med skelettet, för projektionen och bilderna.
rigs = [o for o in bpy.context.scene.objects if o.type == "ARMATURE"]
if rigs and r.get("arm_angle_deg") is not None:
    from math import radians, sin, cos
    from mathutils import Matrix, Vector
    rig = rigs[0]
    W3 = rig.matrix_world.to_3x3()
    names = list(rig.pose.bones.keys())
    for side, sgn in (("L", 1), ("R", -1)):
        pb = rig.pose.bones[f"upperarm01.{side}"]
        end = rig.pose.bones[next(n for n in (f"wrist.{side}", f"lowerarm02.{side}") if n in names)]
        cur = (W3 @ (end.head - pb.head)).normalized()
        a_ = radians(r["arm_angle_deg"])
        # Blenders värld: +X är figurens vänster om hon ser mot -Y; armen pekar nedåt och lite utåt.
        side_x = 1 if (W3 @ pb.head).x > 0 else -1
        want = Vector((side_x * sin(a_), 0, -cos(a_)))
        Rw = cur.rotation_difference(want).to_matrix()
        Ra = (W3.inverted() @ Rw @ W3).to_4x4()
        h = pb.head.copy()
        pb.matrix = Matrix.Translation(h) @ Ra @ Matrix.Translation(-h) @ pb.matrix
        bpy.context.view_layer.update()
# Glb-exporten tillämpar aldrig skelettet, så posen bakas till egna nät.
dg = bpy.context.evaluated_depsgraph_get()
baked = []
for o in [o for o in bpy.context.scene.objects if o.type == "MESH" and not o.hide_get()]:
    me = bpy.data.meshes.new_from_object(o.evaluated_get(dg), depsgraph=dg)
    if not me.materials:
        me.materials.append(bpy.data.materials.new("skin"))
    n = bpy.data.objects.new(o.name.split(".")[-1], me)
    n.matrix_world = o.matrix_world
    bpy.context.collection.objects.link(n)
    baked.append(n)
for o in bpy.context.scene.objects:
    o.select_set(o in baked)
bpy.ops.export_scene.gltf(filepath=os.path.join(r["out"], "posed.glb"), export_format="GLB", use_selection=True, export_apply=True, export_animations=False, export_skins=False, export_vertex_color="NONE")
arm = [o for o in bpy.context.scene.objects if o.type == "ARMATURE"]
print("RESULT " + json.dumps({"parts": parts, "meshes": info, "bones": len(arm[0].data.bones) if arm else 0}))
