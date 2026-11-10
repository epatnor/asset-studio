# Körs i Blender (utan fönster, med de sparade inställningarna så att MPFB laddas) av tools/character/human/make_human.py.
# En människa ur ett recept med reglage (human_sliders.json) på MPFB:s grundnät: proxy (spelupplösning), ögon och
# spelskelettet. Skriver <out>/<name>.glb (riggad, i MPFB:s vilopose) och <name>_pose.glb (armarna i vald vinkel, utan
# skelett: för jämförelser och inpassning mot Pixal3D-figurer i samma pose), och en rad "HUMAN_RESULT {json}".
# Bygger på body-gen/tools/blender/mpfb_human.py.
import json, os, sys
from math import radians, sin, cos

import bpy
from mathutils import Matrix, Vector
from bl_ext.user_default.mpfb.services.assetservice import AssetService
from bl_ext.user_default.mpfb.services.humanservice import HumanService
from bl_ext.user_default.mpfb.services.targetservice import TargetService

job = json.loads(sys.argv[sys.argv.index("--") + 1])
cat = json.load(open(job["catalog"]))
out, name = job["out"], job["name"]
os.makedirs(out, exist_ok=True)
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o)


def age_macro(years):
    """MakeHuman: 0 = 1 år, 0.1875 = 11, 0.5 = 25, 1 = 90. Bara vuxna: minst 18 år."""
    y = max(18.0, min(90.0, float(years)))
    return 0.1875 + (y - 11) / 14 * 0.3125 if y < 25 else 0.5 + (y - 25) / 65 * 0.5


r = job["recipe"]
macro = TargetService.get_default_macro_info_dict()
for m in cat["macro"]:
    if m["id"] in r:
        v = r[m["id"]]
        macro[m["macro"]] = age_macro(v) if m["id"] == "age" else max(m["min"], min(m["max"], float(v)))
for k, v in (r.get("macro") or {}).items():   # råa MPFB-värden går också (t.ex. "african": 0.3)
    macro[k] = v
base = HumanService.create_human(mask_helpers=True, detailed_helpers=False, extra_vertex_groups=True, feet_on_ground=False,
                                 scale=0.1, macro_detail_dict=macro)
TROOT = os.path.join(os.path.dirname(sys.modules[TargetService.__module__].__file__), "..", "data", "targets")
applied = {}


def load(path, w, label):
    TargetService.load_target(base, os.path.join(TROOT, path + ".target.gz"), weight=w, name=label)


for s in cat["sliders"]:
    v = float((r.get("sliders") or {}).get(s["id"], 0))
    if not v:
        continue
    v = max(-1.0, min(1.0, v))
    end = "-incr" if v > 0 else "-decr"
    paths = [s["pair"]] if "pair" in s else s["pairs"] if "pairs" in s else [s["lr"].format(s=side) for side in ("l", "r")]
    for p in paths:
        load(p + end, abs(v), (p + end).split("/")[-1])
    applied[s["id"]] = round(v, 3)
for path, w in (r.get("targets") or {}).items():   # vilket mål som helst ur biblioteket: {"torso/measure-waist-circ-decr": 0.5}
    load(path, w, path.split("/")[-1])
bpy.context.view_layer.update()
rig = HumanService.add_builtin_rig(base, r.get("rig", "game_engine"), import_weights=True) if r.get("rig", "game_engine") else None
sex = macro.get("gender", 0)
proxy = r.get("proxy") or ("male1591" if sex >= 0.5 else "female1605")
parts = {}
for kind, sub, atype, ext, nm in (("proxy", "proxymeshes", "Proxymeshes", "proxy", proxy), ("eyes", "eyes", "Eyes", "mhclo", r.get("eyes", "low-poly")),
                                  ("hair", "hair", "Hair", "mhclo", r.get("hair"))):
    if not nm:
        continue
    path = AssetService.find_asset_absolute_path(f"{nm}/{nm}.{ext}", sub)
    ob = HumanService.add_mhclo_asset(path, base, asset_type=atype, subdiv_levels=int(r.get("subdiv", 1)) if kind == "proxy" else 0,
                                      material_type="GAMEENGINE")
    parts[kind] = ob.name if ob else None
    for md in (ob.modifiers if ob else []):   # MPFB sätter bara render_levels; exporten använder levels
        if md.type == "SUBSURF":
            md.levels = md.render_levels
