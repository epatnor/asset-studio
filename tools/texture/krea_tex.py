# /// script
# requires-python = ">=3.12"
# dependencies = ["pillow==11.1.0", "numpy==2.2.3"]
# ///
"""Sömlösa material med Krea-2, sömlösa redan när de genereras (docs/texture-krea.md).

  uv run --quiet --script tools/texture/krea_tex.py '{"only": ["grass"], "variants": 3}'
  uv run --quiet --script tools/texture/krea_tex.py '{"sheet": true, "group": "ground"}'
  uv run --quiet --script tools/texture/krea_tex.py '{"install": {"grass": 2}}'

Materialen är data i tools/texture/krea_set.json. Generering: ComfyUI-noderna Krea2SeamlessRoll (latenten rullas
med en ny förskjutning före varje modellsteg, så att kanterna hela tiden hamnar mitt i bilden och målas ihop) och
VAEDecodeSeamless (avkodningen ser över kanten). Ingen toning eller ommålning av sömmar i efterhand behövs.
Struktur (tegel, skiffer, plankor): "base" är en sömlös layoutbild som Krea målar över (bild till bild, denoise).

Efteråt: stora ljusskillnader jämnas ut (FFT med wrap), värdena hålls inom stilguidens 8–90 %, och normal- och
höjdkarta räknas ur ljusheten med wrap. Kandidater i build/krea/<namn>/v<i>*.png med mått i meta.json.
"install" kopierar en vald variant till målfilerna i assets/textures/ (gamla finns i backups/ och taggen
textures-before-krea) och skriver assets/textures/krea_installed.json. Svarar med en rad JSON.
"""
import io
import json
import random
import shutil
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
SET = json.loads((Path(__file__).parent / "krea_set.json").read_text())
MODELS = {"unet": "krea2_turbo_int8_convrot.safetensors", "clip": "qwen3vl_4b_fp8_scaled.safetensors", "vae": "qwen_image_vae.safetensors"}
BUILD = ROOT / "build" / "krea"
TEX = ROOT / "assets" / "textures"


def run_graph(graph, timeout=900):
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
            return Image.open(io.BytesIO(urllib.request.urlopen(f"{COMFY}/view?{q}", timeout=60).read())).convert("RGB")
        time.sleep(1.5)
    raise TimeoutError(pid)


def upload(path):
    buf = io.BytesIO(); Image.open(path).convert("RGB").save(buf, "PNG")
    boundary = uuid.uuid4().hex
    body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"krea_base_{Path(path).stem}.png\"\r\nContent-Type: image/png\r\n\r\n").encode() \
        + buf.getvalue() + f"\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"overwrite\"\r\n\r\ntrue\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(f"{COMFY}/upload/image", data=body, headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    return json.load(urllib.request.urlopen(req, timeout=60))["name"]


def prompt_for(m):
    view = {"surface": STYLE["surface_view"], "facade": STYLE["facade_view"], "tile": SET["_views"]["tile"]}[m.get("view", "surface")]
    return ", ".join(p for p in [view, m["prompt"], STYLE["surface_style"], STYLE["kinds"]["tile"], SET["_views"]["common"]] if p)


