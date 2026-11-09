# Körs i Blender av tools/character/human/fit_human.py. Character creatorns inpassning, omgång 1: letar fram de
# reglagevärden (makro + human_sliders.json) som gör MPFB:s grundnät likt en AI-form (Pixal3D-GLB). Ingen punkt flyttas
# fritt här: resultatet är bara ett recept, så topologi, UV och skelett förblir de gemensamma.
#
# Metoden: AI-formen skalas till mallens längd och ställs på marken. Armarnas och benens vinkel letas fram med ett rutnät.
# Sedan Gauss-Newton i några varv: varje reglage blir en kolumn (hur punkterna rör sig, i posen), avstånden tas åt båda
# hållen (mallens punkter mot AI-ytan längs normalen, AI-ytans punkter mot närmaste mallpunkt) och ett begränsat
# minsta-kvadrat-problem med en dragning mot standardvärdena ger nästa steg. Händerna räknas inte (fingrarna stämmer aldrig).
# Skriver <out>/recipe.json, <out>/overlay.png (före och efter, framifrån och från sidan: rött = AI-formen, blått = mallen,
# vitt = båda) och en rad "FIT_RESULT {json}".
import json, os, sys
from math import radians, sin, cos

import bpy
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree
from mathutils.kdtree import KDTree
from bl_ext.user_default.mpfb.services.humanservice import HumanService
from bl_ext.user_default.mpfb.services.targetservice import TargetService
from bl_ext.user_default.mpfb.services.rigservice import RigService
from bl_ext.user_default.mpfb.entities.objectproperties import HumanObjectProperties

job = json.loads(sys.argv[sys.argv.index("--") + 1])
cat = json.load(open(job["catalog"]))
out = job["out"]; os.makedirs(out, exist_ok=True)
r = job.get("start", {})
rng = np.random.default_rng(1)
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o)

# --- mallen -----------------------------------------------------------------------------------------------------------
macro = TargetService.get_default_macro_info_dict()
macro["gender"] = float(r.get("sex", 0))
FIT_MACROS = [m for m in cat["macro"] if m["id"] in job.get("fit_macros", ["muscle", "weight", "proportions", "bust_size"])]
if macro["gender"] >= 0.5:
    FIT_MACROS = [m for m in FIT_MACROS if m["id"] not in ("bust_size", "bust_firmness")]
for m in cat["macro"]:
    if m["id"] in r and m["id"] != "age":
        macro[m["macro"]] = float(r[m["id"]])
base = HumanService.create_human(mask_helpers=True, detailed_helpers=False, extra_vertex_groups=True, feet_on_ground=False,
                                 scale=0.1, macro_detail_dict=macro)
rig = HumanService.add_builtin_rig(base, "game_engine", import_weights=True)
rig.location.z -= min(v.co.z for v in base.data.vertices)   # på marken via skelettet (se human_blender.py)
for md in base.modifiers:
    if md.type == "MASK":
        md.show_viewport = False   # alla punkter i samma ordning; kroppen väljs med gruppen "body"
NV = len(base.data.vertices)
gi = {g.name: g.index for g in base.vertex_groups}
W = {}
for v in base.data.vertices:
    for g in v.groups:
        W.setdefault(g.group, np.zeros(NV))[v.index] = g.weight
body = W[gi["body"]] > 0.5
handbones = [n for n in gi if n.startswith(("hand_", "index_", "middle_", "pinky_", "ring_", "thumb_"))]
hand = sum(W.get(gi[n], np.zeros(NV)) for n in handbones) > 0.3
def region(names):
    return sum(W.get(gi[n], np.zeros(NV)) for n in names if n in gi)
REG = {"arms": region(["upperarm_l", "upperarm_r", "lowerarm_l", "lowerarm_r"]) > 0.5,
       "legs": region(["thigh_l", "thigh_r", "calf_l", "calf_r", "foot_l", "foot_r", "ball_l", "ball_r"]) > 0.5,
       "head": region(["head", "neck_01"]) > 0.5}
REG["torso"] = ~(REG["arms"] | REG["legs"] | REG["head"] | hand)
USE = body & ~hand
idx = np.nonzero(USE)[0]

def posed():
    dg = bpy.context.evaluated_depsgraph_get()
    e = base.evaluated_get(dg).to_mesh()
    a = np.empty(len(e.vertices) * 3); e.vertices.foreach_get("co", a)
    base.evaluated_get(dg).to_mesh_clear()
    M = np.array(base.matrix_world)
    a = a.reshape(-1, 3)
    return a @ M[:3, :3].T + M[:3, 3]