bpy.context.view_layer.update()
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import proxy_ops
pre_wrap = None   # the proxy (world) before the wrap, for the eyes
if r.get("wrap") and parts.get("proxy"):   # inpassningens wrap (fit_blender.py): proxyn tight mot AI-formen, inbakad i nätet
    import numpy as np
    wz = np.load(r["wrap"])
    px_ = bpy.data.objects[parts["proxy"]]
    proxy_ops.apply_subdiv(px_)   # samma topologisteg som i inpassningen
    if "hands_low" in wz.files and bool(wz["hands_low"]):
        applied["hands_low"] = proxy_ops.reduce_hands(px_)
    if len(px_.data.vertices) == int(wz["nverts"]) and str(wz["proxy"]) == proxy:
        co = np.empty(len(px_.data.vertices) * 3); px_.data.vertices.foreach_get("co", co)
        px_.data.vertices.foreach_set("co", (co.reshape(-1, 3) + wz["offsets"]).ravel()); px_.data.update()
        applied["wrap"] = True
        applied["tongue"] = proxy_ops.keep_tongue(px_, co.reshape(-1, 3))   # the tongue follows the mouth rigidly, not the wrap
        pre_wrap = proxy_ops._world(px_, co.reshape(-1, 3))   # the eyes are placed after the edits (fit_eyes below)
        after_ = np.empty(len(px_.data.vertices) * 3); px_.data.vertices.foreach_get("co", after_)
        if parts.get("hair"):   # hair follows the wrapped body per vertex
            applied["hair_follow"] = proxy_ops.follow_wrap(bpy.data.objects[parts["hair"]], px_, co.reshape(-1, 3), after_.reshape(-1, 3))
    else:
        applied["wrap"] = f"skipped: {len(px_.data.vertices)} verts, wrap has {int(wz['nverts'])}"
    bpy.context.view_layer.update()
if r.get("mons") and parts.get("proxy"):
    # Skötet (mons pubis): en liten utbuktning framför blygdbenet och ett grunt veck vid ljumskarna, längs proxyns normaler
    # (samma för alla kroppar: platsen räknas ur kroppen själv). mons 0..1 (1 = 9 mm buk, 3 mm veck). AI-formerna har ofta
    # trosor här, så formen kan inte hämtas därifrån.
    import numpy as np
    px_ = bpy.data.objects[parts["proxy"]]; me_ = px_.data
    M_ = np.array(px_.matrix_world); Mi_ = np.linalg.inv(M_)
    co = np.empty(len(me_.vertices) * 3); me_.vertices.foreach_get("co", co); co = co.reshape(-1, 3)
    W_ = co @ M_[:3, :3].T + M_[:3, 3]
    me_.calc_normals_split() if hasattr(me_, "calc_normals_split") else None
    nr = np.empty(len(me_.vertices) * 3); me_.vertices.foreach_get("normal", nr); nr = nr.reshape(-1, 3) @ M_[:3, :3].T
    nr /= np.maximum(np.linalg.norm(nr, axis=1, keepdims=True), 1e-9)
    H_ = np.ptp(W_[:, 2]); z0_ = W_[:, 2].min()
    # grenens topp: lägsta punkten på mittlinjen mellan benen (inom 1 cm från x = 0, mellan 40 och 60 % av längden)
    mid = (np.abs(W_[:, 0]) < 0.01) & (W_[:, 2] > z0_ + 0.40 * H_) & (W_[:, 2] < z0_ + 0.60 * H_)
    crotch = W_[mid][np.argmin(W_[mid][:, 2])] if mid.any() else None
    if crotch is not None:
        front = nr[:, 1] < -0.25   # Blender: framåt är -y
        cz = crotch[2] + 0.045
        dx, dz = W_[:, 0] / 0.055, (W_[:, 2] - cz) / 0.04
        bulge = np.exp(-(dx ** 2 + dz ** 2) * 1.6) * front * (W_[:, 1] < crotch[1] + 0.02)
        # vecket: två linjer från skötets sidor ned mot grenen, där låret möter
        crease = np.zeros(len(W_))
        for sx in (1, -1):
            a_, b_ = np.array([sx * 0.065, cz + 0.025]), np.array([sx * 0.014, crotch[2] + 0.008])
            q = np.stack([W_[:, 0], W_[:, 2]], 1); t = np.clip(((q - a_) @ (b_ - a_)) / ((b_ - a_) @ (b_ - a_)), 0, 1)
            dd = np.linalg.norm(q - (a_ + t[:, None] * (b_ - a_)), axis=1)
            crease = np.maximum(crease, np.exp(-(dd / 0.011) ** 2) * front * (W_[:, 1] < crotch[1] + 0.04))
        w_ = float(r["mons"])
        amount = w_ * (0.009 * bulge - 0.003 * crease)
        W2 = W_ + nr * amount[:, None]
        me_.vertices.foreach_set("co", (W2 @ Mi_[:3, :3].T + Mi_[:3, 3]).ravel()); me_.update()
        applied["mons"] = {"weight": w_, "moved_verts": int((np.abs(amount) > 0.0005).sum()), "max_mm": round(1000 * float(np.abs(amount).max()), 1)}
    else:
        applied["mons"] = "skipped: no crotch found"
    bpy.context.view_layer.update()
