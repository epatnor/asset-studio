# render_views.py: körs i Blender på Darrowmere, utan skärm, för granskningarna och panelen.
#   blender -b --factory-startup -P render_views.py -- <modell.glb> <utmapp> [storlek] [motor]
# Renderar modellen från fyra håll runt den lodräta axeln plus snett framifrån, ortografiskt, med jämnt ljus och
# texturens färger: <stam>_render_a.png … _render_d.png och _render_e.png (snett). Vilket håll som är "fram" vet skriptet
# inte (Meshy och Tripo vänder modellerna olika), så vyerna namnges a–d i stället för fram/vänster/bak/höger.
# Motor: WORKBENCH (snabb, kräver EGL) eller CYCLES (processorn, alltid möjlig). Skriver en rad JSON.
import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector

args = sys.argv[sys.argv.index("--") + 1:]
src, out = Path(args[0]), Path(args[1])
size = int(args[2]) if len(args) > 2 else 512
engine = args[3].upper() if len(args) > 3 else "WORKBENCH"
out.mkdir(parents=True, exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=str(src))
meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
corners = [o.matrix_world @ Vector(c) for o in meshes for c in o.bound_box]
low = Vector([min(c[i] for c in corners) for i in range(3)])
high = Vector([max(c[i] for c in corners) for i in range(3)])
center, extent = (low + high) / 2, high - low

scene = bpy.context.scene
scene.render.resolution_x, scene.render.resolution_y = size, int(size * 4 / 3)
scene.render.film_transparent = False
world = bpy.data.worlds.new("bg")
scene.world = world
world.use_nodes = True
world.node_tree.nodes["Background"].inputs[0].default_value = (0.62, 0.62, 0.62, 1)
world.node_tree.nodes["Background"].inputs[1].default_value = 1.0
if engine == "CYCLES":
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 24
    scene.cycles.use_denoising = False
    scene.view_settings.view_transform = "Standard"
else:
    scene.render.engine = "BLENDER_WORKBENCH"
    shading = scene.display.shading
    shading.light, shading.color_type = "FLAT", "TEXTURE"
    shading.background_type, shading.background_color = "VIEWPORT", (0.62, 0.62, 0.62)
    scene.view_settings.view_transform = "Standard"

cam_data = bpy.data.cameras.new("cam")
cam_data.type = "ORTHO"
cam = bpy.data.objects.new("cam", cam_data)
scene.collection.objects.link(cam)
scene.camera = cam
height = max(extent.z, max(extent.x, extent.y) * 0.75) * 1.08
cam_data.ortho_scale = height
distance = max(extent) * 3 + 1

done = []
for name, angle in (("a", 0), ("b", 90), ("c", 180), ("d", 270), ("e", 45)):
    rad = math.radians(angle)
    direction = Vector((math.sin(rad), -math.cos(rad), 0))
    cam.location = center + direction * distance
    cam.rotation_euler = (-direction).to_track_quat("-Z", "Y").to_euler()
    path = out / f"{src.stem}_render_{name}.png"
    scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)
    done.append(path.name)
print("RENDER_RESULT " + json.dumps({"ok": True, "engine": scene.render.engine, "files": done}), flush=True)
