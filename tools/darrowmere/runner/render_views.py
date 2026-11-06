# render_views.py: körs i Blender på Darrowmere, utan skärm, för granskningarna och panelen.
#   blender -b --factory-startup -P render_views.py -- <modell.glb> <utmapp> [storlek] [motor]        (fem vyer a–e, som förut)
#   blender -b --factory-startup -P render_views.py -- --json '<json>'
# JSON: {"glb", "out_dir", "size": 512, "preset": "inspect" | "basic", "shots": [...], "stats": true}
#   shot: {"name", "yaw": grader runt den lodräta axeln, "pitch": grader uppåt, "zoom": 1 = hela figuren,
#          "height": 0..1 var på figuren bilden centreras (0 fötterna, 1 hjässan), "mode": "texture" | "clay" | "wire"}
# yaw räknas från modellens framsida, som anges med "front_yaw" (0 = Blenders −Y som Meshy, 90 = +X).
# Lera: grå yta med kavitetsskuggning, så att veck, armhålor och skrev syns utan textur. Trådnät: kanterna mörka ovanpå leran.
# stats: nätets siffror (trianglar, quads, lösa delar, hål, poler, täthet per höjd) utan bilder.
# Skriver en rad "RENDER_RESULT {json}".
import json
import math
import sys
from pathlib import Path

import bmesh
import bpy
import numpy as np
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:]
if argv and argv[0] == "--json":
    job = json.loads(argv[1])
else:
    job = {"glb": argv[0], "out_dir": argv[1], "size": int(argv[2]) if len(argv) > 2 else 512, "preset": "basic",
           "engine": argv[3] if len(argv) > 3 else "WORKBENCH"}
src, out = Path(job["glb"]), Path(job["out_dir"])
size = int(job.get("size", 512))
out.mkdir(parents=True, exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=str(src))
meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
corners = [o.matrix_world @ Vector(c) for o in meshes for c in o.bound_box]
low = Vector([min(c[i] for c in corners) for i in range(3)])
high = Vector([max(c[i] for c in corners) for i in range(3)])
center, extent = (low + high) / 2, high - low

PRESETS = {
    "basic": [{"name": n, "yaw": y, "mode": "texture"} for n, y in (("a", 0), ("b", 90), ("c", 180), ("d", 270), ("e", 45))],
    "inspect": [{"name": f"tex_{y:03d}", "yaw": y, "mode": "texture"} for y in range(0, 360, 45)]
               + [{"name": "tex_top", "yaw": 0, "pitch": 89, "mode": "texture"}]
               + [{"name": f"clay_{y:03d}", "yaw": y, "mode": "clay"} for y in (0, 90, 180, 315)]
               + [{"name": f"wire_{y:03d}", "yaw": y, "mode": "wire", "size": 768} for y in (0, 90)]
               + [{"name": "close_shoulders_front", "yaw": 0, "zoom": 2.2, "height": 0.74, "mode": "clay"},
                  {"name": "close_shoulders_back", "yaw": 180, "zoom": 2.2, "height": 0.74, "mode": "clay"},
                  {"name": "close_armpit_side", "yaw": 90, "pitch": -10, "zoom": 2.6, "height": 0.72, "mode": "clay"},
                  {"name": "close_hips_front", "yaw": 0, "pitch": -8, "zoom": 2.4, "height": 0.47, "mode": "clay"},
                  # Huvudet och ansiktet är det viktigaste: närbilder från alla fyra håll, snett och uppifrån (hjässan, där vyer
                  # möts), i textur för skarvar och färgfel och i lera för formen; trådnät framifrån och från sidan för topologin
                  *[{"name": f"head_tex_{y:03d}", "yaw": y, "zoom": 5.5, "height": 0.925, "mode": "texture", "size": 640} for y in (0, 45, 90, 180, 270)],
                  {"name": "head_tex_top", "yaw": 0, "pitch": 75, "zoom": 5.0, "height": 0.95, "mode": "texture", "size": 640},
                  *[{"name": f"head_clay_{y:03d}", "yaw": y, "zoom": 5.5, "height": 0.925, "mode": "clay", "size": 640} for y in (0, 90, 180, 270)],
                  *[{"name": f"head_wire_{y:03d}", "yaw": y, "zoom": 5.5, "height": 0.925, "mode": "wire", "size": 768} for y in (0, 90)],
                  {"name": "close_hands_side", "yaw": 90, "zoom": 3.0, "height": 0.5, "mode": "texture"}],
}
shots = job.get("shots") or PRESETS[job.get("preset", "basic")]

scene = bpy.context.scene
scene.render.engine = "BLENDER_WORKBENCH"
scene.view_settings.view_transform = "Standard"
shading = scene.display.shading
shading.background_type, shading.background_color = "VIEWPORT", (0.62, 0.62, 0.62)

cam_data = bpy.data.cameras.new("cam")
cam_data.type = "ORTHO"
cam = bpy.data.objects.new("cam", cam_data)
scene.collection.objects.link(cam)
scene.camera = cam
full = max(extent.z, max(extent.x, extent.y) * 0.75) * 1.08
distance = max(extent) * 3 + 1

