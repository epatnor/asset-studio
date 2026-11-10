# Bäckenet i lera från sidan och snett framifrån, för flera GLB i samma skala. Argument: mapp, glb ...
import math, os, sys
import bpy
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
scene.cycles.samples = 16
scene.view_settings.view_transform = "Standard"
scene.render.resolution_x, scene.render.resolution_y = 320, 360
clay = bpy.data.materials.new("clay")
clay.use_nodes = True
clay.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.5, 0.48, 0.46, 1)
for n, glb in enumerate(GLBS):
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o)
    bpy.ops.import_scene.gltf(filepath=glb)
    for o in scene.objects:
        if o.type == "MESH":
            for i in range(max(len(o.data.materials), 1)):
                if len(o.data.materials) <= i:
                    o.data.materials.append(clay)
                o.data.materials[i] = clay
            for poly in o.data.polygons:
                poly.use_smooth = True
    sun = bpy.data.lights.new("sun", "SUN")
    sun.energy = 2.2
    s = bpy.data.objects.new("sun", sun)
    bpy.context.collection.objects.link(s)
    s.rotation_euler = (math.radians(60), 0, math.radians(35))
    cam = bpy.data.cameras.new("cam")
    cam.type = "ORTHO"
    cam.ortho_scale = 0.5
    c = bpy.data.objects.new("cam", cam)
    bpy.context.collection.objects.link(c)
    scene.camera = c
    for ang in (0, 40, 90):
        a = math.radians(ang)
        c.rotation_euler = (math.pi / 2, 0, a)
        c.location = (5 * math.sin(a), -5 * math.cos(a), 0.92)
        scene.render.filepath = os.path.join(P, f"hip{n}_{ang}.png")
        bpy.ops.render.render(write_still=True)
