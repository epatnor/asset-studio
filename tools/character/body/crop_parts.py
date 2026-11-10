"""Delbilder ur helkroppens förlaga, isolerade med AI-kroppens egna delar.

  .venv/bin/python -I tools/crop_parts.py <male|female> <body_front.png> <body.glb> <height> [del ...] [--denoise 0.45]

AI-kroppen (Pixal3D, uppräthet) delas efter skelettet som i fit.py. Delens trianglar projiceras på framvyn (bildens
figur och modellens bbox i x och y motsvarar varandra) och blir en mask; allt utanför masken blir vitt, rutan
beskärs kvadratiskt kring delen och skalas till 1024. Krea målar sedan om den (bild till bild) så att snittkanterna
blir rena och detaljerna fler. Vänster sida av figuren (bildens högra halva) används för armar och ben.
Skriver images/<kön>/crop_<del>.png (masken) och part_<del>.png (Kreas bild)."""
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fit  # noqa: E402  (passningen build/fit/<kön>.npz måste finnas; den etiketterar AI-kroppen)
import gen_refs  # noqa: E402

ROOT = Path(__file__).resolve().parents[3]   # asset-studio
HERE = ROOT / "build/body"                    # body-gens arbetsyta: build/, out/, images/ (flyttad 2026-11-10)
TOOLS = Path(__file__).resolve().parent
SPEL = ROOT.parents[1]                        # ~/Spelutveckling (img2mesh, lowpoly-test)
LABELS = {"head": ["head"], "torso": ["torso"], "upperarm": ["upperarm_L"], "forearm": ["forearm_L"],
          "hand": ["hand_L"], "leg": ["leg_L"], "foot": ["foot_L"]}
TEXT = {k: v[1] for k, v in gen_refs.PARTS.items()}


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    denoise = float(sys.argv[sys.argv.index("--denoise") + 1]) if "--denoise" in sys.argv else 0.45
    if "--denoise" in sys.argv:
        args.remove(sys.argv[sys.argv.index("--denoise") + 1])
    sex, img, glb, height = args[0], args[1], args[2], float(args[3])
    only = args[4:] or list(LABELS)
    m = fit.load_target(glb, height)
    lab = fit.label_from_fit(m, np.load(HERE / f"build/fit/{sex}.npz")["X6"])
    im, (bx0, by0, bx1, by1) = gen_refs.figure_bbox(img)
    pad = 600   # vit marginal runt bilden, så att rutor som går utanför blir vita
    big = Image.new("RGB", (im.width + 2 * pad, im.height + 2 * pad), (255, 255, 255))
    big.paste(im, (pad, pad))
    im, bx0, by0, bx1, by1 = big, bx0 + pad, by0 + pad, bx1 + pad, by1 + pad
    V = np.asarray(m.vertices)
    (xmin, ymin, _), (xmax, ymax, _) = m.bounds
    # framvy: modellens +X (figurens vänster) är bildens högra sida
    px = bx0 + (V[:, 0] - xmin) / (xmax - xmin) * (bx1 - bx0)
    py = by1 - (V[:, 1] - ymin) / (ymax - ymin) * (by1 - by0)
    F = np.asarray(m.faces)
    front = m.face_normals[:, 2] > -0.2
    d = HERE / "images" / sex
    for part in only:
        sel = np.isin(lab, LABELS[part]) & front
        mask = Image.new("L", im.size, 0)
        dr = ImageDraw.Draw(mask)
        for f in F[sel]:
            dr.polygon([(px[i], py[i]) for i in f], fill=255)
        mask = mask.filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.GaussianBlur(1.5))
        x0, y0, x1, y1 = mask.getbbox()
        s = int(max(x1 - x0, y1 - y0) * 1.15)
        cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
        cut = Image.composite(im, Image.new("RGB", im.size, (255, 255, 255)), mask)
        box = (cx - s // 2, cy - s // 2, cx - s // 2 + s, cy - s // 2 + s)
        crop = Image.new("RGB", (s, s), (255, 255, 255))
        crop.paste(cut.crop(box), (0, 0))
        crop = crop.resize((1024, 1024), Image.LANCZOS)
        base = d / f"crop_{part}.png"
        crop.save(base)
        p = f"{gen_refs.ART}, 3D model reference, {TEXT[part].format(who=gen_refs.WHO[sex])}, filling the frame, {gen_refs.LIGHT}, {gen_refs.CUT}"
        gen_refs.krea(p, 1024, 1024, d / f"part_{part}.png", 7, base=base, denoise=denoise, asset=f"{part}_{sex}")


if __name__ == "__main__":
    main()
