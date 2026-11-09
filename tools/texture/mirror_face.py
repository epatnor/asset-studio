"""Speglar den lyckade halvan av ett ansikte till den andra i en texturerad GLB (ny fil, originalet rörs inte).

Flervysmålning (UltraTex) lyckas ofta med ena ögat och missar det andra, där vyerna möts. För varje texel på målsidan av
ansiktet räknas punkten i 3D ut, speglas över ansiktets mittplan (genom nästippen) och färgen hämtas från närmaste punkt på
källsidan. Övergången tonas vid näsryggen och vid områdets kanter. Bara ansiktet framifrån ändras; hår bakom och
hästsvans rörs inte. Följer Patriks regel om symmetriska kroppar (spegla ena sidan).

  uv run --no-project --python 3.12 --with trimesh --with numpy --with pillow --with scipy --with rtree \\
      python -I tools/texture/mirror_face.py '<recept>'

Recept: in, out (GLB), source ("right" = figurens högra sida är den lyckade, standard; "left"), front ("+z" standard,
figurens framåtriktning i glTF), band ([under, över] nästippen som andel av figurens höjd, standard [0.05, 0.075], upp till hårfästet så att ögonbrynen ligger helt inne),
depth (hur långt bakåt från nästippen, andel av höjden, 0.05), feather (tonbredd vid mittlinjen, andel av höjden, 0.006).
Svarar med en rad JSON.
"""
import io, json, struct, sys

import numpy as np
import trimesh
from PIL import Image


def read_glb(path):
    b = open(path, "rb").read()
    n = struct.unpack("<I", b[12:16])[0]
    j = json.loads(b[20:20 + n])
    blob = b[20 + n + 8: 20 + n + 8 + struct.unpack("<I", b[20 + n:24 + n])[0]]
    views = [blob[v.get("byteOffset", 0): v.get("byteOffset", 0) + v["byteLength"]] for v in j["bufferViews"]]
    return j, views


def write_glb(path, j, views):
    out = bytearray()
    for i, v in enumerate(views):
        j["bufferViews"][i]["byteOffset"] = len(out); j["bufferViews"][i]["byteLength"] = len(v)
        out += v; out += b"\0" * (-len(out) % 4)
    j["buffers"][0]["byteLength"] = len(out)
    js = json.dumps(j, separators=(",", ":")).encode(); js += b" " * (-len(js) % 4)
    open(path, "wb").write(struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(out))
                           + struct.pack("<II", len(js), 0x4E4F534A) + js + struct.pack("<II", len(out), 0x004E4942) + out)


def smooth(t):
    t = np.clip(t, 0, 1)
    return t * t * (3 - 2 * t)


