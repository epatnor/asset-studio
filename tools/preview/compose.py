"""Bilder bredvid varandra i samma höjd, med en etikett under var och en (för jämförelser i Apparition).

  uv run --no-project --python 3.12 --with pillow==11.1.0 python -I tools/preview/compose.py \\
    '{"images": ["a.png", "b.png"], "labels": ["koncept", "3D"], "height": 576, "out": "build/x.png"}'

Svarar med en rad JSON: {"out": ..., "size": [w, h]}.
"""
import json
import sys

from PIL import Image, ImageDraw, ImageFont


def main():
    r = json.loads(sys.argv[1])
    h = int(r.get("height", 576))
    labels = r.get("labels", [])
    pad = 34 if labels else 0
    tiles = []
    for p in r["images"]:
        im = Image.open(p).convert("RGB")
        tiles.append(im.resize((round(im.width * h / im.height), h), Image.LANCZOS))
    out = Image.new("RGB", (sum(t.width for t in tiles), h + pad), (24, 24, 28))
    draw = ImageDraw.Draw(out)
    # DejaVu har å, ä och ö; standardtypsnittet saknar dem
    try:
        font = ImageFont.truetype("DejaVuSans.ttf", 20)
    except OSError:
        font = ImageFont.load_default(size=20)
    x = 0
    for i, t in enumerate(tiles):
        out.paste(t, (x, 0))
        if i < len(labels):
            draw.text((x + 10, h + 6), labels[i], fill=(230, 230, 230), font=font)
        x += t.width
    out.save(r["out"])
    print(json.dumps({"out": r["out"], "size": list(out.size)}))


if __name__ == "__main__":
    main()
