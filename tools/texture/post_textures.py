"""Efterbehandling av genererade texturer.

  tile   <in.png> <out.png>   gör en textur sömlös (för bark, mark, sten ...)
  cutout <in.png> <out.png>   ger en sprite på vit bakgrund alfakanal och beskär
                              så att foten/stjälken hamnar i nederkant (UV v=0)
  matte  <in.png> <out.png> [maxbredd]   alfakanal ur vit bakgrund, tätt beskuren men med bildens proportioner
                              (flaggor, skyltar, tyger: fransar och slitna kanter blir genomskinliga)
  atlas  <out.png> <a> <b> <c> <d>   packar fyra sprites till en 2x2-atlas
  gray   <in.png> <out.png>   gråskala för tintning (färgen sätts i materialet)
  soften <in.png> <out.png> [mängd]   lägre kontrast: fåror och skåror mjukare, stora former kvar (sömlös)
  thumbs <utmapp> <px> <in.png> ...    små förhandsbilder (JPEG) för studion; alfa läggs på mörk bakgrund

Kör med: uv run --no-project --python 3.12 --with pillow==11.1.0 --with numpy==2.2.3 python -I post_textures.py ...
"""
import json
import sys

import numpy as np
from PIL import Image, ImageFilter


def tile(src, dst):
    # Blanda med en halvt förskjuten kopia så att kanterna möts vid upprepning
    a = np.asarray(Image.open(src).convert("RGB")).astype(np.float32)
    h, w, _ = a.shape
    s = np.roll(a, (h // 2, w // 2), axis=(0, 1))
    yy, xx = np.mgrid[0:h, 0:w]
    edge = np.minimum.reduce([xx, w - 1 - xx, yy, h - 1 - yy]) / (min(h, w) / 2)
    wgt = np.clip(edge * 2.5, 0, 1)[..., None] ** 1.5
    Image.fromarray((a * wgt + s * (1 - wgt)).astype(np.uint8)).save(dst)
    return {"out": dst, "size": [w, h]}


def white_alpha(src):
    # Alfa från avstånd till vit bakgrund
    img = np.asarray(Image.open(src).convert("RGB")).astype(np.float32)
    dist = np.linalg.norm(255 - img, axis=2)
    # Kantpixlar är blandade med det vita: färg = a*C + (1-a)*vitt. Skatta a mot den rena
    # förgrundsfärgen i närheten (lokalt max av avståndet till vitt), inte mot ett fast tröskelvärde;
    # en mörk lövfärg ligger annars "långt från vitt" även när den är 30 % vit.
    d8 = Image.fromarray(np.clip(dist / 441 * 255, 0, 255).astype(np.uint8))
    local = np.asarray(d8.filter(ImageFilter.MaxFilter(9))).astype(np.float32) / 255 * 441
    alpha = np.clip(dist / np.maximum(local, 40), 0, 1)
    alpha[dist < 18] = 0
    alpha = np.clip((alpha - 0.15) / 0.85, 0, 1)
    # Räkna bort det vita, och krymp kanten en pixel så att restfransen försvinner
    a = np.maximum(alpha, 1e-3)[..., None]
    img = np.clip((img - (1 - a) * 255) / a, 0, 255)
    alpha = np.minimum(alpha, np.asarray(Image.fromarray((alpha * 255).astype(np.uint8)).filter(ImageFilter.MinFilter(3))) / 255)
    return img, alpha


def matte(src, dst, max_w=1024, margin=0.015):
    # Som cutout, men beskuren tätt runt motivet med dess egna proportioner (ingen kvadrat, ingen fot nedtill)
    img, alpha = white_alpha(src)
    ys, xs = np.nonzero(alpha > 0.5)
    h, w = alpha.shape
    mx, my = int((xs.max() - xs.min()) * margin), int((ys.max() - ys.min()) * margin)
    x0, x1 = max(0, xs.min() - mx), min(w, xs.max() + mx + 1)
    y0, y1 = max(0, ys.min() - my), min(h, ys.max() + my + 1)
    # Hål inne i motivet (ljusa fläckar som skattats som bakgrund) fylls: allt som inte hänger ihop med bakgrunden
    # utanför blir helt täckt, så att bara kanter och fransar får alfa
    from PIL import ImageDraw
    outside = Image.fromarray(np.pad((alpha < 0.5).astype(np.uint8) * 255, 1, constant_values=255)).copy()  # floodfill kräver en egen buffert
    ImageDraw.floodfill(outside, (0, 0), 128)
    inside = np.asarray(outside)[1:-1, 1:-1] != 128
    alpha = np.where(inside, 1.0, alpha)
    rgba = np.dstack([img, alpha * 255]).astype(np.uint8)[y0:y1, x0:x1]
    out = Image.fromarray(rgba, "RGBA")
    max_w = int(max_w)
    if out.width > max_w:
        out = out.resize((max_w, round(out.height * max_w / out.width)), Image.LANCZOS)
    out.save(dst)
    return {"out": dst, "size": list(out.size), "coverage": round(float((alpha[y0:y1, x0:x1] > 0.5).mean()), 3)}


def cutout(src, dst, size=512, margin=1.12):
    img, alpha = white_alpha(src)
    ys, xs = np.nonzero(alpha > 0.5)
    cx = (xs.min() + xs.max()) // 2
    side = int(max(xs.max() - xs.min(), ys.max() - ys.min()) * margin)
    # Kvadrat med marginal runt klustret; stjälken nära nederkanten. Fyll utanför bilden med genomskinligt.
    pad = side
    full = np.dstack([img, alpha * 255]).astype(np.uint8)
    full = np.pad(full, ((pad, pad), (pad, pad), (0, 0)))
    x0 = cx - side // 2 + pad
    y0 = ys.max() + int(side * 0.03) - side + pad
    rgba = full[y0:y0 + side, x0:x0 + side]
    Image.fromarray(rgba, "RGBA").resize((size, size), Image.LANCZOS).save(dst)
    return {"out": dst, "size": [size, size]}


def atlas(dst, *cells, size=1024):
    # 2x2-atlas av fyra sprites med alfa: cell 0 uppe till vänster, 1 uppe till höger, 2 och 3 nedre raden
    # (glTF har v=0 överst i bilden; canopy.mjs räknar med samma ordning)
    half = size // 2
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    for i, src in enumerate(cells[:4]):
        im = Image.open(src).convert("RGBA").resize((half, half), Image.LANCZOS)
        out.paste(im, ((i % 2) * half, (i // 2) * half))
    # Fyll genomskinliga pixlar med närliggande färg, så att mipmaps inte får mörka kanter
    rgb = out.convert("RGB").filter(ImageFilter.MaxFilter(9))
    a = out.getchannel("A")
    filled = Image.composite(out.convert("RGB"), rgb, a)
    filled.putalpha(a)
    filled.save(dst)
    return {"out": dst, "size": [size, size], "cells": len(cells[:4])}


def gray(src, dst, target_mean=0.82):
    # Gråskaleversion för tintning i materialet (som Material Instances): ljushetsdetaljen behålls,
    # färgen kommer från baseColorFactor. Normaliseras så att synliga pixlar har medelljushet ~0.82,
    # så att tintfärgen blir ungefär den färg man ber om.
    im = Image.open(src).convert("RGBA")
    a = np.asarray(im).astype(np.float32) / 255
    lum = a[..., :3] @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    vis = a[..., 3] > 0.45
    scale = target_mean / max(float(lum[vis].mean()) if vis.any() else 1.0, 1e-3)
    g = np.clip(lum * scale, 0, 1)
    out = np.dstack([g, g, g, a[..., 3]])
    Image.fromarray((out * 255).astype(np.uint8), "RGBA").save(dst)
    return {"out": dst, "scale": round(scale, 3)}



def soften(src, dst, amount=1.0):
    # Mjukare målning: skillnaden mot ett lokalt medel (fåror, skåror, högdagrar) dras ner, och hela bilden
    # dras lite mot sitt medelvärde. Oskärpan görs på en kantupprepad kopia så att texturen förblir sömlös.
    amount = float(amount)
    im = Image.open(src).convert("RGB")
    a = np.asarray(im).astype(np.float32)
    h, w, _ = a.shape
    pad = max(8, w // 40)
    big = np.pad(a, ((pad, pad), (pad, pad), (0, 0)), mode="wrap")
    blur = np.asarray(Image.fromarray(big.astype(np.uint8)).filter(ImageFilter.GaussianBlur(pad / 2))).astype(np.float32)[pad:-pad, pad:-pad]
    local = blur + (a - blur) * (1 - 0.45 * amount)
    mean = local.reshape(-1, 3).mean(0)
    out = mean + (local - mean) * (1 - 0.2 * amount)
    Image.fromarray(np.clip(out, 0, 255).astype(np.uint8)).save(dst)
    return {"out": dst, "amount": amount, "std_before": round(float(a.std()), 1), "std_after": round(float(out.std()), 1)}


def thumbs(outdir, size, *srcs):
    size = int(size)
    made = []
    for src in srcs:
        im = Image.open(src).convert("RGBA")
        im.thumbnail((size, size), Image.LANCZOS)
        bg = Image.new("RGBA", im.size, (58, 62, 70, 255))
        bg.alpha_composite(im)
        dst = f"{outdir}/{src.rsplit('/', 1)[-1].rsplit('.', 1)[0]}_{size}.jpg"
        bg.convert("RGB").save(dst, quality=85)
        made.append(dst)
    return {"made": len(made)}

if __name__ == "__main__":
    cmd, *args = sys.argv[1:]
    if cmd == "atlas":
        print(json.dumps(atlas(args[0], *args[1:])))
    elif cmd == "soften":
        print(json.dumps(soften(*args)))
    elif cmd == "matte":
        print(json.dumps(matte(*args)))
    elif cmd == "thumbs":
        print(json.dumps(thumbs(*args)))
    else:
        print(json.dumps({"tile": tile, "cutout": cutout, "gray": gray}[cmd](args[0], args[1])))
