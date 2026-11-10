# Flera GLB i lera i samma skala (höjd 1,72 m): bäcken framifrån och snett, huvud framifrån och i profil. Argument: mapp, glb ...
import math, os, sys
import bpy
import numpy as np
args = sys.argv[sys.argv.index("--") + 1:]
P, GLBS = args[0], args[1:]
os.makedirs(P, exist_ok=True)
scene = bpy.context.scene
world = bpy.data.worlds.new("w")
world.use_nodes = True
world.node_tree.nodes["Background"].inputs[0].default_value = (0.9, 0.9, 0.9, 1)
world.node_tree.nodes["Background"].inputs[1].default_value = 0.7
scene.world = world
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = 12
scene.view_settings.view_transform = "Standard"
scene.render.resolution_x, scene.render.resolution_y = 300, 340
clay = bpy.data.materials.new("clay")
clay.use_nodes = True
clay.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.5, 0.48, 0.46, 1)
for n, glb in enumerate(GLBS):
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o)
    bpy.ops.import_scene.gltf(filepath=glb)
    obs = [o for o in scene.objects if o.type == "MESH"]
    bpy.context.view_layer.update()
    pts = []
    for o in obs:
        co = np.empty(len(o.data.vertices) * 3)
        o.data.vertices.foreach_get("co", co)
        M = np.array(o.matrix_world)
        pts.append(co.reshape(-1, 3) @ M[:3, :3].T + M[:3, 3])
        o.data.materials.clear()
        o.data.materials.append(clay)
        o.data.polygons.foreach_set("use_smooth", [True] * len(o.data.polygons))
        o.data.update()
    W = np.concatenate(pts)
    lo, hi = W.min(0), W.max(0)
    k = 1.72 / float(hi[2] - lo[2])
    cx, cy = float(np.median(W[:, 0])), float(np.median(W[:, 1]))
    for o in obs:
        o.scale = [v * k for v in o.scale]
        # Skalningen sker kring objektets origo, så läget skalas med: figuren ska stå på z = 0 med mitten i origo.
        o.location = ((o.location[0] - cx) * k, (o.location[1] - cy) * k, (o.location[2] - float(lo[2])) * k)
    sun = bpy.data.lights.new("sun", "SUN")
    sun.energy = 2.2
    s = bpy.data.objects.new("sun", sun)
    bpy.context.collection.objects.link(s)
    s.rotation_euler = (math.radians(60), 0, math.radians(30))
    cam = bpy.data.cameras.new("cam")
    cam.type = "ORTHO"
    c = bpy.data.objects.new("cam", cam)
    bpy.context.collection.objects.link(c)
    scene.camera = c
    for label, ang, ortho, z in (("hip0", 0, 0.5, 0.95), ("hip40", 40, 0.5, 0.95), ("face0", 0, 0.32, 1.58), ("face90", 90, 0.32, 1.58)):
        a = math.radians(ang)
        cam.ortho_scale = ortho
        c.rotation_euler = (math.pi / 2, 0, a)
        c.location = (5 * math.sin(a), -5 * math.cos(a), z)
        scene.render.filepath = os.path.join(P, f"v{n}_{label}.png")
        bpy.ops.render.render(write_still=True)
