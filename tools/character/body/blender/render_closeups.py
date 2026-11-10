"""Närbilder i lera av flera GLB med samma kameror, utan perspektiv. Allt anges i glTF:s axlar (uppåt +Y).
  blender --background --python render_closeups.py -- '{"glbs": {"dense": "..."}, "folder": "...", "size": 340, "views": [{"name": "face_front", "dir": [0, 0, 1], "center": [0, 1.5, 0.05], "span": 0.3}]}'"""
import json
import sys
from pathlib import Path

import bpy
from mathutils import Vector

r = json.loads(sys.argv[sys.argv.index("--") + 1])
for tag, glb in r["glbs"].items():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    # Kantiga ytor som standard, så att olika modeller jämförs lika.
    bpy.ops.import_scene.gltf(filepath=glb, import_shading=r.get("shading", "FLAT"))
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.render.resolution_x = scene.render.resolution_y = r["size"]
    shading = scene.display.shading
    shading.light = "STUDIO"
    shading.color_type = "SINGLE"
    shading.single_color = (0.72, 0.62, 0.55)
    shading.background_type = "VIEWPORT"
    shading.background_color = (0.32, 0.34, 0.38)
    shading.show_cavity = False
    shading.show_shadows = False
    scene.view_settings.view_transform = "Standard"
    data = bpy.data.cameras.new("view")
    data.type = "ORTHO"
    camera = bpy.data.objects.new("view", data)
    scene.collection.objects.link(camera)
    scene.camera = camera
    for view in r["views"]:
        x, y, z = view["dir"]
        unit = Vector((x, -z, y)).normalized()
        cx, cy, cz = view["center"]
        data.ortho_scale = view["span"]
        camera.location = Vector((cx, -cz, cy)) + unit * 3
        camera.rotation_euler = (-unit).to_track_quat("-Z", "Y").to_euler()
        scene.render.filepath = str(Path(r["folder"]) / f"{tag}_{view['name']}.png")
        bpy.ops.render.render(write_still=True)
