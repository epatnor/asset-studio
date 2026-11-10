# Körs i Blender av tools/character/human/transfer_texture.py: källans färg bakas (selected to active) till MPFB-kroppens
# UV i samma pose, och bilden läggs sedan på den riggade figuren, som exporteras med skelett. Skriver "TRANSFER_RESULT {json}".
import json, os, sys

import bpy
import numpy as np
from mathutils import Vector

job = json.loads(sys.argv[sys.argv.index("--") + 1])
out = job["out"]; png = os.path.splitext(out)[0] + "_color.png"


def clear():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o)


def load(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    return [o for o in bpy.data.objects if o not in before]


def bbox(objs):
    pts = np.array([tuple(o.matrix_world @ Vector(c)) for o in objs for c in o.bound_box])
    return pts.min(0), pts.max(0)


def body_of(objs):
    meshes = [o for o in objs if o.type == "MESH"]
    return max(meshes, key=lambda o: len(o.data.vertices) if "low-poly" not in o.name else -1)


clear()
src = [o for o in load(job["source"]) if o.type == "MESH"]
tgt_all = load(job["pose"])
tgt = body_of(tgt_all)
# Källan kan vara flyttad (UltraTex lägger nätet ovanför origo): rikta in efter lådornas mitt, kontrollera skalan
(s0, s1), (t0, t1) = bbox(src), bbox([tgt])
scale = float(np.ptp([s0[2], s1[2]]) / max(1e-9, np.ptp([t0[2], t1[2]])))
shift = (t0 + t1) / 2 - (s0 + s1) / 2
for o in src:
    o.location += Vector(shift)
bpy.context.view_layer.update()

# Källans material: basfärgen som emission (bakas utan ljus)
for o in src:
    for slot in o.material_slots:
        m = slot.material
        if not m or not m.use_nodes:
            continue
        nt = m.node_tree
        bsdf = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None)
        outn = next((n for n in nt.nodes if n.type == "OUTPUT_MATERIAL"), None)
        if not bsdf or not outn:
            continue
        em = nt.nodes.new("ShaderNodeEmission")
        link = next((l for l in nt.links if l.to_socket == bsdf.inputs["Base Color"]), None)
        if link:
            nt.links.new(link.from_socket, em.inputs["Color"])
        else:
            em.inputs["Color"].default_value = bsdf.inputs["Base Color"].default_value
        nt.links.new(em.outputs[0], outn.inputs["Surface"])

# Målet: ny bild på MPFB:s UV
img = bpy.data.images.new("baked", job["tex"], job["tex"], alpha=False)
mat = bpy.data.materials.new("bake_target"); mat.use_nodes = True
tn = mat.node_tree.nodes.new("ShaderNodeTexImage"); tn.image = img
mat.node_tree.nodes.active = tn
tgt.data.materials.clear(); tgt.data.materials.append(mat)

sc = bpy.context.scene
sc.render.engine = "CYCLES"; sc.cycles.device = "CPU"; sc.cycles.samples = 1
bk = sc.render.bake
bk.use_selected_to_active = True; bk.cage_extrusion = job["cage"]; bk.max_ray_distance = job["cage"] * 3; bk.margin = job["margin"]
bk.margin_type = "EXTEND"
for o in bpy.data.objects:
    o.select_set(o in src)
tgt.select_set(True); bpy.context.view_layer.objects.active = tgt
bpy.ops.object.bake(type="EMIT")

# Täckning: andelen texlar inne i UV-öarna som fick färg (svart = ingen träff)
px = np.array(img.pixels[:]).reshape(job["tex"], job["tex"], 4)[..., :3]
uv = np.array([tuple(d.uv) for d in tgt.data.uv_layers.active.data])
inside = np.zeros((job["tex"], job["tex"]), bool)
for poly in tgt.data.polygons:   # grov mask: texlar vid hörnens UV
    for li in poly.loop_indices:
        u, v = uv[li]
        inside[min(job["tex"] - 1, int(v * job["tex"])), min(job["tex"] - 1, int(u * job["tex"]))] = True
coverage = float((px[inside].max(1) > 0.02).mean()) if inside.any() else 0.0
img.filepath_raw = png; img.file_format = "PNG"; img.save()

# Den riggade figuren med den nya bilden
clear()
rig_objs = load(job["rigged"])
body = body_of(rig_objs)
im2 = bpy.data.images.load(png)
m2 = bpy.data.materials.new("skin"); m2.use_nodes = True
nt = m2.node_tree; bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
t2 = nt.nodes.new("ShaderNodeTexImage"); t2.image = im2
nt.links.new(t2.outputs["Color"], bsdf.inputs["Base Color"])
bsdf.inputs["Roughness"].default_value = 0.6
body.data.materials.clear(); body.data.materials.append(m2)
for o in bpy.data.objects:
    o.select_set(o in rig_objs)
bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", use_selection=True, export_apply=False, export_animations=False,
                          export_skins=True, export_vertex_color="NONE")
skins = sum(1 for o in rig_objs if o.type == "ARMATURE")
print("TRANSFER_RESULT " + json.dumps({"out": out, "png": png, "coverage": round(coverage, 3), "scale_ratio": round(scale, 4),
                                       "shift_m": [round(float(x), 3) for x in shift], "body": body.name, "skins": skins, "tex": job["tex"]}))
