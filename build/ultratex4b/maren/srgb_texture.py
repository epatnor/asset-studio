"""Försök (2026-11-09): bas-VAE:ns dekoder ger linjära färger. Gör om bastexturen i en GLB till sRGB (eller en mildare
kurva, gamma) och skriv en ny GLB (originalet rörs inte). python3 srgb_texture.py in.glb out.glb [gamma]"""
import io, json, struct, sys
import numpy as np
from PIL import Image

src, dst = sys.argv[1], sys.argv[2]
GAMMA = float(sys.argv[3]) if len(sys.argv) > 3 else 0   # 0 = full sRGB-kurva, annars a ** (1 / GAMMA)
b = open(src, "rb").read()
n = struct.unpack("<I", b[12:16])[0]
j = json.loads(b[20:20 + n])
bin_start = 20 + n + 8
blob = b[bin_start:bin_start + struct.unpack("<I", b[20 + n:24 + n])[0]]
mat = j["materials"][0]["pbrMetallicRoughness"]
img_idx = j["textures"][mat["baseColorTexture"]["index"]]["source"]
views = [blob[v.get("byteOffset", 0):v.get("byteOffset", 0) + v["byteLength"]] for v in j["bufferViews"]]
bv = j["images"][img_idx]["bufferView"]
a = np.asarray(Image.open(io.BytesIO(views[bv])).convert("RGB"), np.float32) / 255
a = np.power(a, 1 / GAMMA) if GAMMA else np.where(a <= 0.0031308, 12.92 * a, 1.055 * np.power(a, 1 / 2.4) - 0.055)
buf = io.BytesIO(); Image.fromarray((np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8)).save(buf, "PNG"); views[bv] = buf.getvalue()
j["images"][img_idx]["mimeType"] = "image/png"
out, off = bytearray(), 0
for i, v in enumerate(views):
    j["bufferViews"][i]["byteOffset"] = len(out); j["bufferViews"][i]["byteLength"] = len(v)
    out += v; out += b"\0" * (-len(out) % 4)
j["buffers"][0]["byteLength"] = len(out)
js = json.dumps(j, separators=(",", ":")).encode(); js += b" " * (-len(js) % 4)
glb = struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(out)) + struct.pack("<II", len(js), 0x4E4F534A) + js + struct.pack("<II", len(out), 0x004E4942) + out
open(dst, "wb").write(glb)
print(json.dumps({"ok": True, "out": dst, "mb": round(len(glb) / 1e6, 1)}))
