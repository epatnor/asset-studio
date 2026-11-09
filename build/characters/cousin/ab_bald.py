"""A/B-prov 2026-11-09 (andra omgången: E och F, rakt framifrån, två upplösningar): vad i kusinens prompt drar fram hår? Patriks fungerande prompt mot våra tillägg, två frön var."""
import copy, json
from pathlib import Path
ROOT = Path(__file__).resolve().parents[3]
krea = next(s["graph"] for s in json.loads((ROOT / "build/darrowmere/branding/order_krea.json").read_text())["steps"] if s["key"] == "logo_11")
STYLE = ", stylized 3D game character render, hand-painted stylized PBR textures, whole figure visible from head to toe, soft even lighting"
A = "bald young woman wearing high-cut bathing suit, standing in A-pose, facing viewer, against flat grey background" + STYLE
B = ("bald young woman wearing a high-cut one-piece bathing suit, royal blue with broad flowing yellow waves, standing in a strict "
     "T-pose with both arms straight out horizontally, feet shoulder-width apart, facing viewer, against flat grey background" + STYLE)
FRONT = ("bald young woman, straight-on front view, body and face square to the camera, perfectly symmetrical, wearing a high-cut "
         "one-piece bathing suit, royal blue with broad flowing yellow waves, standing in a strict T-pose with both arms straight out "
         "horizontally, feet shoulder-width apart, against flat grey background" + STYLE)
V = {"E": FRONT, "F": FRONT + ", slender legs and thighs, narrow hips, slim waist, fairly full bust"}
steps = []
for k, p in V.items():
    for seed, (w, h) in [(sd, r) for sd in (11, 12) for r in ((832, 1216), (1152, 1728))]:
        g = copy.deepcopy(krea)
        for n in g.values():
            i = n["inputs"]
            if n["class_type"] == "CLIPTextEncode": i["text"] = p
            elif n["class_type"] == "EmptyLatentImage": i.update(width=w, height=h, batch_size=1)
            elif n["class_type"] == "KSampler": i.update(seed=seed, steps=8, cfg=1.0)
            elif n["class_type"] == "SaveImage": i["filename_prefix"] = f"characters/cousin/ab/{k}_s{seed}_{w}"
        steps.append({"key": f"{k}_{seed}_{w}", "label": f"Bald A/B: variant {k}, seed {seed}, {w}x{h}", "kind": "comfy", "graph": g})
order = {"id": "cousin-ab-bald2", "title": "Cousin: straight-on front view, normal vs double resolution (Krea-2)", "project": "asset-studio", "asset": "cousin",
         "use": "test-only", "gpu": "t1000", "mission": "cousin", "mission_title": "The sorceress's cousin: smooth swimsuit body", "inputs": {}, "steps": steps}
(Path(__file__).parent / "ab_bald_order.json").write_text(json.dumps(order, indent=1))
print(json.dumps({"ok": True, "steps": len(steps)}))