# Patriks egna ändringar (Body Editor i Character Creator): förflyttning per proxyhörn i glTF-rummet (y uppåt), i vilan,
# lagda sist. Filen: {"proxy", "nverts", "offsets": [x, y, z, ...]} (tools/character/human/EDITS.md)
import numpy as np
GLTF = np.array([[1.0, 0, 0], [0, 0, 1.0], [0, -1.0, 0]])   # Blender (z upp) -> glTF (y upp)
edit_info = None
if parts.get("proxy") and applied.get("wrap") is True:
    px_ = bpy.data.objects[parts["proxy"]]
    L3 = np.array(px_.matrix_world)[:3, :3]
    co = np.empty(len(px_.data.vertices) * 3); px_.data.vertices.foreach_get("co", co); co = co.reshape(-1, 3)
    base_rest = (co @ L3.T + np.array(px_.matrix_world)[:3, 3]) @ GLTF.T
    offs = np.zeros_like(co)
    if r.get("edits"):
        ed = json.load(open(r["edits"]))
        if int(ed.get("nverts", -1)) == len(co) and ed.get("proxy") == proxy:
            offs = np.array(ed["offsets"], float).reshape(-1, 3)
            local = (offs @ np.linalg.inv(GLTF).T) @ np.linalg.inv(L3).T
            px_.data.vertices.foreach_set("co", (co + local).ravel()); px_.data.update()
            applied["edits"] = {"moved_verts": int((np.linalg.norm(offs, axis=1) > 1e-5).sum()), "max_mm": round(1000 * float(np.linalg.norm(offs, axis=1).max()), 1)}
        else:
            applied["edits"] = f"skipped: {len(co)} verts, edits have {ed.get('nverts')}"
    px_.data.calc_loop_triangles()
    tri = np.empty(len(px_.data.loop_triangles) * 3, dtype=np.int64); px_.data.loop_triangles.foreach_get("vertices", tri)
    edit_info = {"base_rest": base_rest, "offsets": offs, "faces": tri, "obj": px_.name}
    bpy.context.view_layer.update()
if parts.get("eyes") and parts.get("proxy"):
    # The eyes into the final socket (after the wrap and the edits), clear of the lids; then the clearance as a check
    px_, eo_ = bpy.data.objects[parts["proxy"]], bpy.data.objects[parts["eyes"]]
    B1_, N1_ = proxy_ops.body_state(px_)
    B0_ = pre_wrap if pre_wrap is not None and len(pre_wrap) == len(B1_) else B1_
    applied["eyes_fit"] = proxy_ops.fit_eyes(eo_, B0_, B1_, N1_)
    bpy.context.view_layer.update()
    applied["eye_gaps"] = proxy_ops.eye_gaps(eo_, B1_, N1_)
if parts.get("proxy"):
    base.hide_set(True); base.hide_render = True
# MPFB:s feet_on_ground flyttar nätet men inte skelettet (armarna roterade då kring bäckenets höjd): ställ i stället
# hela figuren på marken genom att flytta skelettet, som näten sitter på, efter det nät som exporteras (proxyn)
_dg = bpy.context.evaluated_depsgraph_get()
_z = min(min((o.matrix_world @ v.co).z for v in o.evaluated_get(_dg).to_mesh().vertices)
         for o in bpy.context.scene.objects if o.type == "MESH" and not o.hide_get())
