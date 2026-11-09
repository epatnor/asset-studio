"""Kusinen (2026-11-09): en människa, smal som trollkvinnorna, i en baddräkt så att kroppen är släta ytor och texturerna får
jobba. Strikt symmetrisk A-pose (armarna raka, 45° ut; fötterna axelbrett, glipa mellan låren) för texturmodellerna,
riggningen och speglingen av ansiktet. Skallig: håret blir ett eget lager senare (hårgenerator), så huvudet och ansiktet blir rena. Matt tyg (inte glansigt): högdagrar i bilden
målas annars in i texturen; Patrik valde därför matt tyg. Steg: fyra Krea-2-bilder, granskning med hårda krav,
närbild och promptreparation, Pixal3D gör formen. UltraTex, gradering och spegling sköts av run_after.sh."""
import copy, json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
krea = next(s["graph"] for s in json.loads((ROOT / "build/darrowmere/branding/order_krea.json").read_text())["steps"] if s["key"] == "logo_11")
pixal = json.loads((ROOT / "build/maren/order/maren_pixal3d.json").read_text())["steps"][0]["graph"]
PROMPT = ("A stylized 3D game character render, full body, an attractive slim adult human woman with round human ears, a friendly "
          "confident smile, warm brown eyes, natural brown eyebrows, a completely bald head with a smooth bald scalp and "
          "no hair at all on the head (hair is added later as a separate part), the whole skull shape, forehead and ears clearly visible, "
          "a clean bare face with no jewellery or make-up marks. She wears only a classic 1980s lifeguard-style one-piece swimsuit: very high-cut leg "
          "openings up to the hip bones, a deep scoop neckline, thin shoulder straps that cross over a wide open back, smooth matte fabric "
          "with no logo, badge or print, coloured in a Swedish theme of sunny yellow and royal blue in broad flowing diagonal waves across "
          "the suit, bare shoulders, arms and legs, barefoot. She stands in a "
          "strict symmetrical A-pose facing the viewer: both arms straight with elbows locked, held out from the body at 45 degrees, palms "
          "facing down, fingers together; legs straight, feet flat on the ground about shoulder-width apart with a clear gap between the "
          "thighs, toes pointing forward. Appealing stylized proportions like Overwatch and World of Warcraft characters, clean readable "
          "shapes, hand-painted stylized PBR textures, the whole figure visible from head to toe and centered, plain flat light grey studio "
          "background, soft even lighting, no text, no other objects")
CRITERIA = ["Exactly one character, a slim adult human woman, shown whole from head to toe and centered.",
            "She wears only a classic high-cut one-piece swimsuit in broad yellow and blue waves, with no logo or badge; shoulders, arms and legs are bare; it is tasteful.",
            "Plain even background, no other objects or text; no strong white highlights on the swimsuit or skin; correct hands and face."]
HARD = ["Completely bald: a smooth bald scalp with no hair at all on the head (eyebrows are fine), no cap, no headwear.",
        "Nothing on the face: no jewellery, face paint or markings; round human ears, not pointed elf ears.",
        "Strict symmetrical A-pose facing the viewer: both arms straight and about 45 degrees out from the body with clear gaps to the torso, "
        "legs straight with feet about shoulder-width apart and a visible gap between the thighs, toes forward."]
CROPS = [{"name": "head", "box": [0.3, 0.0, 0.7, 0.18]}]


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


steps = [{"key": "img_1", "label": "Cousin: image (Krea-2), seed 5", "kind": "comfy", "graph": krea_graph(5, "characters/cousin/krea_s5")},
         {"key": "rev_1", "label": "Review: cousin image", "kind": "review", "images": ["$step:img_1"], "criteria": CRITERIA,
          "hard": HARD, "crops": CROPS, "min_score": 7, "retry": {"step": "img_1", "max": 6, "rewrite": True}},
         {"key": "mesh", "label": "Cousin: Pixal3D model", "kind": "comfy", "graph": pixal_graph("$step:img_1", "3d/characters/cousin_pixal3d")}]
steps += [{"key": f"img_{k}", "label": f"Cousin: image (Krea-2), seed {s}", "kind": "comfy", "graph": krea_graph(s, f"characters/cousin/krea_s{s}")}
          for k, s in ((2, 19), (3, 44), (4, 73))]
order = {"id": "cousin-r3", "title": "Cousin (bald, hair comes later): human A-pose in a yellow-and-blue 80s high-cut swimsuit, Krea-2 images, review and a Pixal3D model",
         "project": "asset-studio", "asset": "cousin", "use": "test-only", "gpu": "t1000", "mission": "cousin",
         "mission_title": "The sorceress's cousin: smooth swimsuit body in A-pose", "inputs": {}, "steps": steps}
(Path(__file__).parent / "order.json").write_text(json.dumps(order, indent=1))
print(json.dumps({"ok": True, "steps": len(steps)}))
