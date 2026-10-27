"""Referensanalys (patriks_input/AAA_Reference_Guided_Procedural_Textures_Tiling_ThreeJS_Reference.md, avsnitt 3):
mäter en referens och vårt material på samma sätt, i fysiska enheter, så att receptet kan styras mot referensen
utan att bilden kopieras. Referensen är ett mätmål, inte den färdiga texturen.

  python3 -I tools/texture/reference_analysis.py '{"ref": "jolcham_oak_bark_01", "ours": "bark_oak_stylized"}'
  python3 -I tools/texture/reference_analysis.py '{"all": true}'     alla par i material-references/wanted.json
  python3 -I tools/texture/reference_analysis.py '{"all": true, "sheet": "build/refs/sheet.png"}'   + jämförelseark

Mått (samma för referens och vårt material):
  palette      5 färger i OKLab (k-means) efter att storskaligt ljus räknats bort (albedo, inte foto-ljus)
  mean, value  medelfärg och ljushetens 5–95-percentil
  orient       strukturens huvudriktning ur höjdens strukturtensor: angle (0 = längs y, stammen) och coherence (0 rund,
               1 helt riktad)
  spacing_m    typiskt avstånd mellan åsar/stenar längs x och längs y, ur höjdens spektrum, i meter
  relief       höjdens spridning (standardavvikelse, 0–1) och andel djupa fåror
  micro        andel högfrekvent energi i färgen (fint brus; stiliserat = lågt)
Svarar med en rad JSON per anrop: {pairs: [{ref, ours, ref_metrics, ours_metrics, suggest}]}.
"""
import json
import os
import sys
from pathlib import Path

try:
    import numpy as np
    from PIL import Image
except ImportError:  # kör om sig själv med paketen via uv (fungerar i containern och på värden)
    os.execvp("uv", ["uv", "run", "--quiet", "--no-project", "--python", "3.12", "--with", "pillow==11.1.0",
                     "--with", "numpy==2.2.3", "python", "-I", __file__, *sys.argv[1:]])

ROOT = Path(__file__).resolve().parents[2]
REF = ROOT / "material-references"
TEX = ROOT / "assets" / "textures"
N = 512  # analysstorlek


def load(p, gray=False):
    im = Image.open(p)
    if gray:
        # Höjdkartor kan vara 16 bitar (Poly Haven): som flyttal, normerat till 0–1
        a = np.asarray(im.convert("F").resize((N, N), Image.BILINEAR), np.float32)
        return (a - a.min()) / max(a.max() - a.min(), 1e-6)
    return np.asarray(im.convert("RGB").resize((N, N), Image.LANCZOS), np.float32) / 255


def srgb_to_lin(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def lin_to_srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)


def to_oklab(rgb):
    l = srgb_to_lin(rgb)
    M1 = np.array([[0.4122214708, 0.5363325363, 0.0514459929], [0.2119034982, 0.6806995451, 0.1073969566],
                   [0.0883024619, 0.2817188376, 0.6299787005]], np.float32)
    M2 = np.array([[0.2104542553, 0.7936177850, -0.0040720468], [1.9779984951, -2.4285922050, 0.4505937099],
                   [0.0259040371, 0.7827717662, -0.8086757660]], np.float32)
    return np.cbrt(l @ M1.T) @ M2.T


def from_oklab(lab):
    M2i = np.linalg.inv(np.array([[0.2104542553, 0.7936177850, -0.0040720468], [1.9779984951, -2.4285922050, 0.4505937099],
                                  [0.0259040371, 0.7827717662, -0.8086757660]], np.float32))
    M1i = np.linalg.inv(np.array([[0.4122214708, 0.5363325363, 0.0514459929], [0.2119034982, 0.6806995451, 0.1073969566],
                                  [0.0883024619, 0.2817188376, 0.6299787005]], np.float32))
    return lin_to_srgb((lab @ M2i.T) ** 3 @ M1i.T)


def blur(a, sigma):
    # Periodisk gaussisk oskärpa i frekvensrummet (texturerna upprepas)
    f = np.fft.fftfreq(a.shape[0])
    fx, fy = np.meshgrid(f, f)
    g = np.exp(-2 * (np.pi * sigma) ** 2 * (fx ** 2 + fy ** 2))
    if a.ndim == 3:
        return np.stack([np.real(np.fft.ifft2(np.fft.fft2(a[..., c]) * g)) for c in range(a.shape[2])], -1)
    return np.real(np.fft.ifft2(np.fft.fft2(a) * g))


