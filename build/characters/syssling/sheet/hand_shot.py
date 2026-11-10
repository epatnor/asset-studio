# Närbild av höger hand (bildens vänstra) med ljus i EEVEE, så att normalkartan syns. JSON {"glb", "out", "size"}
import bpy, json, sys, math
from mathutils import Vector
a = json.loads(sys.argv[sys.argv.index("--") + 1])
bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
bpy.ops.import_scene.gltf(filepath=a["glb"])
ms = [o for o in bpy.data.objects if o.type == "MESH" and "female" in o.name.lower() or (o.type == "MESH" and "male" in o.name.lower())]
print("MESHES", [(o.name, len(o.data.vertices)) for o in bpy.data.objects if o.type == "MESH"])
dg = bpy.context.evaluated_depsgraph_get()
pts = []
for o in ms:
    e = o.evaluated_get(dg).to_mesh(); pts += [o.matrix_world @ v.co for v in e.vertices]; o.evaluated_get(dg).to_mesh_clear()
zmin = min(p.z for p in pts); zmax = max(p.z for p in pts); H = zmax - zmin
xmax = max(p.x for p in pts)
zmin2 = zmin; hand = [p for p in pts if p.x > xmax - 0.10]   # handen: det yttersta på ena sidan
print("HANDPOS", len(hand), tuple(round(x, 3) for x in (sum(hand, Vector()) / max(1, len(hand)))), "H", round(H, 3))
c = sum(hand, Vector()) / len(hand)
cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam")); sc.collection.objects.link(cam); sc.camera = cam
cam.data.type = "ORTHO"; cam.data.ortho_scale = 0.26
cam.location = c + Vector((0.25, -1.0, 0.15)); cam.rotation_euler = (c - cam.location).to_track_quat("-Z", "Y").to_euler()
sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN")); sc.collection.objects.link(sun); sun.data.energy = 3.5
sun.rotation_euler = (math.radians(50), math.radians(-20), math.radians(25))
sc.world = bpy.data.worlds.new("w"); sc.world.use_nodes = True; sc.world.node_tree.nodes["Background"].inputs[1].default_value = 0.6
sc.render.engine = "BLENDER_EEVEE_NEXT" if "BLENDER_EEVEE_NEXT" in [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items] else "BLENDER_EEVEE"
sc.render.resolution_x = sc.render.resolution_y = a.get("size", 500)
sc.render.filepath = a["out"]; bpy.ops.render.render(write_still=True)
