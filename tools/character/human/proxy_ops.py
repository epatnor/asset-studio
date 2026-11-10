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
    """Moves another MPFB part (hair, later clothes; the eyes use fit_eyes) with the wrap of the body proxy: MPFB fits the
    parts to the base mesh, but the wrap moves only the proxy. Each loose part smaller than 6 cm moves rigidly with the mean
    offset of the body within 2 cm; larger parts (hair) move per vertex with the inverse-distance mean of the 8 nearest body vertices.
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


def _eye_parts(part):
    """Loose parts of an MPFB eyes object (one per eye; corneas may be extra parts): vertex labels and the triangles."""
    import numpy as np
    me = part.data; n = len(me.vertices)
    ev = np.empty(len(me.edges) * 2, dtype=np.int64); me.edges.foreach_get("vertices", ev); ev = ev.reshape(-1, 2)
    lab = np.arange(n)
    while len(ev):
        m = np.minimum(lab[ev[:, 0]], lab[ev[:, 1]])
        new = lab.copy(); np.minimum.at(new, ev[:, 0], m); np.minimum.at(new, ev[:, 1], m)
        new = new[new]
        if (new == lab).all():
            break
        lab = new
    me.calc_loop_triangles()
    lt = np.empty(len(me.loop_triangles) * 3, dtype=np.int64); me.loop_triangles.foreach_get("vertices", lt)
    return lab, lt.reshape(-1, 3)


def _world(ob, co):
    import numpy as np
    M = np.array(ob.matrix_world)
    return co @ M[:3, :3].T + M[:3, 3]


def body_state(ob):
    """The body as exported (modifiers evaluated, at rest): world vertices and unit normals, N x 3 each."""
    import numpy as np
    dg = bpy.context.evaluated_depsgraph_get()
    e = ob.evaluated_get(dg).to_mesh()
    co = np.empty(len(e.vertices) * 3); e.vertices.foreach_get("co", co)
    nr = np.empty(len(e.vertices) * 3); e.vertices.foreach_get("normal", nr)
    ob.evaluated_get(dg).to_mesh_clear()
    M = np.array(ob.matrix_world)
    N = nr.reshape(-1, 3) @ M[:3, :3].T
    return co.reshape(-1, 3) @ M[:3, :3].T + M[:3, 3], N / np.maximum(np.linalg.norm(N, axis=1, keepdims=True), 1e-9)


def eye_gaps(eyes, body_world, normals):
    """Clearance between the skin around each eye and the eyeball, without images: for every body vertex within 3 cm of an
    eye whose normal faces away from the eye centre (the outside of the lids, not the rim tucked into the socket), the signed
    distance to the eye surface (negative = inside the eye, so the eye pokes through the lid there: the spike seen in the
    Normals view). Returns per eye: the lids' smallest gap in mm, how many vertices are inside, and the lower/upper split."""
    import numpy as np
    from mathutils import Vector
    from mathutils.bvhtree import BVHTree
    ec = np.empty(len(eyes.data.vertices) * 3); eyes.data.vertices.foreach_get("co", ec); EW = _world(eyes, ec.reshape(-1, 3))
    lab, tri = _eye_parts(eyes)
    out = []
    for t in np.unique(lab):
        sel = lab == t
        if np.ptp(EW[sel], axis=0).max() < 0.01:   # a small cornea or highlight part, not an eyeball
            continue
        g = _gaps_one(EW, tri[sel[tri].all(1)], EW[sel].mean(0), body_world, normals, np.zeros(3))
        out.append({k: v for k, v in g.items() if not k.startswith("_")})
    return out


def _gaps_one(EW, tri, c, BW, N, shift):
    import numpy as np
    from mathutils import Vector
    from mathutils.bvhtree import BVHTree
    bvh = BVHTree.FromPolygons([tuple(q) for q in EW], [tuple(x) for x in tri], all_triangles=True)
    hit, nrm, _, _ = bvh.find_nearest(Vector(tuple(c)))
    flip = 1.0 if (np.array(c) - np.array(hit)) @ np.array(nrm) < 0 else -1.0   # outward normals whatever the winding
    near = np.where(np.linalg.norm(BW - (c + shift), axis=1) < 0.03)[0]
    rad = BW[near] - (c + shift); rad /= np.maximum(np.linalg.norm(rad, axis=1, keepdims=True), 1e-9)
    near = near[(N[near] * rad).sum(1) > 0.3]   # the lids' outside, facing away from the eye
    g = np.empty(len(near))
    for k, i in enumerate(near):
        q = BW[i] - shift
        h, n_, _, d = bvh.find_nearest(Vector(tuple(q)))
        g[k] = d * np.sign(flip * (np.array(q) - np.array(h)) @ np.array(n_))
    inside = g < 0
    lower = BW[near][:, 2] < c[2] + shift[2]
    return {"min_gap_mm": round(1000 * float(g.min()), 2) if len(g) else None, "inside": int(inside.sum()),
            "inside_lower": int((inside & lower).sum()), "inside_upper": int((inside & ~lower).sum()), "_g": g, "_idx": near}