def hexc(rgb):
    return "#" + "".join(f"{int(round(max(0, min(1, x)) * 255)):02X}" for x in rgb)


def kmeans(lab, k=5, iters=15):
    s = lab.reshape(-1, 3)[::7]
    order = np.argsort(s[:, 0])
    c = s[order[((np.arange(k) + 0.5) / k * len(order)).astype(int)]].copy()
    for _ in range(iters):
        near = ((s[:, None, :] - c[None]) ** 2).sum(-1).argmin(1)
        for j in range(k):
            if (near == j).any():
                c[j] = s[near == j].mean(0)
    share = np.bincount(near, minlength=k) / len(near)
    o = np.argsort(c[:, 0])
    return c[o], share[o]


def spacing(h, meters):
    # Dominerande våglängd längs x (variationen längs en rad) och längs y, ur medelspektrum per axel. Tyngdpunkten i
    # spektrumet (viktad med effekt) är stabilare än en enskild topp. Detaljer under ~0,4 cm jämnas ut först, så att
    # fibrer och porer inte räknas som fåror
    h = blur(h, max(0.5, N * 0.004 / max(meters, 1e-3)))
    h = h - h.mean()
    out = []
    for prof in ((np.abs(np.fft.rfft(h, axis=1)) ** 2).mean(0), (np.abs(np.fft.rfft(h, axis=0)) ** 2).mean(1)):
        lo, hi = 2, len(prof) // 4
        k, w = np.arange(lo, hi), prof[lo:hi]
        kc = (k * w).sum() / max(w.sum(), 1e-9)
        out.append(round(meters / max(kc, 1e-6), 3))
    return out  # [längs x, längs y] i meter


def analyse(color_path, height_path, meters):
    rgb = load(color_path)
    lab = to_oklab(rgb)
    # Bort med storskaligt ljus: ljusheten delas med sin egen oskärpa (stor radie), färgen behålls
    L = lab[..., 0]
    light = blur(L, N / 6)
    lab_d = lab.copy()
    lab_d[..., 0] = np.clip(L / np.maximum(light, 1e-3) * L.mean(), 0, 1)
    pal, share = kmeans(lab_d)
    lum = lab_d[..., 0]
    if height_path and Path(height_path).exists():
        h = load(height_path, gray=True)
    else:
        h = blur(L, 1.5)  # utan höjdkarta: ljusheten som ersättning (märks i svaret)
    h = (h - h.min()) / max(h.max() - h.min(), 1e-6)
    gy, gx = np.gradient(blur(h, 2))
    jxx, jyy, jxy = blur(gx * gx, 6).mean(), blur(gy * gy, 6).mean(), blur(gx * gy, 6).mean()
    tr, det = jxx + jyy, jxx * jyy - jxy ** 2
    l1 = tr / 2 + np.sqrt(max(tr * tr / 4 - det, 0))
    l2 = tr / 2 - np.sqrt(max(tr * tr / 4 - det, 0))
    coh = float((l1 - l2) / max(l1 + l2, 1e-9))
    # Gradientens huvudriktning; strukturen (fårorna) går vinkelrätt mot den. 0° = strukturen längs y
    ang = 0.5 * np.degrees(np.arctan2(2 * jxy, jxx - jyy))
    hf = L - blur(L, 2)
    return {
        "palette": [hexc(c) for c in from_oklab(pal)],
        "palette_share": [round(float(s), 3) for s in share],
        "mean": hexc(from_oklab(lab_d.reshape(-1, 3).mean(0))),
        "value": [round(float(np.percentile(lum, 5)), 3), round(float(np.percentile(lum, 95)), 3)],
        "chroma": round(float(np.hypot(lab_d[..., 1], lab_d[..., 2]).mean()), 4),
        "orient": {"angle": round(float(ang), 1), "coherence": round(coh, 3)},
        "spacing_m": spacing(h, meters),
        "relief": {"std": round(float(h.std()), 3), "furrows": round(float((h < np.percentile(h, 50) - 1.2 * h.std()).mean()), 3)},
        "micro": round(float((hf ** 2).mean() / max(((L - L.mean()) ** 2).mean(), 1e-9)), 4),
        "height_from": "height map" if height_path and Path(height_path).exists() else "luminance",
    }


