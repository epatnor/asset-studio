"""Ark: Noras referenser bredvid figuren, kropp i färg och lera, ansikte i färg och lera. Argument: mapp med bilder, ut.png."""
import sys
from PIL import Image
P, OUT = sys.argv[1].rstrip("/") + "/", sys.argv[2]
N = "/home/epatnor/Spelutveckling/img2mesh/input/nora/"
C = N + "ChatGPT-bild 2 nov. 2026 16_1"
W = 200
s = Image.new("RGB", (W * 6, 320 * 2), (235, 235, 235))
for i, c in enumerate([N + "vanster.png", P + "body_90.png", P + "claybody_90.png", N + "bak.png", P + "body_180.png", P + "claybody_180.png"]):
    im = Image.open(c).convert("RGB")
    im.thumbnail((W, 320))
    s.paste(im, (W * i + (W - im.width) // 2, 0))
for i, c in enumerate([C + "3_59.png", P + "face_0.png", P + "clayface_0.png", C + "4_12.png", P + "face_90.png", P + "clayface_90.png"]):
    im = Image.open(c).convert("RGB")
    im.thumbnail((W, 320))
    s.paste(im, (W * i + (W - im.width) // 2, 320))
s.save(OUT)
