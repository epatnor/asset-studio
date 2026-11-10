"""Läser av ett huvud ur en framvy och en sidovy: konturerna och var formerna sitter. Bara bildanalys, ingen modell.

  ../lowpoly-test/.venv/bin/python tools/head_measure.py <framvy.png> <sidovy.png> [ut.png]

Sidovyn ska ha ansiktet mot bildens vänstra kant, och båda ska ha samma skala och höjd. Skriver en rad JSON,
och med ut.png en bild med mätpunkterna inritade. Används av tools/head_builder.py."""
import json
import sys

import numpy as np
from PIL import Image, ImageDraw
from scipy.ndimage import gaussian_filter1d, label


def read(path):
    pixels = np.asarray(Image.open(path).convert("RGB")).astype(float)
    background = np.median(pixels[:20, :20].reshape(-1, 3), axis=0)
    mask = np.abs(pixels - background).max(axis=2) > 22
    return pixels, mask


def edges(mask):
    rows = np.where(mask.any(axis=1))[0]
    left = np.full(mask.shape[0], np.nan)
    right = np.full(mask.shape[0], np.nan)
    for row in rows:
        columns = np.where(mask[row])[0]
        left[row], right[row] = columns[0], columns[-1]
    return rows, left, right


def next_extreme(values, start, stop, want_max, tolerance=0.4):
    """Första toppen eller dalen från start mot stop. Faller tillbaka på det största värdet i intervallet."""
    step = 1 if stop > start else -1
    previous = values[start]
    for row in range(start + step, stop, step):
        if (want_max and values[row] < previous - tolerance) or (not want_max and values[row] > previous + tolerance):
            return row - step
        previous = values[row]
    part = np.arange(min(start, stop), max(start, stop))
    return int(part[np.argmax(values[part])] if want_max else part[np.argmin(values[part])])


def mouth_limit(face_center, half_width):
    return int(face_center + half_width * 0.6)


