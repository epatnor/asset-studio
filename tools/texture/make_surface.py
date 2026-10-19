# /// script
# requires-python = ">=3.12"
# dependencies = ["pillow==11.1.0", "numpy==2.2.3"]
# ///
"""Sömlös, stiliserad yttextur (mark, gräs, sten, plankor ...) med Krea-2 + sömlagning.

  uv run --quiet --script tools/texture/make_surface.py '{"name":"grass","preset":"grass","seed":1}'

1. Krea-2 genererar en platt, uppifrån sedd yta.
2. Bilden förskjuts ett halvt varv, så att kanterna hamnar i mitten som ett kors.
3. Krea-2 målar om bara korset (inpainting med SetLatentNoiseMask).
4. Bara det ommålade korset läggs tillbaka (mjuk mask) ovanpå den förskjutna bilden: kanterna är då
   originalpixlar som gränsar till varandra, så texturen är exakt sömlös.
5. Normalkarta ur ljusheten (med wrap, så den också är sömlös).

Resultat: assets/textures/surface_<name>.png och surface_<name>_normal.png. Svarar med en rad JSON
inklusive seam_score (1,0 = sömmen syns inte mer än vilken pixelgräns som helst).
"""
import io
import json
import random
import sys
import time
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parents[2]
COMFY = "http://127.0.0.1:8188"
STYLE = json.loads((ROOT / "tools" / "style.json").read_text())["prompt"]
SURFACES = json.loads((Path(__file__).parent / "surfaces.json").read_text())
MODELS = {"unet": "krea2_turbo_int8_convrot.safetensors", "clip": "qwen3vl_4b_fp8_scaled.safetensors", "vae": "qwen_image_vae.safetensors"}


def run_graph(graph, timeout=600):
    req = urllib.request.Request(f"{COMFY}/prompt", data=json.dumps({"prompt": graph}).encode(), headers={"Content-Type": "application/json"})
    pid = json.load(urllib.request.urlopen(req, timeout=30))["prompt_id"]
    t0 = time.time()
    while time.time() - t0 < timeout:
        hist = json.load(urllib.request.urlopen(f"{COMFY}/history/{pid}", timeout=30)).get(pid)
        if hist and hist["status"].get("completed") is not None:
            if hist["status"].get("status_str") != "success":
                raise RuntimeError(json.dumps(hist["status"])[:800])
            img = next(o["images"][0] for o in hist["outputs"].values() if o.get("images"))
            q = urllib.parse.urlencode({"filename": img["filename"], "subfolder": img["subfolder"], "type": img["type"]})
            return Image.open(io.BytesIO(urllib.request.urlopen(f"{COMFY}/view?{q}", timeout=30).read())).convert("RGB")
        time.sleep(1.5)
    raise TimeoutError(pid)


def upload(img, name):
    # multipart/form-data till ComfyUI:s /upload/image
    buf = io.BytesIO(); img.save(buf, "PNG")
    boundary = uuid.uuid4().hex
    body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"{name}\"\r\nContent-Type: image/png\r\n\r\n").encode() \
        + buf.getvalue() + f"\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"overwrite\"\r\n\r\ntrue\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(f"{COMFY}/upload/image", data=body, headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    return json.load(urllib.request.urlopen(req, timeout=60))["name"]


def base_nodes(prompt):
    return {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": MODELS["unet"], "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": MODELS["clip"], "type": "krea2", "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": MODELS["vae"]}},
        "4": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["2", 0]}},
        "5": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["4", 0]}},
    }


def txt2img(prompt, size, seed):
    g = base_nodes(prompt)
    g |= {
        "6": {"class_type": "EmptyLatentImage", "inputs": {"width": size, "height": size, "batch_size": 1}},
        "7": {"class_type": "KSampler", "inputs": {"model": ["1", 0], "positive": ["4", 0], "negative": ["5", 0], "latent_image": ["6", 0],
              "seed": seed, "steps": 8, "cfg": 1.0, "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0}},
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["7", 0], "vae": ["3", 0]}},
        "9": {"class_type": "SaveImage", "inputs": {"images": ["8", 0], "filename_prefix": "surface"}},
    }
    return run_graph(g)