def set_pose(arm_deg, leg_deg, fwd_deg=None):
    global ARM_FWD
    if fwd_deg is not None:
        ARM_FWD = fwd_deg
    for pb in rig.pose.bones:
        pb.matrix_basis = Matrix.Identity(4)
    bpy.context.view_layer.update()
    W3 = rig.matrix_world.to_3x3()
    for up, lo, ang in [(f"upperarm_{s}", f"hand_{s}", arm_deg) for s in "lr"] + [(f"thigh_{s}", f"foot_{s}", leg_deg) for s in "lr"]:
        pb, end = rig.pose.bones[up], rig.pose.bones[lo]
        cur = (W3 @ (end.head - pb.head)).normalized()
        sx = 1 if (W3 @ pb.head).x > 0 else -1
        f = radians(ARM_FWD) if up.startswith("upperarm") else 0.0   # armarna kan också peka framåt (mot -y)
        want = Vector((sx * sin(radians(ang)) * cos(f), -sin(f), -cos(radians(ang)) * cos(f)))
        Ra = (W3.inverted() @ cur.rotation_difference(want).to_matrix() @ W3).to_4x4()
        h = pb.head.copy()
        pb.matrix = Matrix.Translation(h) @ Ra @ Matrix.Translation(-h) @ pb.matrix
        bpy.context.view_layer.update()

ARM_FWD = 0.0


def rest_angles():
    """Mallens egna vinklar (armar och ben mot lodlinjen), så att rutnätet börjar rätt."""
    W3 = rig.matrix_world.to_3x3(); out_ = []
    for up, lo in (("upperarm_l", "hand_l"), ("thigh_l", "foot_l")):
        d = (W3 @ (rig.pose.bones[lo].head - rig.pose.bones[up].head)).normalized()
        out_.append(float(np.degrees(np.arctan2(abs(d.x), -d.z))))
    return out_

# --- reglagen som kolumner ---------------------------------------------------------------------------------------------
TROOT = os.path.join(os.path.dirname(sys.modules[TargetService.__module__].__file__), "..", "data", "targets")
cols = []   # (namn, sort, nyckel(ar)/makro, min, max, prior)
for s in cat["sliders"]:
    if s["id"] in job.get("skip_sliders", []):
        continue
    paths = [s["pair"]] if "pair" in s else [s["lr"].format(s=x) for x in "lr"]
    for end in ("-incr", "-decr"):
        keys = []
        for p in paths:
            nm = "fit_" + (p + end).replace("/", "_")
            TargetService.load_target(base, os.path.join(TROOT, p + end + ".target.gz"), weight=0.0, name=nm)
            keys.append(nm)
        cols.append({"id": s["id"], "end": end, "kind": "slider", "keys": keys, "lo": 0.0, "hi": 1.0, "prior": 0.0, "x": 0.0})
for m in FIT_MACROS:
    cols.append({"id": m["id"], "kind": "macro", "macro": m["macro"], "lo": m["min"], "hi": m["max"], "prior": float(m["default"]),
                 "x": float(macro[m["macro"]])})
KB = base.data.shape_keys.key_blocks

def apply_x():
    for c in cols:
        if c["kind"] == "slider":
            for k in c["keys"]:
                KB[k].value = c["x"]
        else:
            HumanObjectProperties.set_value(c["macro"], c["x"], entity_reference=base)
    TargetService.reapply_macro_details(base, remove_zero_weight_targets=False)
    for c in cols:   # reapply nollställer inte våra nycklar, men säkrare att sätta dem igen
        if c["kind"] == "slider":
            for k in c["keys"]:
                KB[k].value = c["x"]
    RigService.refit_existing_armature(rig, base)
    bpy.context.view_layer.update()

def jacobian():
    P0 = posed(); J = []
    for c in cols:
        if c["kind"] == "slider":
            for k in c["keys"]:
                KB[k].value = c["x"] + 1.0
            bpy.context.view_layer.update(); J.append(posed() - P0)
            for k in c["keys"]:
                KB[k].value = c["x"]
        else:
            d = 0.08 if c["x"] + 0.08 <= c["hi"] else -0.08
            HumanObjectProperties.set_value(c["macro"], c["x"] + d, entity_reference=base)
            TargetService.reapply_macro_details(base, remove_zero_weight_targets=False)
            bpy.context.view_layer.update(); J.append((posed() - P0) / d)
            HumanObjectProperties.set_value(c["macro"], c["x"], entity_reference=base)
            TargetService.reapply_macro_details(base, remove_zero_weight_targets=False)
    bpy.context.view_layer.update()
    return P0, np.stack(J, -1)   # NV x 3 x K