def ours_paths(name):
    # Ett sparat material (assets/textures) eller ett färdigt recept i verkstaden (renderas till build/refs/)
    cat = json.loads((TEX / "catalog.json").read_text())
    row = next((r for r in cat["textures"] if r["name"] == name), None)
    if row:
        h = TEX / f"{name}_height.png"
        return TEX / f"{name}.png", h if h.exists() else None, row.get("meters", 2.0)
    preset = json.loads((ROOT / "tools/texture/workshop.json").read_text())["presets"].get(name)
    if not preset:
        return None, None, 2.0
    import subprocess
    out = ROOT / "build" / "refs" / name
    out.parent.mkdir(parents=True, exist_ok=True)
    recipe = {**preset["recipe"], "size": 512, "out": str(out.relative_to(ROOT))}
    subprocess.run([sys.executable, "-I", str(ROOT / "tools/texture/workshop.py"), json.dumps(recipe)], capture_output=True, cwd=ROOT)
    meters = (preset["recipe"].get("material") or {}).get("meters", 2.0)
    h = Path(f"{out}_height.png")
    return Path(f"{out}_color.png"), h if h.exists() else None, meters


def suggest(ref, ours, ref_m, ours_m, ours_meters):
    # Förslag i receptets termer: färgerna ur referensens palett, åsarnas antal ur avståndet
    s = {"dark": ref["palette"][0], "light": ref["palette"][3], "accent": ref["palette"][4]}
    sx = ref["spacing_m"][0]
    if sx:
        s["ridges_for_tile"] = max(2, round(ours_meters / sx))
    s["value_ref_vs_ours"] = [ref["value"], ours["value"]]
    s["coherence_ref_vs_ours"] = [ref["orient"]["coherence"], ours["orient"]["coherence"]]
    s["spacing_ref_vs_ours_m"] = [ref["spacing_m"], ours["spacing_m"]]
    s["micro_ref_vs_ours"] = [ref["micro"], ours["micro"]]
    return s


def sheet(pairs, out):
    s = 220
    W = Image.new("RGB", (len(pairs) * s, 2 * s + 36), (30, 30, 30))
    from PIL import ImageDraw
    d = ImageDraw.Draw(W)
    for i, p in enumerate(pairs):
        ref_m = json.loads((REF / "manifests" / f"{p['ref']}.json").read_text())
        a = Image.open(ROOT / ref_m["maps"]["color"]["file"]).convert("RGB")
        c, _, meters = ours_paths(p["ours"])
        # Samma fysiska yta: 1 m × 1 m ur båda
        def crop(im, m):
            k = min(1.0, 1.0 / m)
            w = int(im.width * k)
            return im.crop((0, 0, w, w)).resize((s, s), Image.LANCZOS)
        W.paste(crop(a, ref_m["physicalWidthMeters"] or 1), (i * s, 0))
        if c:
            W.paste(crop(Image.open(c).convert("RGB"), meters), (i * s, s))
        d.text((i * s + 4, 2 * s + 4), p["ref"][:26], fill=(220, 220, 220))
        d.text((i * s + 4, 2 * s + 18), p["ours"][:26], fill=(160, 200, 160))
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    W.save(out)


def main():
    req = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {"all": True}
    wanted = json.loads((REF / "wanted.json").read_text())
    pairs = [{"ref": r, "ours": o} for r, o in wanted["for"].items()] if req.get("all") else [{"ref": req["ref"], "ours": req["ours"]}]
    out = []
    for p in pairs:
        m = json.loads((REF / "manifests" / f"{p['ref']}.json").read_text())
        ref = analyse(ROOT / m["maps"]["color"]["file"], ROOT / m["maps"]["height"]["file"] if "height" in m["maps"] else None,
                      m["physicalWidthMeters"] or 1.0)
        row = {"ref": p["ref"], "ours": p["ours"], "ref_metrics": ref}
        c, h, meters = ours_paths(p["ours"])
        if c and c.exists():
            ours = analyse(c, h, meters)
            row["ours_metrics"] = ours
            row["suggest"] = suggest(ref, ours, m["physicalWidthMeters"], meters, meters)
        out.append(row)
    if req.get("sheet"):
        sheet(pairs, ROOT / req["sheet"])
    if req.get("save"):
        (REF / "analysis.json").write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n")
    print(json.dumps({"pairs": out}))


if __name__ == "__main__":
    main()
