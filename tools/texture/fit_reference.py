"""Referensstyrt recept (patriks_input/AAA_Reference_Guided_Procedural_Textures_Tiling_ThreeJS_Reference.md, avsnitt 3–4):
justerar ett barkrecept mot en referens med samma mått som tools/texture/reference_analysis.py, i fysiska enheter.
Referensen är ett mätmål: bara palett, skala, riktning och relief tas över, aldrig pixlar.

  python3 -I tools/texture/fit_reference.py '{"ref": "jolcham_oak_bark_01", "name": "bark_oak_stylized",
      "meters": 1.0, "source": {...barkens övriga spakar...}, "exaggerate": 1.6, "iters": 4, "save": false}'

  - Färgen: dark/light/accent ur referensens palett (ljuset borträknat), lite mättare (saturate, standard 1,12)
  - Skalan: ridges (tvärs) och rows (längs) justeras tills vår uppmätta spacing är exaggerate × referensens
    (stiliserat = något större drag än verkligheten, avsnitt 9)
  - Reliefen (fit_relief: true): depth mot referensens höjdspridning × relief (standard 1,6)
  - Riktningen: wiggle mot referensens coherence (+0,1, något tydligare drag)
save: true sparar materialet (med storebror hd 2048, kartorna color, normal, height och recept) i assets/textures/.
Svarar med en rad JSON: slutliga spakar och måtten för referens och resultat.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

try:
    import numpy  # noqa: F401
    import PIL  # noqa: F401
except ImportError:  # kör om sig själv med paketen via uv, innan reference_analysis importeras
    os.execvp("uv", ["uv", "run", "--quiet", "--no-project", "--python", "3.12", "--with", "pillow==11.1.0",
                     "--with", "numpy==2.2.3", "python", "-I", __file__, *sys.argv[1:]])

ROOT = Path(__file__).resolve().parents[2]
REF = ROOT / "material-references"
sys.path.insert(0, str(ROOT / "tools" / "texture"))


def analysis():
    import importlib
    return importlib.import_module("reference_analysis")


def saturate(hexc, k):
    ra = analysis()
    import numpy as np
    lab = ra.to_oklab(np.array([[int(hexc[i:i + 2], 16) / 255 for i in (1, 3, 5)]], np.float32))
    lab[:, 1:] *= k
    return ra.hexc(ra.from_oklab(lab)[0])


def render(recipe, out):
    r = subprocess.run([sys.executable, "-I", str(ROOT / "tools/texture/workshop.py"), json.dumps(recipe)], capture_output=True, text=True, cwd=ROOT)
    return json.loads(r.stdout.strip().splitlines()[-1])


def main():
    req = json.loads(sys.argv[1])
    ra = analysis()
    m = json.loads((REF / "manifests" / f"{req['ref']}.json").read_text())
    ref = ra.analyse(ROOT / m["maps"]["color"]["file"], ROOT / m["maps"]["height"]["file"], m["physicalWidthMeters"] or 1.0)
    meters, E = req.get("meters", 1.0), req.get("exaggerate", 1.6)
    pal = ref["palette"]
    sat = req.get("saturate", 1.12)
    src = {"type": "bark", "plates": 0.5, "depth": 0.6, "width": 0.18, "wiggle": 0.5, "detail": 0.45, "tint": 0.12, "flakes": 0.2,
           **req.get("source", {})}
    if req.get("colors", True):
        src.update(dark=saturate(pal[0], sat), light=saturate(pal[3], sat), accent=saturate(pal[4], sat * 0.9))
        # Fårorna: referensens mörkaste ton, ännu mörkare (djupa skuggade sprickor)
        if req.get("crevice_from_ref", True) and "crevice" not in req.get("source", {}):
            c = [int(pal[0][i:i + 2], 16) * 0.55 for i in (1, 3, 5)]
            src["crevice"] = "#" + "".join(f"{int(x):02X}" for x in c)
    want = [ref["spacing_m"][0] * E, ref["spacing_m"][1] * E]
    src["ridges"] = int(src.get("ridges") or max(3, round(meters / want[0])))
    # Plattornas längd: aspect (längd/bredd) om den är satt; annars rows ur avståndet längs stammen
    if not src.get("aspect"):
        src["rows"] = int(src.get("rows") or max(1, round(meters / want[1])))
    steps = req.get("steps", [{"op": "stylize", "strength": 0.5, "colors": 8, "shape": 0.5, "saturation": 1.0, "relief": True}])
    out = ROOT / "build" / "fit" / req["name"]
    out.parent.mkdir(parents=True, exist_ok=True)
    ours = None
    for _ in range(req.get("iters", 4)):
        render({"source": src, "steps": steps, "size": 512, "out": str(out.relative_to(ROOT))}, out)
        ours = ra.analyse(Path(f"{out}_color.png"), Path(f"{out}_height.png"), meters)
        # Skalan: fler åsar om våra drag är för stora (spacing för stort), färre om för små
        for i, key in ((0, "ridges"), (1, "rows")):
            if not req.get(f"lock_{key}") and key in src:
                k = ours["spacing_m"][i] / max(want[i], 1e-6)
                src[key] = int(max(2 if key == "ridges" else 1, min(40, round(src[key] * k ** 0.8))))
        # Reliefen och riktningen
        # Reliefen: höjdkartorna normeras olika (Poly Havens förskjutning mot vår höjd), så djupet följs bara på begäran
        if req.get("fit_relief"):
            rt = ref["relief"]["std"] * req.get("relief", 1.6)
            src["depth"] = round(min(0.95, max(0.15, src["depth"] * (rt / max(ours["relief"]["std"], 1e-3)) ** 0.6)), 3)
        ct = min(0.95, ref["orient"]["coherence"] + 0.1)
        if not req.get("lock_wiggle"):
            src["wiggle"] = round(min(1.2, max(0.15, src["wiggle"] * (ours["orient"]["coherence"] / max(ct, 1e-3)) ** 1.2)), 3)
    render({"source": src, "steps": steps, "size": 512, "out": str(out.relative_to(ROOT))}, out)
    ours = ra.analyse(Path(f"{out}_color.png"), Path(f"{out}_height.png"), meters)
    res = {"name": req["name"], "ref": req["ref"], "source": src, "want_spacing_m": [round(w, 3) for w in want],
           "ref": {k: ref[k] for k in ("palette", "spacing_m", "orient", "relief", "value")},
           "ours": {k: ours[k] for k in ("palette", "spacing_m", "orient", "relief", "value")}}
    if req.get("save"):
        recipe = {"source": src, "steps": steps, "size": 1024, "material": {"meters": meters},
                  "save": {"name": req["name"], "profile": "bark", "tags": req.get("tags", ["bark", "stylized"]), "hd": 2048,
                           "maps": ["color", "normal", "height"], "overwrite": True},
                  "references": [{"id": req["ref"], "source": "polyhaven", "license": "CC0-1.0"}]}
        r = render(recipe, None)
        res["saved"] = r.get("out") or r.get("error")
    print(json.dumps(res))


if __name__ == "__main__":
    main()