def generate(m, w, h, seed):
    g = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": MODELS["unet"], "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": MODELS["clip"], "type": "krea2", "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": MODELS["vae"]}},
        "4": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt_for(m), "clip": ["2", 0]}},
        "5": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["4", 0]}},
        "6": {"class_type": "EmptyLatentImage", "inputs": {"width": w, "height": h, "batch_size": 1}},
        "20": {"class_type": "Krea2SeamlessRoll", "inputs": {"model": ["1", 0], "axis": m.get("axis", "both"), "seed": seed & 0xFFFFFFFF}},
        "7": {"class_type": "KSampler", "inputs": {"model": ["20", 0], "positive": ["4", 0], "negative": ["5", 0], "latent_image": ["6", 0],
              "seed": seed, "steps": 8, "cfg": 1.0, "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0}},
        "8": {"class_type": "VAEDecodeSeamless", "inputs": {"samples": ["7", 0], "vae": ["3", 0], "axis": m.get("axis", "both"), "pad": 8}},
        "9": {"class_type": "SaveImage", "inputs": {"images": ["8", 0], "filename_prefix": "krea_tex"}},
    }
    if m.get("base"):
        # Struktur: en sömlös layoutbild (t.ex. kit_masonry) målas över; latenten börjar från den
        g["10"] = {"class_type": "LoadImage", "inputs": {"image": upload(ROOT / m["base"])}}
        g["11"] = {"class_type": "ImageScale", "inputs": {"image": ["10", 0], "upscale_method": "lanczos", "width": w, "height": h, "crop": "disabled"}}
        g["6"] = {"class_type": "VAEEncode", "inputs": {"pixels": ["11", 0], "vae": ["3", 0]}}
        g["7"]["inputs"]["denoise"] = float(m.get("denoise", 0.7))
    return np.asarray(run_graph(g))


def blur_wrap(a, sigma_px):
    hh, ww = a.shape[:2]
    fy, fx = np.fft.fftfreq(hh), np.fft.fftfreq(ww)
    g = np.exp(-2 * np.pi ** 2 * sigma_px ** 2 * (fy[:, None] ** 2 + fx[None, :] ** 2))
    if a.ndim == 2:
        return np.real(np.fft.ifft2(np.fft.fft2(a) * g))
    return np.stack([np.real(np.fft.ifft2(np.fft.fft2(a[..., c]) * g)) for c in range(a.shape[2])], axis=-1)


def flatten(a, amount):
    # Stora ljusfläckar syns som ett rutnät när texturen upprepas: dela med en kraftigt suddad kopia (med wrap)
    a = a.astype(np.float32)
    blur = blur_wrap(a, 0.12 * min(a.shape[:2]))
    flat = a / np.maximum(blur, 1) * a.reshape(-1, 3).mean(0)
    return a * (1 - amount) + flat * amount


def clamp_values(a, lo=0.08, hi=0.9):
    # Stilguiden: inget rent svart eller vitt. Ljusheten pressas mjukt in i [lo, hi], nyansen behålls.
    lum = a @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32) / 255
    target = lo + (hi - lo) * np.clip(lum, 0, 1)
    scale = target / np.maximum(lum, 1e-3)
    return np.clip(a * scale[..., None], 0, 255)


def height_map(rgb, invert=False):
    lum = rgb.astype(np.float32) @ np.array([0.299, 0.587, 0.114], dtype=np.float32) / 255
    h = blur_wrap(lum, 1.5)
    h = h - blur_wrap(h, 0.08 * min(h.shape))  # bara relief, ingen lågfrekvent ljushet
    h = 1 - h if invert else h
    return np.clip((h - h.min()) / max(np.ptp(h), 1e-6), 0, 1)


def normal_map(height, strength):
    dx = (np.roll(height, -1, axis=1) - np.roll(height, 1, axis=1)) * strength * 4
    dy = (np.roll(height, -1, axis=0) - np.roll(height, 1, axis=0)) * strength * 4
    n = np.dstack([-dx, dy, np.ones_like(height)])
    n /= np.linalg.norm(n, axis=2, keepdims=True)
    return (n * 0.5 + 0.5) * 255


def seam_score(a):
    a = a.astype(np.float32)
    inner = (np.abs(np.diff(a, axis=1)).mean() + np.abs(np.diff(a, axis=0)).mean()) / 2
    seam = (np.abs(a[:, 0] - a[:, -1]).mean() + np.abs(a[0, :] - a[-1, :]).mean()) / 2
    return float(seam / max(inner, 1e-6))


def blotch(a):
    # Upprepningskänsla: hur mycket den lågfrekventa ljusheten varierar (0 = jämn, > 0.08 syns som rutnät)
    lum = a.astype(np.float32) @ np.array([0.299, 0.587, 0.114], dtype=np.float32) / 255
    low = blur_wrap(lum, 0.08 * min(lum.shape))
    return float(low.std() / max(lum.mean(), 1e-3))


