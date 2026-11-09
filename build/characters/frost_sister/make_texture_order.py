"""UltraTex-omålning av frostsystern med metoden från docs/ultratex-4b.md (2026-11-09): Klein base 4B + run1 steg 8000,
bas-VAE:ns dekoder, bakning med vyvikt 8, två extra kamerauppsättningar (45° och fyra kameror 40° uppifrån mot sidorna).
python3 make_texture_order.py <glb på Darrowmere> <referensbild lokalt>"""
import json, sys
from pathlib import Path

HERE = Path(__file__).parent
glb, ref = sys.argv[1], sys.argv[2]
o = json.load(open(HERE / "../../ultratex4b/maren/maren_rig3_test.json"))
g = [s for s in o["steps"] if s["kind"] == "comfy"][0]["graph"]
g["22"]["inputs"].update(glb_path=glb, only_vertices_and_faces=True)
g["19"]["inputs"]["image"] = "$in:ref.png"
for nid, pre in (("26", "ut4b_albedo_views"), ("42", "ut4b_albedo_views_2"), ("12", "frost_sister_ut4b")):
    g[nid]["inputs"]["filename_prefix"] = f"characters/frost_sister/{pre}"
o.update(id="frost-sister-ut4b-r4", title="Frost sister repainted: UltraTex 4B step 8000, base decoder, view weight 8, 45° + above rigs",
         asset="frost-sister", mission="frost-sister", mission_title="The sorceress's sister, a frost mage", inputs={"ref.png": str(Path(ref).resolve())})
o["steps"][0]["label"] = "UltraTex 4B repaint (6 + 45° + 4 from above)"
(HERE / "texture_order.json").write_text(json.dumps(o, indent=1))
print(json.dumps({"ok": True}))