def main():
    r = json.loads(sys.argv[1])
    scene = trimesh.load(r["in"])
    m = list(scene.geometry.values())[0] if hasattr(scene, "geometry") else scene
    v, f, uv = m.vertices, m.faces, m.visual.uv
    H = v[:, 1].max() - v[:, 1].min()
    fz = 1 if r.get("front", "+z") == "+z" else -1
    # Nästippen: den främsta punkten i huvudets övre del
    head = v[:, 1] > v[:, 1].max() - 0.14 * H
    tip = v[head][np.argmax(v[head][:, 2] * fz)]
    lo, hi = r.get("band", [0.05, 0.075])
    # Spegelplanet: lodrätt, genom (x0, z vid nästippen), vridet theta runt höjdaxeln. Läge och vridning väljs så att
    # ansiktets form blir mest symmetrisk (minsta medianavstånd från speglade punkter till ytan), eftersom huvudet sällan
    # sitter rakt (2026-11-09: frostsysterns huvud var lite vridet och ögonbrynet blev dubbelt med ett rakt plan)
    face_v = np.where(head & (np.abs(v[:, 1] - tip[1]) < 0.05 * H) & ((v[:, 2] - tip[2]) * fz > -0.04 * H))[0]
    face_v = face_v[np.random.default_rng(0).choice(len(face_v), min(len(face_v), 3000), replace=False)]
    fmesh = trimesh.Trimesh(v, f[np.isin(f, face_v).any(1)], process=False)
    def mirror(P, x0, th):
        n = np.array([np.cos(th), 0.0, np.sin(th)])
        return P - 2 * ((P - np.array([x0, 0, tip[2]])) @ n)[:, None] * n
    best = (1e9, tip[0], 0.0)
    for th in np.radians(np.arange(-12, 12.1, 2)):
        for x0 in tip[0] + np.linspace(-0.012, 0.012, 9) * H:
            d = trimesh.proximity.closest_point(fmesh, mirror(v[face_v], x0, th))[1]
            best = min(best, (float(np.median(d)), x0, th))
    for th in best[2] + np.radians(np.arange(-1.5, 1.6, 0.5)):
        for x0 in best[1] + np.linspace(-0.003, 0.003, 7) * H:
            d = trimesh.proximity.closest_point(fmesh, mirror(v[face_v], x0, th))[1]
            best = min(best, (float(np.median(d)), x0, th))
    _, x0, theta = best
    nrm = np.array([np.cos(theta), 0.0, np.sin(theta)])
    side = lambda P: (P - np.array([x0, 0, tip[2]])) @ nrm   # signerat avstånd till planet
    depth, feather = r.get("depth", 0.05) * H, r.get("feather", 0.006) * H
    # Figurens högra sida är −X när hon tittar mot +Z
    src_sign = -1 if r.get("source", "right") == "right" else 1
    src_sign *= fz
    c = v[f].mean(1)
    inband = (c[:, 1] > tip[1] - lo * H) & (c[:, 1] < tip[1] + hi * H) & ((c[:, 2] - tip[2]) * fz > -depth)
    tgt = np.where(inband & (side(c) * src_sign < 0))[0]
    srcf = np.where(inband & (side(c) * src_sign > -feather))[0]
    sub = trimesh.Trimesh(v, f[srcf], process=False)

    j, views = read_glb(r["in"])
    mat = j["materials"][0]["pbrMetallicRoughness"]
    img_i = j["textures"][mat["baseColorTexture"]["index"]]["source"]
    bv = j["images"][img_i]["bufferView"]
    tex = np.asarray(Image.open(io.BytesIO(views[bv])).convert("RGB"), np.float32)
    th, tw = tex.shape[:2]

    # Texlar i målsidans trianglar (rastrering i UV-rummet) och deras punkter i 3D
    pix, pts = [], []
    for fi in tgt:
        a, b_, cc = uv[f[fi]] * [tw, th]
        a[1], b_[1], cc[1] = th - a[1], th - b_[1], th - cc[1]   # glTF-UV har v uppåt
        x_lo, x_hi = int(np.floor(min(a[0], b_[0], cc[0]))), int(np.ceil(max(a[0], b_[0], cc[0])))
        y_lo, y_hi = int(np.floor(min(a[1], b_[1], cc[1]))), int(np.ceil(max(a[1], b_[1], cc[1])))
        if x_hi - x_lo > 64 or y_hi - y_lo > 64:
            continue
        gx, gy = np.meshgrid(np.arange(x_lo, x_hi + 1) + 0.5, np.arange(y_lo, y_hi + 1) + 0.5)
        P = np.stack([gx.ravel(), gy.ravel()], 1)
        T = np.array([[b_[0] - a[0], cc[0] - a[0]], [b_[1] - a[1], cc[1] - a[1]]])
        if abs(np.linalg.det(T)) < 1e-9:
            continue
        l = np.linalg.solve(T, (P - a).T).T
        w = np.stack([1 - l[:, 0] - l[:, 1], l[:, 0], l[:, 1]], 1)
        ok = (w >= -0.02).all(1)
        if not ok.any():
            continue
        pix.append(np.floor(P[ok]).astype(int)); pts.append(w[ok] @ v[f[fi]])
    if not pix:
        print(json.dumps({"ok": False, "error": "no texels in the face region"})); sys.exit(1)
    pix, pts = np.concatenate(pix), np.concatenate(pts)
    pix[:, 0] = np.clip(pix[:, 0], 0, tw - 1); pix[:, 1] = np.clip(pix[:, 1], 0, th - 1)
    mir = mirror(pts, x0, theta)
    cp, dist, tri = trimesh.proximity.closest_point(sub, mir)
    bary = trimesh.triangles.points_to_barycentric(sub.triangles[tri], cp)
    suv = (bary[:, :, None] * uv[sub.faces[tri]]).sum(1)
    sx, sy = suv[:, 0] * tw - 0.5, (1 - suv[:, 1]) * th - 0.5
    x0i, y0i = np.clip(np.floor(sx).astype(int), 0, tw - 2), np.clip(np.floor(sy).astype(int), 0, th - 2)
    fx, fy = (sx - x0i)[:, None], (sy - y0i)[:, None]
    col = (tex[y0i, x0i] * (1 - fx) * (1 - fy) + tex[y0i, x0i + 1] * fx * (1 - fy)
           + tex[y0i + 1, x0i] * (1 - fx) * fy + tex[y0i + 1, x0i + 1] * fx * fy)
    # Toning: vid mittlinjen, vid bandets över- och underkant, bakåt mot öronen, och där speglingen inte hittar något nära
    wgt = smooth(np.abs(side(pts)) / feather)
    edge = np.minimum(pts[:, 1] - (tip[1] - lo * H), (tip[1] + hi * H) - pts[:, 1])
    wgt *= smooth(edge / (0.01 * H)) * smooth(((pts[:, 2] - tip[2]) * fz + depth) / (0.012 * H))
    wgt *= dist < 0.02 * H
    out = tex.copy()
    out[pix[:, 1], pix[:, 0]] = out[pix[:, 1], pix[:, 0]] * (1 - wgt[:, None]) + col * wgt[:, None]
    buf = io.BytesIO(); Image.fromarray(np.clip(out, 0, 255).astype(np.uint8)).save(buf, "PNG")
    views[bv] = buf.getvalue(); j["images"][img_i]["mimeType"] = "image/png"
    write_glb(r["out"], j, views)
    print(json.dumps({"ok": True, "out": r["out"], "texels": int(len(pix)), "changed": int((wgt > 0.05).sum()),
                      "mirror_x": round(float(x0), 4), "mirror_turn_deg": round(float(np.degrees(theta)), 1), "median_match_dist": round(float(np.median(dist)), 5)}))


if __name__ == "__main__":
    main()
