"""Förlagor till kroppsgeneratorn med Krea-2 Turbo i lokal ComfyUI, genom GPU-kön.

  python3 -I gen_refs.py body <male|female> [seed ...] [--front] [--base=förlaga.png --denoise=0.6]
                                                               hel kropp fram (A-pose) och från sidan; --base: bild till bild
  python3 -I gen_refs.py parts <male|female> <body.png>        varje kroppsdel för sig, ur helkroppens beskärning (bild till bild)

Husstilen kommer ur asset-studio/tools/style.json (prompt.character_art), utan miljö och dramatiskt ljus:
förlagorna ska bli 3D, så de behöver jämnt ljus och vit bakgrund.
Bilderna hamnar i body-gen/images/<kön>/; en rad JSON per bild i images/refs.jsonl (prompt, seed, fil)."""
import json, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]   # asset-studio
HERE = ROOT / "build/body"                    # body-gens arbetsyta: build/, out/, images/ (flyttad 2026-11-10)
TOOLS = Path(__file__).resolve().parent
SPEL = ROOT.parents[1]                        # ~/Spelutveckling (img2mesh, lowpoly-test)
KREA = SPEL / "azshara-studio/asset-studio/tools/texture/krea2.py"
GPUQ = SPEL / "img2mesh/gpuq.py"
STYLE = json.load(open(SPEL / "azshara-studio/asset-studio/tools/style.json"))["prompt"]

# character_art utan det som inte hör hemma i en förlaga för 3D (miljö, djup, dramatiskt motljus, rustning, hår)
DROP = ("dramatic cinematic lighting", "glossy metal", "simplified stylized hair", "detailed fabrics",
        "expressive environment", "atmospheric depth", "premium game promotional", "premium fantasy splash")
ART = ", ".join(p.strip() for p in STYLE["character_art"].rstrip(".").split(",")
                if not any(p.strip().startswith(d) for d in DROP))
CUT = STYLE["kinds"]["cutout"]
LIGHT = "even soft frontal studio lighting, no rim light, no cast shadows, neutral color grading"
# Badkläder (2026-11-01, Patrik): så mycket hud som möjligt syns, med hudtonens naturliga toningar
SKIN = ("natural healthy skin with visible tonal variation, slightly warmer and pinker on the cheeks, nose, ears, knees, elbows, "
        "knuckles and toes, subtle tan, painted skin texture")

WHO = {
    "male": "an athletic adult human man, fit heroic build, broad shoulders, defined but not bulky muscles, "
            "short cropped dark hair close to the scalp, clean shaven, wearing only small tight plain navy blue brief-cut swim briefs with high cut leg openings, "
            "upper thighs fully bare, bare chest, bare arms and bare legs, barefoot",
    "female": "an athletic adult human woman, fit heroic build, feminine curves, medium bust, wide hips, "
              "hair tied back in a tight bun close to the head, wearing only a simple small plain navy blue bikini, triangle top and bikini bottom, "
              "bare midriff, bare arms and bare legs, barefoot",
}
APOSE = ("standing in a symmetric A-pose, arms straight and angled 45 degrees out from the body with a wide gap between arms and torso, palms facing the thighs, "
         "fingers together and straight, thumb slightly apart, feet shoulder width apart pointing forward, legs straight, "
         "neutral relaxed face, eyes open looking forward, entire body visible from the top of the head to the soles of the feet")
VIEWS = {
    "front": "orthographic front view, facing the camera straight on",
    "side": "orthographic side view, full profile facing left, arms angled down beside the body",
}

# Delarna: beskärning ur helkroppen (andel av bildens höjd/bredd kring figurens mått) och en prompt för den isolerade delen.
# Ruta: (x0, y0, x1, y1) i andelar av figurens bbox; höger sida i bilden = figurens vänstra sida.
PARTS = {
    "head":     ((0.30, -0.02, 0.70, 0.17), "the head and neck of {who}, front view, head and neck only, cut off cleanly at the base of the neck"),
    "torso":    ((0.18, 0.11, 0.82, 0.55), "the torso of {who}, front view, torso only from the base of the neck to the crotch and hip joints, "
                                           "no head, no arms, arms cut off cleanly at the shoulders, no legs, cut off cleanly at the hip joints, like a classical marble torso sculpture"),
    "upperarm": ((0.66, 0.16, 0.96, 0.40), "a single upper arm of {who}, from the shoulder to the elbow, isolated, cut off cleanly at both ends, nothing else"),
    "forearm":  ((0.72, 0.33, 1.00, 0.55), "a single forearm of {who}, from the elbow to the wrist, isolated, cut off cleanly at both ends, nothing else"),
    "hand":     ((0.78, 0.46, 1.00, 0.62), "a single relaxed open right hand of {who}, palm facing the viewer, fingers together and straight, thumb slightly apart, "
                                           "cut off cleanly at the wrist, nothing else"),
    "leg":      ((0.48, 0.50, 0.78, 0.94), "a single leg of {who}, front view, from the hip joint to the ankle, thigh, knee and calf, isolated, "
                                           "cut off cleanly at the hip and at the ankle, no foot, nothing else"),
    "foot":     ((0.48, 0.88, 0.78, 1.01), "a single bare foot of {who}, three quarter view from the front and side, from the ankle down, "
                                           "toes together, cut off cleanly at the ankle, nothing else"),
}


