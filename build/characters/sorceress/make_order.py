"""En stiliserad fantasyfigur som 3D-spelobjekt (för glädjens skull, 2026-11-09): fyra Krea-2-bilder, DeepSeek granskar den
första (nytt frö vid underkänt), Pixal3D gör modell och textur av den. Samma väg som kistan (docs/character-generator.md)."""
import copy, json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
krea = next(s["graph"] for s in json.loads((ROOT / "build/darrowmere/branding/order_krea.json").read_text())["steps"] if s["key"] == "logo_11")
pixal = json.loads((ROOT / "build/maren/order/maren_pixal3d.json").read_text())["steps"][0]["graph"]
PROMPT = ("A stylized 3D game character render, full body, an attractive adult woman, a fantasy elf ranger-sorceress with a confident "
          "playful smile and bright green eyes, long wavy auburn hair worn up in a loose braided updo with a few strands framing her face, "
          "elegant pointed elf ears, fitted dark green leather corset armour with gold filigree, white linen sleeves, a short flowing "
          "emerald cape, slim leather trousers and tall boots, a belt with small pouches and a glowing crystal pendant, standing in a "
          "relaxed A-pose facing the viewer, appealing stylized proportions like Overwatch and World of Warcraft characters, clean "
          "readable shapes, hand-painted stylized PBR textures, the whole figure visible from head to toe and centered, plain flat light "
          "grey studio background, soft even lighting, no text, no weapon, no other objects")
CRITERIA = ["Exactly one character, a stylized fantasy elf woman, fully clothed in armour, shown whole from head to toe and centered.",
            "Front-facing relaxed A-pose with both arms and legs clearly separated from the body, readable for a 3D model.",
            "Plain even background, no other objects, no text; clean anatomy with correct hands and face, no melted or extra parts."]


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


steps = [{"key": "img_1", "label": "Sorceress: image (Krea-2), seed 7", "kind": "comfy", "graph": krea_graph(7, "characters/sorceress/krea_s7")},
         {"key": "rev_1", "label": "Review: sorceress image", "kind": "review", "images": ["$step:img_1"], "criteria": CRITERIA,
          "min_score": 7, "retry": {"step": "img_1", "max": 2}},
         {"key": "mesh", "label": "Sorceress: Pixal3D model + texture", "kind": "comfy", "graph": pixal_graph("$step:img_1", "3d/characters/sorceress_pixal3d")}]
steps += [{"key": f"img_{k}", "label": f"Sorceress: image (Krea-2), seed {s}", "kind": "comfy", "graph": krea_graph(s, f"characters/sorceress/krea_s{s}")}
          for k, s in ((2, 21), (3, 42), (4, 77))]
order = {"id": "sorceress-r1", "title": "Stylized fantasy sorceress: Krea-2 images and a Pixal3D model", "project": "asset-studio",
         "asset": "sorceress", "use": "test-only", "gpu": "t1000", "mission": "sorceress", "mission_title": "A stylized fantasy sorceress",
         "inputs": {}, "steps": steps}
(Path(__file__).parent / "order.json").write_text(json.dumps(order, indent=1))
print(json.dumps({"ok": True, "steps": len(steps)}))
