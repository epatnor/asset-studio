# Lerjämförelse: GLB-filer sida vid sida i grå lera (workbench), framifrån och snett från sidan. Argument: JSON {"glbs": [...], "out": png}
import bpy, json, sys, math
from mathutils import Vector
a = json.loads(sys.argv[sys.argv.index("--") + 1])
bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
x = 0.0; groups = []
for p in a["glbs"]:
    before = set(bpy.data.objects); bpy.ops.import_scene.gltf(filepath=p)
    objs = [o for o in bpy.data.objects if o not in before and o.type == "MESH"]
    bpy.context.view_layer.update()
    pts = [o.matrix_world @ Vector(c) for o in objs for c in o.bound_box]
    lo = Vector((min(q.x for q in pts), min(q.y for q in pts), min(q.z for q in pts))); hi = Vector((max(q.x for q in pts), max(q.y for q in pts), max(q.z for q in pts)))
    s = 1.65 / (hi.z - lo.z)
    roots = [o for o in bpy.data.objects if o not in before and o.parent is None]
    for r in roots:
        r.scale *= s
    bpy.context.view_layer.update()
    pts = [o.matrix_world @ Vector(c) for o in objs for c in o.bound_box]
    lo = Vector((min(q.x for q in pts), min(q.y for q in pts), min(q.z for q in pts))); hi = Vector((max(q.x for q in pts), max(q.y for q in pts), max(q.z for q in pts)))
    off = Vector((x - (lo.x + hi.x) / 2, -(lo.y + hi.y) / 2, -lo.z))
    for r in roots:
        r.location += off
    x += max(1.0, hi.x - lo.x + 0.25)
sc.render.engine = "BLENDER_WORKBENCH"
sh = sc.display.shading; sh.light = "STUDIO"; sh.color_type = "SINGLE"; sh.single_color = (0.72, 0.68, 0.64); sh.show_cavity = True
sc.render.resolution_x, sc.render.resolution_y = a.get("size", [1200, 520])
sc.world = bpy.data.worlds.new("w"); sc.render.film_transparent = False
cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam")); sc.collection.objects.link(cam); sc.camera = cam
cam.data.type = "ORTHO"; cam.data.ortho_scale = max(x, 1.9) * 1.02
mid = Vector(((x - max(1.0, 0)) / 2 - 0.0, 0, 0.85))
outs = []
for i, (az, tag) in enumerate(((0, "front"), (35, "side"))):
    d = 6.0; r = math.radians(az)
    cx = (x - 1.0) / 2
    cam.location = Vector((cx + d * math.sin(r), -d * math.cos(r), 0.9))
    cam.rotation_euler = (math.radians(90), 0, r)
    sc.render.filepath = a["out"].replace(".png", f"_{tag}.png"); bpy.ops.render.render(write_still=True); outs.append(sc.render.filepath)
print("SHEET", outs)