def make(name, m, variants, seed0):
    w, h = m.get("size", [1024, 1024])
    out = BUILD / name
    out.mkdir(parents=True, exist_ok=True)
    meta_path = out / "meta.json"
    meta = json.loads(meta_path.read_text()) if meta_path.exists() else {"variants": {}}
    made = []
    start = len(meta["variants"])
    for i in range(start, start + variants):
        seed = seed0 + i * 7919
        t0 = time.time()
        raw = generate(m, w, h, seed)
        Image.fromarray(raw).save(out / f"v{i}_raw.png")
        col = flatten(raw, float(m.get("flatten", 0.55)))
        col = clamp_values(col)
        col8 = col.clip(0, 255).astype(np.uint8)
        Image.fromarray(col8).save(out / f"v{i}.png")
        hgt = height_map(col8, m.get("invert_height", False))
        Image.fromarray((hgt * 65535).astype(np.uint16)).save(out / f"v{i}_height.png")  # 16 bit, som barkens höjdkartor
        Image.fromarray(normal_map(hgt, float(m.get("normal", 1.0))).astype(np.uint8)).save(out / f"v{i}_normal.png")
        # AO: fåror (lägre än omgivningen) mörkare; ruffighet: matt, lite blankare på kammarna. ORM = AO, ruffighet, metall 0
        ao = np.clip(1 - np.maximum(blur_wrap(hgt, 6) - hgt, 0) * 2.2, 0.35, 1)
        rough = np.clip(0.92 - 0.12 * hgt, 0, 1)
        Image.fromarray((ao * 255).astype(np.uint8)).save(out / f"v{i}_ao.png")
        Image.fromarray((rough * 255).astype(np.uint8)).save(out / f"v{i}_rough.png")
        Image.fromarray((np.dstack([ao, rough, np.zeros_like(ao)]) * 255).astype(np.uint8)).save(out / f"v{i}_orm.png")
        info = {"seed": seed, "seam": round(seam_score(col8), 2), "seam_raw": round(seam_score(raw), 2), "blotch": round(blotch(col8), 3),
                "mean": [round(float(x)) for x in col8.reshape(-1, 3).mean(0)], "sec": round(time.time() - t0)}
        info["ok"] = info["seam"] < 1.6 and info["blotch"] < 0.09
        meta["variants"][str(i)] = info
        made.append(i)
        meta_path.write_text(json.dumps(meta, indent=1))
    meta["prompt"] = prompt_for(m)
    meta_path.write_text(json.dumps(meta, indent=1))
    return {"name": name, "made": made, "variants": meta["variants"]}