(rig or base).location.z -= _z
bpy.context.view_layer.update()

# Mått och kontroller: trianglar per nät, fötterna på marken, symmetri (spegling i X), längd
dg = bpy.context.evaluated_depsgraph_get()
meshes, tris, zmin, zmax, asym = {}, 0, 1e9, -1e9, 0.0
for o in bpy.context.scene.objects:
    if o.type != "MESH" or o.hide_get():
        continue
    e = o.evaluated_get(dg).to_mesh(); e.calc_loop_triangles()
    pts = [o.matrix_world @ v.co for v in e.vertices]
    meshes[o.name] = {"verts": len(e.vertices), "tris": len(e.loop_triangles), "uv": bool(e.uv_layers)}
    tris += len(e.loop_triangles)
    zmin, zmax = min(zmin, min(p.z for p in pts)), max(zmax, max(p.z for p in pts))
    if o.name == parts.get("proxy"):   # symmetri: speglade punkter mot närmaste yta (inte närmaste punkt; topologin är inte spegelbild)
        from mathutils.bvhtree import BVHTree
        bvh = BVHTree.FromPolygons(pts, [t.vertices for t in e.loop_triangles])
        d = sorted(bvh.find_nearest(Vector((-p.x, p.y, p.z)))[3] for p in pts)
        asym = d[int(len(d) * 0.99)]   # 99:e percentilen
    o.evaluated_get(dg).to_mesh_clear()
for o in bpy.context.scene.objects:
    o.select_set(not o.hide_get() and o.type in ("MESH", "ARMATURE"))
bpy.ops.export_scene.gltf(filepath=os.path.join(out, f"{name}.glb"), export_format="GLB", use_selection=True, export_apply=True,
                          export_animations=False, export_skins=True, export_vertex_color="NONE")

# Samma figur med armarna i vald vinkel (90 = T-pose, 45 = A-pose), bakad till nät utan skelett
pose = r.get("pose", "T")
angle = {"T": 90, "A": 45}.get(pose, pose if isinstance(pose, (int, float)) else None)
arms = [o for o in bpy.context.scene.objects if o.type == "ARMATURE"]
if arms and angle is not None:
    rig_o = arms[0]; W3 = rig_o.matrix_world.to_3x3(); names = list(rig_o.pose.bones.keys())
    limbs = [(f"upperarm_{s_}", f"hand_{s_}", angle) for s_ in "lr"]
    if r.get("leg_spread"):   # benen utåt från lodlinjen, grader (inpassningen anger det)
        limbs += [(f"thigh_{s_}", f"foot_{s_}", float(r["leg_spread"])) for s_ in "lr"]
    for up, lo, angle in limbs:
        if up not in names or lo not in names:
            continue
        pb, end = rig_o.pose.bones[up], rig_o.pose.bones[lo]
        cur = (W3 @ (end.head - pb.head)).normalized()
        a_ = radians(angle)
        side_x = 1 if (W3 @ pb.head).x > 0 else -1
        f_ = radians(float(r.get("arm_forward", 0))) if up.startswith("upperarm") else 0.0   # armarna framåt (grader)
        want = Vector((side_x * sin(a_) * cos(f_), -sin(f_), -cos(a_) * cos(f_)))
        Ra = (W3.inverted() @ cur.rotation_difference(want).to_matrix() @ W3).to_4x4()
        h = pb.head.copy()
        pb.matrix = Matrix.Translation(h) @ Ra @ Matrix.Translation(-h) @ pb.matrix
        bpy.context.view_layer.update()
    if r.get("elbow_flex") or r.get("elbow_carry"):   # armbågarna som i inpassningen (fit_blender.py, bend_elbows)
        W3 = rig_o.matrix_world.to_3x3()
        for sd in "lr":
            if f"lowerarm_{sd}" not in names or f"hand_{sd}" not in names:
                continue
            up, lo, hd = rig_o.pose.bones[f"upperarm_{sd}"], rig_o.pose.bones[f"lowerarm_{sd}"], rig_o.pose.bones[f"hand_{sd}"]
            u = (W3 @ (lo.head - up.head)).normalized(); cur = (W3 @ (hd.head - lo.head)).normalized()
            sx = 1 if (W3 @ lo.head).x > 0 else -1
            f_ = Vector((0, -1, 0)); f_ = (f_ - u * f_.dot(u)).normalized()
            o_ = Vector((sx, 0, 0)); o_ = (o_ - u * o_.dot(u) - f_ * o_.dot(f_)).normalized()
            a2, c2 = radians(float(r.get("elbow_flex", 0))), radians(float(r.get("elbow_carry", 0)))
            want = (u * (cos(a2) * cos(c2)) + f_ * sin(a2) + o_ * sin(c2)).normalized()
            Ra = (W3.inverted() @ cur.rotation_difference(want).to_matrix() @ W3).to_4x4()
            h = lo.head.copy()
            lo.matrix = Matrix.Translation(h) @ Ra @ Matrix.Translation(-h) @ lo.matrix
            bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    if edit_info:
        po = bpy.data.objects[edit_info["obj"]]; e = po.evaluated_get(dg).to_mesh()
        a_ = np.empty(len(e.vertices) * 3); e.vertices.foreach_get("co", a_); po.evaluated_get(dg).to_mesh_clear()
        Mw = np.array(po.matrix_world)
        edit_info["pose"] = (a_.reshape(-1, 3) @ Mw[:3, :3].T + Mw[:3, 3]) @ GLTF.T
    baked = []
    for o in [o for o in bpy.context.scene.objects if o.type == "MESH" and not o.hide_get()]:
        me = bpy.data.meshes.new_from_object(o.evaluated_get(dg), depsgraph=dg)
        if not me.materials:
            me.materials.append(bpy.data.materials.new("skin"))
        n = bpy.data.objects.new(o.name.split(".")[-1], me); n.matrix_world = o.matrix_world
        bpy.context.collection.objects.link(n); baked.append(n)
    for o in bpy.context.scene.objects:
        o.select_set(o in baked)
    bpy.ops.export_scene.gltf(filepath=os.path.join(out, f"{name}_pose.glb"), export_format="GLB", use_selection=True, export_apply=True,
                              export_animations=False, export_skins=False, export_vertex_color="NONE")
