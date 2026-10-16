"""Bygg showcase/catalog.json från alla genererade modeller (assets/trees, props och plants).

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
    ("Stenar och mossa", ["stone", "stones", "mossy_stone", "boulder", "mossy_boulder"]),
    ("Svampar, stubbar och marktäcke", ["fly_agaric", "porcini", "chanterelle", "stump", "mossy_stump", "leafpile", "creeper", "ivy"]),
    ("Gräs, vass och säd", ["grass_tuft", "grass_tall", "grass_seeded", "feather_grass", "reed", "cattail", "wheat", "barley"]),
    ("Blommor", ["daisy", "poppy", "buttercup", "tulip", "cornflower", "lavender", "lupine"]),
    ("Vattenväxter", ["water_lily", "pondweed"]),
]

items = []
dirs = [d for kind in ("trees", "props", "plants") if (ROOT / "assets" / kind).exists() for d in sorted((ROOT / "assets" / kind).iterdir())]
for d in dirs:
    rec, glb = d / "recipe.json", d / f"{d.name}.gltf"
    if not (rec.exists() and glb.exists()):
        continue
    r = json.loads(rec.read_text())
    preset = r.get("preset", "")
    species = preset if d.parent.name in ("props", "plants") else preset.split("_")[0]
    items.append({"name": d.name, "species": species, "label": d.name, "tint": r.get("leaf_tint"), "height": r.get("height"),
                  "model": f"../assets/{d.parent.name}/{d.name}/{d.name}.gltf"})

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
