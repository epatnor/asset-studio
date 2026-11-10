# Hela figuren och närbilder av huvud och hals, från en GLB med flera delar. Argument: glb, mapp.
import math, os, sys
import bpy
import numpy as np
GLB, P = sys.argv[sys.argv.index("--") + 1:][:2]
os.makedirs(P, exist_ok=True)
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o)
bpy.ops.import_scene.gltf(filepath=GLB)
meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
bpy.context.view_layer.update()
pts = []
for ob in meshes:
    co = np.empty(len(ob.data.vertices) * 3)
    ob.data.vertices.foreach_get("co", co)
    M = np.array(ob.matrix_world)
    pts.append(co.reshape(-1, 3) @ M[:3, :3].T + M[:3, 3])
W = np.concatenate(pts)
lo, hi = W.min(0), W.max(0)
H = float(hi[2] - lo[2])
cx, cy = float((lo[0] + hi[0]) / 2), float((lo[1] + hi[1]) / 2)
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
scene.cycles.samples = 24
scene.view_settings.view_transform = "Standard"
def shots(prefix, angs, res, ortho, z):
    scene.render.resolution_x, scene.render.resolution_y = res
    cam.ortho_scale = ortho
    for ang in angs:
        a = math.radians(ang)
        c.rotation_euler = (math.pi / 2, 0, a)
        c.location = (cx + 5 * math.sin(a), cy - 5 * math.cos(a), z)
        scene.render.filepath = os.path.join(P, f"{prefix}_{ang}.png")
        bpy.ops.render.render(write_still=True)
shots("body", (0, 90, 180), (360, 640), H * 1.04, float(lo[2] + H / 2))
shots("head", (0, 35, 90, 180), (420, 420), H * 0.27, float(hi[2] - H * 0.13))
shots("neck", (0, 90, 180), (420, 420), H * 0.14, float(hi[2] - H * 0.19))
shots("face", (0, 90), (420, 420), H * 0.17, float(hi[2] - H * 0.085))
clay = bpy.data.materials.new("clay")
clay.use_nodes = True
clay.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.5, 0.48, 0.46, 1)
for ob in meshes:
    for i in range(len(ob.data.materials)):
        ob.data.materials[i] = clay
shots("clayface", (0, 90), (420, 420), H * 0.17, float(hi[2] - H * 0.085))
shots("claybody", (90, 180), (360, 640), H * 1.04, float(lo[2] + H / 2))
