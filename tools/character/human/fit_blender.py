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
    bend_elbows(rig, ELBOW_FLEX, ELBOW_CARRY)

ARM_FWD = 0.0
ELBOW_FLEX, ELBOW_CARRY = 0.0, 0.0


def bend_elbows(rig_o, flex, carry):
    """Underarmen ställs mot överarmen: flex grader framåt (böjd armbåge), carry grader utåt (armbågsvinkeln)."""
    if not flex and not carry:
        return
    W3 = rig_o.matrix_world.to_3x3()
    for sd in "lr":
        if f"lowerarm_{sd}" not in rig_o.pose.bones or f"hand_{sd}" not in rig_o.pose.bones:
            continue
        up, lo, hd = rig_o.pose.bones[f"upperarm_{sd}"], rig_o.pose.bones[f"lowerarm_{sd}"], rig_o.pose.bones[f"hand_{sd}"]
        u = (W3 @ (lo.head - up.head)).normalized()
        cur = (W3 @ (hd.head - lo.head)).normalized()
        sx = 1 if (W3 @ lo.head).x > 0 else -1
        f = Vector((0, -1, 0)); f = (f - u * f.dot(u)).normalized()
        o = Vector((sx, 0, 0)); o = (o - u * o.dot(u) - f * o.dot(f)).normalized()
        a, c = radians(flex), radians(carry)
        want = (u * (cos(a) * cos(c)) + f * sin(a) + o * sin(c)).normalized()
        Ra = (W3.inverted() @ cur.rotation_difference(want).to_matrix() @ W3).to_4x4()
        h = lo.head.copy()
        lo.matrix = Matrix.Translation(h) @ Ra @ Matrix.Translation(-h) @ lo.matrix
        bpy.context.view_layer.update()


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
    paths = [s["pair"]] if "pair" in s else s["pairs"] if "pairs" in s else [s["lr"].format(s=x) for x in "lr"]
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
    if job.get("elbows", True):   # armbågen: underarmar och händer dit AI-formens är
        global ELBOW_FLEX, ELBOW_CARRY
        fore = (region(["lowerarm_l", "lowerarm_r"]) + region(handbones)) > 0.5
        def err_e(fl, ca):
            global ELBOW_FLEX, ELBOW_CARRY
            ELBOW_FLEX, ELBOW_CARRY = fl, ca
            return err(arm, leg, fore)
        best = min(((fl, ca) for fl in range(0, 41, 5) for ca in range(-10, 26, 5)), key=lambda fc: err_e(*fc))
        best = min(((fl, ca) for fl in np.arange(max(0, best[0] - 4), best[0] + 4.1, 2) for ca in np.arange(best[1] - 4, best[1] + 4.1, 2)),
                   key=lambda fc: err_e(*fc))
        ELBOW_FLEX, ELBOW_CARRY = float(best[0]), float(best[1])
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
    lo = np.array([c["lo"] for c in cols] + [-0.1, -0.1, 0.0, -0.1, -0.15]) - x; hi = np.array([c["hi"] for c in cols] + [0.1, 0.1, 0.0, 0.1, 0.15]) - x   # tz låst: båda står på marken
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
# Posen på nytt med de exakta vinklarna som receptet sparar: reglagen flyttar skelettet (refit), så vinklarna gled under
# varven, och exporten ställer in dem på nytt (benen låg annars 2 cm fel mot exporten, 2026-11-10)
arm, leg = float(round(arm)), float(round(leg, 1))
ELBOW_FLEX, ELBOW_CARRY = round(ELBOW_FLEX, 1), round(ELBOW_CARRY, 1)
set_pose(arm, leg, ARM_FWD)
P = posed(); V = place_target(P, yaw); bvh, S = surf(V)
end = {**measure(P, bvh, S), "it": "final pose"}
sheet.append(render_masks([(dense(V), 0), (template_dense(P), 2)], "after"))

