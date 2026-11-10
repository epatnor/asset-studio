"""Gör en valfri GLB till ett nät för editorn: hopsvetsade hörn, rutor där trianglar ligger plant, vikter och spegelhörn.

Modellen skalas och vänds bara när den uppenbart är en hel kropp i annan storlek eller riktning. Texturer följer inte med."""
import io
import json
import re
from pathlib import Path

import numpy as np
import trimesh
from scipy.spatial import cKDTree

SKIN = [0.78, 0.72, 0.66, 1.0]
BODY_HEIGHT = 1.7
MERGE_DEGREES = 25.0


def to_quads(points, triangles):
    """Slår ihop par av trianglar som ligger plant och bildar en hygglig ruta. Bästa paren först."""
    normals = np.cross(points[triangles[:, 1]] - points[triangles[:, 0]], points[triangles[:, 2]] - points[triangles[:, 0]])
    normals /= np.linalg.norm(normals, axis=1, keepdims=True) + 1e-12
    owners = {}
    for index, triangle in enumerate(triangles):
        for k in range(3):
            a, b = int(triangle[k]), int(triangle[(k + 1) % 3])
            owners.setdefault((min(a, b), max(a, b)), []).append((index, k))
    candidates = []
    for (a, b), pair in owners.items():
        if len(pair) != 2:
            continue
        (t0, k0), (t1, k1) = pair
        cosine = float(np.dot(normals[t0], normals[t1]))
        if cosine < np.cos(np.radians(MERGE_DEGREES)):
            continue
        first, second = triangles[t0], triangles[t1]
        # Rutan i varvordning: hörnet mitt emot kanten i varje triangel läggs mellan kantens hörn.
        quad = [int(first[k0]), int(second[(k1 + 2) % 3]), int(first[(k0 + 1) % 3]), int(first[(k0 + 2) % 3])]
        worst = 0.0
        for k in range(4):
            u = points[quad[(k + 1) % 4]] - points[quad[k]]
            v = points[quad[k - 1]] - points[quad[k]]
            angle = np.degrees(np.arccos(np.clip(np.dot(u, v) / (np.linalg.norm(u) * np.linalg.norm(v) + 1e-12), -1, 1)))
            worst = max(worst, abs(angle - 90))
        if worst > 55:
            continue
        candidates.append((worst - cosine * 10, t0, t1, quad))
    candidates.sort(key=lambda item: item[0])
    used = set()
    polygons = []
    for _, t0, t1, quad in candidates:
        if t0 in used or t1 in used:
            continue
        used.update((t0, t1))
        polygons.append(quad)
    polygons += [[int(v) for v in triangle] for index, triangle in enumerate(triangles) if index not in used]
    return polygons


def normalize(points):
    """Hela kroppar ställs på marken i editorns storlek och riktning. Allt annat lämnas där det är."""
    notes = []
    extents = points.max(axis=0) - points.min(axis=0)
    height = extents[1]
    # En kropp i A-pose är bred men tunn. Ett ensamt huvud är ungefär lika djupt som högt.
    full_body = height > 0 and extents[[0, 2]].max() / height > 0.35 and extents[[0, 2]].min() / height < 0.33
    if full_body and extents[2] > extents[0] * 1.4:
        # Armarna ligger längs z: modellen tittar längs x, som Tripos, och vänds mot +Z.
        points = np.stack([-points[:, 2], points[:, 1], points[:, 0]], axis=1)
        notes.append("turned to face front")
    if full_body and not 1.2 < height < 2.4:
        points = points * (BODY_HEIGHT / height)
        notes.append(f"scaled to {BODY_HEIGHT} m")
    if full_body:
        low, high = points.min(axis=0), points.max(axis=0)
        points = points - np.array([(low[0] + high[0]) / 2, low[1], 0.0])
    return points, notes


def read_glb(data):
    mesh = trimesh.load(io.BytesIO(data), file_type="glb", force="scene").to_geometry()
    points = np.asarray(mesh.vertices, float)
    faces = np.asarray(mesh.faces)
    # UV-sömmar delar hörn: de svetsas ihop, annars går det inte att flytta nätet som en yta.
    _, index, inverse = np.unique(np.round(points, 5), axis=0, return_index=True, return_inverse=True)
    points = points[index]
    faces = inverse.ravel()[faces]
    faces = faces[(faces[:, 0] != faces[:, 1]) & (faces[:, 1] != faces[:, 2]) & (faces[:, 0] != faces[:, 2])]
    return points, faces


def import_glb(data, file_name, versions, editor):
    """Svaret är nät och ändringar. Är filen en sparad version med samma trianglar används dess riktiga polygoner."""
    stem = Path(file_name).stem
    points, faces = read_glb(data)
    saved = versions / f"{stem}.json"
    if re.fullmatch(r"[\w.-]+", stem) and saved.exists():
        stored = json.loads(saved.read_text())
        if len(stored["mesh"]["triangles"]) // 3 == len(faces):
            return {"mesh": stored["mesh"], "edits": stored["edits"], "name": stem, "source": "version", "notes": []}
    points, notes = normalize(points)
    polygons = to_quads(points, faces)
    base = np.array(editor["positions"]).reshape(-1, 3)
    indices = np.array(editor["indices"]).reshape(-1, 4)
    weights = np.array(editor["weights"]).reshape(-1, 4)
    # Vikterna lånas från närmaste punkt på kroppen, så att poserna går att prova direkt.
    _, nearest = cKDTree(base).query(points)
    distance, partner = cKDTree(points * np.array([-1.0, 1.0, 1.0])).query(points)
    mesh = {
        "positions": np.round(points, 5).ravel().tolist(), "polygons": polygons, "triangles": faces.ravel().tolist(),
        "keys": [f"file|{i}" for i in range(len(points))], "indices": indices[nearest].ravel().tolist(),
        "weights": weights[nearest].ravel().tolist(), "colors": SKIN * len(points),
        "mirror": np.where(distance < 0.012, partner, -1).tolist(),
    }
    quads = sum(len(polygon) == 4 for polygon in polygons)
    return {"mesh": mesh, "edits": {}, "name": stem, "source": "file", "notes": notes, "quads": quads, "triangles": len(polygons) - quads}
