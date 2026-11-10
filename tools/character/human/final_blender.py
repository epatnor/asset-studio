# Körs i Blender av tools/character/human/make_final.py: den riggade figuren får hudens material (färgkarta eller jämn
# hudfärg, detaljernas normalkarta, ruffighet) och exporteras som en GLB med skelett och tangenter. Ögonen behåller sitt
# eget material. Skriver "FINAL_RESULT {json}".
import json, sys

import bpy

job = json.loads(sys.argv[sys.argv.index("--") + 1])
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o)
bpy.ops.import_scene.gltf(filepath=job["rigged"])
objs = list(bpy.data.objects)
meshes = [o for o in objs if o.type == "MESH"]
eyes = [o for o in meshes if "low-poly" in o.name or "eye" in o.name.lower()]
body = max((o for o in meshes if o not in eyes), key=lambda o: len(o.data.vertices))
arm = next((o for o in objs if o.type == "ARMATURE"), None)

m = bpy.data.materials.new("skin"); m.use_nodes = True; nt = m.node_tree
bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
bsdf.inputs["Roughness"].default_value = job["roughness"]
if job["color"]:
    im = bpy.data.images.load(job["color"])
    t = nt.nodes.new("ShaderNodeTexImage"); t.image = im
    nt.links.new(t.outputs["Color"], bsdf.inputs["Base Color"])
else:
    h = job["skin"].lstrip("#")
    bsdf.inputs["Base Color"].default_value = (*[(int(h[i:i + 2], 16) / 255) ** 2.2 for i in (0, 2, 4)], 1)
if job["normal"]:
    imn = bpy.data.images.load(job["normal"]); imn.colorspace_settings.name = "Non-Color"
    tn = nt.nodes.new("ShaderNodeTexImage"); tn.image = imn
    nm = nt.nodes.new("ShaderNodeNormalMap"); nm.inputs["Strength"].default_value = job["normal_strength"]
    nt.links.new(tn.outputs["Color"], nm.inputs["Color"]); nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
body.data.materials.clear(); body.data.materials.append(m)

for o in bpy.data.objects:
    o.select_set(o in objs)
bpy.ops.export_scene.gltf(filepath=job["out"], export_format="GLB", use_selection=True, export_apply=False, export_animations=False,
                          export_skins=True, export_tangents=bool(job["normal"]), export_vertex_color="NONE")

dg = bpy.context.evaluated_depsgraph_get()
tris = 0
for o in meshes:
    me = o.evaluated_get(dg).to_mesh(); me.calc_loop_triangles(); tris += len(me.loop_triangles); o.evaluated_get(dg).to_mesh_clear()
zs = [(body.matrix_world @ v.co).z for v in body.data.vertices]
skinned = any(md.type == "ARMATURE" for md in body.modifiers) or body.parent == arm
links = lambda sock: any(l.to_socket == sock for l in nt.links)
print("FINAL_RESULT " + json.dumps({
    "tris": tris, "bones": len(arm.data.bones) if arm else 0, "skinned": bool(arm and skinned and len(body.vertex_groups) > 0),
    "eyes": bool(eyes) and all(e.active_material is not None for e in eyes), "height_m": round(max(zs) - min(zs), 3),
    "normal_map": links(bsdf.inputs["Normal"]), "color_map": links(bsdf.inputs["Base Color"]),
    "images": {i.name: list(i.size) for i in bpy.data.images if i.users and i.type == "IMAGE" and i.size[0] > 0}}))
