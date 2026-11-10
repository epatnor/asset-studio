# Fasta topologisteg på MPFB-proxyn, gemensamma för inpassningen (fit_blender.py) och bygget (human_blender.py), så att
# båda får exakt samma nät (samma hörn i samma ordning) för alla kroppar. Körs i Blender.
import bmesh
import bpy

HAND_PREFIXES = ("hand_", "index_", "middle_", "pinky_", "ring_", "thumb_")


def apply_subdiv(ob):
    """Proxyns uppdelning in i nätet, före skelettet (MPFB lägger den efter)."""
    for md in list(ob.modifiers):
        if md.type == "SUBSURF":
            with bpy.context.temp_override(object=ob, active_object=ob, selected_objects=[ob]):
                bpy.ops.object.modifier_move_to_index(modifier=md.name, index=0)
                bpy.ops.object.modifier_apply(modifier=md.name)


def reduce_hands(ob, thr=0.5):
    """Händerna tillbaka till proxyns egen täthet (uppdelningen tas bort där): ytor vars alla hörn hör till handens ben.
    Händerna hade 37 % av trianglarna, och uppdelningen smalnade av fingertopparna till klor (sysslingen, 2026-11-10)."""
    ids = {g.index for g in ob.vertex_groups if g.name.startswith(HAND_PREFIXES)}
    me = ob.data
    w = [sum(g.weight for g in v.groups if g.group in ids) for v in me.vertices]
    before = len(me.polygons)
    with bpy.context.temp_override(object=ob, active_object=ob, selected_objects=[ob]):
        bpy.context.view_layer.objects.active = ob
        bpy.ops.object.mode_set(mode="EDIT")
        bm = bmesh.from_edit_mesh(me)
        for f in bm.faces:
            f.select = all(w[v.index] > thr for v in f.verts)
        bmesh.update_edit_mesh(me)
        bpy.ops.mesh.unsubdivide(iterations=1)
        bpy.ops.mesh.select_all(action="DESELECT")
        bpy.ops.mesh.select_non_manifold()
        bm = bmesh.from_edit_mesh(me)
        nonmanifold = sum(1 for v in bm.verts if v.select)
        bpy.ops.object.mode_set(mode="OBJECT")
    me.calc_loop_triangles()
    return {"faces_before": before, "faces_after": len(me.polygons), "tris": len(me.loop_triangles), "nonmanifold_verts": nonmanifold}