# --- wrap: det exporterade nätet tight mot AI-ytan (Patriks "kroppsstrumpa", som body-gens fit.py) -----------------------
# Reglagen ger grovformen. Wrapen görs på proxyn som exporteras (female1605/male1591, uppdelad som i human_blender.py),
# inte på grundnätet: proxyns uppdelning krymper formen 1–2 cm, så en wrap på grundnätet försvann i exporten (2026-11-10).
# Varje hörn dras mot AI-ytan (närmaste punkt, normalkontroll) med en utjämning mot grannarna som börjar styv och släpps i
# steg. Händer, fötter och en tunn ring runt ögonen har ingen egen dragning utan följer grannarna (AI-händerna är klumpar,
# fransarna blir utstickande geometri), och förflyttningen speglas. Den räknas om till vilopose (per hörn: hur hörnet rör sig
# i posen när vilopunkten flyttas) och sparas som wrap.npz, som human_blender.py bakar in i proxyn.
wrap = None
if job.get("wrap", True):
    from bl_ext.user_default.mpfb.services.assetservice import AssetService
    sub_lv = int(job.get("subdiv", 1))
    pname = job.get("proxy") or ("male1591" if macro.get("gender", 0) >= 0.5 else "female1605")
    def add_asset(nm, sub, atype, ext, lv):
        ob = HumanService.add_mhclo_asset(AssetService.find_asset_absolute_path(f"{nm}/{nm}.{ext}", sub), base, asset_type=atype,
                                          subdiv_levels=lv, material_type="GAMEENGINE")
        for md in ob.modifiers:
            if md.type == "SUBSURF":
                md.levels = md.render_levels
        return ob
    proxy = add_asset(pname, "proxymeshes", "Proxymeshes", "proxy", sub_lv)
    eyes_ob = add_asset("low-poly", "eyes", "Eyes", "mhclo", 0)
    bpy.context.view_layer.update()
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import proxy_ops
    proxy_ops.apply_subdiv(proxy)   # uppdelningen in i nätet, före skelettet, så att hörnen är de som exporteras
    hands_low = bool(job.get("hands_low", True))
    hand_info = proxy_ops.reduce_hands(proxy) if hands_low else None
    bpy.context.view_layer.update()
    def eval_pts(ob):
        dg = bpy.context.evaluated_depsgraph_get(); e = ob.evaluated_get(dg).to_mesh()
        a = np.empty(len(e.vertices) * 3); e.vertices.foreach_get("co", a); ob.evaluated_get(dg).to_mesh_clear()
        M = np.array(ob.matrix_world); a = a.reshape(-1, 3)
        return a @ M[:3, :3].T + M[:3, 3]
    pm = proxy.data; PN = len(pm.vertices)
    ev = np.empty(len(pm.edges) * 2, dtype=np.int64); pm.edges.foreach_get("vertices", ev); ev = ev.reshape(-1, 2)
    pm.calc_loop_triangles()
    lt = np.empty(len(pm.loop_triangles) * 3, dtype=np.int64); pm.loop_triangles.foreach_get("vertices", lt); lt = lt.reshape(-1, 3)
    deg = np.bincount(ev.ravel(), minlength=PN).astype(float)
    pgi = {g.name: g.index for g in proxy.vertex_groups}
    PW_ = {}
    for v in pm.vertices:
        for g in v.groups:
            PW_.setdefault(g.group, np.zeros(PN))[v.index] = g.weight
    def pregion(names):
        return sum((PW_.get(pgi[n], np.zeros(PN)) for n in names if n in pgi), np.zeros(PN))
    def vnormals(X):
        fn = np.cross(X[lt[:, 1]] - X[lt[:, 0]], X[lt[:, 2]] - X[lt[:, 0]])
        n = np.zeros_like(X)
        for k in range(3):
            np.add.at(n, lt[:, k], fn)
        return n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)
    P0 = eval_pts(proxy)
    E = eval_pts(eyes_ob)
    eyes = [E[np.sign(E[:, 0]) == sg].mean(0) for sg in (1, -1) if (np.sign(E[:, 0]) == sg).any()]
    # dragning per hörn: 0 för händer och fötter (de följer armar och ben) och en tunn ring runt ögonen (lock och fransar)
    data_w = np.ones(PN)
    data_w *= 1 - np.clip(pregion(handbones) * 2, 0, 1)
    data_w *= 1 - np.clip(pregion(["foot_l", "foot_r", "ball_l", "ball_r"]) * 2, 0, 1)
    for c in eyes:
        d = np.linalg.norm(P0 - c, axis=1)
        data_w *= np.clip((d - 0.017) / 0.008, 0, 1)
    zones = {}
    lam_mul = np.ones(PN)
    if len(eyes) == 2:
        ec = (eyes[0] + eyes[1]) / 2; hw = abs(eyes[0][0] - eyes[1][0]) / 2   # ögonens mitt och halva avståndet mellan dem
        dx, dy, dz = P0[:, 0] - ec[0], P0[:, 1] - ec[1], P0[:, 2] - ec[2]
        soft = lambda v, a, b: np.clip((v - a) / max(b - a, 1e-6), 0, 1)
        # brynbågen (de målade brynen blir bulor i AI-nätet): ovanför ögonen, framtill
        brow = soft(dz, 0.004, 0.012) * (1 - soft(dz, 0.032, 0.042)) * (1 - soft(np.abs(dx), hw + 0.018, hw + 0.03)) * (1 - soft(dy, 0.0, 0.02))
        # öronen (tunna och fransiga i AI-nätet): på sidan av huvudet, bakom ögonen, i ögonens höjd
        ear = soft(np.abs(dx), hw + 0.03, hw + 0.042) * (1 - soft(np.abs(dz + 0.012), 0.035, 0.05)) * soft(dy, 0.03, 0.05) * (1 - soft(dy, 0.12, 0.14))
        data_w *= (1 - brow) * (1 - ear)
        # bysten: mjukare utjämning, så att formen blir mer definierad
        band = (np.abs(dz + 0.30) < 0.06) & (np.abs(P0[:, 0] - ec[0]) < 0.16)
        ymid = float(np.median(P0[band, 1])) if band.any() else ec[1] + 0.1   # bålens mitt i djupled vid bysten
        chest = (1 - soft(np.abs(dz + 0.30), 0.06, 0.10)) * (1 - soft(np.abs(P0[:, 0] - ec[0]), 0.14, 0.18)) * (1 - soft(P0[:, 1], ymid - 0.01, ymid + 0.03))
        lam_mul = 1 - 0.7 * chest
    # armbågar och handleder: MPFB:s form (ingen egen dragning), underarmen styvare; händerna flyttas stelt med handleden
    # lederna ur nätet: där vikterna går över från ett ben till nästa (skelettets lägen stämde inte i det här rummet)
    joints = {}
    handw = pregion(handbones)
    for sd in "lr":
        lw, uw = pregion([f"lowerarm_{sd}"]), pregion([f"upperarm_{sd}"])
        er = (lw > 0.3) & (uw > 0.3)
        wr = (handw > 0.2) & (handw < 0.6) & (lw > 0.2)
        if er.any() and wr.any():
            joints[sd] = (P0[er].mean(0), P0[wr].mean(0))
    for sd, (elb, wri) in joints.items():
        for c in (elb, wri):
            d = np.linalg.norm(P0 - c, axis=1)
            data_w *= np.clip((d - 0.03) / 0.02, 0, 1)
    lam_mul = lam_mul * (1 + 3 * np.clip(pregion(["lowerarm_l", "lowerarm_r"]), 0, 1))
    rigid, rigid_dbg = {}, {}
    for sd, (elb, wri) in joints.items():
        side = np.sign(P0[:, 0]) == np.sign(wri[0])
        hm = (handw > 0.5) & side
        ring = (~hm) & side & (np.linalg.norm(P0 - wri, axis=1) < 0.035)
        if hm.any() and ring.any():
            rigid[sd] = (hm, ring)
        rigid_dbg[sd] = {"hand": int(hm.sum()), "ring": int(ring.sum()), "wrist_to_nearest_mm": round(1000 * float(np.linalg.norm(P0 - wri, axis=1).min()), 1),
                         "max_hand_w": round(float(handw[side].max()), 2)}
        zones = {"brow_verts": int((brow > 0.5).sum()), "ear_verts": int((ear > 0.5).sum()), "bust_verts": int((chest > 0.5).sum())}
    # spegelpar
    kd = KDTree(PN)
    for i in range(PN):
        kd.insert(P0[i], i)
    kd.balance()
    mirror = np.full(PN, -1)
    for i in range(PN):
        co, j, dist = kd.find(Vector((-P0[i, 0], P0[i, 1], P0[i, 2])))
        if dist < 0.004:
            mirror[i] = j
    sym = bool(job.get("symmetric", True))
    X = P0.copy()
    stages = [(10.0, 0.10), (3.0, 0.06), (1.0, 0.03), (0.3, 0.015), (0.1, 0.008)]
    if job.get("fine", True):   # finare steg för detaljer (nyckelben, axlar, ansiktets drag), mjukare utjämning
        stages += [(0.03, 0.005), (0.01, 0.003)]
    wlog = []
    for lam_w, cap in stages:
        for _ in range(2):
            Nx = vnormals(X)
            r_ = np.zeros_like(X); conf = np.zeros(PN)
            for i in range(PN):
                if data_w[i] <= 0:
                    continue
                loc, nrm, fi, dist = bvh.find_nearest(Vector(X[i]))
                if loc is None or dist > cap or float(np.dot(np.array(nrm), Nx[i])) < 0.3:
                    continue
                r_[i] = np.array(loc) - X[i]; conf[i] = data_w[i]
            dlt = np.zeros_like(X)
            for _ in range(300):
                acc = np.zeros_like(X)
                np.add.at(acc, ev[:, 0], dlt[ev[:, 1]]); np.add.at(acc, ev[:, 1], dlt[ev[:, 0]])
                lv = lam_w * lam_mul
                dlt = (conf[:, None] * r_ + lv[:, None] * acc) / np.maximum(conf + lv * deg, 1e-9)[:, None]
            for hm, ring in rigid.values():
                dlt[hm] = dlt[ring].mean(0)
            if sym:
                ok = mirror >= 0
                dlt[ok] = 0.5 * (dlt[ok] + dlt[mirror[ok]] * np.array([-1.0, 1.0, 1.0]))
            X = X + dlt
        wlog.append({"lam": lam_w, "cap_mm": int(cap * 1000), "moved_mm": round(1000 * float(np.linalg.norm(X - P0, axis=1).mean()), 2),
                     "data_share": round(float((conf > 0).mean()), 3)})
    D = X - P0
    # posens förflyttning -> vilopose, med provnycklar på proxyn
    if not pm.shape_keys:
        proxy.shape_key_add(name="Basis", from_mix=False)
    probe = proxy.shape_key_add(name="wrap_probe", from_mix=False)
    basis = np.empty(PN * 3); pm.shape_keys.key_blocks[0].data.foreach_get("co", basis); basis = basis.reshape(-1, 3)
    h = 0.01; Mv = np.zeros((PN, 3, 3))
    for ax in range(3):
        co = basis.copy(); co[:, ax] += h
        probe.data.foreach_set("co", co.ravel()); probe.value = 1.0; bpy.context.view_layer.update()
        Mv[:, :, ax] = (eval_pts(proxy) - P0) / h
    good = np.abs(np.linalg.det(Mv)) > 1e-12
    rest = np.zeros((PN, 3)); rest[good] = np.linalg.solve(Mv[good], D[good][:, :, None])[:, :, 0]
    probe.data.foreach_set("co", (basis + rest).ravel()); probe.value = 1.0; bpy.context.view_layer.update()
    PW = eval_pts(proxy)
    # mått åt båda hållen, yta mot yta: proxyns hörn till AI-ytan, och AI-ytans punkter till proxyns yta
    pb = BVHTree.FromPolygons([tuple(q) for q in PW], [tuple(t) for t in lt], all_triangles=True)
    pb0 = BVHTree.FromPolygons([tuple(q) for q in P0], [tuple(t) for t in lt], all_triangles=True)
    to_ai = np.array([bvh.find_nearest(Vector(q))[3] for q in PW])
    from_ai = np.array([pb.find_nearest(Vector(q))[3] for q in S])
    from_ai0 = np.array([pb0.find_nearest(Vector(q))[3] for q in S])
    wrap_end = {"to_ai_mean_mm": round(1000 * float(to_ai.mean()), 1), "from_ai_mean_mm": round(1000 * float(from_ai.mean()), 1),
                "from_ai_p95_mm": round(1000 * float(np.percentile(from_ai, 95)), 1), "from_ai_over_3cm": round(float((from_ai > 0.03).mean()), 3),
                "before_from_ai_mean_mm": round(1000 * float(from_ai0.mean()), 1), "before_from_ai_p95_mm": round(1000 * float(np.percentile(from_ai0, 95)), 1)}
    zr = (S[:, 2] - S[:, 2].min()) / np.ptp(S[:, 2])
    for nm_, a_, b_ in (("head", .87, 1.01), ("chest", .68, .87), ("hips", .50, .68), ("thighs", .28, .50), ("shins", .06, .28)):
        sel = (zr >= a_) & (zr < b_)
        wrap_end[f"from_ai_{nm_}_mm"] = round(1000 * float(from_ai[sel].mean()), 1)
    np.savez_compressed(os.path.join(out, "wrap.npz"), offsets=rest.astype(np.float32), proxy=pname, subdiv=sub_lv, nverts=PN, hands_low=hands_low)
    np.savez_compressed(os.path.join(out, "wrap_debug.npz"), ai=V.astype(np.float32), ai_faces=TF.astype(np.int32), tpl0=P0.astype(np.float32),
                        tpl=PW.astype(np.float32), use=np.ones(PN, bool), lab=np.zeros(PN, int), pin=(1 - data_w).astype(np.float32),
                        tpl_faces=lt.astype(np.int32), regions=np.array(["all"]),
                        hand=np.clip(pregion(handbones), 0, 1).astype(np.float32),
                        foot=np.clip(pregion(["foot_l", "foot_r", "ball_l", "ball_r"]), 0, 1).astype(np.float32))
    w_ = rng.random((len(lt), 3)); w_ /= w_.sum(1, keepdims=True)
    sheet.append(render_masks([(dense(V), 0), ((PW[lt] * w_[:, :, None]).sum(1), 2)], "wrapped"))
    wrap = {"file": os.path.join(out, "wrap.npz"), "proxy": pname, "subdiv": sub_lv, "verts": PN, "end": wrap_end, "stages": wlog,
            "eyes": len(eyes), "zones": zones, "hands_low": hand_info, "rigid_hands": len(rigid), "rigid_dbg": rigid_dbg, "symmetric": sym, "mirror_pairs": int((mirror >= 0).sum()),
            "reproduce_mm": round(1000 * float(np.linalg.norm(PW - X, axis=1).mean()), 3)}
