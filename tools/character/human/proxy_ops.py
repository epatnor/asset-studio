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


def keep_tongue(ob, before):
    """The proxy's tongue (a small loose part inside the mouth) after the wrap: its shape from before the wrap, moved
    rigidly with the mouth around it. The wrap otherwise stretched it with the face (cousin wrap6-13: 4.2 -> 6.6 cm wide,
    222 of 538 edges through the cheeks; wrap14-16: 6 edges through the mouth corners). If it still touches the skin it is
    shrunk towards its centre in small steps. before: the vertices (local, N x 3) before the wrap. Returns a short report."""
    import numpy as np
    from mathutils.bvhtree import BVHTree
    me = ob.data; n = len(me.vertices)
    ev = np.empty(len(me.edges) * 2, dtype=np.int64); me.edges.foreach_get("vertices", ev); ev = ev.reshape(-1, 2)
    lab = np.arange(n)   # loose parts by label propagation over the edges
    while True:
        m = np.minimum(lab[ev[:, 0]], lab[ev[:, 1]])
        new = lab.copy(); np.minimum.at(new, ev[:, 0], m); np.minimum.at(new, ev[:, 1], m)
        new = new[new]
        if (new == lab).all():
            break
        lab = new
    ids, counts = np.unique(lab, return_counts=True)
    if len(ids) < 2:
        return "no tongue"
    small = ids[counts < 0.1 * n]
    co = np.empty(n * 3); me.vertices.foreach_get("co", co); co = co.reshape(-1, 3)
    body = ~np.isin(lab, small)
    tongue = np.zeros(n, bool)
    for t in small:   # the tongue: the small part whose nearest body vertices are closest (inside the mouth)
        sel = lab == t
        c = before[sel].mean(0)
        if np.linalg.norm(before[body] - c, axis=1).min() < 0.05 and sel.sum() > tongue.sum():
            tongue = sel
    if not tongue.any():
        return "no tongue"
    c0 = before[tongue].mean(0)
    near = body & (np.linalg.norm(before - c0, axis=1) < 0.04)
    shift = (co[near] - before[near]).mean(0) if near.any() else np.zeros(3)
    me.calc_loop_triangles()
    lt = np.empty(len(me.loop_triangles) * 3, dtype=np.int64); me.loop_triangles.foreach_get("vertices", lt); lt = lt.reshape(-1, 3)
    tt, bt = lt[tongue[lt].all(1)], lt[body[lt].all(1)]
    scale = 1.0
    for _ in range(12):
        co[tongue] = c0 + shift + (before[tongue] - c0) * scale
        bt_tree = BVHTree.FromPolygons([tuple(q) for q in co], [tuple(t) for t in bt], all_triangles=True)
        tg_tree = BVHTree.FromPolygons([tuple(q) for q in co], [tuple(t) for t in tt], all_triangles=True)
        if not bt_tree.overlap(tg_tree):
            break
        scale *= 0.94
    crossing = len(bt_tree.overlap(tg_tree))
    me.vertices.foreach_set("co", co.ravel()); me.update()
    return {"verts": int(tongue.sum()), "shift_mm": round(1000 * float(np.linalg.norm(shift)), 1), "scale": round(scale, 3), "crossing_tris": crossing}


def follow_wrap(part, body, before, after):
    """Moves another MPFB part (eyes, hair, later clothes) with the wrap of the body proxy: MPFB fits the parts to the base
    mesh, but the wrap moves only the proxy. Each loose part smaller than 6 cm (an eye) moves rigidly with the mean offset of
    the body within 2 cm; larger parts (hair) move per vertex with the inverse-distance mean of the 8 nearest body vertices.
    before/after: the proxy's vertices (local) before and after the wrap. Returns a short report."""
    import numpy as np
    from mathutils.kdtree import KDTree
    Mb, Mp = np.array(body.matrix_world), np.array(part.matrix_world)
    B0 = before @ Mb[:3, :3].T + Mb[:3, 3]
    D = (after - before) @ Mb[:3, :3].T   # the wrap's offsets in world space
    me = part.data; n = len(me.vertices)
    if not n:
        return "empty"
    co = np.empty(n * 3); me.vertices.foreach_get("co", co); co = co.reshape(-1, 3)
    W = co @ Mp[:3, :3].T + Mp[:3, 3]
    kd = KDTree(len(B0))
    for i, q in enumerate(B0):
        kd.insert(q, i)
    kd.balance()
    ev = np.empty(len(me.edges) * 2, dtype=np.int64); me.edges.foreach_get("vertices", ev); ev = ev.reshape(-1, 2)
    lab = np.arange(n)
    while len(ev):
        m = np.minimum(lab[ev[:, 0]], lab[ev[:, 1]])
        new = lab.copy(); np.minimum.at(new, ev[:, 0], m); np.minimum.at(new, ev[:, 1], m)
        new = new[new]
        if (new == lab).all():
            break
        lab = new
    move = np.zeros_like(W); rigid = 0
    for t in np.unique(lab):
        sel = lab == t
        if np.ptp(W[sel], axis=0).max() < 0.06:
            near = [j for _, j, _ in kd.find_range(W[sel].mean(0), 0.02)] or [kd.find(W[sel].mean(0))[1]]
            move[sel] = D[near].mean(0); rigid += 1
        else:
            for i in np.where(sel)[0]:
                hits = kd.find_n(W[i], 8)
                w = np.array([1.0 / max(d, 1e-4) for _, _, d in hits])
                move[i] = (w[:, None] * D[[j for _, j, _ in hits]]).sum(0) / w.sum()
    me.vertices.foreach_set("co", (co + move @ np.linalg.inv(Mp[:3, :3]).T).ravel()); me.update()
    return {"rigid_parts": rigid, "max_mm": round(1000 * float(np.linalg.norm(move, axis=1).max()), 1)}
