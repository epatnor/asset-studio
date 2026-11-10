"""Förhandsbilder.

1. Snabbt, utan Blender (för felsökning av passningen): ytan samplas tätt och punkterna ritas med z-buffert.
     from render import views; views([(V, F, rgb), ...], "ut.png", angles=(0, 90, 180))
2. Med asset-studios förhandsvisning och husljus (tools/preview/preview_glb.py), i Cycles på processorn så att den
   kan köras medan ComfyUI har grafikkortet:
     python3 -I tools/render.py <ut.png> <a.glb>[@rot] [<b.glb>[@rot] ...] [--size 1600x800] [--elev 8]
   Flera GLB-filer ställs på rad; @90 vrider en modell till profil."""
import json, shutil, subprocess, sys
from pathlib import Path

STUDIO = Path.home() / "Spelutveckling/azshara-studio/asset-studio"
ROOT = Path(__file__).resolve().parents[3]   # asset-studio
HERE = ROOT / "build/body"                    # body-gens arbetsyta: build/, out/, images/ (flyttad 2026-11-10)
TOOLS = Path(__file__).resolve().parent
SPEL = ROOT.parents[1]                        # ~/Spelutveckling (img2mesh, lowpoly-test)


def _splat(P, N, C, ang, size, box):
    import numpy as np
    a = np.radians(ang)
    R = np.array([[np.cos(a), 0, np.sin(a)], [0, 1, 0], [-np.sin(a), 0, np.cos(a)]])
    Q, Nn = P @ R.T, N @ R.T
    (x0, y0), s = box
    px = ((Q[:, 0] - x0) * s).astype(int)
    py = (size[1] - 1 - (Q[:, 1] - y0) * s).astype(int)
    ok = (px >= 0) & (px < size[0]) & (py >= 0) & (py < size[1])
    px, py, z, Nn, C = px[ok], py[ok], Q[ok, 2], Nn[ok], C[ok]
    light = np.array([0.35, 0.5, 0.8]); light /= np.linalg.norm(light)
    sh = np.abs(Nn @ light) * 0.75 + 0.25
    img = np.full((size[1], size[0], 3), 245, np.uint8)
    order = np.argsort(z)
    for dx in (0, 1):
        for dy in (0, 1):
            x, y = np.clip(px + dx, 0, size[0] - 1)[order], np.clip(py + dy, 0, size[1] - 1)[order]
            img[y, x] = (C[order] * sh[order, None]).clip(0, 255).astype(np.uint8)
    return img


def views(items, out, angles=(0, 90, 180), size=(360, 720), n=600000):
    """items: (V, F, rgb) eller (trimesh, None, rgb). Alla får samma skala; en rad med vinklar per item."""
    import numpy as np
    import trimesh
    from PIL import Image
    clouds = []
    for V, F, col in items:
        m = V if F is None else trimesh.Trimesh(V, F, process=False)
        P, fi = trimesh.sample.sample_surface(m, n, seed=0)
        clouds.append((P, m.face_normals[fi], np.tile(np.array(col, float), (len(P), 1))))
    allp = np.vstack([c[0] for c in clouds])
    h = allp[:, 1].max() - allp[:, 1].min()
    s = (size[1] - 20) / h
    box = ((-size[0] / 2 / s, allp[:, 1].min() - 10 / s), s)
    rows = [np.hstack([_splat(P, N, C, a, size, box) for a in angles]) for P, N, C in clouds]
    Image.fromarray(np.hstack(rows)).save(out)


# Körs i Blender: asset-studios förhandsvisning med Cycles på processorn i stället för EEVEE
WRAP = """
import bpy
src = open({preview!r}).read()
src = src.replace('for eng in ("BLENDER_EEVEE", "BLENDER_EEVEE_NEXT"):', 'for eng in ("CYCLES",):')
src = src.replace('bpy.ops.render.render(write_still=True)',
                  'scene.cycles.device = "CPU"; scene.cycles.samples = 48; scene.cycles.use_denoising = True; '
                  'bpy.ops.render.render(write_still=True)')
exec(compile(src, {preview!r}, "exec"))
"""


def blender_views(out, glbs, size=(1600, 800), elev=8):
    out = Path(out).resolve()
    wrap = HERE / "build/.render_wrap.py"
    wrap.parent.mkdir(exist_ok=True)
    wrap.write_text(WRAP.format(preview=str(STUDIO / "tools/preview/preview_glb.py")))
    items = []
    for g in glbs:
        path, _, rot = g.partition("@")
        items.append({"glb": str(Path(path).resolve()), "rot": float(rot or 0)})
    args = {"glbs": items, "out": str(out), "style": str(STUDIO / "tools/style.json"), "size": list(size),
            "elev": elev, "backlight": True}
    pre = ["host-spawn"] if shutil.which("host-spawn") else []
    r = subprocess.run(pre + ["flatpak", "run", f"--filesystem={STUDIO}", f"--filesystem={ROOT}", "org.blender.Blender",
                              "--background", "--factory-startup", "--python", str(wrap), "--", json.dumps(args)],
                       capture_output=True, text=True, errors="replace")
    if not out.exists():
        sys.exit(r.stdout[-1500:] + r.stderr[-1500:])
    return str(out)


if __name__ == "__main__":
    a = sys.argv[1:]
    size, elev = (1600, 800), 8
    if "--size" in a:
        i = a.index("--size"); size = tuple(int(v) for v in a[i + 1].split("x")); del a[i:i + 2]
    if "--elev" in a:
        i = a.index("--elev"); elev = float(a[i + 1]); del a[i:i + 2]
    print(blender_views(a[0], a[1:], size, elev))
