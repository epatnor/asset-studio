"""Täckning för UltraTex: hur väl ser kamerorna varje del av modellen? Ger andelen yta som syns bra, bara snett eller
inte alls, en GLB där ytan är färgad efter täckningen (grön bra, gul snett, röd osynlig), och förslag på nästa
kameravinklar som täcker mest av det som saknas (girigt, tills vinsten är under `min_gain`).

Kamerorna följer UltraTex (ultratex_core/render.py): modellen centreras och skalas till radien 0,5, perspektivkameror på
avståndet 1,67, sex kanoniska vyer (fram +Z, vänster −X, bak −Z, höger +X, upp +Y, ner −Y i glTF). En rigg
{"azimuth", "elevation"} vrider de fyra sidokamerorna (azimut 90 = höger, +X) och höjer dem (elevation > 0 = uppifrån);
topp och botten följer bara azimuten. Siktlinjen prövas med strålar från ytan till kameran (trimesh + embree).

  uv run --no-project --python 3.12 --with trimesh --with embreex --with numpy python -I tools/ultratex4b/coverage.py '<recept>'

Recept: mesh (GLB), rigs (standard [{"azimuth": 0}]), good (cos-gräns för "bra", 0,5 = högst 60° snett), suggest (antal
förslag, 0 = inga), weight ("game": väg ytan efter hur den syns uppifrån och från sidan som i spelet), min_gain (andel av ytan, 0,01), out (GLB med färgad täckning, valfri), faces (högst så många ytor
prövas, slumpvis urval, 300 000).
Andelarna räknas på ytan som alls syns utifrån (64 riktningar); `inside_share` är resten (insidor, dubbla lager).
"""
import json
import sys

import numpy as np
import trimesh

CAM_DIST = 1.67
SIDE = np.array([[0, 0, 1], [-1, 0, 0], [0, 0, -1], [1, 0, 0]], float)   # fram, vänster, bak, höger (glTF)
SLOT_AZ = [0.0, 270.0, 180.0, 90.0]


def cam_dir(azimuth, elevation):
    """Riktning från modellen till kameran: azimut 0 = fram (+Z), 90 = höger (+X); elevation > 0 = uppifrån."""
    a, e = np.radians(azimuth), np.radians(elevation)
    return np.array([np.sin(a) * np.cos(e), np.sin(e), np.cos(a) * np.cos(e)])


def rig_cameras(azimuth=0.0, elevation=0.0):
    cams = [cam_dir(az + azimuth, elevation) for az in SLOT_AZ]
    cams += [np.array([0.0, 1.0, 0.0]), np.array([0.0, -1.0, 0.0])]
    return [c * CAM_DIST for c in cams]


def quality(mesh, pts, normals, cams):
    """cos(vinkel mellan ytnormal och riktning mot kameran) för varje punkt och kamera, 0 om skymd eller bortvänd."""
    q = np.zeros((len(cams), len(pts)), np.float32)
    for k, c in enumerate(cams):
        d = c[None] - pts
        dist = np.linalg.norm(d, axis=1)
        d /= dist[:, None]
        cos = (normals * d).sum(1)
        front = np.where(cos > 0.05)[0]
        if not len(front):
            continue
        origins = pts[front] + normals[front] * 1e-4
        hit = mesh.ray.intersects_any(origins, d[front])
        vis = front[~hit]
        q[k, vis] = cos[vis]
    return q