img = np.concatenate(sheet, 1)
H, Wd = img.shape[:2]
im = bpy.data.images.new("overlay", Wd, H, alpha=False)
px = np.ones((H, Wd, 4)); px[..., :3] = img[::-1]
im.pixels.foreach_set(px.ravel().astype(np.float32))
im.filepath_raw = os.path.join(out, "overlay.png"); im.file_format = "PNG"; im.save()

# --- receptet ----------------------------------------------------------------------------------------------------------
recipe = {"sex": macro["gender"], "age": r.get("age", 25), "sliders": {}, "pose": round(arm), "arm_forward": ARM_FWD, "leg_spread": round(leg, 1),
          "elbow_flex": round(ELBOW_FLEX, 1), "elbow_carry": round(ELBOW_CARRY, 1)}
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
if wrap:
    recipe["wrap"] = wrap["file"]
json.dump(recipe, open(os.path.join(out, "recipe.json"), "w"), indent=1)
print("FIT_RESULT " + json.dumps({"recipe": recipe, "ai_transform": {"scale": round(XF["s"], 4), "move_mm": (XF["t"] * 1000).round(1).tolist(), "lean_deg": round(float(np.degrees(XF["rx"])), 2)}, "start": start, "end": end, "log": log, "facing_flipped": bool(yaw), "wrap": wrap,
                                  "overlay": os.path.join(out, "overlay.png")}))
