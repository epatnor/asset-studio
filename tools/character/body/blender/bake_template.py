# Körs i Blender: bakar AI-kroppens utseende (basfärg och normaler) till mallens UV och skriver en färdig GLB.
# blender --background --factory-startup --python bake_template.py -- '<json>'
# json: {"high": ai.glb, "low": mall.glb, "out": ut.glb, "maps": mapp, "name": "male_L3", "tex": 2048,
#        "extrusion": 0.012, "ray": 0.04, "cpu": false}
#   high: AI-kroppen i passningens rum (fit.py skriver build/fit/<namn>_ai.glb)
#   low: mallen på en nivå med UV-atlasen och eventuella morph targets (export.py); morph targets följer med
#   extrusion, ray: bakstrålarnas start utanför mallen och längd, i meter (mallen ligger nära AI-ytan)
#   maps_in: {"basecolor": png, "normal": png} hoppar över bakningen och sätter ihop modellen med färdiga kartor
# Samma metod som img2mesh/blender/lowpoly_bake.py: normalkartan med högpolyns material, färgen via emission.
import bpy, json, sys

args = json.loads(sys.argv[sys.argv.index("--") + 1])
TEX = args.get("tex", 2048)
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene


def select_only(objs, active):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = active


bpy.ops.import_scene.gltf(filepath=args["high"] if not args.get("maps_in") else args["low"])
meshes = [o for o in bpy.data.objects if o.type == "MESH"]
select_only(meshes, meshes[0])
if len(meshes) > 1:
    bpy.ops.object.join()
high = bpy.context.view_layer.objects.active
high.name = "high"
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

before = set(bpy.data.objects)
bpy.ops.import_scene.gltf(filepath=args["low"])
low = next(o for o in bpy.data.objects if o not in before and o.type == "MESH")
low.name = args.get("name", "body")
select_only([low], low)
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
bpy.ops.object.shade_smooth()

mat = bpy.data.materials.new(low.name)
low.data.materials.clear()
low.data.materials.append(mat)
nt = mat.node_tree
bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
bsdf.inputs["Roughness"].default_value = 0.75
maps = {}
for name, color in (("basecolor", "sRGB"), ("normal", "Non-Color")):
    img = bpy.data.images.new(f"{low.name}_{name}", TEX, TEX)
    img.colorspace_settings.name = color
    node = nt.nodes.new("ShaderNodeTexImage")
    node.image = img
    maps[name] = node

scene.render.engine = "CYCLES"
prefs = bpy.context.preferences.addons["cycles"].preferences
for kind in () if args.get("cpu") else ("OPTIX", "CUDA"):
    try:
        prefs.compute_device_type = kind
        prefs.get_devices()
        if any(d.type == kind for d in prefs.devices):
            for d in prefs.devices:
                d.use = True
            scene.cycles.device = "GPU"
            break
    except TypeError:
        pass
scene.cycles.samples = 4
bake = dict(use_selected_to_active=True, cage_extrusion=args.get("extrusion", 0.012),
            max_ray_distance=args.get("ray", 0.04), margin=16, use_clear=False)


def mean_color(obj):
    for m in obj.data.materials:
        s = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED").inputs["Base Color"]
        if s.links and s.links[0].from_node.type == "TEX_IMAGE":
            px = s.links[0].from_node.image.pixels[:]
            n = len(px) // 4
            step = max(1, n // 20000)
            return tuple(sum(px[i * 4 + c] for i in range(0, n, step)) / len(range(0, n, step)) for c in range(3)) + (1,)
    return (0.5, 0.5, 0.5, 1)


fill = {"basecolor": mean_color(high), "normal": (0.5, 0.5, 1, 1)}
for name, node in maps.items():
    node.image.generated_color = fill[name]


def bake_to(name, kind):
    nt.nodes.active = maps[name]
    select_only([high, low], low)
    bpy.ops.object.bake(type=kind, **bake)


if args.get("maps_in"):
    # Ingen bakning: kartorna finns redan (t.ex. en blandning av två kroppars kartor), sätt bara ihop modellen
    for name, node in maps.items():
        node.image = bpy.data.images.load(args["maps_in"][name])
        node.image.colorspace_settings.name = "sRGB" if name == "basecolor" else "Non-Color"
    high.data.materials.clear()
else:
    bake_to("normal", "NORMAL")
for hm in high.data.materials:
    hn = hm.node_tree
    p = next(n for n in hn.nodes if n.type == "BSDF_PRINCIPLED")
    out = next(n for n in hn.nodes if n.type == "OUTPUT_MATERIAL" and n.is_active_output)
    em = hn.nodes.new("ShaderNodeEmission")
    hn.links.new(em.outputs[0], out.inputs["Surface"])
    src = p.inputs["Base Color"]
    if src.links:
        hn.links.new(src.links[0].from_socket, em.inputs["Color"])
    else:
        em.inputs["Color"].default_value = tuple(src.default_value)
if not args.get("maps_in"):
    bake_to("basecolor", "EMIT")
for name, node in maps.items() if not args.get("maps_in") else ():
    node.image.filepath_raw = f"{args['maps']}/{low.name}_{name}.png"
    node.image.file_format = "PNG"
    node.image.save()
nt.links.new(maps["basecolor"].outputs["Color"], bsdf.inputs["Base Color"])
nm = nt.nodes.new("ShaderNodeNormalMap")
nt.links.new(maps["normal"].outputs["Color"], nm.inputs["Color"])
nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
for node in maps.values():
    node.image.pack()
select_only([low], low)
bpy.ops.export_scene.gltf(filepath=args["out"], export_format="GLB", use_selection=True, export_tangents=True,
                          export_morph=True, export_morph_normal=False)
tris = sum(len(p.vertices) - 2 for p in low.data.polygons)
keys = [k.name for k in low.data.shape_keys.key_blocks] if low.data.shape_keys else []
print("BODYGEN_RESULT " + json.dumps({"out": args["out"], "tris": tris, "tex": TEX, "shape_keys": keys}))
