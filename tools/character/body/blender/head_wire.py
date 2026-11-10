# Större bilder av ett huvud, utan och med trianglarna ritade. Argument: glb, ut.png.
import math, sys
import bpy
import numpy as np
GLB, OUT = sys.argv[sys.argv.index("--") + 1:][:2]
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
span = float((hi - lo).max())
cx, cy, cz = (float(x) for x in (lo + hi) / 2)
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
cam.ortho_scale = span * 1.05
c = bpy.data.objects.new("cam", cam)
bpy.context.collection.objects.link(c)
scene.camera = c
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = 24
scene.view_settings.view_transform = "Standard"
scene.render.resolution_x, scene.render.resolution_y = 700, 700
# Trianglarna: en kopia med Wireframe och mörkt material.
wire = ob.copy()
wire.data = ob.data.copy()
bpy.context.collection.objects.link(wire)
# Trianglarna från glb:n slås ihop till fyrhörningar igen, så att nätet visas som det är byggt.
import bmesh
bm = bmesh.new()
bm.from_mesh(wire.data)
bmesh.ops.join_triangles(bm, faces=bm.faces, angle_face_threshold=3.14, angle_shape_threshold=3.14, cmp_uvs=False, cmp_vcols=False, cmp_seam=False, cmp_sharp=False, cmp_materials=False)
bm.to_mesh(wire.data)
bm.free()
dark = bpy.data.materials.new("dark")
dark.use_nodes = True
dark.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.02, 0.02, 0.02, 1)
wire.data.materials[0] = dark
mod = wire.modifiers.new("w", "WIREFRAME")
mod.thickness = span * 0.0006
mod.offset = 1
paths = []
for name, on, ang in (("a", False, 0), ("b", False, 35), ("c", False, 90), ("d", True, 0), ("e", True, 35), ("f", True, 90)):
    wire.hide_render = not on
    a = math.radians(ang)
    c.rotation_euler = (math.pi / 2, 0, a)
    c.location = (cx + 5 * math.sin(a), cy - 5 * math.cos(a), cz)
    scene.render.filepath = f"{OUT}_{name}.png"
    bpy.ops.render.render(write_still=True)
    paths.append(scene.render.filepath)
print("RESULT", paths)
