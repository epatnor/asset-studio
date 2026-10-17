"""Körs av Blender headless: läser en modell (FBX, OBJ, DAE, blend, STL, PLY) och skriver GLB.

  blender --background --python to_glb.py -- <in> <ut.glb>
"""
import sys
from pathlib import Path

import bpy

src, dst = sys.argv[sys.argv.index("--") + 1:][:2]
ext = Path(src).suffix.lower()
if ext == ".blend":
    bpy.ops.wm.open_mainfile(filepath=src)
else:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    importers = {
        ".fbx": lambda: bpy.ops.import_scene.fbx(filepath=src),
        ".obj": lambda: bpy.ops.wm.obj_import(filepath=src),
        ".dae": lambda: bpy.ops.wm.collada_import(filepath=src),
        ".stl": lambda: bpy.ops.wm.stl_import(filepath=src),
        ".ply": lambda: bpy.ops.wm.ply_import(filepath=src),
    }
    if ext not in importers:
        sys.exit(f"okänt format {ext}")
    importers[ext]()
bpy.ops.export_scene.gltf(filepath=dst, export_format="GLB", export_apply=True, export_yup=True)
