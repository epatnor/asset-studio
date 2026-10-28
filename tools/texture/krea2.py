"""Krea-2 Turbo via ComfyUI: python3 -I krea2.py "<prompt>" <bredd> <höjd> <utfil.png> [seed] [--base <bild.png> --denoise 0.6] [--seamless]

(ord:vikt) i prompten, t.ex. (anime:-1), går via Krea2PromptWeight: vanliga vikter och negativa prompter gör inget vid cfg 1.
--base gör bild till bild: bilden laddas upp till ComfyUI och Krea målar om den, så mycket som denoise säger (0..1).
--seamless gör bilden sömlös redan i genereringen (Krea2SeamlessRoll rullar latenten mellan stegen, VAEDecodeSeamless
avkodar över kanten), så att den inte behöver tonas eller lagas efteråt."""
import json, random, re, sys, time, urllib.parse, urllib.request, uuid

COMFY = "http://127.0.0.1:8188"
args = sys.argv[1:]
base = denoise = None
seamless = "--seamless" in args
if seamless:
    args.remove("--seamless")
if "--base" in args:
    i = args.index("--base"); base = args[i + 1]; del args[i:i + 2]
if "--denoise" in args:
    i = args.index("--denoise"); denoise = float(args[i + 1]); del args[i:i + 2]
prompt, w, h, out = args[0], int(args[1]), int(args[2]), args[3]
seed = int(args[4]) if len(args) > 4 else random.randint(0, 2**48)

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
if base:
    # Bild till bild: ladda upp basbilden, skala till rätt storlek och koda den till latentrummet
    boundary = uuid.uuid4().hex
    data = open(base, "rb").read()
    body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"tt_base_{uuid.uuid4().hex[:8]}.png\"\r\n"
            "Content-Type: image/png\r\n\r\n").encode() + data + f"\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"overwrite\"\r\n\r\ntrue\r\n--{boundary}--\r\n".encode()
    up = urllib.request.Request(f"{COMFY}/upload/image", data=body, headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    name = json.load(urllib.request.urlopen(up, timeout=30))["name"]
    g["10"] = {"class_type": "LoadImage", "inputs": {"image": name}}
    g["11"] = {"class_type": "ImageScale", "inputs": {"image": ["10", 0], "upscale_method": "lanczos", "width": w, "height": h, "crop": "center"}}
    g["6"] = {"class_type": "VAEEncode", "inputs": {"pixels": ["11", 0], "vae": ["3", 0]}}
    g["7"]["inputs"]["denoise"] = 0.6 if denoise is None else max(0.05, min(1.0, denoise))
if seamless:
    g["20"] = {"class_type": "Krea2SeamlessRoll", "inputs": {"model": g["7"]["inputs"]["model"], "axis": "both", "seed": seed & 0xFFFFFFFF}}
    g["7"]["inputs"]["model"] = ["20", 0]
    g["8"] = {"class_type": "VAEDecodeSeamless", "inputs": {"samples": ["7", 0], "vae": ["3", 0], "axis": "both", "pad": 8}}
if re.search(r"\([^()]+:-?\d+(\.\d+)?\)", prompt):
    g["4"] = {"class_type": "Krea2PromptWeight", "inputs": {"model": ["1", 0], "clip": ["2", 0], "text": prompt, "strength": 1.0}}
    g["5"]["inputs"]["conditioning"] = ["4", 1]
    if seamless:
        g["20"]["inputs"]["model"] = ["4", 0]
        g["7"]["inputs"]["positive"] = ["4", 1]
    else:
        g["7"]["inputs"].update(model=["4", 0], positive=["4", 1])

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
