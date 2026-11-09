"""Trollkvinnans syster, frostmagikern (2026-11-09). Konceptet undviker problemen vi sett med UltraTex och Pixal3D
(docs/ultratex-4b.md): inget hår i ansiktet, ingen halsduk, mantel eller huva, släta ärmar och handskar utan uppvikta kanter,
ett platt bälte utan väskor, armarna fria från kroppen (händerna på höfterna, armbågarna ut) och benen lite isär.
Steg: fyra Krea-2-bilder, DeepSeek granskar den första (nytt frö vid underkänt), Pixal3D gör formen. UltraTex målar sedan
om modellen i en egen beställning (make_texture_order.py), eftersom runnern bara kan skicka bilder mellan steg."""
import copy, json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
krea = next(s["graph"] for s in json.loads((ROOT / "build/darrowmere/branding/order_krea.json").read_text())["steps"] if s["key"] == "logo_11")
pixal = json.loads((ROOT / "build/maren/order/maren_pixal3d.json").read_text())["steps"][0]["graph"]
PROMPT = ("A stylized 3D game character render, full body, an attractive adult woman, a fantasy elf frost mage, confident playful smile, "
          "icy blue eyes, long platinum-silver hair pulled back tightly into a sleek high bun with a neat braided crown, no loose strands, "
          "no fringe, the whole face and forehead clear of hair, elegant pointed elf ears fully visible, a thin silver circlet with a small "
          "ice crystal, a fitted ice-blue and white bodice with silver frost filigree, smooth fitted long sleeves, smooth fitted fingerless "
          "silver-blue gloves with no cuffs, slim fitted pale trousers, smooth knee-high white boots with no flaps, a single flat narrow silver "
          "belt with no pouches, no cape, no scarf, no hood, no hanging cloth or loose ribbons, standing confidently with both hands on her "
          "hips and elbows held out away from the body so there is clear space between the arms and the torso, legs slightly apart, facing "
          "the viewer, appealing stylized proportions like Overwatch and World of Warcraft characters, clean readable shapes, hand-painted "
          "stylized PBR textures, the whole figure visible from head to toe and centered, plain flat light grey studio background, soft even "
          "lighting, no text, no weapon, no other objects, no magic effects around her")
CRITERIA = ["Exactly one character, a stylized fantasy elf woman in fitted frost-blue clothes, shown whole from head to toe and centered.",
            "Her face and forehead are completely free of hair: hair is pulled back into a bun, with no loose strands or fringe over the face.",
            "No cape, scarf, hood or hanging cloth; sleeves, gloves and boots are smooth without folded cuffs; only a flat belt without pouches.",
            "Hands on hips with elbows out and clear gaps between arms and torso, legs slightly apart; correct hands and face, no melted or extra parts.",
            "Plain even background, no other objects, no text, no magic effects."]


def krea_graph(seed, prefix):
    g = copy.deepcopy(krea)
    for n in g.values():
        i = n["inputs"]
        if n["class_type"] == "CLIPTextEncode":
            i["text"] = PROMPT
        elif n["class_type"] == "EmptyLatentImage":
            i.update(width=832, height=1216, batch_size=1)
        elif n["class_type"] == "KSampler":
            i.update(seed=seed, steps=8, cfg=1.0)
        elif n["class_type"] == "SaveImage":
            i["filename_prefix"] = prefix
    return g


def pixal_graph(img_ref, prefix):
    g = copy.deepcopy(pixal)
    for n in g.values():
        if n["class_type"] == "LoadImage":
            n["inputs"]["image"] = img_ref
        elif n["class_type"] == "SaveGLB":
            n["inputs"]["filename_prefix"] = prefix
    return g


steps = [{"key": "img_1", "label": "Frost mage: image (Krea-2), seed 11", "kind": "comfy", "graph": krea_graph(11, "characters/frost_sister/krea_s11")},
         {"key": "rev_1", "label": "Review: frost mage image", "kind": "review", "images": ["$step:img_1"], "criteria": CRITERIA,
          "min_score": 7, "retry": {"step": "img_1", "max": 3}},
         {"key": "mesh", "label": "Frost mage: Pixal3D model", "kind": "comfy", "graph": pixal_graph("$step:img_1", "3d/characters/frost_sister_pixal3d")}]
steps += [{"key": f"img_{k}", "label": f"Frost mage: image (Krea-2), seed {s}", "kind": "comfy", "graph": krea_graph(s, f"characters/frost_sister/krea_s{s}")}
          for k, s in ((2, 23), (3, 57), (4, 91))]
order = {"id": "frost-sister-r1", "title": "Frost sister: Krea-2 images, review and a Pixal3D model", "project": "asset-studio",
         "asset": "frost-sister", "use": "test-only", "gpu": "t1000", "mission": "frost-sister", "mission_title": "The sorceress's sister, a frost mage",
         "inputs": {}, "steps": steps}
(Path(__file__).parent / "order.json").write_text(json.dumps(order, indent=1))
print(json.dumps({"ok": True, "steps": len(steps)}))
