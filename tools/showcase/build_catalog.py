"""Bygg showcase/catalog.json från alla genererade växter (assets/trees/*/recipe.json).

  python3 -I tools/showcase/build_catalog.py

Raderna grupperas efter art, så att nya träd dyker upp på visningssidan automatiskt.
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

ROWS = [
    ("Lövträd", ["oak", "maple", "ash", "aspen", "birch", "cherry"]),
    ("Speciella träd", ["willow", "acacia", "cypress", "jpine", "palm", "deadtree"]),
    ("Barrträd", ["pine", "fir"]),
    ("Buskar", ["bush", "shrub", "ballbush", "moundbush"]),
    ("Bladkupoler", ["leafbush", "petalbush", "serratebush"]),
]

items = []
for d in sorted((ROOT / "assets" / "trees").iterdir()):
    rec, glb = d / "recipe.json", d / f"{d.name}.glb"
    if not (rec.exists() and glb.exists()):
        continue
    r = json.loads(rec.read_text())
    species = r.get("preset", "").split("_")[0]
    items.append({"name": d.name, "species": species, "label": d.name, "tint": r.get("leaf_tint"), "height": r.get("height"),
                  "glb": f"../assets/trees/{d.name}/{d.name}.glb"})

rows = []
for title, species in ROWS:
    row = sorted((i for i in items if i["species"] in species), key=lambda i: (species.index(i["species"]), i["name"]))
    if row:
        rows.append({"title": title, "items": row})
placed = {i["name"] for row in rows for i in row["items"]}
rest = [i for i in items if i["name"] not in placed]
if rest:
    rows.append({"title": "Övrigt", "items": rest})

out = ROOT / "showcase" / "catalog.json"
out.parent.mkdir(exist_ok=True)
out.write_text(json.dumps({"rows": rows}, indent=2, ensure_ascii=False))
print(json.dumps({"catalog": str(out.relative_to(ROOT)), "rows": len(rows), "items": len(items)}))
