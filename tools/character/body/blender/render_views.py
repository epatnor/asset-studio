"""Färgbilder av en GLB med platt ljus och utan perspektiv. Kamerariktningarna anges i glTF:s axlar (uppåt +Y).
  blender --background --python render_views.py -- '{"glb": "...", "folder": "...", "size": [864, 1152], "views": {"front": [0, 0, 1]}}'"""
import json
import sys
from pathlib import Path

import bpy
from mathutils import Vector

r = json.loads(sys.argv[sys.argv.index("--") + 1])
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=r["glb"])
meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
corners = [o.matrix_world @ Vector(c) for o in meshes for c in o.bound_box]
low = Vector(min(c[i] for c in corners) for i in range(3))
high = Vector(max(c[i] for c in corners) for i in range(3))
center, height = (low + high) / 2, high.z - low.z

scene = bpy.context.scene
scene.render.engine = "BLENDER_WORKBENCH"
scene.render.resolution_x, scene.render.resolution_y = r["size"]
scene.display.shading.light = "FLAT"
scene.display.shading.color_type = "TEXTURE"
scene.display.shading.background_type = "VIEWPORT"
scene.display.shading.background_color = (0.6, 0.6, 0.6)
scene.view_settings.view_transform = "Standard"
data = bpy.data.cameras.new("view")
data.type = "ORTHO"
data.ortho_scale = height / r.get("share", 0.92)
camera = bpy.data.objects.new("view", data)
scene.collection.objects.link(camera)
scene.camera = camera
for name, (x, y, z) in r["views"].items():
    unit = Vector((x, -z, y)).normalized()
    camera.location = center + unit * height * 2
    camera.rotation_euler = (-unit).to_track_quat("-Z", "Y").to_euler()
    scene.render.filepath = str(Path(r["folder"]) / f"{name}.png")
    bpy.ops.render.render(write_still=True)