# Trådnät: en kopia av varje del med en Wireframe-modifierare, mörk, som bara syns i läget "wire"
wires = []
for o in meshes:
    w = o.copy()
    w.data = o.data
    scene.collection.objects.link(w)
    mod = w.modifiers.new("wire", "WIREFRAME")
    mod.thickness = max(extent) * 0.0012
    mod.use_replace = True
    w.color = (0.08, 0.08, 0.1, 1)
    wires.append(w)


def set_mode(mode):
    for w in wires:
        w.hide_render = mode != "wire"
    if mode == "texture":
        shading.light, shading.color_type, shading.show_cavity = "FLAT", "TEXTURE", False
    else:
        shading.light, shading.studio_light = "STUDIO", "Default"
        shading.color_type = "OBJECT" if mode == "wire" else "SINGLE"
        shading.single_color = (0.78, 0.78, 0.78)
        for o in meshes:
            o.color = (0.8, 0.8, 0.8, 1)
        shading.show_cavity, shading.cavity_type = True, "BOTH"
        shading.cavity_ridge_factor, shading.cavity_valley_factor = 1.0, 1.6


done = []
for sh in shots:
    s_size = int(sh.get("size", size))
    scene.render.resolution_x, scene.render.resolution_y = s_size, int(s_size * 4 / 3)
    set_mode(sh.get("mode", "texture"))
    # front_yaw: var modellens framsida är (0 = Blenders −Y, som Meshy; 90 = +X, som våra Tripo/Pixal-modeller vända mot +X)
    yaw = math.radians(sh.get("yaw", 0) + float(job.get("front_yaw", 0)))
    pitch = math.radians(max(-89.0, min(89.0, sh.get("pitch", 0))))
    direction = Vector((math.sin(yaw) * math.cos(pitch), -math.cos(yaw) * math.cos(pitch), math.sin(pitch)))
    target = Vector((center.x, center.y, low.z + extent.z * float(sh.get("height", 0.5))))
    cam.location = target + direction * distance
    cam.rotation_euler = (-direction).to_track_quat("-Z", "Y").to_euler()
    cam_data.ortho_scale = full / max(0.5, float(sh.get("zoom", 1)))
    path = out / f"{src.stem}_{'render_' if job.get('preset', 'basic') == 'basic' and not job.get('shots') else 'inspect_'}{sh['name']}.png"
    scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)
    done.append(path.name)

stats = None
if job.get("stats", job.get("preset") == "inspect"):
    # Nätets siffror för granskningen: utan bilder, i modellens egen skala (höjden normeras till 1)
    tris = quads = ngons = boundary = nonmanifold = degenerate = verts = 0
    valence = {}
    parts = 0
    bands = np.zeros(10)
    for o in meshes:
        bm = bmesh.new()
        bm.from_mesh(o.data)
        bm.transform(o.matrix_world)
        # glTF delar hörnen vid varje UV-söm: svetsa ihop dem först, annars ser nätet sönderklippt ut
        bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=max(extent) * 1e-5)
        bm.verts.ensure_lookup_table()
        bm.verts.index_update()
        verts += len(bm.verts)
        for f in bm.faces:
            n = len(f.verts)
            tris += n == 3
            quads += n == 4
            ngons += n > 4
            if f.calc_area() < 1e-12:
                degenerate += 1
            z = (f.calc_center_median().z - low.z) / max(extent.z, 1e-9)
            bands[min(9, max(0, int(z * 10)))] += 1
        for e in bm.edges:
            if e.is_boundary:
                boundary += 1
            elif not e.is_manifold:
                nonmanifold += 1
        for v in bm.verts:
            valence[min(9, len(v.link_edges))] = valence.get(min(9, len(v.link_edges)), 0) + 1
        # Sammanhängande delar: genomgång över kanterna
        seen = set()
        for v in bm.verts:
            if v.index in seen:
                continue
            parts += 1
            stack = [v]
            seen.add(v.index)
            while stack:
                cur = stack.pop()
                for e in cur.link_edges:
                    nb = e.other_vert(cur)
                    if nb.index not in seen:
                        seen.add(nb.index)
                        stack.append(nb)
        bm.free()
    faces = tris + quads + ngons
    stats = {"faces": faces, "triangles_after_triangulation": tris + 2 * quads, "tris": tris, "quads": quads,
             "ngons": ngons, "vertices": verts, "objects": len(meshes), "connected_parts": parts,
             "boundary_edges_holes": boundary, "non_manifold_edges": nonmanifold, "degenerate_faces": degenerate,
             "vertex_valence_histogram": {str(k) + ("+" if k == 9 else ""): v for k, v in sorted(valence.items())}, "height_units": round(extent.z, 4),
             "faces_per_height_band_feet_to_head": [int(b) for b in bands],
             "bbox_width_depth_height": [round(extent.x, 3), round(extent.y, 3), round(extent.z, 3)]}
print("RENDER_RESULT " + json.dumps({"ok": True, "engine": scene.render.engine, "files": done, "stats": stats}), flush=True)
