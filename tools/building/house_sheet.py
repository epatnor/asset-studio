"""Kontaktark av husen (docs/buildings.md): bygger recepten med make_building.py och renderar dem på rad i Blender
(tools/preview/preview_glb.py, stilguidens ljus), så att husen kan granskas utan att öppna studion.

  python3 -I tools/building/house_sheet.py '{"recipes": [{"archetype": "cottage", "seed": 1}, ...], "style": "fantasy",
      "stylization": "overwatch", "out": "build/houses/sheet.png", "size": [1800, 600], "lod": 0, "rot": -32, "elev": 24}'

Utan recipes byggs alla hustyper i houses.json med seed 1. Svarar med en rad JSON: arket, och kontrollerna per hus.
"""
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools" / "tree"))
from make_tree import preview  # noqa: E402


def main():
    r = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
    houses = json.loads((ROOT / "tools/building/houses.json").read_text())["archetypes"]
    recipes = r.get("recipes") or [{"archetype": a, "seed": 1} for a in houses]
    glbs, results = [], []
    for i, rc in enumerate(recipes):
        rc = {"style": r.get("style", "fantasy"), "stylization": r.get("stylization", "overwatch"), "textures": False, **rc}
        rc["name"] = rc.get("name") or f"sheet_{i}_{rc['archetype']}_{rc['style']}_{rc['seed']}"
        rc["out_root"] = "build/houses"
        run = subprocess.run([sys.executable, "-I", str(ROOT / "tools/building/make_building.py"), json.dumps(rc)], cwd=ROOT, capture_output=True, text=True)
        try:
            res = json.loads(run.stdout.strip().splitlines()[-1])
        except (IndexError, json.JSONDecodeError):
            res = {"error": (run.stderr or run.stdout)[-400:]}
        results.append({"name": rc["name"], "ok": res.get("checks", {}).get("ok"), "tris": res.get("tris_lod"), **({"error": res["error"]} if "error" in res else {})})
        if "model" in res:
            glbs.append({"glb": str(ROOT / res["model"]), "rot": r.get("rot", -32)})  # snett framifrån, så att gavlar och flyglar syns
    out = r.get("out", "build/houses/sheet.png")
    preview(glbs, str(ROOT / out), lod=r.get("lod", 0), size=tuple(r.get("size", [1800, 600])), elev=r.get("elev", 24))
    print(json.dumps({"out": out, "houses": results}))


if __name__ == "__main__":
    main()