def krea(prompt, w, h, out, seed, base=None, denoise=None, asset="body"):
    cmd = ["python3", "-I", str(GPUQ), "run", "--kind", "comfyui", "--asset", asset, "--stage", "krea", "--",
           "python3", "-I", str(KREA), prompt, str(w), str(h), str(out), str(seed)]
    if base:
        cmd += ["--base", str(base), "--denoise", str(denoise)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode:
        sys.exit(r.stderr[-800:])
    rec = {"file": str(Path(out).relative_to(HERE)), "seed": seed, "prompt": prompt, "base": str(base) if base else None, "denoise": denoise}
    with open(HERE / "images/refs.jsonl", "a") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    print(json.dumps(rec, ensure_ascii=False)[:200])


def body(sex, seeds, views=VIEWS, base=None, denoise=None):
    """base: bild till bild ur en tidigare förlaga (samma kropp och pose, ny klädsel)."""
    d = HERE / "images" / sex
    d.mkdir(parents=True, exist_ok=True)
    for seed in seeds:
        for view in views:
            p = f"{ART}, a single full body figure, only one person, reference for a 3D model, {VIEWS[view]}, {WHO[sex]}, {SKIN}, {APOSE}, {LIGHT}, {CUT}"
            tag = f"{seed}i" if base else f"{seed}"
            krea(p, 832, 1472, d / f"body_{view}_{tag}.png", seed, base=base, denoise=denoise, asset=f"body_{sex}")


def figure_bbox(img):
    """Figurens bbox i en bild på vit bakgrund (pixlar som inte är nästan vita)."""
    from PIL import Image, ImageChops
    im = Image.open(img).convert("RGB")
    diff = ImageChops.difference(im, Image.new("RGB", im.size, (255, 255, 255))).convert("L").point(lambda v: 255 if v > 24 else 0)
    return im, diff.getbbox()


def parts(sex, body_png, only=None, seed=7, denoise=0.62):
    from PIL import Image
    d = HERE / "images" / sex
    im, (bx0, by0, bx1, by1) = figure_bbox(body_png)
    bw, bh = bx1 - bx0, by1 - by0
    for name, ((x0, y0, x1, y1), ptxt) in PARTS.items():
        if only and name not in only:
            continue
        box = [bx0 + x0 * bw, by0 + y0 * bh, bx0 + x1 * bw, by0 + y1 * bh]
        # kvadratisk ruta kring delen, så att den fyller bilden
        cx, cy, s = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2, max(box[2] - box[0], box[3] - box[1])
        crop = Image.new("RGB", (int(s), int(s)), (255, 255, 255))
        crop.paste(im.crop((int(cx - s / 2), int(cy - s / 2), int(cx + s / 2), int(cy + s / 2))), (0, 0))
        crop = crop.resize((1024, 1024), Image.LANCZOS)
        base = d / f"crop_{name}.png"
        crop.save(base)
        p = f"{ART}, 3D model reference, {ptxt.format(who=WHO[sex])}, filling the frame, {LIGHT}, {CUT}"
        krea(p, 1024, 1024, d / f"part_{name}.png", seed, base=base, denoise=denoise, asset=f"{name}_{sex}")


if __name__ == "__main__":
    what, sex = sys.argv[1], sys.argv[2]
    if what == "body":
        # body <kön> [frö ...] [--front] [--base=förlaga.png --denoise=0.6]
        rest = sys.argv[3:]
        opt = dict(a[2:].split("=", 1) for a in rest if a.startswith("--") and "=" in a)
        body(sex, [int(s) for s in rest if not s.startswith("--")] or [101], views=["front"] if "--front" in rest else VIEWS,
             base=opt.get("base"), denoise=float(opt["denoise"]) if "denoise" in opt else None)
    else:
        rest = sys.argv[4:]
        parts(sex, sys.argv[3], only=[a for a in rest if not a.startswith("--")] or None,
              denoise=float(next((a.split("=")[1] for a in rest if a.startswith("--denoise=")), 0.62)))