def main():
    r = json.loads(sys.argv[1])
    mesh = trimesh.load(r["mesh"], force="mesh")
    used = mesh.vertices[np.unique(mesh.faces)]
    lo, hi = used.min(0), used.max(0)
    centre = (lo + hi) / 2
    mesh.vertices = (mesh.vertices - centre) * (0.5 / np.linalg.norm(used - centre, axis=1).max())
    rng = np.random.default_rng(0)
    nf = len(mesh.faces)
    idx = rng.choice(nf, min(nf, int(r.get("faces", 300000))), replace=False) if nf > r.get("faces", 300000) else np.arange(nf)
    pts, normals, area = mesh.triangles_center[idx], mesh.face_normals[idx], mesh.area_faces[idx]
    area = area / area.sum()
    good = float(r.get("good", 0.5))
    # En rigg är {"azimuth", "elevation"} (sex kameror som UltraTex Rotate Rig) eller {"views": [[azimut, höjd], ...]} (Custom Rig)
    cams = [c for rig in r.get("rigs", [{"azimuth": 0}])
            for c in ([cam_dir(a, e) * CAM_DIST for a, e in rig["views"]] if "views" in rig else rig_cameras(rig.get("azimuth", 0), rig.get("elevation", 0)))]
    best = quality(mesh, pts, normals, cams).max(0)
    # Yta som alls går att se utifrån (från 64 riktningar runt om); insidor och dubbla lager räknas inte
    n = 64; i = np.arange(n) + 0.5; phi = np.arccos(1 - 2 * i / n); th = np.pi * (1 + 5 ** 0.5) * i
    sphere = np.stack([np.cos(th) * np.sin(phi), np.cos(phi), np.sin(th) * np.sin(phi)], 1) * CAM_DIST
    sq = quality(mesh, pts, normals, list(sphere))
    exposed = sq.max(0) > 0
    hidden_share = float(area[~exposed].sum())
    if r.get("weight") == "game":
        # Som en spelkamera ser figuren: yta viktas efter hur väl den syns från riktningar uppifrån och från sidan
        # (höjd −10° till 70°), så att en fläck på kragen väger mer än en under fållen
        up = (sphere[:, 1] / CAM_DIST >= np.sin(np.radians(-10))) & (sphere[:, 1] / CAM_DIST <= np.sin(np.radians(70)))
        area = area * sq[up].mean(0)
    area = np.where(exposed, area, 0); area = area / area.sum()

    def summary(b):
        return {"good": round(float(area[b >= good].sum()), 4), "grazing": round(float(area[(b > 0) & (b < good)].sum()), 4),
                "unseen": round(float(area[b <= 0].sum()), 4)}

    res = {"ok": True, "cameras": len(cams), "inside_share": round(hidden_share, 4), "coverage": summary(best)}
    # Förslag: enstaka kameror (azimut var 30:e grad, höjd −45..45) som gör mest yta "bra" av det som inte är det än
    if int(r.get("suggest", 0)):
        cands = [(az, el) for el in (-45, -25, 25, 45) for az in range(0, 360, 30)]
        cq = quality(mesh, pts, normals, [cam_dir(a, e) * CAM_DIST for a, e in cands])
        picks, cur = [], best.copy()
        for _ in range(int(r["suggest"])):
            gains = [float(area[(cur < good) & (cq[k] >= good)].sum()) for k in range(len(cands))]
            k = int(np.argmax(gains))
            if gains[k] < float(r.get("min_gain", 0.01)):
                break
            cur = np.maximum(cur, cq[k])
            picks.append({"azimuth": cands[k][0], "elevation": cands[k][1], "gain": round(gains[k], 4), "coverage_after": summary(cur)})
        res["suggestions"] = picks
    if r.get("out"):
        full = np.zeros(nf, np.float32) - 1
        full[idx] = best
        col = np.zeros((nf, 4), np.uint8); col[:, 3] = 255
        col[full >= good] = [60, 200, 90, 255]
        col[(full > 0) & (full < good)] = [235, 200, 40, 255]
        col[(full <= 0) & (full > -1)] = [220, 50, 50, 255]
        col[full == -1] = [150, 150, 150, 255]
        ins = np.zeros(nf, bool); ins[idx[~exposed]] = True
        col[ins] = [90, 90, 110, 255]   # insidor som ingen kamera kan se
        m = trimesh.Trimesh(mesh.vertices, mesh.faces, face_colors=col, process=False)
        m.export(r["out"])
        res["out"] = r["out"]
    print(json.dumps(res))


if __name__ == "__main__":
    main()
