# Körs i Blender (utan fönster) av tools/mesh/make_low.py: en tung modell (t.ex. Pixal3D, ~700k trianglar) blir en spel­modell.
# Steg: decimera en kopia till målantalet trianglar, packa upp UV på nytt, baka färg och normalkarta från originalet
# (Cycles, selected to active), byt materialet och exportera GLB. Skriver en rad "LOW_RESULT {json}".
import json
import math
import os
import sys

import bpy

job = json.loads(sys.argv[sys.argv.index("--") + 1])
out_glb, tex_size, target = job["out"], int(job.get("tex", 1024)), int(job.get("tris", 1500))
out_dir = os.path.dirname(out_glb)
stem = os.path.splitext(os.path.basename(out_glb))[0]

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=job["high"])
meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
bpy.ops.object.select_all(action="DESELECT")
for o in meshes:
    o.select_set(True)
bpy.context.view_layer.objects.active = meshes[0]
if len(meshes) > 1:
    bpy.ops.object.join()
high = bpy.context.view_layer.objects.active
high.name = "high"
bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
high_tris = sum(len(p.vertices) - 2 for p in high.data.polygons)

# Låg: decimera en kopia (i två steg, så att formen hinner följa med), triangulera, mjuka normaler med skarpa kanter
low = high.copy(); low.data = high.data.copy(); low.name = "low"
bpy.context.collection.objects.link(low)
bpy.ops.object.select_all(action="DESELECT"); low.select_set(True); bpy.context.view_layer.objects.active = low
# Voxel-remesh först: jämnar ut AI-modellens brus och ger jämna trianglar, så att decimeringen inte blir hackig
vox = job.get("voxel", 1 / 140)
if vox:
    m = low.modifiers.new("vox", "REMESH"); m.mode = "VOXEL"; m.voxel_size = max(low.dimensions) * vox; m.use_smooth_shade = True
    bpy.ops.object.modifier_apply(modifier=m.name)
cur = sum(len(p.vertices) - 2 for p in low.data.polygons)
for ratio in (math.sqrt(min(1.0, target / cur)),) * 2:
    m = low.modifiers.new("dec", "DECIMATE"); m.decimate_type = "COLLAPSE"; m.ratio = ratio; m.use_collapse_triangulate = True
    bpy.ops.object.modifier_apply(modifier=m.name)
low.data.materials.clear()
bpy.ops.object.shade_smooth()
try:
    bpy.ops.object.shade_auto_smooth(angle=math.radians(job.get("smooth_angle", 40)))
    for m in list(low.modifiers):
        bpy.ops.object.modifier_apply(modifier=m.name)
except Exception:
    pass
low_tris = sum(len(p.vertices) - 2 for p in low.data.polygons)

# Ny UV
while low.data.uv_layers:
    low.data.uv_layers.remove(low.data.uv_layers[0])
low.data.uv_layers.new(name="UVMap")
bpy.ops.object.mode_set(mode="EDIT"); bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.01)
bpy.ops.object.mode_set(mode="OBJECT")

# Material med bakmål
mat = bpy.data.materials.new(stem); mat.use_nodes = True
low.data.materials.append(mat)
nt = mat.node_tree; bsdf = nt.nodes["Principled BSDF"]
imgs = {}
for kind, color in (("color", True), ("normal", False), ("orm", False)):
    img = bpy.data.images.new(f"{stem}_{kind}", tex_size, tex_size, alpha=False, float_buffer=False)
    if not color:
        img.colorspace_settings.name = "Non-Color"
    node = nt.nodes.new("ShaderNodeTexImage"); node.image = img; imgs[kind] = (img, node)

scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.samples = 4
try:
    prefs = bpy.context.preferences.addons["cycles"].preferences
    for dev in ("OPTIX", "CUDA"):
        try:
            prefs.compute_device_type = dev; prefs.get_devices()
            if any(d.type == dev for d in prefs.devices):
                for d in prefs.devices:
                    d.use = d.type == dev
                scene.cycles.device = "GPU"; break
        except Exception:
            continue
except Exception:
    pass
size = max(low.dimensions)
bake = scene.render.bake
bake.use_selected_to_active = True; bake.cage_extrusion = size * job.get("cage", 0.04); bake.max_ray_distance = size * job.get("ray", 0.2)
bake.margin = 8
bpy.ops.object.select_all(action="DESELECT"); high.select_set(True); low.select_set(True)
bpy.context.view_layer.objects.active = low
# Originalets material: metall har ingen diffus färg (blir svart i en DIFFUSE-bakning). Färgen bakas därför med metallvärdet
# satt till 0, och metall och ruffighet för sig som emission till en ORM-karta (G = ruffighet, B = metall, som glTF)
def socket_src(ntree, sock):
    return sock.links[0].from_socket if sock.links else None


hmats = [s.material for s in high.material_slots if s.material and s.material.use_nodes]
saved = []
for hm in hmats:
    hn = hm.node_tree; pb = next((n for n in hn.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if not pb:
        continue
    met, rough = pb.inputs["Metallic"], pb.inputs["Roughness"]
    saved.append((hm, pb, socket_src(hn, met), met.default_value, socket_src(hn, rough), rough.default_value))
    for l in list(met.links):
        hn.links.remove(l)
    met.default_value = 0.0


def bake_to(kind, btype, **kw):
    img, node = imgs[kind]
    nt.nodes.active = node
    bpy.ops.object.bake(type=btype, **kw)
    img.filepath_raw = os.path.join(out_dir, f"{stem}_{kind}.png"); img.file_format = "PNG"; img.save()


bake_to("color", "DIFFUSE", pass_filter={"COLOR"})
bake_to("normal", "NORMAL")
for hm, pb, msrc, mval, rsrc, rval in saved:   # ORM som emission: R = 1, G = ruffighet, B = metall
    hn = hm.node_tree
    comb = hn.nodes.new("ShaderNodeCombineColor"); comb.inputs[0].default_value = 1.0
    comb.inputs[1].default_value = rval; comb.inputs[2].default_value = mval
    if rsrc: hn.links.new(rsrc, comb.inputs[1])
    if msrc: hn.links.new(msrc, comb.inputs[2])
    emi = hn.nodes.new("ShaderNodeEmission"); hn.links.new(comb.outputs[0], emi.inputs["Color"])
    outn = next(n for n in hn.nodes if n.type == "OUTPUT_MATERIAL"); hn.links.new(emi.outputs[0], outn.inputs["Surface"])
bake_to("orm", "EMIT")

# Slutligt material: färg och normalkarta
links = nt.links
links.new(imgs["color"][1].outputs["Color"], bsdf.inputs["Base Color"])
nmap = nt.nodes.new("ShaderNodeNormalMap"); links.new(imgs["normal"][1].outputs["Color"], nmap.inputs["Color"])
links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])
sep = nt.nodes.new("ShaderNodeSeparateColor"); links.new(imgs["orm"][1].outputs["Color"], sep.inputs["Color"])
links.new(sep.outputs[1], bsdf.inputs["Roughness"]); links.new(sep.outputs[2], bsdf.inputs["Metallic"])
bpy.data.objects.remove(high, do_unlink=True)
bpy.ops.object.select_all(action="DESELECT"); low.select_set(True)
bpy.ops.export_scene.gltf(filepath=out_glb, export_format="GLB", use_selection=True, export_image_format="AUTO")
print("LOW_RESULT " + json.dumps({"ok": True, "high_tris": high_tris, "tris": low_tris, "tex": tex_size,
                                   "device": scene.cycles.device, "size_m": round(size, 3)}))