def inpaint(prompt, image_name, mask_name, seed, denoise):
    g = base_nodes(prompt)
    g |= {
        "6": {"class_type": "LoadImage", "inputs": {"image": image_name}},
        "7": {"class_type": "LoadImageMask", "inputs": {"image": mask_name, "channel": "red"}},
        "8": {"class_type": "VAEEncode", "inputs": {"pixels": ["6", 0], "vae": ["3", 0]}},
        "9": {"class_type": "SetLatentNoiseMask", "inputs": {"samples": ["8", 0], "mask": ["7", 0]}},
        "10": {"class_type": "KSampler", "inputs": {"model": ["1", 0], "positive": ["4", 0], "negative": ["5", 0], "latent_image": ["9", 0],
               "seed": seed, "steps": 8, "cfg": 1.0, "sampler_name": "euler", "scheduler": "simple", "denoise": denoise}},
        "11": {"class_type": "VAEDecode", "inputs": {"samples": ["10", 0], "vae": ["3", 0]}},
        "12": {"class_type": "SaveImage", "inputs": {"images": ["11", 0], "filename_prefix": "surface_seam"}},
    }
    return run_graph(g)


def seam_score(a):
    # Medelskillnad över sömmen (sista -> första kolumnen/raden) delat med medelskillnaden mellan grannpixlar
    a = a.astype(np.float32)
    inner = (np.abs(np.diff(a, axis=1)).mean() + np.abs(np.diff(a, axis=0)).mean()) / 2
    seam = (np.abs(a[:, 0] - a[:, -1]).mean() + np.abs(a[0, :] - a[-1, :]).mean()) / 2
    return float(seam / max(inner, 1e-6))


def harmonize_edges(a, k=40):
    # Där korsets armar når bildkanten är pixlarna nymålade, och vänster/höger (topp/botten) har inte
    # målats ihop. Blanda motsatta kanter spegelvänt i en smal remsa, så att de blir lika i själva kanten.
    a = a.astype(np.float32).copy()
    s = a.shape[0]
    for axis in (1, 0):
        b = np.moveaxis(a, axis, 0)  # vy: kanterna längs första axeln
        for j in range(k):
            w = 0.5 * (1 - j / k) ** 1.5
            L, R = b[j].copy(), b[s - 1 - j].copy()
            b[j] = L * (1 - w) + R * w
            b[s - 1 - j] = R * (1 - w) + L * w
    return a.clip(0, 255).astype(np.uint8)


def gauss_wrap(a, sigma_px):
    # Gaussisk oskärpa med wrap (FFT), per kanal
    s = a.shape[0]
    f = np.fft.fftfreq(s)
    g = np.exp(-2 * np.pi ** 2 * sigma_px ** 2 * (f[:, None] ** 2 + f[None, :] ** 2))
    return np.stack([np.real(np.fft.ifft2(np.fft.fft2(a[..., c]) * g)) for c in range(a.shape[2])], axis=-1)


def cross_mask(s, band_frac=0.14):
    # Samma kors som målades om: mitten av bilden, mjuk kant
    band, c = int(s * band_frac), s // 2
    m = np.zeros((s, s), np.float32)
    m[:, c - band:c + band] = 1
    m[c - band:c + band, :] = 1
    return np.clip(gauss_wrap(m[..., None], band * 0.5)[..., 0] * 1.4, 0, 1)


def repair_cross(a, band_frac=0.14):
    # Det ommålade korset blir ofta lite mörkare eller ljusare än omgivningen och syns som ett rutnät
    # vid upprepning. Byt korsets lågfrekventa ljushet mot omgivningens (bred oskärpa), behåll detaljerna.
    a = a.astype(np.float32)
    s = a.shape[0]
    small, big = gauss_wrap(a, s * 0.04), gauss_wrap(a, s * 0.16)
    w = cross_mask(s, band_frac)[..., None]
    factor = np.clip(big / np.maximum(small, 1), 0.6, 1.6)
    return (a * (1 + (factor - 1) * w)).clip(0, 255).astype(np.uint8)


def flatten(a, sigma=0.12, amount=0.65):
    # Ta bort stora ljusskillnader (vinjett, mörka och ljusa fläckar) som annars syns som ett rutnät när
    # texturen upprepas. Dela med en kraftigt suddad version av sig själv (gaussisk via FFT, alltså med
    # wrap, så sömlösheten bevaras) och behåll medelfärgen. Detaljer och färg finns kvar.
    a = a.astype(np.float32)
    s = a.shape[0]
    f = np.fft.fftfreq(s)
    # Gaussisk oskärpa med standardavvikelse sigma·s pixlar, som filter i frekvensplanet: exp(−2π²σ²f²)
    g = np.exp(-2 * np.pi ** 2 * (sigma * s) ** 2 * (f[:, None] ** 2 + f[None, :] ** 2))
    blur = np.stack([np.real(np.fft.ifft2(np.fft.fft2(a[..., c]) * g)) for c in range(3)], axis=-1)
    mean = a.reshape(-1, 3).mean(0)
    flat = a / np.maximum(blur, 1) * mean
    return (a * (1 - amount) + flat * amount).clip(0, 255).astype(np.uint8)


