"""Hur nära originalet kommer en texturerad modell? Alla modeller renderas platt (bara textur, inget ljus) från samma
vinklar i Blender, och varje kandidat jämförs med referensen på de pixlar där båda syns (kanterna borträknade):

  detail      hur mycket fint mönster texturen har (standardavvikelse efter högpassfilter, i 0–255)
  detail_ref  samma för referensen, att jämföra med
  placement   om mönstret sitter på samma ställen som referensens (korrelation av högpassbilderna, −1..1)
  colour      medelfärgens avstånd till referensens (0 = samma)

  python3 -I tools/ultratex4b/detail_score.py '{"reference": "a.glb", "candidates": {"9b": "b.glb", "s4000": "c.glb"}}'

Recept: reference, candidates (namn → GLB), views (grader runt modellen, standard [0, 90, 180]), size (768), out
(mapp för renderingarna, standard build/detail_score). Kör Blender som tools/mesh/make_low.py; svarar med en rad JSON.
"""
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def blender_cmd():
    if os.environ.get("BLENDER"):
        return [os.environ["BLENDER"]]
    if shutil.which("blender"):
        return ["blender"]
    flatpak = ["flatpak", "run", f"--filesystem={ROOT}", "org.blender.Blender"]
    return (["host-spawn"] if shutil.which("host-spawn") else []) + flatpak


def render(glb, out, views, size):
    job = {"glb": str(glb), "out_dir": str(out), "size": size, "prefix": "score_",
           "shots": [{"name": f"{v:03d}", "yaw": v, "mode": "texture"} for v in views]}
    r = subprocess.run(blender_cmd() + ["-b", "--factory-startup", "-P", str(ROOT / "tools/darrowmere/runner/render_views.py"),
                                        "--", "--json", json.dumps(job)], capture_output=True, text=True)
    if "RENDER_RESULT" not in r.stdout:
        raise RuntimeError(f"Blender could not render {glb}: {(r.stderr or r.stdout)[-300:]}")
    return {v: out / f"{Path(glb).stem}_score_{v:03d}.png" for v in views}


def load(path):
    import numpy as np
    from PIL import Image, ImageFilter
    a = np.asarray(Image.open(path).convert("RGBA"), np.float32)
    rgb = a[..., :3]
    mask = a[..., 3] > 128 if a[..., 3].min() < 255 else np.abs(rgb - rgb[0, 0]).sum(2) > 12
    mask = np.asarray(Image.fromarray((mask * 255).astype(np.uint8)).filter(ImageFilter.MinFilter(13))) > 128
    lum = Image.fromarray(rgb.mean(2).astype(np.uint8))
    hp = np.asarray(lum, np.float32) - np.asarray(lum.filter(ImageFilter.GaussianBlur(5)), np.float32)
    return rgb, mask, hp


def main():
    import numpy as np
    r = json.loads(sys.argv[1])
    views, size = r.get("views", [0, 90, 180]), int(r.get("size", 768))
    out = ROOT / r.get("out", "build/detail_score")
    out.mkdir(parents=True, exist_ok=True)
    ref = render((ROOT / r["reference"]).resolve(), out, views, size)
    res = {}
    for name, glb in r["candidates"].items():
        imgs = render((ROOT / glb).resolve(), out, views, size)
        per = []
        for v in views:
            o_rgb, o_m, o_hp = load(ref[v])
            rgb, m, hp = load(imgs[v])
            mm = o_m & m
            if mm.sum() < 500:
                continue
            per.append({"detail": float(hp[mm].std()), "detail_ref": float(o_hp[mm].std()),
                        "placement": float(np.corrcoef(o_hp[mm], hp[mm])[0, 1]),
                        "colour": float(np.abs(rgb[mm].mean(0) - o_rgb[mm].mean(0)).mean())})
        res[name] = {k: round(sum(p[k] for p in per) / len(per), 2) for k in ("detail", "detail_ref", "placement", "colour")} if per else None
    print(json.dumps({"ok": True, "reference": r["reference"], "views": views, "scores": res}))


if __name__ == "__main__":
    main()
