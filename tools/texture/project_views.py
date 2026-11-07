# project_views.py (från lowpoly-test/project_texture.py)
# Målar bilder av en modell, sedda från flera håll, rakt in i modellens UV-karta, så att bildernas utseende behålls.
# Mot skarvar: varje målad vy rätas först upp mot sin egen rendering med optiskt flöde ("render" i vyn), så att detaljer
# som Krea-2 flyttat hamnar där modellen har dem, och vyerna blandas i två frekvensband: grova färger mjukt över ett brett
# område, fina detaljer från den vy som ser ytan rakast med en smal övergång (inga dubbla kanter).
#   uv run --no-project --python 3.12 --with trimesh --with numpy --with pillow --with scipy --with opencv-python-headless \
#     python -I tools/texture/project_views.py <recept.json>
# Receptfält utöver de gamla: "align": true (standard), "two_band": true (standard), "low_radius" (meter, 0.03),
# "detail_power" (vinkelns exponent för detaljbandet, 24), "mirror_axis" ("x"/"y"/"z": symmetrisk kropp, vänster och höger
# görs lika över spegelplanet; "mirror_plane", "mirror_tolerance"), "blend": "best" (ingen blandning: varje yta tar färgen
# från en enda vy, den som ser den rakast räknat över ett område ("best_radius", meter, 0.03), med en smal övergång
# ("best_power", 40); behåller Krea-2:s skärpa, skarvarna hamnar mellan sammanhängande områden), "blend": "stitch" (sömnad:
# en vy per yta som i best, men skarvarna läggs där vyerna är överens (vyval över ett grannskapsnät där en skarv kostar efter
# färgskillnaden mellan vyerna, "stitch_color" 4, "stitch_potts" 1, "stitch_hops" 8) och färgskillnaden som är kvar jämnas ut över hela
# nätet med en mjuk korrektion per vy (glesa minsta kvadrater, "stitch_level" true); "stitch_samples" 60000), "fill": "baked" (det ingen bild ser behåller modellens egen
# textur i stället för närmaste sedda färg). Svarar med en rad JSON.
import argparse
import json
import struct
from pathlib import Path

import cv2
import numpy as np
import trimesh
from PIL import Image
from scipy import ndimage, optimize
from scipy.spatial import cKDTree

GRID = 0.002
DEPTH_TOLERANCE = 0.012
SAMPLES = 16000
SHRINK = 2
FACING_POWER = 6
SEEN_LEVEL = 0.5
UP = np.array([0.0, 1.0, 0.0])
# Where the camera stands. Tripo's models face +X in glTF space, and in left the face points to the left edge of the image.
CAMERAS = {
    "front": (1, 0, 0),
    "left": (0, 0, -1),
    "back": (-1, 0, 0),
    "right": (0, 0, 1),
    "left_front": (1, 0, -1),
    "right_front": (1, 0, 1),
    "top": (0, 1, 0),
    "left_back": (-1, 0, -1),
    "right_back": (-1, 0, 1),
}


def smoothstep(low, high, value):
    t = np.clip((value - low) / (high - low), 0, 1)
    return t * t * (3 - 2 * t)


# Position and normal per texel of the UV map.
def bake_surface(mesh, size):
    vertices, faces, uv = np.asarray(mesh.vertices), np.asarray(mesh.faces), np.asarray(mesh.visual.uv)
    _, welded = np.unique(np.round(vertices, 5), axis=0, return_inverse=True)
    welded = welded.ravel()
    face_normals = np.cross(vertices[faces[:, 1]] - vertices[faces[:, 0]], vertices[faces[:, 2]] - vertices[faces[:, 0]])
    summed = np.zeros((welded.max() + 1, 3))
    for corner in range(3):
        np.add.at(summed, welded[faces[:, corner]], face_normals)
    normals = summed[welded] / (np.linalg.norm(summed[welded], axis=1, keepdims=True) + 1e-12)

    pixels = np.stack([uv[:, 0] * size, (1 - uv[:, 1]) * size], axis=1)
    owner = np.full((size, size), -1, np.int32)
    corners = np.round((pixels[faces] - 0.5) * 16).astype(np.int32)
    for index, corner in enumerate(corners):
        cv2.fillConvexPoly(owner, corner, index, lineType=cv2.LINE_8, shift=4)
    rows, columns = np.where(owner >= 0)
    triangle = owner[rows, columns]
    a, b, c = pixels[faces[triangle, 0]], pixels[faces[triangle, 1]], pixels[faces[triangle, 2]]
    x, y = columns + 0.5, rows + 0.5
    area = (b[:, 1] - c[:, 1]) * (a[:, 0] - c[:, 0]) + (c[:, 0] - b[:, 0]) * (a[:, 1] - c[:, 1])
    area = np.where(np.abs(area) < 1e-9, 1e-9, area)
    weight_a = ((b[:, 1] - c[:, 1]) * (x - c[:, 0]) + (c[:, 0] - b[:, 0]) * (y - c[:, 1])) / area
    weight_b = ((c[:, 1] - a[:, 1]) * (x - c[:, 0]) + (a[:, 0] - c[:, 0]) * (y - c[:, 1])) / area
    weights = np.clip(np.stack([weight_a, weight_b, 1 - weight_a - weight_b], axis=1), 0, 1)
    weights /= weights.sum(axis=1, keepdims=True)
    position = (vertices[faces[triangle]] * weights[..., None]).sum(axis=1).astype(np.float32)
    normal = (normals[faces[triangle]] * weights[..., None]).sum(axis=1).astype(np.float32)
    normal /= np.linalg.norm(normal, axis=1, keepdims=True) + 1e-9
    return rows, columns, position, normal


