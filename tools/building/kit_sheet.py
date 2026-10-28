"""Kontaktark av byggsatsen (docs/building-kit.md): bygger katalogens moduler och husen med gen_kit.mjs och renderar
dem i Blender (tools/preview/preview_glb.py, stilguidens ljus), så att modulerna kan granskas utan att öppna studion.

  python3 -I tools/building/kit_sheet.py '{"what": "catalog", "out": "build/kit/catalog.png", "size": [2000, 520]}'
  python3 -I tools/building/kit_sheet.py '{"what": "assembly", "assembly": "cottage", "rot": -35, "elev": 20, "out": "build/kit/cottage.png"}'

Svarar med en rad JSON: arket och generatorns svar.
"""
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools" / "tree"))
from make_tree import preview  # noqa: E402


def gen(recipe):
    run = subprocess.run(["node", str(ROOT / "tools/building/gen_kit.mjs"), json.dumps(recipe)], cwd=ROOT, capture_output=True, text=True)
    lines = [l for l in run.stdout.splitlines() if l.startswith("{")]
    if not lines:
        raise SystemExit(json.dumps({"error": (run.stderr or run.stdout)[-600:]}))
    return json.loads(lines[-1])


def main():
    r = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
    what = r.get("what", "catalog")
    if what == "catalog":
        res = gen({"catalog": True, "out_dir": "build/kit/catalog"})
        only = r.get("only")
        items = [c for c in res["catalog"] if not only or any(o in c["model"] for o in only)]
        glbs = [{"glb": str(ROOT / c["model"]), "rot": r.get("rot", -24)} for c in items]
        out = r.get("out", "build/kit/catalog.png")
        summary = {"ok": res["ok"], "modules": [{"model": Path(c["model"]).stem, "tris": c["tris_lod"], "ok": c["checks"]["ok"]} for c in items]}
    else:
        a = r.get("assembly", "cottage")
        res = gen({"assembly": a, "out": f"build/kit/{a}.gltf"})
        glbs = [{"glb": str(ROOT / res["model"]), "rot": r.get("rot", -35)}]
        out = r.get("out", f"build/kit/{a}.png")
        summary = res
    preview(glbs, str(ROOT / out), lod=r.get("lod", 0), size=tuple(r.get("size", [2000, 520])), elev=r.get("elev", 14))
    print(json.dumps({"out": out, **summary}))


if __name__ == "__main__":
    main()
