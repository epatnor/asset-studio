"""Statyn och monstret ur valideringen (TexVerse, Sketchfab, CC BY) texturerade med vår 4B (run1 10000) och med 9B,
för att jämföra med originalets textur i 3D. Referensbilden är originalet renderat platt framifrån i Blender; UltraTex får
bara formen (only_vertices_and_faces). Bara för test: monstret är fankonst av en Metroid-figur."""
import json
src = json.load(open("build/maren/order/maren_ultratex.json"))["steps"][0]["graph"]
OBJ = {"statue": "Polybios Statue Lowpoly (zvodd, CC BY)", "monster": "Boost Guardian (Bornstellar Makes Eternallasting, CC BY)"}
for name, credit in OBJ.items():
    for model in ("4b", "9b"):
        g = json.loads(json.dumps(src))
        for k in ("24", "27", "28", "112"):
            g.pop(k, None)
        g["12"]["inputs"].pop("metallic_roughness_views", None)
        if model == "4b":
            g["5"] = {"class_type": "UNETLoader", "inputs": {"unet_name": "flux-2-klein-base-4b-fp8.safetensors", "weight_dtype": "default"}}
            g["9"]["inputs"].update(clip_name="qwen_3_4b.safetensors", type="flux2")
            g["7"]["inputs"]["lora_name"] = "ultratex4b_run1_10000.safetensors"
        g["22"]["inputs"].update(glb_path=f"/data/utdata/ultratex4b/testobjects/{name}_original.glb", only_vertices_and_faces=True)
        g["19"]["inputs"]["image"] = "$step:ref"
        g["26"]["inputs"]["filename_prefix"] = f"ultratex4b/testobjects/{name}_{model}_albedo_views"
        g["12"]["inputs"]["filename_prefix"] = f"ultratex4b/testobjects/{name}_{model}"
        o = {"id": f"testobj-{name}-{model}", "gpu": "t1000", "project": "asset-studio", "asset": f"texverse-{name}", "use": "test-only",
             "title": f"UltraTex {model.upper()} on the {name} from validation ({credit})",
             "mission": "ultratex4b-testobjects", "mission_title": "UltraTex 4B: validation objects in 3D, ours vs 9B vs original",
             "inputs": {"mesh.glb": f"{name}_original.glb"},
             "steps": [{"key": "ref", "label": "Reference: original, front, flat", "kind": "blender",
                        "args": {"glb": "$in:mesh.glb", "size": 1024, "shots": [{"name": "front", "yaw": 0, "mode": "texture"}]}},
                       {"key": "texture", "label": f"UltraTex albedo ({model.upper()})", "kind": "comfy", "graph": g}]}
        json.dump(o, open(f"build/ultratex4b/testobjects/{name}_{model}.json", "w"), indent=1)
print(json.dumps({"ok": True}))
