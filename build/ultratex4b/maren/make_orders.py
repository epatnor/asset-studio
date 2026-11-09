"""Maren-provet för UltraTex 4B (docs/ultratex-4b.md, steg 6): samma nät, referens, frö och vyer som 9B-körningen
2026-11-08 (build/maren/order/maren_ultratex.json), men Klein base 4B, Qwen3 4B och vår LoRA från run1. Bara albedo:
4B har ingen ruffighets/metall-LoRA än, och bakningen klarar sig utan."""
import json
src = json.load(open("build/maren/order/maren_ultratex.json"))
for step in (5000, 10000):
    g = json.loads(json.dumps(src["steps"][0]["graph"]))
    for k in ("24", "27", "28", "112"):
        g.pop(k, None)
    g["12"]["inputs"].pop("metallic_roughness_views", None)
    g["5"] = {"class_type": "UNETLoader", "inputs": {"unet_name": "flux-2-klein-base-4b-fp8.safetensors", "weight_dtype": "default"}}
    g["9"]["inputs"].update(clip_name="qwen_3_4b.safetensors", type="flux2")
    g["7"]["inputs"]["lora_name"] = f"ultratex4b_run1_{step:05d}.safetensors"
    tag = f"ultratex4b/maren/s{step:05d}"
    g["26"]["inputs"]["filename_prefix"] = f"{tag}_albedo_views"
    g["12"]["inputs"]["filename_prefix"] = f"{tag}_MarenPBR"
    o = {**{k: src[k] for k in ("project", "asset", "use", "inputs")},
         "id": f"maren-ultratex4b-s{step:05d}", "gpu": "t1000",
         "title": f"Maren: UltraTex 4B run1 step {step} (albedo, vs 9B)",
         "mission": "ultratex4b-maren", "mission_title": "UltraTex 4B: Maren test, run1 checkpoints vs 9B",
         "steps": [{"key": "texture", "label": f"UltraTex albedo (Klein base 4B + run1 {step})", "kind": "comfy", "graph": g}]}
    o["inputs"] = {"maren_ref.png": "../../maren/ref/maren_ref.png"}
    json.dump(o, open(f"build/ultratex4b/maren/maren_s{step:05d}.json", "w"), indent=1)
print(json.dumps({"ok": True}))
