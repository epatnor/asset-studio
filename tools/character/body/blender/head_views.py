# Huvud i flera vinklar från en GLB, plus lera framifrån och från sidan. Argument: glb, mapp.
import math, os, sys
import bpy
import numpy as np
GLB, P = sys.argv[sys.argv.index("--") + 1:][:2]
os.makedirs(P, exist_ok=True)
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o)
bpy.ops.import_scene.gltf(filepath=GLB)
ob = [o for o in bpy.context.scene.objects if o.type == "MESH"][0]
bpy.context.view_layer.update()
co = np.empty(len(ob.data.vertices) * 3)
ob.data.vertices.foreach_get("co", co)
M = np.array(ob.matrix_world)
W = co.reshape(-1, 3) @ M[:3, :3].T + M[:3, 3]
lo, hi = W.min(0), W.max(0)
span = float(max(hi[2] - lo[2], hi[1] - lo[1], hi[0] - lo[0]))
cx, cy, cz = float((lo[0] + hi[0]) / 2), float((lo[1] + hi[1]) / 2), float((lo[2] + hi[2]) / 2)
scene = bpy.context.scene
world = bpy.data.worlds.new("w")
world.use_nodes = True
world.node_tree.nodes["Background"].inputs[0].default_value = (0.9, 0.9, 0.9, 1)
world.node_tree.nodes["Background"].inputs[1].default_value = 0.85
scene.world = world
sun = bpy.data.lights.new("sun", "SUN")
sun.energy = 1.6
s = bpy.data.objects.new("sun", sun)
bpy.context.collection.objects.link(s)
s.rotation_euler = (math.radians(55), 0, math.radians(-25))
cam = bpy.data.cameras.new("cam")
cam.type = "ORTHO"
c = bpy.data.objects.new("cam", cam)
bpy.context.collection.objects.link(c)
scene.camera = c
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = 16
scene.view_settings.view_transform = "Standard"
scene.render.resolution_x, scene.render.resolution_y = 320, 320
cam.ortho_scale = span * 1.05
def shots(prefix, angs):
    for ang in angs:
        a = math.radians(ang)
        c.rotation_euler = (math.pi / 2, 0, a)
        c.location = (cx + 5 * math.sin(a), cy - 5 * math.cos(a), cz)
        scene.render.filepath = os.path.join(P, f"{prefix}_{ang}.png")
        bpy.ops.render.render(write_still=True)
shots("head", (0, 35, 90, 180, -90))
clay = bpy.data.materials.new("clay")
clay.use_nodes = True
clay.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.42, 0.40, 0.38, 1)
ob.data.materials[0] = clay
shots("clay", (0, 90))
