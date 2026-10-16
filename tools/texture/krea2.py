"""Krea-2 Turbo via ComfyUI: python3 -I krea2.py "<prompt>" <bredd> <höjd> <utfil.png> [seed]"""
import json, random, sys, time, urllib.parse, urllib.request

COMFY = "http://127.0.0.1:8188"
prompt, w, h, out = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
seed = int(sys.argv[5]) if len(sys.argv) > 5 else random.randint(0, 2**48)

g = {
    "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "krea2_turbo_int8_convrot.safetensors", "weight_dtype": "default"}},
    "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen3vl_4b_fp8_scaled.safetensors", "type": "krea2", "device": "default"}},
    "3": {"class_type": "VAELoader", "inputs": {"vae_name": "qwen_image_vae.safetensors"}},
    "4": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["2", 0]}},
    "5": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["4", 0]}},
    "6": {"class_type": "EmptyLatentImage", "inputs": {"width": w, "height": h, "batch_size": 1}},
    "7": {"class_type": "KSampler", "inputs": {"model": ["1", 0], "positive": ["4", 0], "negative": ["5", 0], "latent_image": ["6", 0],
          "seed": seed, "steps": 8, "cfg": 1.0, "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0}},
    "8": {"class_type": "VAEDecode", "inputs": {"samples": ["7", 0], "vae": ["3", 0]}},
    "9": {"class_type": "SaveImage", "inputs": {"images": ["8", 0], "filename_prefix": "tree_tool"}},
}

def get(url):
    return json.load(urllib.request.urlopen(url, timeout=30))

req = urllib.request.Request(f"{COMFY}/prompt", data=json.dumps({"prompt": g}).encode(), headers={"Content-Type": "application/json"})
pid = json.load(urllib.request.urlopen(req, timeout=30))["prompt_id"]

for _ in range(200):
    hist = get(f"{COMFY}/history/{pid}").get(pid)
    if hist and hist["status"].get("completed") is not None:
        break
    time.sleep(2)
else:
    sys.exit(f"timeout {pid}")

if hist["status"].get("status_str") != "success":
    sys.exit(json.dumps(hist["status"])[:1000])
img = hist["outputs"]["9"]["images"][0]
q = urllib.parse.urlencode({"filename": img["filename"], "subfolder": img["subfolder"], "type": img["type"]})
with open(out, "wb") as f:
    f.write(urllib.request.urlopen(f"{COMFY}/view?{q}", timeout=30).read())
print(json.dumps({"out": out, "seed": seed}))
