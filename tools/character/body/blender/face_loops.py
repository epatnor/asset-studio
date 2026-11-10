# Fler loopar där ansiktet behöver dem: kring ögonen och i hakan. Formen ändras inte, bara hörnen blir fler. Argument: in.glb, ut.glb, JSON med eye_y, mouth_y, chin_y.
import json, sys
import bmesh
import bpy
from mathutils import Vector
IN, OUT, CFG = sys.argv[sys.argv.index("--") + 1:][:3]
c = json.loads(CFG)
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o)
bpy.ops.import_scene.gltf(filepath=IN)
ob = next(o for o in bpy.context.scene.objects if o.type == "MESH" and "female" in o.name)
bm = bmesh.new()
bm.from_mesh(ob.data)
bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
bmesh.ops.join_triangles(bm, faces=bm.faces, angle_face_threshold=3.14, angle_shape_threshold=3.14, cmp_uvs=False, cmp_vcols=False, cmp_seam=False, cmp_sharp=False, cmp_materials=False)
M = ob.matrix_world


def wanted(f):
    # Världens rum i Blender: uppåt är Z, framåt är -Y.
    p = M @ f.calc_center_median()
    x, up, front = p.x, p.z, -p.y
    if front < c["front_min"]:
        return False
    eye = ((abs(x) - 0.034) / 0.034) ** 2 + ((up - c["eye_y"]) / 0.024) ** 2 < 1
    chin = abs(x) < 0.042 and c["chin_y"] - 0.022 < up < c["mouth_y"] - 0.008
    return eye or chin


faces = [f for f in bm.faces if wanted(f)]
n0 = len(bm.faces)
edges = list({e for f in faces for e in f.edges})
bmesh.ops.subdivide_edges(bm, edges=edges, cuts=1, use_grid_fill=True, quad_corner_type="STRAIGHT_CUT")
bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 4])
quads = sum(1 for f in bm.faces if len(f.verts) == 4)
tris = sum(len(f.verts) - 2 for f in bm.faces)
bm.to_mesh(ob.data)
bm.free()
for o in bpy.context.scene.objects:
    o.select_set(o.type == "MESH")
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", use_selection=True, export_apply=False, export_animations=False, export_skins=False, export_vertex_color="NONE")
print("RESULT " + json.dumps({"picked_faces": len(faces), "faces_before": n0, "tris_after": tris, "quads_after": quads}))