def fit_eyes(eyes, B0, B1, N1, clearance=0.0005, step=0.0002, max_push=0.004):
    """Places each eye in the reshaped socket (after a wrap and the Body Editor's edits): MPFB fits the eyes to the base mesh,
    but the wrap moves only the proxy. Each eyeball moves rigidly with the lid rim, the body vertices within 5 mm of its
    surface before the change (weighted, nearest most), not with the mean of everything within 2 cm, which pushed the eyes
    1.5 mm into the lower lids of the cousins (wrap6-20_t: lid skin 0.87 mm inside the eye, the spike in the Normals view).
    Then, while the outside of a lid is closer than the clearance a plain MPFB figure has (0.5 mm; or the gap before the
    change, if smaller), the eye steps back from those vertices (0.2 mm steps, at most 4 mm). Corneas move with their eye.
    B0/B1: the proxy's vertices (world) before the change and now, N1 its normals now (body_state). Without a change (B0 = B1)
    only the clearance step runs. Returns a short report per eye."""
    import numpy as np
    from mathutils import Vector
    from mathutils.bvhtree import BVHTree
    em = eyes.data
    ec = np.empty(len(em.vertices) * 3); em.vertices.foreach_get("co", ec); ec = ec.reshape(-1, 3); EW = _world(eyes, ec)
    lab, tri = _eye_parts(eyes)
    balls = [t for t in np.unique(lab) if np.ptp(EW[lab == t], axis=0).max() >= 0.01]
    move = np.zeros_like(EW); report = []
    for t in balls:
        sel = lab == t; c = EW[sel].mean(0)
        tri_t = tri[sel[tri].all(1)]
        bvh = BVHTree.FromPolygons([tuple(q) for q in EW], [tuple(x) for x in tri_t], all_triangles=True)
        cand = np.where(np.linalg.norm(B0 - c, axis=1) < 0.03)[0]
        d0 = np.array([bvh.find_nearest(Vector(tuple(B0[i])))[3] for i in cand])
        rim, w = cand[d0 < 0.005], (1 - d0[d0 < 0.005] / 0.005) ** 2
        shift = (w[:, None] * (B1[rim] - B0[rim])).sum(0) / max(w.sum(), 1e-9) if len(rim) else np.zeros(3)
        g0 = _gaps_one(EW, tri_t, c, B0, N1, np.zeros(3))
        want = min(clearance, g0["min_gap_mm"] / 1000) if g0["min_gap_mm"] is not None else clearance
        want = max(want, 0.0001)
        push = np.zeros(3); g = _gaps_one(EW, tri_t, c, B1, N1, shift)
        while g["min_gap_mm"] is not None and g["min_gap_mm"] / 1000 < want and np.linalg.norm(push) < max_push:
            bad = g["_idx"][g["_g"] < want]
            dirn = N1[bad].mean(0); dirn /= max(np.linalg.norm(dirn), 1e-9)
            push -= dirn * step
            g = _gaps_one(EW, tri_t, c, B1, N1, shift + push)
        own = np.linalg.norm(EW - c, axis=1) < 0.03   # the eyeball and the cornea/highlight parts on it
        move[own & (np.isin(lab, balls, invert=True) | sel)] = shift + push
        report.append({"rim_verts": int(len(rim)), "shift_mm": round(1000 * float(np.linalg.norm(shift)), 2),
                       "push_mm": round(1000 * float(np.linalg.norm(push)), 2), "min_gap_mm": g["min_gap_mm"], "inside": g["inside"]})
    em.vertices.foreach_set("co", (ec + move @ np.linalg.inv(np.array(eyes.matrix_world)[:3, :3]).T).ravel()); em.update()
    return report