# --- AI-formen ---------------------------------------------------------------------------------------------------------
before = set(bpy.data.objects)
bpy.ops.import_scene.gltf(filepath=job["target"])
parts = [o for o in bpy.data.objects if o not in before and o.type == "MESH"]
for o in [o for o in bpy.data.objects if o not in before and o.type != "MESH"]:
    for c in o.children:
        c.matrix_world = c.matrix_world.copy()
tv, tf, off = [], [], 0
for o in parts:
    M = o.matrix_world; me = o.data
    a = np.empty(len(me.vertices) * 3); me.vertices.foreach_get("co", a); a = a.reshape(-1, 3)
    tv.append(a @ np.array(M)[:3, :3].T + np.array(M)[:3, 3])
    me.calc_loop_triangles()
    t = np.empty(len(me.loop_triangles) * 3, dtype=np.int64); me.loop_triangles.foreach_get("vertices", t)
    tf.append(t.reshape(-1, 3) + off); off += len(me.vertices)
for o in list(bpy.data.objects):
    if o not in before:
        bpy.data.objects.remove(o)
TV0, TF = np.concatenate(tv), np.concatenate(tf)

XF = {"s": 1.0, "t": np.zeros(3), "rx": 0.0}   # AI-formens extra skala och förflyttning, som inpassningen själv letar fram

def place_target(P, yaw):
    """AI-formen skalad till mallens längd, på marken, centrerad efter kroppen under axlarna (hår och knut räknas inte),
    och sedan XF: den skala och förflyttning som inpassningen har letat fram."""
    V = TV0.copy()
    if yaw:
        V[:, :2] *= -1
    s = (P[:, 2].max() - P[:, 2].min()) / (V[:, 2].max() - V[:, 2].min())
    V *= s; V[:, 2] -= V[:, 2].min() - P[:, 2].min()
    lowV = V[V[:, 2] < V[:, 2].min() + 0.75 * np.ptp(V[:, 2])]; lowP = P[idx][P[idx, 2] < P[:, 2].min() + 0.75 * np.ptp(P[:, 2])]
    for k in (0, 1):
        V[:, k] += np.median(lowP[:, k]) - np.median(lowV[:, k])
    c, sn = np.cos(XF["rx"]), np.sin(XF["rx"])   # lutning framåt/bakåt kring fotsulorna (x-axeln genom origo)
    V = np.stack([V[:, 0], c * V[:, 1] - sn * V[:, 2], sn * V[:, 1] + c * V[:, 2]], 1)
    return V * XF["s"] + XF["t"]

def surf(V):
    bvh = BVHTree.FromPolygons([tuple(p) for p in V], [tuple(f) for f in TF], all_triangles=True)
    S = V[rng.choice(len(V), min(len(V), 40000), replace=False)]
    return bvh, S

def measure(P, bvh, S):
    """Avstånd åt båda hållen, per område: mallens punkter till AI-ytan och AI-ytans punkter till mallens närmaste punkt."""
    fw = np.array([bvh.find_nearest(Vector(P[i]))[3] for i in idx])
    kd = KDTree(len(idx))
    for j, i in enumerate(idx):
        kd.insert(P[i], j)
    kd.balance()
    bw = np.array([kd.find(Vector(q))[2] for q in S])
    res = {"mean_mm": round(1000 * float((fw.mean() + bw.mean()) / 2), 1), "to_ai_p95_mm": round(1000 * float(np.percentile(fw, 95)), 1),
           "from_ai_p95_mm": round(1000 * float(np.percentile(bw, 95)), 1)}
    for k, m in REG.items():
        sel = m[idx] & True
        res[k + "_mm"] = round(1000 * float(fw[sel].mean()), 1)
    return res

def pose_search(bvh):
    """Rutnät för armarnas och benens vinkel mot lodlinjen; armarna mäts på armarnas punkter, benen på benens."""
    def err(arm, leg, region_mask):
        set_pose(arm, leg); P = posed()
        sel = np.nonzero(region_mask & USE)[0][::3]
        return float(np.mean([bvh.find_nearest(Vector(P[i]))[3] for i in sel]))
    arm = min(range(15, 101, 5), key=lambda a: err(a, 3, REG["arms"]))
    arm = min(np.arange(max(10, arm - 4), arm + 4.1, 2), key=lambda a: err(a, 3, REG["arms"]))
    def err_f(fw):
        set_pose(arm, 3, fw); return err(arm, 3, REG["arms"])
    fwd = min(range(-10, 41, 5), key=err_f); set_pose(arm, 3, fwd)
    arm = min(np.arange(max(10, arm - 6), arm + 6.1, 2), key=lambda a: err(a, 3, REG["arms"]))
    leg = min(np.arange(0, 20.1, 2), key=lambda l: err(arm, l, REG["legs"]))
    set_pose(arm, leg)
    return float(arm), float(leg)