# Den målade bilden flyttas tillbaka till renderingen den målades över: tätt optiskt flöde mellan bildernas strukturer
# (gråskala, utjämnad), utslätat och begränsat, så att bara Krea-2:s förskjutningar rättas och inte själva motivet ändras.
def align_to_render(image, render_path, max_shift=15, mirror=False):
    render = np.asarray(Image.open(render_path).convert("RGB").resize(image.shape[1::-1], Image.BILINEAR)).astype(np.float32) / 255
    if mirror:  # speglad vy: renderingen är den ospeglade källans, så den speglas på samma sätt
        render = np.ascontiguousarray(render[:, ::-1])
    gray = lambda im: cv2.GaussianBlur((im.mean(axis=2) * 255).astype(np.uint8), (0, 0), 1.2)
    a, b = gray(render), gray(image)
    dis = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)
    dis.setFinestScale(1)
    forward = dis.calc(a, b, None)    # punkt i renderingen -> var den hamnade i den målade bilden
    backward = dis.calc(b, a, None)
    h, w = image.shape[:2]
    grid_x, grid_y = np.meshgrid(np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32))
    # Kontroll fram och tillbaka: där flödet inte leder tillbaka till samma punkt (skymda kanter, olika motiv) räknas det inte
    back_at = cv2.remap(backward, grid_x + forward[..., 0], grid_y + forward[..., 1], cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    error = np.linalg.norm(forward + back_at, axis=2)
    figure = figure_mask(render) & figure_mask(image)
    trust = ((error < 2.0) & figure).astype(np.float32)
    # Utslätning som bara räknar betrodda punkter (normaliserad faltning), och ett tak på förflyttningen
    sigma = 8
    weight = ndimage.gaussian_filter(trust, sigma) + 1e-4
    flow = np.stack([ndimage.gaussian_filter(forward[..., i] * trust, sigma) / weight for i in range(2)], axis=-1)
    flow *= np.clip(weight / 0.3, 0, 1)[..., None]  # där nästan inget är betrott: ingen förflyttning
    length = np.linalg.norm(flow, axis=2, keepdims=True)
    flow = flow * np.minimum(1, max_shift / (length + 1e-6))
    warped = cv2.remap(image, grid_x + flow[..., 0], grid_y + flow[..., 1], cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
    drift = np.linalg.norm(flow, axis=2)[figure]
    return warped.clip(0, 1), {"median": round(float(np.median(drift)), 2), "p90": round(float(np.percentile(drift, 90)), 2),
                               "trusted": round(float(trust.sum() / max(figure.sum(), 1)), 3)}


# The figure is what does not connect to the image border with the border's color.
def figure_mask(image):
    border = np.concatenate([image[:12].reshape(-1, 3), image[:, :12].reshape(-1, 3), image[:, -12:].reshape(-1, 3)])
    labels, _ = ndimage.label(np.abs(image - np.median(border, axis=0)).sum(axis=2) < 0.1)
    outer = np.unique(np.concatenate([labels[0], labels[:, 0], labels[:, -1], labels[-1]]))
    return ~np.isin(labels, outer[outer > 0])


# Fits an image to the model. The model's baked colors must line up with the image and the model must stay inside the figure.
# Views from one sheet share their scale and height, so after the first view of a sheet only the sideways position is free.
def fit_view(view, image, mask, x_axis, y_axis, baked, usable, height_top, sheet_fit):
    shrunk = cv2.resize(image.mean(axis=2), (image.shape[1] // SHRINK, image.shape[0] // SHRINK), interpolation=cv2.INTER_AREA)
    shrunk_mask = cv2.resize(mask.astype(np.float32), (image.shape[1] // SHRINK, image.shape[0] // SHRINK), interpolation=cv2.INTER_AREA)
    candidates = np.where(usable)[0]
    picks = candidates[np.linspace(0, len(candidates) - 1, min(len(candidates), SAMPLES)).astype(int)]
    sample_x, sample_y, sample_color = x_axis[picks], y_axis[picks], baked[picks].mean(axis=1)

    def score(parameters):
        scale_x, scale_y, offset_x, offset_y = parameters
        u, v = (scale_x * sample_x + offset_x) / SHRINK, (-scale_y * sample_y + offset_y) / SHRINK
        inside = (u >= 0) & (u < shrunk.shape[1] - 1) & (v >= 0) & (v < shrunk.shape[0] - 1)
        if inside.mean() < 0.85:
            return 1.0
        seen = ndimage.map_coordinates(shrunk, [v[inside], u[inside]], order=1)
        in_figure = ndimage.map_coordinates(shrunk_mask, [v[inside], u[inside]], order=1).mean()
        color = sample_color[inside]
        correlation = ((seen - seen.mean()) * (color - color.mean())).mean() / (seen.std() * color.std() + 1e-9)
        stretch = abs(scale_x / scale_y - 1)
        return -float(correlation + 1.5 * in_figure * inside.mean()) + 4 * max(stretch - 0.05, 0)

    rows, columns = np.where(mask)
    middle_x = (sample_x.min() + sample_x.max()) / 2
    if sheet_fit is not None:
        scale_x, scale_y, _, offset_y = sheet_fit
        center = (columns.max() + columns.min()) / 2 - scale_x * middle_x
        reach = 0.25 * (columns.max() - columns.min()) + 20
        steps = np.linspace(center - reach, center + reach, 41)
        start = min(steps, key=lambda value: score((scale_x, scale_y, value, offset_y)))
        result = optimize.minimize_scalar(lambda value: score((scale_x, scale_y, value, offset_y)), bounds=(start - reach / 20, start + reach / 20), method="bounded")
        return (scale_x, scale_y, float(result.x), offset_y), float(-result.fun)
    estimate =(rows.max() - rows.min()) / (height_top - view.get("bottom_y", -0.5))
    best = (9.0, None)
    for scale in estimate * np.linspace(0.75, 1.25, 11):
        for shift_x in np.linspace(-0.12, 0.12, 9) * (columns.max() - columns.min()):
            for shift_y in np.linspace(-0.12, 0.12, 9) * (rows.max() - rows.min()):
                start_x = (columns.max() + columns.min()) / 2 - scale * middle_x + shift_x
                start_y = rows.min() + scale * height_top + shift_y
                value = score((scale, scale, start_x, start_y))
                if value < best[0]:
                    best = (value, (scale, scale, start_x, start_y))
    result = optimize.minimize(score, best[1], method="Powell", options={"xtol": 1e-3, "ftol": 1e-4, "maxiter": 40})
    return result.x, float(-result.fun)


# trimesh compresses the image again on export, so the GLB gets the saved file as it is.
def embed_image(glb_path, image_path):
    data = glb_path.read_bytes()
    json_length = struct.unpack_from("<I", data, 12)[0]
    document = json.loads(data[20:20 + json_length])
    binary = data[20 + json_length + 8:]
    color_texture = document["materials"][0]["pbrMetallicRoughness"]["baseColorTexture"]["index"]
    replaced = document["images"][document["textures"][color_texture]["source"]]["bufferView"]
    views = document["bufferViews"]
    chunks = []
    offset = 0
    for index, view in enumerate(views):
        start = view.get("byteOffset", 0)
        chunk = image_path.read_bytes() if index == replaced else binary[start:start + view["byteLength"]]
        padding = -offset % 4
        chunks.append(b"\0" * padding + chunk)
        offset += padding
        view["byteOffset"], view["byteLength"] = offset, len(chunk)
        offset += len(chunk)
    new_binary = b"".join(chunks)
    new_binary += b"\0" * (-len(new_binary) % 4)
    document["buffers"][0]["byteLength"] = len(new_binary)
    text = json.dumps(document, separators=(",", ":")).encode()
    text += b" " * (-len(text) % 4)
    total = 12 + 8 + len(text) + 8 + len(new_binary)
    header = struct.pack("<4sII", b"glTF", 2, total) + struct.pack("<I4s", len(text), b"JSON")
    glb_path.write_bytes(header + text + struct.pack("<I4s", len(new_binary), b"BIN\0") + new_binary)


def stitch(position, layers, energies, recipe, area):
    """Sömnad: en vy per yta, skarvar där vyerna är överens och färgerna utjämnade över skarvarna (som Waechter m.fl. 2014,
    "Let there be color", fast på ett urval av ytpunkter i stället för på nätets ytor). Ger färgen per texel och en rapport."""
    from scipy import sparse
    from scipy.sparse.linalg import cg
    count, total = len(layers), len(position)
    n = min(total, int(recipe.get("stitch_samples", 60000)))
    pick = np.random.default_rng(0).choice(total, n, replace=False)
    spacing = float(np.sqrt(area / n))
    radius = recipe.get("stitch_radius", 2.2 * spacing)
    tree = cKDTree(position[pick])
    pairs = tree.query_pairs(radius, output_type="ndarray")
    i, j = pairs[:, 0], pairs[:, 1]
    A = sparse.coo_matrix((np.ones(2 * len(i), np.float32), (np.r_[i, j], np.r_[j, i])), shape=(n, n)).tocsr()
    degree = np.asarray(A.sum(axis=1)).ravel() + 1e-6
    _, owner = tree.query(position, workers=-1)
    owned = np.bincount(owner, minlength=n) + 1e-6

    def at_samples(values):  # medel över de texlar som hör till varje urvalspunkt
        if values.ndim == 1:
            return np.bincount(owner, weights=values, minlength=n) / owned
        return np.stack([np.bincount(owner, weights=values[:, c], minlength=n) for c in range(values.shape[1])], 1) / owned[:, None]

    valid = np.stack([at_samples(layer[0]) for layer in layers]) > 0.3          # vyn ser punkten
    C = np.stack([at_samples(layer[1]) for layer in layers]).astype(np.float32)  # vyns färg i punkten
    E = np.stack([at_samples(e) for e in energies])
    for _ in range(int(recipe.get("stitch_hops", 8))):  # utjämnad över några grannsteg (~2 cm), så att valet följer formen, inte varje fasett
        E = (A @ E.T + E.T).T / (degree + 1)
    data = np.where(valid, 1 - E / (np.where(valid, E, 0).max(axis=0) + 1e-9), 50.0)

    # Färgskillnaden mellan två vyer i varje punkt (0..1); en vy som inte ser punkten räknas som oense
    diff = np.full((count, count, n), 0.5, np.float32)
    for a in range(count):
        for b in range(count):
            both = valid[a] & valid[b]
            diff[a, b, both] = np.abs(C[a, both] - C[b, both]).mean(axis=1)
            if a == b:
                diff[a, b] = 0
    color_w, potts = recipe.get("stitch_color", 4.0), recipe.get("stitch_potts", 1.0)

    def seam_stats(lab):  # skarvkanter (andel av alla kanter) och färgskillnaden över dem där båda vyerna ser ytan
        cut = lab[i] != lab[j]
        a, b = lab[i][cut], lab[j][cut]
        ok = valid[a, i[cut]] & valid[b, i[cut]] & valid[a, j[cut]] & valid[b, j[cut]]
        miss = (diff[a, b, i[cut]] + diff[a, b, j[cut]])[ok] / 2
        return round(float(cut.mean()), 4), round(float(miss.mean()) if len(miss) else 0.0, 4)

    # Vyval: iterativ förbättring (ICM), varje punkt tar den vy som ger lägst egen kostnad + skarvkostnad mot grannarna
    label = np.argmax(np.where(valid, E, -1), axis=0)
    before = seam_stats(label)
    rng = np.random.default_rng(1)
    for sweep in range(int(recipe.get("stitch_sweeps", 20))):
        onehot = (label[None, :] == np.arange(count)[:, None]).astype(np.float32)  # L,n
        neigh = A @ onehot.T                                                       # n,L: grannar med vy b
        cost = data.copy()
        for l in range(count):
            # summan av skarvens kostnad mot grannar med en annan vy b: färgskillnad här och hos grannen, plus en fast kostnad
            far = A @ (onehot * diff[l]).T  # n,L: Σ över grannar med vy b av diff_lb(granne)
            seam = 0.5 * color_w * (neigh * diff[l].T + far) + potts * neigh
            seam[:, l] = 0
            cost[l] += seam.sum(axis=1) / degree
        new = np.argmin(cost, axis=0)
        move = (new != label) & (rng.random(n) < 0.5)
        label[move] = new[move]
        if move.sum() < n * 1e-4:
            break
    after = seam_stats(label)
    if recipe.get("stitch_debug"):
        np.savez_compressed(recipe["stitch_debug"], label=label, valid=valid, E=E, i=i, j=j, pos=position[pick], C=C, diff=diff)

    # Utjämning: en korrektion g per punkt (för dess vy), så att färgen möts över skarvarna och varierar mjukt inom vyns område
    g = np.zeros((n, 3), np.float32)
    level = {}
    if recipe.get("stitch_level", True):
        cut = label[i] != label[j]
        a, b = label[i], label[j]
        both_a = valid[a, i] & valid[a, j]
        both_b = valid[b, i] & valid[b, j]
        use = cut & both_a & both_b
        d = (C[b, i] + C[b, j]) / 2 - (C[a, i] + C[a, j]) / 2  # g_i - g_j = det vyn b har här minus det vyn a har
        size_d = np.abs(d).mean(axis=1)
        seam_w = recipe.get("stitch_seam_weight", 10.0) * np.minimum(1, recipe.get("stitch_max_diff", 0.25) / (size_d + 1e-6))
        rows_w = np.where(use, seam_w, np.where(cut, 0.0, 1.0)).astype(np.float64)  # inre kanter: g lika hos grannar
        target = np.where(use[:, None], d, 0)
        m = len(i)
        D = sparse.coo_matrix((np.r_[rows_w, -rows_w], (np.r_[np.arange(m), np.arange(m)], np.r_[i, j])), shape=(m, n)).tocsr()
        # normalekvationerna (DᵀD + εI) g = Dᵀ(w·d); D har redan vikten w i raderna
        M = (D.T @ D + sparse.identity(n) * recipe.get("stitch_eps", 1e-3)).tocsr()
        for c in range(3):
            rhs = D.T @ (rows_w * target[:, c])
            g[:, c], _ = cg(M, rhs, rtol=1e-6, maxiter=3000)
        g = np.clip(g, -0.35, 0.35)
        fixed = (C[a[use], i[use]] + g[i[use]]) - (C[b[use], j[use]] + g[j[use]])
        raw = C[a[use], i[use]] - C[b[use], j[use]]
        level = {"seam_edges": int(use.sum()), "mismatch_before": round(float(np.abs(raw).mean()), 4),
                 "mismatch_after": round(float(np.abs(fixed).mean()), 4), "max_correction": round(float(np.abs(g).max()), 3)}

    # Till texlarna: vyernas andel från de närmaste urvalspunkterna (smal övergång, ett par punktavstånd), bara vyer som ser
    # texeln, och korrektionen för varje vy förlängd från dess eget område (närmaste punkt med den vyn).
    k = 6
    dist, near = tree.query(position, k=k, workers=-1)
    wk = np.exp(-(dist / spacing) ** 2).astype(np.float32)
    wk /= wk.sum(axis=1, keepdims=True) + 1e-12
    share = np.zeros((count, total), np.float32)
    for l in range(count):
        share[l] = (wk * (label[near] == l)).sum(axis=1) * (layers[l][0] > 0.3)
    none = share.sum(axis=0) < 1e-6
    if none.any():
        fallback = np.argmax(energies[:, none], axis=0)
        share[fallback, np.where(none)[0]] = 1
    share /= share.sum(axis=0, keepdims=True)
    mixed = np.zeros((total, 3), np.float32)
    for l in range(count):
        here = share[l] > 0
        if not here.any():
            continue
        mine = np.where(label == l)[0]
        if len(mine):
            _, nearest_l = cKDTree(position[pick][mine]).query(position[pick], workers=-1)
            g_l = g[mine][nearest_l]  # korrektionen för vy l i alla punkter
        else:
            g_l = np.zeros((n, 3), np.float32)
        g_t = (g_l[near[here]] * wk[here][..., None]).sum(axis=1)
        mixed[here] += share[l][here, None] * (layers[l][1][here] + g_t)
    return mixed.clip(0, 1).astype(np.float32), {
        "samples": n, "spacing_m": round(spacing, 4), "radius_m": round(float(radius), 4), "sweeps": sweep + 1,
        "seams_before": {"cut": before[0], "mismatch": before[1]}, "seams_after": {"cut": after[0], "mismatch": after[1]},
        "share": {recipe["views"][l]["name"]: round(float((label == l).mean()), 3) for l in range(count)}, "level": level}


def main():
    parser = argparse.ArgumentParser(description="Paint reference images onto a finished model.")
    parser.add_argument("recipe", type=Path)
    args = parser.parse_args()
    recipe = json.loads(args.recipe.read_text())
    size = recipe.get("size", 4096)

    mesh = trimesh.load(recipe["glb"], force="scene").to_geometry()
    rows, columns, position, normal = bake_surface(mesh, size)
    baked_map = mesh.visual.material.baseColorTexture.convert("RGB").resize((size, size), Image.BILINEAR)
    baked = np.asarray(baked_map).astype(np.float32)[rows, columns] / 255
    height_top = float(position[:, 1].max())

    # The face belongs to the front image. Facets that lean sideways would otherwise pick a side view and leave patches.
    face = None
    if recipe.get("face"):
        distance = np.sqrt((((position - np.array(recipe["face"]["center"])) / np.array(recipe["face"]["radius"])) ** 2).sum(axis=1))
        face = smoothstep(1.0, 0.8, distance).astype(np.float32)

    layers, report, sheet_fits = [], [], {}
    for view in recipe["views"]:
        camera = np.array(CAMERAS[view["camera"]], dtype=np.float64)
        # A model that faces +Z, like the character engine's, is turned a quarter around the up axis.
        if recipe.get("facing") == "z":
            camera = np.array([-camera[2], camera[1], camera[0]])
        camera /= np.linalg.norm(camera)
        top = view["camera"] == "top"
        if top:
            # Rakt uppifrån (som blender_render_views.py): bildens höger är modellens framåt (+X), bildens upp är -Z
            right, up = np.array([1.0, 0, 0]), np.array([0, 0, -1.0])
            if recipe.get("facing") == "z":
                right, up = np.array([0, 0, 1.0]), np.array([1.0, 0, 0])
        else:
            right, up = np.cross(-camera, UP), UP
        right /= np.linalg.norm(right)
        x_axis = (position @ right.astype(np.float32))
        depth = position @ camera.astype(np.float32)
        y_axis = (position @ up.astype(np.float32)).astype(np.float32)

        cell_x = ((x_axis - x_axis.min()) / GRID).astype(np.int32)
        cell_y = ((y_axis.max() - y_axis) / GRID).astype(np.int32)
        nearest = np.full((cell_y.max() + 1, cell_x.max() + 1), -1e9, np.float32)
        np.maximum.at(nearest, (cell_y, cell_x), depth)
        visible = depth >= nearest[cell_y, cell_x] - DEPTH_TOLERANCE
        facing = normal @ camera.astype(np.float32)
        region = np.ones_like(y_axis) if top else smoothstep(view.get("bottom_y", -1.0), view.get("bottom_y", -1.0) + view.get("fade", 0.02), y_axis)

        image = np.asarray(Image.open(view["image"]).convert("RGB")).astype(np.float32) / 255
        if view.get("mirror_image"):  # symmetrisk kropp: höger vy = speglad vänster
            image = np.ascontiguousarray(image[:, ::-1])
        if view.get("render") and recipe.get("align", True):
            image, drift = align_to_render(image, view["render"], mirror=bool(view.get("mirror_image")))
            view["_drift"] = drift
        mask = figure_mask(image)
        usable = visible & (facing > 0.3) & (region > 0.99)
        top_y = float(y_axis.max()) if top else height_top
        fit_view_args = {**view, "bottom_y": float(y_axis.min())} if top else view
        fitted, fit = fit_view(fit_view_args, image, mask, x_axis, y_axis, baked, usable, top_y, sheet_fits.get(view["sheet"]))
        sheet_fits.setdefault(view["sheet"], fitted)
        scale_x, scale_y, offset_x, offset_y = fitted
        u, v = scale_x * x_axis + offset_x, -scale_y * y_axis + offset_y

        kept = ndimage.gaussian_filter(ndimage.binary_erosion(mask, iterations=view.get("erode", 3)).astype(np.float32), 1.5)
        inside = ndimage.map_coordinates(kept, [v, u], order=1, cval=0)
        weight = (visible * smoothstep(0.08, 0.5, facing) * inside * region).astype(np.float32)
        colors = np.stack([ndimage.map_coordinates(image[..., i], [v, u], order=3, cval=0) for i in range(3)], axis=1).clip(0, 1).astype(np.float32)
        energy = weight * view.get("bias", 1.0) * np.maximum(facing, 0.02) ** FACING_POWER
        if face is not None and view["camera"] != "front":
            energy *= 1 - 0.995 * face
            weight = weight * (1 - face)
        elif face is not None:
            energy = energy * (1 - face) + face * weight * view.get("bias", 1.0)
        layers.append([weight, colors, energy])
        report.append({"name": view["name"], **({"drift_px": view["_drift"]} if view.get("_drift") else {}), "fit": round(fit, 3), "px_per_unit": round(float(scale_y), 1), "stretch": round(float(scale_x / scale_y), 3), "seen": round(float((weight > SEEN_LEVEL).mean()), 3)})
        print(json.dumps(report[-1]), flush=True)

    # Every image gets a gain per channel against the first view, measured where both see the surface.
    first_weight, first_colors = layers[0][0], layers[0][1]
    for index in range(1, len(layers)):
        both = (layers[index][0] > 0.25) & (first_weight > 0.25)
        if both.sum() > 400:
            gain = np.clip(np.median(first_colors[both], axis=0) / (np.median(layers[index][1][both], axis=0) + 1e-4), 0.8, 1.25)
            layers[index][1] = (layers[index][1] * gain).astype(np.float32)
            report[index]["gain"] = [round(float(value), 3) for value in gain]

    energies = np.stack([layer[2] for layer in layers])
    total = energies.sum(axis=0) + 1e-6
    mixed = sum(layers[i][1] * (energies[i] / total)[..., None] for i in range(len(layers)))
    def make_lowpass(radius):
        # Lågpass på ytan: viktad medelfärg inom radius kring varje punkt, på ett urval av texlar med en gles grannmatris
        from scipy import sparse
        pick = np.random.default_rng(0).choice(len(position), min(len(position), 30000), replace=False)
        tree = cKDTree(position[pick])
        pairs = tree.query_pairs(radius, output_type="ndarray")
        n = len(pick)
        W = sparse.coo_matrix((np.ones(len(pairs) * 2 + n, np.float32),
                               (np.r_[pairs[:, 0], pairs[:, 1], np.arange(n)], np.r_[pairs[:, 1], pairs[:, 0], np.arange(n)])), shape=(n, n)).tocsr()
        _, owner = tree.query(position, workers=-1)

        def lowpass(values, weights):
            wv = np.stack([np.bincount(owner, weights=values[:, c] * weights, minlength=n) for c in range(values.shape[1])], axis=1)
            ww = np.bincount(owner, weights=weights, minlength=n)
            return ((W @ wv) / ((W @ ww)[:, None] + 1e-6))[owner].astype(np.float32)
        return lowpass, n, len(pairs)

    best_mode = recipe.get("blend") in ("best", "stitch")  # välj en vy, blanda inte (också i spegelpasset)
    if recipe.get("blend") == "stitch":
        mixed, info = stitch(position, layers, energies, recipe, float(mesh.area))
        report.append({"stitch": info})
        print(json.dumps(report[-1]), flush=True)
    elif best_mode:
        # En vy per yta: vyernas energi (rak vinkel × bias) jämnas ut över best_radius så att valet blir sammanhängande områden,
        # en vy som inte ser punkten (skymd eller utanför bilden) kan inte väljas, och övergången görs smal med en hög potens.
        lowpass, n, npairs = make_lowpass(recipe.get("best_radius", 0.03))
        smooth = np.stack([lowpass(energies[i][:, None], np.ones(len(position), np.float32))[:, 0] * (layers[i][0] > 0.3)
                           for i in range(len(layers))])
        top = smooth.max(axis=0) + 1e-12
        pick_w = (smooth / top) ** recipe.get("best_power", 40)
        mixed = (sum(layers[i][1] * pick_w[i][..., None] for i in range(len(layers))) / (pick_w.sum(axis=0)[..., None] + 1e-12)).astype(np.float32)
        winner = smooth.argmax(axis=0)
        report.append({"best": {"radius": recipe.get("best_radius", 0.03), "power": recipe.get("best_power", 40),
                                "share": {recipe["views"][i]["name"]: round(float((winner == i).mean()), 3) for i in range(len(layers))}}})
    elif recipe.get("two_band", True):
        # Lågpass på ytan: viktad medelfärg inom low_radius kring varje punkt. Räknas på ett slumpvis urval av texlar med en
        # gles grannmatris och förs över till alla texlar med närmaste urvalspunkt (lågpassad färg varierar långsamt).
        from scipy import sparse
        radius = recipe.get("low_radius", 0.025)
        pick = np.random.default_rng(0).choice(len(position), min(len(position), 30000), replace=False)
        tree = cKDTree(position[pick])
        pairs = tree.query_pairs(radius, output_type="ndarray")
        n = len(pick)
        W = sparse.coo_matrix((np.ones(len(pairs) * 2 + n, np.float32),
                               (np.r_[pairs[:, 0], pairs[:, 1], np.arange(n)], np.r_[pairs[:, 1], pairs[:, 0], np.arange(n)])), shape=(n, n)).tocsr()
        _, owner = tree.query(position, workers=-1)
        # Urvalspunkternas värden: medel över de texlar som hör till punkten
        counts = np.bincount(owner, minlength=n).astype(np.float32) + 1e-6

        def lowpass(values, weights):
            wv = np.stack([np.bincount(owner, weights=values[:, c] * weights, minlength=n) for c in range(3)], axis=1)
            ww = np.bincount(owner, weights=weights, minlength=n)
            return ((W @ wv) / ((W @ ww)[:, None] + 1e-6))[owner].astype(np.float32)

        # Grova färger: alla vyer blandade mjukt (deras breda vikt). Detaljer: varje vys högpass, viktat skarpt mot den rakaste vyn.
        soft = np.stack([layer[0] * view.get("bias", 1.0) + 1e-4 for layer, view in zip(layers, recipe["views"])])
        soft_total = soft.sum(axis=0)
        low = [lowpass(layers[i][1], layers[i][0] + 1e-4) for i in range(len(layers))]
        soft_s = [lowpass(np.repeat(soft[i][:, None], 3, axis=1), np.ones(len(position), np.float32))[:, 0] for i in range(len(layers))]
        soft_s_total = np.sum(soft_s, axis=0) + 1e-6
        low_mix = sum(low[i] * (soft_s[i] / soft_s_total)[..., None] for i in range(len(layers)))
        power = recipe.get("detail_power", 24)
        sharp = np.stack([layer[2] ** (power / FACING_POWER) for layer in layers])
        sharp_total = sharp.sum(axis=0) + 1e-12
        detail = sum((layers[i][1] - low[i]) * (sharp[i] / sharp_total)[..., None] for i in range(len(layers)))
        report.append({"two_band": {"samples": n, "pairs": int(len(pairs)), "radius": radius}})
        mixed = (low_mix + detail).clip(0, 1).astype(np.float32)
    best_weight = np.max([layer[0] for layer in layers], axis=0)
    if recipe.get("mirror_axis") in ("x", "y", "z"):
        # Symmetrisk kropp: varje punkt jämförs med sin spegelpunkt på andra sidan; den sida som ser ytan bäst väger mest.
        # Så blir vänster och höger lika även där vyerna skiljer sig åt. Stäng av för kläder och rustning som inte är symmetriska.
        ax = "xyz".index(recipe["mirror_axis"])
        plane = recipe.get("mirror_plane", float((position[:, ax].min() + position[:, ax].max()) / 2))
        mirrored = position.copy()
        mirrored[:, ax] = 2 * plane - mirrored[:, ax]
        dist, partner = cKDTree(position).query(mirrored, workers=-1)
        close = dist < recipe.get("mirror_tolerance", 0.004)
        w_self = best_weight ** 2 + 1e-6
        w_other = np.where(close, best_weight[partner] ** 2, 0)
        if best_mode:  # ingen blandning här heller: den sida som ser ytan bäst ger färgen till båda
            mixed = np.where((w_other > w_self)[:, None], mixed[partner], mixed).astype(np.float32)
        else:
            mixed = ((mixed * w_self[:, None] + mixed[partner] * w_other[:, None]) / (w_self + w_other)[:, None]).astype(np.float32)
        best_weight = np.where(close, np.maximum(best_weight, best_weight[partner]), best_weight)
        report.append({"mirror": {"axis": recipe["mirror_axis"], "plane": round(float(plane), 4), "matched": round(float(close.mean()), 3)}})
    seen = (best_weight > SEEN_LEVEL) & (total > 1e-3)

    patch = recipe.get("patch")
    if patch:
        # Only a zone of the model is painted. The images are colored to fit what surrounds the zone.
        distance = np.sqrt((((position - np.array(patch["center"])) / np.array(patch["radius"])) ** 2).sum(axis=1))
        alpha = (smoothstep(1.0, patch.get("inner", 0.75), distance) * best_weight).astype(np.float32)
        ring = (alpha > 0.15) & (alpha < 0.85) & (mixed.mean(axis=1) > 0.35)
        gain = np.clip(np.median(baked[ring], axis=0) / (np.median(mixed[ring], axis=0) + 1e-4), 0.75, 1.3)
        mixed = baked * (1 - alpha[:, None]) + (mixed * gain).clip(0, 1) * alpha[:, None]
        report.append({"patch_texels": int((alpha > 0.5).sum()), "gain": [round(float(value), 3) for value in gain]})
        seen = np.ones(len(mixed), bool)
    elif recipe.get("fill") == "baked":
        # Det som ingen bild ser behåller modellens egen textur (t.ex. UltraTex under Krea-2), färgad mot det målade där de möts
        alpha = (smoothstep(SEEN_LEVEL - 0.3, SEEN_LEVEL + 0.1, best_weight) * (total > 1e-3)).astype(np.float32)
        ring = (alpha > 0.3) & (alpha < 0.9)
        gain = np.clip(np.median(mixed[ring], axis=0) / (np.median(baked[ring], axis=0) + 1e-4), 0.75, 1.3) if ring.sum() > 200 else np.ones(3)
        mixed = ((baked * gain).clip(0, 1) * (1 - alpha[:, None]) + mixed * alpha[:, None]).astype(np.float32)
        report.append({"fill_baked": {"share": round(float((alpha < 0.5).mean()), 3), "gain": [round(float(v), 3) for v in gain]}})
        seen = np.ones(len(mixed), bool)
    else:
        # What no image sees takes the color of the nearest seen point on the model.
        known = np.where(seen)[0]
        known = known[np.linspace(0, len(known) - 1, min(len(known), 400000)).astype(int)]
        _, nearest_known = cKDTree(position[known]).query(position[~seen], workers=-1)
        mixed[~seen] = mixed[known][nearest_known]

    canvas = np.zeros((size, size, 3), np.float32)
    canvas[rows, columns] = mixed
    covered = np.zeros((size, size), bool)
    covered[rows, columns] = True
    indices = ndimage.distance_transform_edt(~covered, return_distances=False, return_indices=True)
    canvas = canvas[indices[0], indices[1]]

    # Every attempt becomes a new file. A finished model is never overwritten.
    target = Path(recipe["out"])
    target.parent.mkdir(parents=True, exist_ok=True)
    stem, version = target.stem, 1
    while target.exists():
        version += 1
        target = target.with_name(f"{stem}_v{version}.glb")
    texture_path = target.with_name(target.stem + "_basecolor.jpg")
    Image.fromarray((canvas.clip(0, 1) * 255 + 0.5).astype(np.uint8)).save(texture_path, quality=recipe.get("jpeg_quality", 92))
    material = trimesh.visual.material.PBRMaterial(name=target.stem, baseColorTexture=Image.open(texture_path), roughnessFactor=recipe.get("roughness", 0.7), metallicFactor=0.0)
    if patch:
        # The model's other maps stay, but the normal map is flat in the zone, where it was painted for the old texture.
        source = mesh.visual.material
        zone = np.zeros((size, size), np.float32)
        zone[rows, columns] = alpha
        normal_map = np.asarray(source.normalTexture.convert("RGB")).astype(np.float32)
        small = cv2.resize(ndimage.grey_dilation(zone, size=5), normal_map.shape[1::-1], interpolation=cv2.INTER_AREA)[..., None]
        flat = normal_map * (1 - small) + np.array([128.0, 128.0, 255.0]) * small
        material = trimesh.visual.material.PBRMaterial(
            name=target.stem, baseColorTexture=Image.open(texture_path), normalTexture=Image.fromarray(flat.astype(np.uint8)),
            metallicRoughnessTexture=source.metallicRoughnessTexture, roughnessFactor=source.roughnessFactor, metallicFactor=source.metallicFactor)
    painted =trimesh.Trimesh(vertices=mesh.vertices, faces=mesh.faces, process=False, visual=trimesh.visual.TextureVisuals(uv=mesh.visual.uv, material=material))
    painted.export(target)
    embed_image(target, texture_path)
    print(json.dumps({"glb": str(target), "mb": round(target.stat().st_size / 2**20, 1), "seen": round(float(seen.mean()), 3), "views": report}))


if __name__ == "__main__":
    main()
