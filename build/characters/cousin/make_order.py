"""Kusinen (2026-11-09): en människa, smal som trollkvinnorna, i en baddräkt så att kroppen är släta ytor och texturerna får
jobba. Strikt symmetrisk T-pose (armarna raka och vågräta; fötterna axelbrett, glipa mellan låren) för texturmodellerna,
riggningen och speglingen av ansiktet. Skallig: håret blir ett eget lager senare (hårgenerator), så huvudet och ansiktet blir rena. Matt tyg (inte glansigt): högdagrar i bilden
målas annars in i texturen; Patrik valde därför matt tyg. Steg: fyra Krea-2-bilder, granskning med hårda krav,
närbild och promptreparation, Pixal3D gör formen. UltraTex, gradering och spegling sköts av run_after.sh."""
import copy, json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
krea = next(s["graph"] for s in json.loads((ROOT / "build/darrowmere/branding/order_krea.json").read_text())["steps"] if s["key"] == "logo_11")
pixal = json.loads((ROOT / "build/maren/order/maren_pixal3d.json").read_text())["steps"][0]["graph"]
# Runda 7: ordet "hair" finns inte i prompten (Krea har ingen negativ prompt; "no hair" ritar hår), och skalligheten
# kommer först. Omskrivningen får inte heller använda ordet (rewrite_avoid).
PROMPT = ("A stylized 3D game character render, full body, an attractive slim adult human woman with a completely bald, "
          "clean-shaven head: smooth bare skin over the whole scalp like a polished mannequin head, the round skull shape, forehead, "
          "temples, back of the head and both ears fully visible. Slender model-like figure: long slim legs with slender thighs and a "
          "clear gap between them, narrow hips, a slender waist and a fairly full bust. Round human ears, a friendly confident smile, "
          "warm brown eyes, thin natural eyebrows, a clean bare face with no jewellery or make-up marks. She wears only a classic 1980s "
          "high-cut one-piece swimsuit: very high-cut leg openings up to the hip bones, a deep scoop neckline, thin shoulder straps that "
          "cross over a wide open back, smooth matte fabric with no logo, badge or print, mostly royal blue with a few broad flowing "
          "diagonal waves of sunny yellow across it (a Swedish colour theme, blue dominant), bare shoulders, arms and legs, barefoot. She "
          "stands in a strict symmetrical T-pose facing the viewer: both arms straight out to the sides at shoulder height, horizontal, "
          "elbows locked, palms facing down, fingers together; legs straight, feet flat on the ground about shoulder-width apart with "
          "light grey background visible between the legs, toes pointing forward. Appealing stylized proportions like Overwatch and "
          "World of Warcraft characters, clean readable shapes, hand-painted stylized PBR textures, the whole figure visible from head "
          "to toe and centered, plain flat light grey studio background, soft even lighting, no text, no other objects")
CRITERIA = ["Exactly one character, a slim adult human woman, shown whole from head to toe and centered.",
            "She wears only a classic high-cut one-piece swimsuit, mostly blue with broad yellow waves, no logo or badge; shoulders, arms and legs are bare; it is tasteful. Slim: long slim legs, slender thighs, narrow hips, a fairly full bust.",
            "Plain even background, no other objects or text; no strong white highlights on the swimsuit or skin; correct hands and face."]
HARD = ["Completely bald: a smooth bald scalp with no hair at all on the head (eyebrows are fine), no cap, no headwear.",
        "Nothing on the face: no jewellery, face paint or markings; round human ears, not pointed elf ears.",
        "Strict symmetrical T-pose facing the viewer: both arms straight out horizontally at shoulder height, "
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
          "hard": HARD, "crops": CROPS, "min_score": 7, "retry": {"step": "img_1", "max": 8, "rewrite": True}, "rewrite_avoid": ["hair", "hairstyle", "haircut"]},
         {"key": "mesh", "label": "Cousin: Pixal3D model", "kind": "comfy", "graph": pixal_graph("$step:img_1", "3d/characters/cousin_pixal3d")}]
steps += [{"key": f"img_{k}", "label": f"Cousin: image (Krea-2), seed {s}", "kind": "comfy", "graph": krea_graph(s, f"characters/cousin/krea_s{s}")}
          for k, s in ((2, 19), (3, 44), (4, 73))]
order = {"id": "cousin-r7", "title": "Cousin r7 (bald, no hair word in the prompt): human T-pose in a yellow-and-blue 80s high-cut swimsuit, Krea-2 images, review and a Pixal3D model",
         "project": "asset-studio", "asset": "cousin", "use": "test-only", "gpu": "t1000", "mission": "cousin",
         "mission_title": "The sorceress's cousin: smooth swimsuit body in A-pose", "inputs": {}, "steps": steps}
(Path(__file__).parent / "order.json").write_text(json.dumps(order, indent=1))
print(json.dumps({"ok": True, "steps": len(steps)}))


# Runda 8 (2026-11-09): Patrik valde G_s11_1440 ur A/B-provet (skallig, rakt framifrån, T-pose, kvadratiskt så att
# händerna kommer med). Bara Pixal3D; resten sköter run_after.sh (CONCEPT=cousin-r8 IMG_SUB=characters/cousin/ab).
import sys
if "--r8" in sys.argv:
    img = ROOT / "build/characters/cousin/ab/G_s11_1440_00001_.png"
    r8 = {"id": "cousin-r8", "title": "Cousin r8: Pixal3D from the chosen bald front-view T-pose image (G_s11_1440)", "project": "asset-studio",
          "asset": "cousin", "use": "test-only", "gpu": "t1000", "mission": "cousin", "mission_title": order["mission_title"],
          "inputs": {"concept.png": str(img)},
          "steps": [{"key": "mesh", "label": "Cousin: Pixal3D model", "kind": "comfy", "graph": pixal_graph("$in:concept.png", "3d/characters/cousin_pixal3d")}]}
    (Path(__file__).parent / "order_r8.json").write_text(json.dumps(r8, indent=1))
    print(json.dumps({"ok": True, "order": "order_r8.json"}))


# Runda 9 (2026-11-09): r8:s Pixal3D-modell hade lösa strängar längs armarna. Samma bild nedskalad till 1024 och 768
# visar om upplösningen spelar in (Patriks misstanke).
if "--r9" in sys.argv:
    steps = []
    for sz in (1024, 768):
        steps.append({"key": f"mesh_{sz}", "label": f"Cousin: Pixal3D from the {sz}px image", "kind": "comfy",
                      "graph": pixal_graph(f"$in:concept_{sz}.png", f"3d/characters/cousin_r9_{sz}")})
    r9 = {"id": "cousin-r9", "title": "Cousin r9: does input resolution cause Pixal3D's arm strands? (1024 vs 768)", "project": "asset-studio",
          "asset": "cousin", "use": "test-only", "gpu": "t1000", "mission": "cousin", "mission_title": order["mission_title"],
          "inputs": {f"concept_{sz}.png": str(ROOT / f"build/characters/cousin/ab/G_s11_from1440_{sz}.png") for sz in (1024, 768)},
          "steps": steps}
    (Path(__file__).parent / "order_r9.json").write_text(json.dumps(r9, indent=1))
    print(json.dumps({"ok": True, "order": "order_r9.json"}))