if edit_info:
    # Editorfilen: nätet i vila och i posen (samma hörnordning som bygget), trianglarna, de sparade ändringarna och, från
    # inpassningen, matriserna som för en förflyttning i posen till vilan (glTF-rummet, per hörn, rad för rad)
    doc = {"name": name, "proxy": proxy, "nverts": len(edit_info["base_rest"]), "space": "glTF, y up, metres",
           "rest": np.round(edit_info["base_rest"] + edit_info["offsets"], 5).ravel().tolist(),
           "base_rest": np.round(edit_info["base_rest"], 5).ravel().tolist(),
           "offsets": np.round(edit_info["offsets"], 5).ravel().tolist(), "faces": edit_info["faces"].tolist()}
    if "pose" in edit_info:
        doc["pose"] = np.round(edit_info["pose"], 5).ravel().tolist()
    wz_ = np.load(r["wrap"]) if r.get("wrap") else None
    if wz_ is not None and "pose_to_rest_local" in wz_.files and len(wz_["pose_to_rest_local"]) == doc["nverts"]:
        Pl = wz_["pose_to_rest_local"]; L3 = np.array(bpy.data.objects[edit_info["obj"]].matrix_world)[:3, :3]
        # glTF-förflyttning i posen -> Blender-värld -> proxyns vila (inpassningen) -> Blender-värld i vila -> glTF
        M = np.einsum("ij,njk,kl,lm->nim", GLTF, np.einsum("ij,njk->nik", L3, Pl), np.eye(3), np.linalg.inv(GLTF))
        doc["pose_to_rest"] = np.round(M, 5).reshape(len(M), 9).ravel().tolist()
    json.dump(doc, open(os.path.join(out, f"{name}_edit.json"), "w"))
print("HUMAN_RESULT " + json.dumps({"proxy": proxy, "meshes": meshes, "tris": tris, "bones": len(arms[0].data.bones) if arms else 0,
                                    "height_m": round(zmax - zmin, 3), "feet_z": round(zmin, 4), "asym_m": round(asym, 4),
                                    "sliders": applied, "pose": pose, "macro": {k: round(v, 3) for k, v in macro.items() if isinstance(v, (int, float))}}))