def normal_map(rgb, strength):
    # Höjd = suddig ljushet; gradienter med wrap (np.roll), så normalkartan också är sömlös
    lum = (rgb.astype(np.float32) / 255) @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    h = np.asarray(Image.fromarray((lum * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(2))).astype(np.float32) / 255
    dx = (np.roll(h, -1, axis=1) - np.roll(h, 1, axis=1)) * strength * 4
    dy = (np.roll(h, -1, axis=0) - np.roll(h, 1, axis=0)) * strength * 4
    n = np.dstack([-dx, dy, np.ones_like(h)])
    n /= np.linalg.norm(n, axis=2, keepdims=True)
    return Image.fromarray(((n * 0.5 + 0.5) * 255).astype(np.uint8))


def main():
    recipe = json.loads(sys.argv[1])
    name = recipe["name"]
    # Ett eget material behöver inget preset: prompt (och view) i params räcker
    sp = {**SURFACES.get(recipe.get("preset", name), {}), **recipe.get("params", {})}
    if recipe.get("reprocess"):
        tex = ROOT / "assets" / "textures" / f"surface_{name}.png"
        out = np.asarray(Image.open(tex).convert("RGB"))
        if recipe.get("cross"):
            out = harmonize_edges(repair_cross(out))
        out = flatten(out) if recipe.get("flatten", True) else out
        Image.fromarray(out).save(tex)
        if sp.get("normal", 1) > 0:
            normal_map(out, sp.get("normal", 1)).save(ROOT / "assets" / "textures" / f"surface_{name}_normal.png")
        print(json.dumps({"texture": str(tex.relative_to(ROOT)), "reprocessed": True, "seam_score": round(seam_score(out), 2)}))
        return
    size = int(recipe.get("size", 1024))
    seed = int(recipe.get("seed", random.randint(0, 2**31)))
    # Vyn först (den väger tyngst): rakt uppifrån, så att ytan ser rätt ut från alla håll när den läggs på marken.
    # Husets ljusgradient uppifrån utelämnas för ytor; den ger ojämn ton i en sömlös textur.
    # view: "surface" (mark, uppifrån) eller "facade" (vägg och tak rakt framifrån, för byggnader)
    prompt = ", ".join([STYLE[f"{sp.get('view', 'surface')}_view"], sp["prompt"], STYLE["surface_style"], STYLE["kinds"]["tile"], "uniform density across the whole image, no vignette, no focal point"])

    base = np.asarray(txt2img(prompt, size, seed))
    shifted = np.roll(base, (size // 2, size // 2), axis=(0, 1))
    # Mask: ett kors över de gamla kanterna (nu i mitten), med mjuk kant
    band = int(size * 0.14)
    m = np.zeros((size, size), np.float32)
    c = size // 2
    m[:, c - band:c + band] = 1
    m[c - band:c + band, :] = 1
    soft = np.asarray(Image.fromarray((m * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(band * 0.35))).astype(np.float32) / 255
    work = ROOT / "build" / "surfaces"
    work.mkdir(parents=True, exist_ok=True)
    img_name = upload(Image.fromarray(shifted), f"tt_{name}_shift.png")
    mask_name = upload(Image.fromarray((np.clip(m + soft, 0, 1) * 255).astype(np.uint8)).convert("RGB"), f"tt_{name}_mask.png")
    fixed = np.asarray(inpaint(prompt, img_name, mask_name, seed + 1, float(sp.get("denoise", 0.72)))).astype(np.float32)
    # Bara korset tas från den ommålade bilden; kanterna är originalets inre, alltså exakt sömlösa
    out = (shifted * (1 - soft[..., None]) + fixed * soft[..., None]).clip(0, 255).astype(np.uint8)
    out = repair_cross(out)
    out = harmonize_edges(out)
    out = flatten(out)

    tex_dir = ROOT / "assets" / "textures"
    albedo = tex_dir / f"surface_{name}.png"
    Image.fromarray(out).save(albedo)
    Image.fromarray(base).save(work / f"{name}_base.png")
    res = {"texture": str(albedo.relative_to(ROOT)), "seed": seed, "seam_score": round(seam_score(out), 2),
           "seam_score_before": round(seam_score(base), 2)}
    if sp.get("normal", 1) > 0:
        nm = tex_dir / f"surface_{name}_normal.png"
        normal_map(out, sp.get("normal", 1)).save(nm)
        res["normal"] = str(nm.relative_to(ROOT))
    res["ok"] = res["seam_score"] < 1.6
    print(json.dumps(res))


if __name__ == "__main__":
    main()