# Riktning (AI-formen kan vara vänd bakåt), pose och första mätningen
set_pose(*rest_angles())
P = posed()
def facing(X):
    """+1 om tårna pekar mot -y (Blenders framåt), -1 mot +y: fötternas mitt jämförs med smalbenens."""
    z0, h = X[:, 2].min(), np.ptp(X[:, 2])
    feet = X[X[:, 2] < z0 + 0.03 * h]; shin = X[(X[:, 2] > z0 + 0.10 * h) & (X[:, 2] < z0 + 0.18 * h)]
    return 1 if np.median(feet[:, 1]) < np.median(shin[:, 1]) else -1
yaw = int(facing(TV0) != facing(P[idx]))
V = place_target(P, yaw); bvh, S = surf(V)
arm, leg = pose_search(bvh)
P = posed(); V = place_target(P, yaw); bvh, S = surf(V)
start = measure(P, bvh, S)

def render_masks(objs_pts, tag):
    """Silhuetter framifrån och från sidan som punktmoln (tätt nog för ett litet ark): rött = AI, blått = mall."""
    H, Wd = 420, 240
    panels = []
    for view in ((0, 2), (1, 2)):
        img = np.zeros((H, Wd, 3))
        allp = np.concatenate([p for p, _ in objs_pts])
        lo = allp[:, list(view)].min(0); hi = allp[:, list(view)].max(0)
        sc = min((Wd - 10) / (hi[0] - lo[0]), (H - 10) / (hi[1] - lo[1]))
        for p, ch in objs_pts:
            u = ((p[:, view[0]] - (lo[0] + hi[0]) / 2) * sc + Wd / 2).astype(int)
            v = (H - 5 - (p[:, view[1]] - lo[1]) * sc).astype(int)
            ok = (u >= 0) & (u < Wd) & (v >= 0) & (v < H)
            m = np.zeros((H, Wd), bool); m[v[ok], u[ok]] = True
            m = m | np.roll(m, 1, 0) | np.roll(m, 1, 1) | np.roll(m, -1, 0) | np.roll(m, -1, 1)
            img[..., ch] = np.maximum(img[..., ch], m)
        both = (img[..., 0] > 0) & (img[..., 2] > 0)
        img[both] = 1.0
        panels.append(img)
    return np.concatenate(panels, 1)

def dense(Vt, n=120000):
    """Punkter jämnt över AI-ytan (trianglarnas tyngdpunkter, slumpvis urval)."""
    f = TF[rng.choice(len(TF), min(n, len(TF)), replace=False)]
    return Vt[f].mean(1)

def template_dense(P):
    me = base.data
    me.calc_loop_triangles()
    t = np.empty(len(me.loop_triangles) * 3, dtype=np.int64); me.loop_triangles.foreach_get("vertices", t); t = t.reshape(-1, 3)
    t = t[USE[t].all(1)]
    w = rng.random((len(t), 3)) ; w /= w.sum(1, keepdims=True)
    return (P[t] * w[:, :, None]).sum(1)

sheet = [render_masks([(dense(V), 0), (template_dense(P), 2)], "before")]

