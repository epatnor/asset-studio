# Ansiktet framifrån med MakeHumans hud, så att ansiktspunkter kan hittas på modellen. Argument: glb, hud.png, ögon.png, ut.png, mitt-y, bredd i meter.
import math, sys
import bpy
GLB, SKIN, EYE, OUT, CY, WIDTH = sys.argv[sys.argv.index("--") + 1:][:6]
CY, WIDTH = float(CY), float(WIDTH)
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o)
bpy.ops.import_scene.gltf(filepath=GLB)
scene = bpy.context.scene


def textured(path):
    m = bpy.data.materials.new(path)
    m.use_nodes = True
    n = m.node_tree.nodes
    t = n.new("ShaderNodeTexImage")
    t.image = bpy.data.images.load(path)
    m.node_tree.links.new(t.outputs["Color"], n["Principled BSDF"].inputs["Base Color"])
    n["Principled BSDF"].inputs["Roughness"].default_value = 0.8
    return m


skin, eye = textured(SKIN), textured(EYE)
for o in list(scene.objects):
    if o.type != "MESH":
        continue
    if "ponytail" in o.name or "hair" in o.name:
        bpy.data.objects.remove(o)
        continue
    mat = eye if ("low-poly" in o.name or "eyes" in o.name) else skin
    o.data.materials.clear()
    o.data.materials.append(mat)
    for p in o.data.polygons:
        p.use_smooth = True
world = bpy.data.worlds.new("w")
world.use_nodes = True
world.node_tree.nodes["Background"].inputs[0].default_value = (0.7, 0.72, 0.78, 1)
world.node_tree.nodes["Background"].inputs[1].default_value = 1.0
scene.world = world
cam = bpy.data.cameras.new("cam")
cam.type = "ORTHO"
cam.ortho_scale = WIDTH
c = bpy.data.objects.new("cam", cam)
bpy.context.collection.objects.link(c)
scene.camera = c
c.rotation_euler = (math.pi / 2, 0, 0)
c.location = (0, -5, CY)
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = 24
scene.view_settings.view_transform = "Standard"
scene.render.resolution_x = scene.render.resolution_y = 1024
scene.render.filepath = OUT
bpy.ops.render.render(write_still=True)
