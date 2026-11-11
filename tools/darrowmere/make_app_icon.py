"""Appikonen för Darrowmere-panelen på hemskärmen: en ratt som i panelen (spår och båge) med ett D i mitten.
Skriver static/app-icon-{180,192,512}.png. Körs med Pillow:

  uv run -q --no-project --python 3.12 --with pillow python -I tools/darrowmere/make_app_icon.py [<letter> <slug>]
With a letter and slug (e.g. R ravenholdt) it writes static/app-icon-{size}-<slug>.png for that machine's panel.
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
BG, TRACK, TEXT = (15, 18, 21), (35, 42, 50), (215, 220, 226)
ARC = [(31, 181, 176), (79, 141, 255)]          # --teal → --blue
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf"


def icon(n=1024, letter="D"):
    im = Image.new("RGB", (n, n), BG)
    d = ImageDraw.Draw(im)
    pad, w = n * 0.17, n * 0.075
    box = [pad, pad, n - pad, n - pad]
    d.arc(box, 135, 405, fill=TRACK, width=round(w))      # hela spåret, 270° med öppningen nedåt
    steps = 120                                            # bågen till ~70 %, färgad från teal till blått
    for i in range(steps):
        t = i / steps
        a0, a1 = 135 + 270 * 0.7 * t, 135 + 270 * 0.7 * (t + 1 / steps) + 0.6
        col = tuple(round(ARC[0][k] + (ARC[1][k] - ARC[0][k]) * t) for k in range(3))
        d.arc(box, a0, a1, fill=col, width=round(w))
    f = ImageFont.truetype(FONT, round(n * 0.36))
    d.text((n / 2, n / 2 + n * 0.01), letter, font=f, fill=TEXT, anchor="mm")
    return im


if __name__ == "__main__":
    letter, slug = (sys.argv[1], sys.argv[2]) if len(sys.argv) > 2 else ("D", "")
    big = icon(letter=letter)
    for s in (180, 192, 512):
        big.resize((s, s), Image.LANCZOS).save(HERE / "static" / f"app-icon-{s}{'-' + slug if slug else ''}.png", optimize=True)
    print('{"ok": true, "icons": [180, 192, 512], "letter": "%s"}' % letter)
