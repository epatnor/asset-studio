# Spelupplaga av ett texturerat huvud: Decimate (collapse) med bevarad UV och nedskalad textur. Argument: in.glb, ut.glb, antal trianglar, texturstorlek.
import json, sys
import bpy
IN, OUT, TRIS, TEX = sys.argv[sys.argv.index("--") + 1:][:4]
TRIS, TEX = int(TRIS), int(TEX)
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o)
bpy.ops.import_scene.gltf(filepath=IN)
ob = [o for o in bpy.context.scene.objects if o.type == "MESH"][0]
bpy.context.view_layer.objects.active = ob
ob.select_set(True)
start = len(ob.data.polygons)
# Glb:ns normaler gäller högupplösningen och ger svarta prickar efter förenklingen. Sömmarna svetsas (UV:n ligger per hörn och blir kvar).
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.mesh.remove_doubles(threshold=1e-5)
bpy.ops.object.mode_set(mode="OBJECT")
bpy.ops.mesh.customdata_custom_splitnormals_clear()
mod = ob.modifiers.new("dec", "DECIMATE")
mod.decimate_type = "COLLAPSE"
mod.ratio = TRIS / start
bpy.ops.object.modifier_apply(modifier=mod.name)
bpy.ops.object.shade_smooth()
for im in bpy.data.images:
    if im.size[0] > TEX:
        im.scale(TEX, TEX)
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", use_selection=True, export_image_format="JPEG", export_jpeg_quality=92)
print("RESULT " + json.dumps({"from": start, "tris": len(ob.data.polygons)}))
