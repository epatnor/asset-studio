# Körs i Blender av tools/character/human/bake_detail.py: AI-formen (ur inpassningens wrap_debug.npz) och MPFB-figuren i
# samma pose läggs i samma rum, AI-ytans normaler bakas (tangentrum, selected to active) till figurens UV, ögonen och
# brynen tonas till plant, och kartan läggs på den riggade figuren. Skriver "DETAIL_RESULT {json}".
import json, os, sys

import bpy
import numpy as np
from mathutils import Vector
from mathutils.kdtree import KDTree

job = json.loads(sys.argv[sys.argv.index("--") + 1])
out = job["out"]; png = os.path.splitext(out)[0] + "_normal.png"; N = job["tex"]
d = np.load(job["debug"])


def clear():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o)


def load(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    return [o for o in bpy.data.objects if o not in before]


def world(o):
    a = np.empty(len(o.data.vertices) * 3); o.data.vertices.foreach_get("co", a); a = a.reshape(-1, 3)
    M = np.array(o.matrix_world)
    return a @ M[:3, :3].T + M[:3, 3]


clear()
objs = load(job["pose"])
body = max((o for o in objs if o.type == "MESH" and "low-poly" not in o.name), key=lambda o: len(o.data.vertices))
eyes = next((o for o in objs if o.type == "MESH" and "low-poly" in o.name), None)
# Figuren in i inpassningens rum: samma proxy och pose, så flytten är skillnaden mellan de omslutande lådornas mitt
# (närmaste punkt-inriktning mellan två punktmängder med 1,5–2 cm mellan hörnen konvergerade fel, 2026-11-10)
B = world(body); tpl = d["tpl"]
shift = (tpl.min(0) + tpl.max(0)) / 2 - (B.min(0) + B.max(0)) / 2
for o in objs:
    if o.parent is None:
        o.location += Vector(shift)
bpy.context.view_layer.update()
B = world(body)
kd = KDTree(len(tpl))
for i, p in enumerate(tpl):
    kd.insert(p, i)
kd.balance()
align = float(np.median([kd.find(Vector(p))[2] for p in B[::7]]))

# AI-formen som nät
me = bpy.data.meshes.new("ai")
me.from_pydata(d["ai"].astype(float).tolist(), [], d["ai_faces"].tolist())
me.update()
ai = bpy.data.objects.new("ai", me); bpy.context.collection.objects.link(ai)
for p in me.polygons:
    p.use_smooth = True

# Ögon och bryn: en mask (1 = plant) som färgattribut på figuren, bakad till en bild med samma UV
E = world(eyes) if eyes else None
mask = np.zeros(len(B))
if E is not None:
    for sg in (1, -1):
        sel = np.sign(E[:, 0]) == sg
        if sel.any():
            c = E[sel].mean(0)
            dd = np.linalg.norm(B - c, axis=1)
            mask = np.maximum(mask, np.clip((0.034 - dd) / 0.012, 0, 1))
            # brynen: ovanför ögat
            up = np.linalg.norm((B - c - np.array([0, 0, 0.022])) * np.array([0.8, 1.0, 1.6]), axis=1)
            mask = np.maximum(mask, np.clip((0.03 - up) / 0.012, 0, 1))
# händer och fötter: AI-formens händer är ihopsmälta klumpar och fötterna har sulor, så där blir kartan plan
# (sysslingen r12: ränder och block på fingrarna). Vikterna kommer ur inpassningen, hörn för hörn via närmaste punkt.
if "hand" in d.files:
    idx_ = np.array([kd.find(Vector(p))[1] for p in B])
    limb = np.maximum(np.clip(d["hand"][idx_] * 1.6 - 0.1, 0, 1), np.clip(d["foot"][idx_] * 1.6 - 0.1, 0, 1))
    mask = np.maximum(mask, limb)
ca = body.data.color_attributes.new("mask", "FLOAT_COLOR", "POINT")
ca.data.foreach_set("color", np.repeat(mask[:, None], 4, 1).astype(np.float32).ravel())

sc = bpy.context.scene
sc.render.engine = "CYCLES"; sc.cycles.device = "CPU"; sc.cycles.samples = 1
bk = sc.render.bake; bk.margin = 16; bk.margin_type = "EXTEND"


def target_material(img, emit_attr=None):
    m = bpy.data.materials.new("bake"); m.use_nodes = True; nt = m.node_tree
    tn = nt.nodes.new("ShaderNodeTexImage"); tn.image = img; nt.nodes.active = tn
    if emit_attr:
        at = nt.nodes.new("ShaderNodeAttribute"); at.attribute_name = emit_attr
        em = nt.nodes.new("ShaderNodeEmission"); nt.links.new(at.outputs["Color"], em.inputs["Color"])
        outn = next(n for n in nt.nodes if n.type == "OUTPUT_MATERIAL"); nt.links.new(em.outputs[0], outn.inputs["Surface"])
    body.data.materials.clear(); body.data.materials.append(m)


for o in bpy.data.objects:
    o.select_set(False)
img_m = bpy.data.images.new("mask", N, N, alpha=False, float_buffer=True)
target_material(img_m, "mask")
body.select_set(True); bpy.context.view_layer.objects.active = body
bk.use_selected_to_active = False
bpy.ops.object.bake(type="EMIT")
M_ = np.array(img_m.pixels[:]).reshape(N, N, 4)[..., 0]

img_n = bpy.data.images.new("normal", N, N, alpha=False, float_buffer=True)
img_n.colorspace_settings.name = "Non-Color"
target_material(img_n)
ai.select_set(True); body.select_set(True); bpy.context.view_layer.objects.active = body
bk.use_selected_to_active = True; bk.cage_extrusion = job["cage"]; bk.max_ray_distance = job["cage"] * 3
bk.normal_space = "TANGENT"
bpy.ops.object.bake(type="NORMAL")
P = np.array(img_n.pixels[:]).reshape(N, N, 4)
flat = np.array([0.5, 0.5, 1.0])
P[..., :3] = P[..., :3] * (1 - M_[..., None]) + flat * M_[..., None]
# Hur mycket kartan säger: andelen texlar som lutar mer än 10 grader från plant, inne i öarna
nz = P[..., :3] * 2 - 1
tilt = np.degrees(np.arccos(np.clip(nz[..., 2] / np.maximum(np.linalg.norm(nz, axis=-1), 1e-6), -1, 1)))
inside = np.abs(P[..., :3] - flat).sum(-1) > 1e-3
img_out = bpy.data.images.new("normal_out", N, N, alpha=False)
img_out.colorspace_settings.name = "Non-Color"
img_out.pixels.foreach_set(P.astype(np.float32).ravel())
img_out.filepath_raw = png; img_out.file_format = "PNG"; img_out.save()

# Den riggade figuren med normalkartan och en jämn hudfärg
clear()
rig_objs = load(job["rigged"])
rbody = max((o for o in rig_objs if o.type == "MESH" and "low-poly" not in o.name), key=lambda o: len(o.data.vertices))
im2 = bpy.data.images.load(png); im2.colorspace_settings.name = "Non-Color"
m2 = bpy.data.materials.new("skin"); m2.use_nodes = True; nt = m2.node_tree
bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
hexc = job["color"].lstrip("#"); rgb = [(int(hexc[i:i + 2], 16) / 255) ** 2.2 for i in (0, 2, 4)]
bsdf.inputs["Base Color"].default_value = (*rgb, 1); bsdf.inputs["Roughness"].default_value = 0.6
tn = nt.nodes.new("ShaderNodeTexImage"); tn.image = im2
nm = nt.nodes.new("ShaderNodeNormalMap"); nt.links.new(tn.outputs["Color"], nm.inputs["Color"]); nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
rbody.data.materials.clear(); rbody.data.materials.append(m2)
for o in bpy.data.objects:
    o.select_set(o in rig_objs)
bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", use_selection=True, export_apply=False, export_animations=False,
                          export_skins=True, export_tangents=True, export_vertex_color="NONE")
print("DETAIL_RESULT " + json.dumps({"out": out, "png": png, "align_mm": round(1000 * align, 2), "tex": N,
                                     "tilted_over_10deg": round(float((tilt[inside] > 10).mean()), 3) if inside.any() else 0.0,
                                     "masked_share": round(float((M_ > 0.5).mean()), 4), "skins": sum(1 for o in rig_objs if o.type == "ARMATURE")}))
