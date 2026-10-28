# Körs i Blender: renderar en eller flera GLB-filer på rad i en bild, med standardljuset
# från docs/style-guide.md avsnitt 6 (värden ur tools/style.json).
# blender --background --factory-startup --python preview_glb.py -- '<json>'
# json: {"glbs": [...], "out": png, "style": style.json, "lod": 0, "size": [w, h], "labels": bool, "backlight": bool, "elev": grader}
# backlight: motljus snett bakifrån för karaktärer (style.json character.preview_backlight)
import bpy, json, math, sys
from mathutils import Matrix, Vector

args = json.loads(sys.argv[sys.argv.index("--") + 1])
style = json.load(open(args["style"]))["preview"]
LOD = args.get("lod", 0)

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene


def hex_rgb(h):
    h = h.lstrip("#")
    return tuple((int(h[i:i + 2], 16) / 255) ** 2.2 for i in (0, 2, 4))


def bounds(objs):
    pts = [o.matrix_world @ Vector(c) for o in objs if o.type == "MESH" for c in o.bound_box]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    return lo, hi


# Importera alla, visa bara vald LOD, ställ dem på rad längs x
x = 0.0
everything = []
for item in args["glbs"]:
    # Varje post är en sökväg eller {"glb": sökväg, "lod": n, "rot": grader} (LOD-nivåer eller vyer bredvid varandra;
    # rot vrider modellen runt lodlinjen, 90 = profil)
    path, lod = (item, LOD) if isinstance(item, str) else (item["glb"], item.get("lod", LOD))
    rot = 0 if isinstance(item, str) else item.get("rot", 0)
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in before]
    # Meshnoderna heter <namn>_trunk_LOD1 osv; hide_render ärvs inte från föräldern, så dölj själva meshen
    for o in new:
        if "_LOD" in o.name and f"_LOD{lod}" not in o.name:
            o.hide_render = True
    shown = [o for o in new if o.type == "MESH" and not o.hide_render]
    roots = [o for o in new if o.parent is None]
    for r in roots:
        if rot:
            r.matrix_world = Matrix.Rotation(math.radians(rot), 4, "Z") @ r.matrix_world
    bpy.context.view_layer.update()
    lo, hi = bounds(shown)
    width = hi.x - lo.x
    for r in roots:
        r.location.x += x - lo.x
    x += width * 1.15
    everything += shown

bpy.context.view_layer.update()
lo, hi = bounds(everything)
center = (lo + hi) / 2
size = hi - lo

# Mark
bpy.ops.mesh.primitive_plane_add(size=1, location=(center.x, center.y, 0))
ground = bpy.context.active_object
ground.scale = (size.x * 3 + 20, size.y * 3 + 40, 1)
gm = bpy.data.materials.new("Ground")
gm.use_nodes = True
gm.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (*hex_rgb("#5E8F3E"), 1)
gm.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 1.0
ground.data.materials.append(gm)

# Ljus enligt stilguiden: varm sol ~45°, kall himmel som fyllning
sun = bpy.data.objects.new("Sun", bpy.data.lights.new("Sun", "SUN"))
sun.data.energy = style["sun"]["energy"]
sun.data.color = hex_rgb(style["sun"]["color"])
sun.data.angle = math.radians(3)
sun.rotation_euler = (math.radians(90 - style["sun"]["elevation_deg"]), 0, math.radians(35))
scene.collection.objects.link(sun)
if args.get("backlight"):
    bl = json.load(open(args["style"]))["character"]["preview_backlight"]
    back = bpy.data.objects.new("Backlight", bpy.data.lights.new("Backlight", "SUN"))
    back.data.energy = bl["strength"]
    back.data.color = hex_rgb(bl["color"])
    # Azimut räknas från kamerans sida (0 = framljus, 180 = rakt bakifrån); kameran står på -Y
    back.rotation_euler = (math.radians(90 - bl["elevation_deg"]), 0, math.radians(bl["azimuth_deg"]))
    scene.collection.objects.link(back)
world = bpy.data.worlds.new("Sky")
world.use_nodes = True
bg = world.node_tree.nodes["Background"]
bg.inputs["Color"].default_value = (*hex_rgb(style["sky_color"]), 1)
bg.inputs["Strength"].default_value = style["sky_strength"]
scene.world = world

# Kamera: lätt ovanifrån, ramar in hela raden
w, h = args.get("size", [1024, 512])
cam = bpy.data.objects.new("Camera", bpy.data.cameras.new("Camera"))
scene.collection.objects.link(cam)
cam.data.lens = 50
cam.data.sensor_fit = "HORIZONTAL"
aspect = w / h
# Avstånd så att både bredd och höjd ryms, med 10 % marginal; kameran något ovanför mitten
fov_x = 2 * math.atan(cam.data.sensor_width / 2 / cam.data.lens)
fov_y = 2 * math.atan(math.tan(fov_x / 2) / aspect)
dist = max(size.x * 0.55 / math.tan(fov_x / 2), size.z * 0.55 / math.tan(fov_y / 2)) + size.y / 2
elev = math.radians(args.get("elev", 8))  # kamerans höjd i grader (husen granskas snett ovanifrån)
cam.location = (center.x, center.y - dist * math.cos(elev), center.z + dist * math.sin(elev))
target = bpy.data.objects.new("Target", None)
target.location = (center.x, center.y, center.z)
scene.collection.objects.link(target)
cam.constraints.new("TRACK_TO").target = target
scene.camera = cam

for eng in ("BLENDER_EEVEE", "BLENDER_EEVEE_NEXT"):
    try:
        scene.render.engine = eng
        break
    except TypeError:
        pass
scene.render.resolution_x, scene.render.resolution_y = w, h
try:
    scene.view_settings.view_transform = style["view_transform"]
    scene.view_settings.look = style["look"]
except TypeError:
    scene.view_settings.view_transform = "Standard"
scene.render.filepath = args["out"]
bpy.ops.render.render(write_still=True)
print("TINKER_RESULT " + json.dumps({"out": args["out"], "count": len(args["glbs"]), "lod": LOD}))