def sheet(group, names, px=200):
    # Kontaktark: varje variant visas 2×2 gånger (sömmen syns då mitt i rutan); en rad per material
    from PIL import ImageDraw
    rows = []
    for n in names:
        d = BUILD / n
        if not (d / "meta.json").exists():
            continue
        meta = json.loads((d / "meta.json").read_text())
        cells = []
        for i in sorted(meta["variants"], key=int):
            im = Image.open(d / f"v{i}.png")
            w, h = im.size
            t = im.resize((px // 2, round(px // 2 * h / w)), Image.LANCZOS)
            tile = Image.new("RGB", (t.width * 2, t.height * 2))
            for yy in range(2):
                for xx in range(2):
                    tile.paste(t, (xx * t.width, yy * t.height))
            ImageDraw.Draw(tile).text((4, 2), f"{n} v{i}", fill=(255, 255, 255))
            cells.append(tile)
        rows.append(cells)
    if not rows:
        return None
    cw = max(c.width for r in rows for c in r)
    ch = [max(c.height for c in r) for r in rows]
    cols = max(len(r) for r in rows)
    canvas = Image.new("RGB", (cols * (cw + 4), sum(ch) + 4 * len(rows)), (40, 42, 48))
    y = 0
    for r, hh in zip(rows, ch):
        for j, c in enumerate(r):
            canvas.paste(c, (j * (cw + 4), y))
        y += hh + 4
    path = BUILD / f"sheet_{group}.jpg"
    canvas.save(path, quality=82)
    return str(path.relative_to(ROOT))


def to_webp(png):
    webp = png.with_suffix(".webp")
    if webp.exists():
        Image.open(png).save(webp, "WEBP", quality=90, method=6)


def targets_of(name, m):
    # Biblioteksmaterial (nya, inte ersättningar) får egna filer: krea_<namn>.png, _normal, _height
    if m.get("library"):
        b = f"assets/textures/krea_{name}"
        return {"color": f"{b}.png", "normal": f"{b}_normal.png", "height": f"{b}_height.png"}
    return m.get("targets", {})


def catalog_update(cat, name, m, info):
    # Texturverkstadens katalog: en ersatt textur behåller sin rad, men receptet pekar nu på Krea-bilden (källan
    # "image") med samma materialinställningar; det procedurella receptet sparas bredvid som <namn>.procedural.texture.json.
    # Ett nytt biblioteksmaterial får en egen rad och ett eget recept.
    tg = targets_of(name, m)
    stem = Path(tg["color"]).stem
    row = next((r for r in cat["textures"] if r.get("files", {}).get("color") == tg["color"]), None)
    if row is None and m.get("library"):
        lib = m["library"]
        row = {"name": stem, "profile": lib["profile"], "maps": list(tg), "files": tg, "meters": lib["meters"], "tags": lib.get("tags", []),
               "recipe": f"assets/textures/{stem}.texture.json", "size": 1024, "saved": time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime())}
        (ROOT / row["recipe"]).write_text(json.dumps({**row, "source": {"type": "image", "name": stem}, "steps": [], "inputs": {},
                                                      "material": {"meters": lib["meters"]}}, indent=2, ensure_ascii=False) + "\n")
        cat["textures"].append(row)
    if row is None:
        return
    row["krea"] = info
    if row.get("recipe") and not m.get("library"):
        rp = ROOT / row["recipe"]
        proc = rp.with_name(rp.name.replace(".texture.json", ".procedural.texture.json"))
        if rp.exists():
            rec = json.loads(rp.read_text())
            if rec.get("source", {}).get("type") != "image":
                proc.write_text(rp.read_text())
                row["recipe_procedural"] = str(proc.relative_to(ROOT))
            rec.update(source={"type": "image", "name": stem}, steps=[], inputs={}, krea=info)
            rp.write_text(json.dumps(rec, indent=2, ensure_ascii=False) + "\n")


def install(choice):
    manifest_path = TEX / "krea_installed.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    cat_path = TEX / "catalog.json"
    cat = json.loads(cat_path.read_text())
    done = []
    for name, v in choice.items():
        m = SET["materials"][name]
        d = BUILD / name
        meta = json.loads((d / "meta.json").read_text())
        for kind, target in targets_of(name, m).items():
            src = d / (f"v{v}.png" if kind == "color" else f"v{v}_{kind}.png")
            dst = ROOT / target
            img = Image.open(src)
            # Målet behåller sin upplösning om den är mindre (t.ex. 512 för små props)
            if dst.exists():
                old = Image.open(dst)
                if old.size != img.size and kind != "height":
                    img = img.resize(old.size, Image.LANCZOS)
            img.save(dst)
            to_webp(dst)
            done.append(target)
        manifest[name] = {"variant": int(v), "seed": meta["variants"][str(v)]["seed"], "prompt": meta.get("prompt"),
                          "targets": targets_of(name, m), "installed": time.strftime("%Y-%m-%d %H:%M")}
        catalog_update(cat, name, m, {"material": name, "variant": int(v), "seed": manifest[name]["seed"]})
    cat_path.write_text(json.dumps(cat, indent=2, ensure_ascii=False) + "\n")
    manifest_path.write_text(json.dumps(manifest, indent=1, ensure_ascii=False))
    return {"installed": done}


def main():
    r = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
    mats = SET["materials"]
    if r.get("install"):
        print(json.dumps(install(r["install"])))
        return
    names = r.get("only") or [n for n, m in mats.items() if not r.get("group") or m.get("group") == r["group"]]
    if r.get("sheet"):
        print(json.dumps({"sheet": sheet(r.get("group", "all"), names, r.get("px", 200))}))
        return
    res = []
    for n in names:
        try:
            res.append(make(n, mats[n], int(r.get("variants", 3)), int(r.get("seed", random.randint(0, 2**31)))))
        except Exception as e:  # noqa: BLE001 – en trasig körning ska inte stoppa resten av batchen
            res.append({"name": n, "error": str(e)[:300]})
        print(json.dumps({"progress": n}), file=sys.stderr, flush=True)
    print(json.dumps({"ok": all("error" not in x for x in res),
                      "results": [{"name": x["name"], **({"error": x["error"]} if "error" in x else
                                   {"made": x["made"], "ok": [k for k, v in x["variants"].items() if v["ok"]]})} for x in res]}))


if __name__ == "__main__":
    main()