# --- Gauss-Newton -------------------------------------------------------------------------------------------------------
lam = float(job.get("reg", 1e-5))
log = []
for it in range(int(job.get("iterations", 5))):
    P, J = jacobian()
    rot = np.stack([np.zeros(NV), -P[:, 2], P[:, 1]], 1)   # vridning kring x-axeln
    J = np.concatenate([J, np.eye(3)[None].repeat(NV, 0), P[:, :, None], rot[:, :, None]], -1)   # tx, ty, tz, skala, lutning
    # mallens punkter mot AI-ytan, längs ytans normal (glider längs ytan, fastnar inte)
    rows, rhs, wts = [], [], []
    near = [bvh.find_nearest(Vector(P[i])) for i in idx]
    d = np.array([n[3] for n in near]); cut = np.percentile(d, 95)
    for i, n in zip(idx, near):
        if n[3] > cut:
            continue
        nn = np.array(n[1]); t = np.array(n[0])
        rows.append(nn @ J[i]); rhs.append(nn @ (t - P[i])); wts.append(1.0)
    # AI-ytans punkter mot mallens närmaste punkt (drar in mallen där AI-formen sticker ut, t.ex. höfter och lår)
    kd = KDTree(len(idx))
    for j, i in enumerate(idx):
        kd.insert(P[i], j)
    kd.balance()
    for q in S[::4]:
        co, j, dist = kd.find(Vector(q))
        if dist > cut:
            continue
        i = idx[j]
        for ax in range(3):
            rows.append(J[i, ax]); rhs.append(q[ax] - P[i, ax]); wts.append(0.5)
    A = np.array(rows) * np.array(wts)[:, None]; b = np.array(rhs) * np.array(wts)
    A /= np.sqrt(len(b)); b /= np.sqrt(len(b))
    x = np.array([c["x"] for c in cols] + [0, 0, 0, 0, 0]); x0 = x.copy(); x0[:len(cols)] = [c["prior"] for c in cols]
    lo = np.array([c["lo"] for c in cols] + [-0.1, -0.1, -0.05, -0.1, -0.15]) - x; hi = np.array([c["hi"] for c in cols] + [0.1, 0.1, 0.05, 0.1, 0.15]) - x
    K = len(x); free = np.ones(K, bool); dx = np.zeros(K)
    lam_v = np.full(K, lam); lam_v[len(cols):] = lam * 1e-3   # flytt och skala dras inte mot noll
    for _ in range(K):   # aktiv mängd: lös, lås det som slår i gränserna, lös igen
        f = np.nonzero(free)[0]
        Af = A[:, f]
        rhs_ = Af.T @ (b - A[:, ~free] @ dx[~free]) + lam_v[f] * (x0 - x)[f]
        dx[f] = np.linalg.solve(Af.T @ Af + np.diag(lam_v[f]), rhs_)
        bad = free & ((dx < lo - 1e-9) | (dx > hi + 1e-9))
        if not bad.any():
            break
        dx = np.clip(dx, lo, hi); free &= ~bad
    for c, v in zip(cols, x + dx):
        c["x"] = float(np.clip(v, c["lo"], c["hi"]))
    t_, s_, r_ = dx[-5:-2], 1 + dx[-2], dx[-1]   # mallen skulle flyttas, skalas och lutas: gör det omvända med AI-formen
    XF["s"] /= s_; XF["t"] = (XF["t"] - t_) / s_; XF["rx"] -= r_
    apply_x()
    if it in (0, 2):
        arm, leg = pose_search(bvh)
    P = posed(); V = place_target(P, yaw); bvh, S = surf(V)
    log.append({"it": it, **measure(P, bvh, S)})
end = log[-1]
sheet.append(render_masks([(dense(V), 0), (template_dense(P), 2)], "after"))
img = np.concatenate(sheet, 1)
H, Wd = img.shape[:2]
im = bpy.data.images.new("overlay", Wd, H, alpha=False)
px = np.ones((H, Wd, 4)); px[..., :3] = img[::-1]
im.pixels.foreach_set(px.ravel().astype(np.float32))
im.filepath_raw = os.path.join(out, "overlay.png"); im.file_format = "PNG"; im.save()

# --- receptet ----------------------------------------------------------------------------------------------------------
recipe = {"sex": macro["gender"], "age": r.get("age", 25), "sliders": {}, "pose": round(arm), "arm_forward": ARM_FWD, "leg_spread": round(leg, 1)}
for m in cat["macro"]:
    if m["id"] in r and m["id"] not in recipe:
        recipe[m["id"]] = r[m["id"]]
for c in cols:
    if c["kind"] == "macro":
        recipe[c["id"]] = round(c["x"], 3)
    else:
        sgn = 1 if c["end"] == "-incr" else -1
        recipe["sliders"][c["id"]] = round(recipe["sliders"].get(c["id"], 0) + sgn * c["x"], 3)
recipe["sliders"] = {k: v for k, v in recipe["sliders"].items() if abs(v) >= 0.02}
json.dump(recipe, open(os.path.join(out, "recipe.json"), "w"), indent=1)
print("FIT_RESULT " + json.dumps({"recipe": recipe, "ai_transform": {"scale": round(XF["s"], 4), "move_mm": (XF["t"] * 1000).round(1).tolist(), "lean_deg": round(float(np.degrees(XF["rx"])), 2)}, "start": start, "end": end, "log": log, "facing_flipped": bool(yaw),
                                  "overlay": os.path.join(out, "overlay.png")}))