def measure(front_path, side_path):
    front, front_mask = read(front_path)
    side, side_mask = read(side_path)
    rows, _, _ = edges(front_mask)
    side_rows, side_left, side_right = edges(side_mask)
    _, front_left, front_right = edges(front_mask)
    center = np.nanmedian((front_left + front_right)[rows[len(rows) // 3:len(rows) * 2 // 3]] / 2)

    # Ansiktets profil: bildens vänstra kant i sidovyn, utjämnad så att bara formerna blir kvar.
    filled = np.where(np.isnan(side_left), np.nanmax(side_left), side_left)
    profile = gaussian_filter1d(filled, 2.0)

    # Hakans undersida: där profilen hoppar in mot halsen.
    low_rows = np.arange(rows[0] + (rows[-1] - rows[0]) // 2, rows[-1] - 1)
    jump = low_rows[np.argmax(np.diff(filled[low_rows]))]
    under_chin = int(jump)

    # Näsans spets är det som sticker ut mest i ansiktets nedre halva, ovanför hakan.
    top = int(side_rows[0])
    span = under_chin - top
    tip = int(top + span * 0.55 + np.argmin(profile[int(top + span * 0.55):int(top + span * 0.9)]))
    nasion = next_extreme(profile, tip, tip - int(span * 0.25), True)
    brow = next_extreme(profile, nasion, nasion - int(span * 0.15), False)
    subnasale = next_extreme(profile, tip, tip + int(span * 0.14), True)
    upper_lip = next_extreme(profile, subnasale, subnasale + int(span * 0.08), False)
    mouth = next_extreme(profile, upper_lip, upper_lip + int(span * 0.06), True)
    lower_lip = next_extreme(profile, mouth, mouth + int(span * 0.06), False)
    sulcus = next_extreme(profile, lower_lip, lower_lip + int(span * 0.07), True)
    chin = int(sulcus + np.argmin(profile[sulcus:under_chin]))

    # Hud och hår i framvyn. Hårfästet är där huden börjar längs mittlinjen.
    red, green, blue = front[..., 0], front[..., 1], front[..., 2]
    skin = (red > 170) & (red - green > 35) & (green > 95)
    middle = int(center)
    skin_rows = np.where(skin[:, middle - 3:middle + 4].mean(axis=1) > 0.6)[0]
    hairline = int(skin_rows[skin_rows < brow][0]) if (skin_rows < brow).any() else int(brow - span * 0.1)

    # Ögon och bryn: mörka fläckar i högra bildhalvan, mellan hårfästet och näsans spets.
    half_width = np.nanmedian((front_right - front_left)[brow:tip]) / 2
    brightness = red + green + blue

    # Ögonen: mörkast i varsin bildhalva, mellan näsroten och näsans spets. Deras mitt är ansiktets mittlinje.
    def eye_on(sign):
        low, high = sorted((center + sign * half_width * 0.12, center + sign * half_width * 0.72))
        band = np.zeros_like(brightness, bool)
        band[nasion - 4:nasion + int((tip - nasion) * 0.55), int(low):int(high)] = True
        dark = (brightness < 240) & band
        labels, count = label(dark)
        best = None
        for index in range(1, count + 1):
            ys, xs = np.where(labels == index)
            if best is None or len(ys) > best[0]:
                best = (len(ys), float(ys.mean()), float(xs.mean()), int(xs.min()), int(xs.max()), int(ys.min()), int(ys.max()))
        return best
    left_eye, right_eye = eye_on(-1), eye_on(1)
    face_center = (left_eye[2] + right_eye[2]) / 2
    eye_x = (right_eye[2] - left_eye[2]) / 2
    eye_y = (left_eye[1] + right_eye[1]) / 2
    eye_half = (right_eye[4] - right_eye[3]) / 2

    # Brynen: nästa mörka band ovanför ögat.
    brow_band = brightness[hairline + 4:int(eye_y) - 8, int(face_center + eye_x - eye_half):int(face_center + eye_x + eye_half)].mean(axis=1)
    brow_row = int(hairline + 4 + np.argmin(brow_band))

    # Munnen ur framvyn: läpparna är rödast längs mittlinjen, och munnens linje mörkast mellan dem.
    middle = int(face_center)
    redness = (red - green)[:, middle - 8:middle + 9].mean(axis=1)
    search = np.arange(subnasale, under_chin)
    lip_rows = search[redness[search] > redness[search].max() * 0.8]
    upper_lip, lower_lip = int(lip_rows[0]), int(lip_rows[-1])
    line = brightness[:, middle - 8:middle + 9].mean(axis=1)
    mouth = int(upper_lip + np.argmin(line[upper_lip:lower_lip + 1]))
    # Munnens hörn: den mörka linjen tar slut.
    row_values = brightness[mouth - 2:mouth + 3].min(axis=0)
    limit = np.median(brightness[mouth - 30:mouth - 20, middle - 60:middle + 60]) * 0.82
    x = middle
    while x < mouth_limit(face_center, half_width) and row_values[x] < limit:
        x += 1
    mouth_x = float(x - face_center)

    # Hakan: det som sticker ut mest under läpparna, i sidoprofilen.
    # Läpparnas spetsar i profilen, nära samma rader som i framvyn.
    near = int(span * 0.03)
    side_upper = int(upper_lip - near + np.argmin(profile[upper_lip - near:mouth]))
    side_lower = int(mouth + np.argmin(profile[mouth:lower_lip + near]))
    sulcus = next_extreme(profile, side_lower, side_lower + int(span * 0.12), True, 0.12)
    chin = int(sulcus + np.argmin(profile[sulcus:under_chin]))
    # En svag haka har ingen tydlig fördjupning ovanför sig, och då gäller proportionerna.
    if sulcus >= under_chin - 12 or chin >= under_chin - 3:
        sulcus = int(side_lower + (under_chin - side_lower) * 0.38)
        chin = int(side_lower + (under_chin - side_lower) * 0.7)

    return {
        "center": float(face_center), "rows": [int(rows[0]), int(rows[-1])], "silhouette_center": float(center),
        "top": top, "hairline": hairline, "brow": int(brow), "brow_row": brow_row, "nasion": int(nasion), "tip": tip, "subnasale": int(subnasale),
        "upper_lip": upper_lip, "mouth": mouth, "lower_lip": lower_lip, "sulcus": sulcus, "chin": chin, "under_chin": under_chin,
        "eye_y": float(eye_y), "eye_x": float(eye_x), "eye_half": float(eye_half), "mouth_x": mouth_x, "half_width": float(half_width),
        "side_upper_lip": side_upper, "side_lower_lip": side_lower,
    }


def annotate(front_path, side_path, marks, target):
    front = Image.open(front_path).convert("RGB")
    side = Image.open(side_path).convert("RGB")
    sheet = Image.new("RGB", (front.width + side.width, front.height), "white")
    sheet.paste(front, (0, 0))
    sheet.paste(side, (front.width, 0))
    draw = ImageDraw.Draw(sheet)
    for name in ("hairline", "brow_row", "nasion", "tip", "subnasale", "upper_lip", "mouth", "lower_lip", "sulcus", "chin", "under_chin"):
        row = marks[name]
        draw.line([(0, row), (sheet.width, row)], fill=(0, 255, 255), width=1)
        draw.text((front.width + 4, row - 11), name, fill=(0, 0, 0))
    center = marks["center"]
    for sign in (-1, 1):
        x, y = center + sign * marks["eye_x"], marks["eye_y"]
        draw.ellipse([x - 5, y - 5, x + 5, y + 5], outline=(255, 255, 0), width=2)
        mx = center + sign * marks["mouth_x"]
        draw.ellipse([mx - 4, marks["mouth"] - 4, mx + 4, marks["mouth"] + 4], outline=(0, 255, 0), width=2)
    crop = sheet.crop((0, marks["rows"][0] - 10, sheet.width, marks["rows"][1] + 10))
    crop.save(target)


if __name__ == "__main__":
    marks = measure(sys.argv[1], sys.argv[2])
    if len(sys.argv) > 3:
        annotate(sys.argv[1], sys.argv[2], marks, sys.argv[3])
    print(json.dumps(marks))
