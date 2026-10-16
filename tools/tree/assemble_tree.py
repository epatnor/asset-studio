# Körs i Blender: bygger ihop ez-tree-OBJ + texturer till ett trädobjekt, renderar och exporterar GLB.
# blender --background --factory-startup --python assemble_tree.py -- '<json>'
# json: {"src": obj-mapp, "bark": png, "leaves": png, "out_dir": mapp, "name": str,
#        "height": meter, "bark_scale": [u, v], "preview": bool}
import bpy, json, math, sys

args = json.loads(sys.argv[sys.argv.index("--") + 1])
SRC = args["src"]
OUT = args["out_dir"]
NAME = args["name"]
TARGET_HEIGHT = float(args.get("height", 9.0))  # meter

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene


def import_obj(name):
    bpy.ops.wm.obj_import(filepath=f"{SRC}/{name}.obj")
    ob = bpy.context.selected_objects[0]
    ob.name = name
    return ob


def image_node(nt, path, non_color=False):
    n = nt.nodes.new("ShaderNodeTexImage")
    n.image = bpy.data.images.load(path)
    if non_color:
        n.image.colorspace_settings.name = "Non-Color"
    return n


branches, leaves = import_obj("branches"), import_obj("leaves")

# Skala till spelstorlek och ställ foten på marken
h = max(v.co.z for v in branches.data.vertices) * branches.scale.z
s = TARGET_HEIGHT / h
tree = bpy.data.objects.new(NAME, None)
scene.collection.objects.link(tree)
for ob in (branches, leaves):
    ob.parent = tree
tree.scale = (s, s, s)

# Bark: sömlös målad textur, upprepad runt stammen
bark = bpy.data.materials.new("Bark_Stylized")
bark.use_nodes = True
nt = bark.node_tree
bsdf = nt.nodes["Principled BSDF"]
tex = image_node(nt, args["bark"])
mapping = nt.nodes.new("ShaderNodeMapping")
bu, bv = args.get("bark_scale", [2.0, 1.0])
mapping.inputs["Scale"].default_value = (bu, bv, 1.0)
coord = nt.nodes.new("ShaderNodeTexCoord")
nt.links.new(coord.outputs["UV"], mapping.inputs["Vector"])
nt.links.new(mapping.outputs["Vector"], tex.inputs["Vector"])
nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
bsdf.inputs["Roughness"].default_value = 0.9
bark.use_backface_culling = True
branches.data.materials.clear()
branches.data.materials.append(bark)

# Löv: målad sprite med alfa, dubbelsidig
leaf = bpy.data.materials.new("Leaves_Stylized")
leaf.use_nodes = True
nt = leaf.node_tree
bsdf = nt.nodes["Principled BSDF"]
tex = image_node(nt, args["leaves"])
nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
# Round = alpha clip vid 0.5; glTF-exportern tolkar det som alphaMode MASK
clip = nt.nodes.new("ShaderNodeMath")
clip.operation = "ROUND"
nt.links.new(tex.outputs["Alpha"], clip.inputs[0])
nt.links.new(clip.outputs["Value"], bsdf.inputs["Alpha"])
bsdf.inputs["Roughness"].default_value = 0.8
leaf.use_backface_culling = False
if hasattr(leaf, "surface_render_method"):
    leaf.surface_render_method = "DITHERED"
leaves.data.materials.clear()
leaves.data.materials.append(leaf)

for ob in (branches, leaves):
    for p in ob.data.polygons:
        p.use_smooth = True

# Enkel förhandsvisningsscen
bpy.ops.mesh.primitive_plane_add(size=40)
ground = bpy.context.active_object
ground.name = "Ground"
gm = bpy.data.materials.new("Ground")
gm.diffuse_color = (0.25, 0.42, 0.18, 1)
gm.use_nodes = True
gm.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.22, 0.38, 0.15, 1)
ground.data.materials.append(gm)

sun = bpy.data.objects.new("Sun", bpy.data.lights.new("Sun", "SUN"))
sun.data.energy = 4.0
sun.data.color = (1.0, 0.93, 0.82)
sun.rotation_euler = (math.radians(50), 0, math.radians(35))
scene.collection.objects.link(sun)

world = bpy.data.worlds.new("Sky")
world.use_nodes = True
world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.55, 0.72, 0.95, 1)
world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.9
scene.world = world

cam = bpy.data.objects.new("Camera", bpy.data.cameras.new("Camera"))
scene.collection.objects.link(cam)
# Rama in hela trädet utifrån dess faktiska bredd
bpy.context.view_layer.update()
xs = [(leaves.matrix_world @ v.co) for v in leaves.data.vertices]
radius = max(math.hypot(p.x, p.y) for p in xs)
top = max(p.z for p in xs)
dist = max(radius, top) * 1.9
cam.location = (dist * 0.7, -dist * 0.7, top * 0.35)
target = bpy.data.objects.new("CamTarget", None)
target.location = (0, 0, top * 0.5)
scene.collection.objects.link(target)
c = cam.constraints.new("TRACK_TO")
c.target = target
cam.data.lens = 40
scene.camera = cam

for eng in ("BLENDER_EEVEE", "BLENDER_EEVEE_NEXT"):
    try:
        scene.render.engine = eng
        break
    except TypeError:
        pass
scene.render.resolution_x = scene.render.resolution_y = 1024
scene.render.filepath = f"{OUT}/{NAME}_preview.png"
scene.view_settings.view_transform = "Standard"
if args.get("preview", True):
    bpy.ops.render.render(write_still=True)

# Exportera bara trädet (inte mark/ljus/kamera)
bpy.ops.object.select_all(action="DESELECT")
for ob in (tree, branches, leaves):
    ob.select_set(True)
bpy.ops.export_scene.gltf(filepath=f"{OUT}/{NAME}.glb", use_selection=True, export_format="GLB", export_apply=True)
bpy.ops.wm.save_as_mainfile(filepath=f"{OUT}/{NAME}.blend")

summary = {
    "glb": f"{OUT}/{NAME}.glb",
    "height_m": TARGET_HEIGHT,
    "branch_tris": sum(len(p.vertices) - 2 for p in branches.data.polygons),
    "leaf_tris": sum(len(p.vertices) - 2 for p in leaves.data.polygons),
}
# Markerad rad så att anroparen kan plocka ut den ur Blenders loggutskrift
print("TINKER_RESULT " + json.dumps(summary))
