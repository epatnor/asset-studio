"""Efterbehandlingen av en figur på Darrowmere, som runner-steg (kind "script"): samma kedja som run_after.sh körde på laptopen.

  /data/venv/bin/python -I finish_character.py '{"glb": ..., "name": ..., "out_dir": ...,
      "gamma": 1.3, "clean": true, "mirror_face": true, "game": true, "tris": 12000, "tex": 2048, "voxel": 0.0035}'

Ordning: färggradering (grade_glb.py), lösa bitar bort (clean_floaters.py), ansiktsspegling (mirror_face.py) och
spelmodell (mesh/make_low.py, Blender). Verktygen kopieras hit av deploy_runner.sh. Mellanfilerna hamnar i en
undermapp; i out_dir ligger bara <name>_high.glb och <name>_low_<k>k.glb. Svarar med en rad JSON.
"""
import importlib.util
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
CONF = json.loads((HERE.parent / "runner.json").read_text()) if (HERE.parent / "runner.json").exists() else {}


def tool(args, label):
    r = subprocess.run([sys.executable, "-I", *map(str, args)], capture_output=True, text=True, timeout=3000,
                       env={**os.environ, "BLENDER": CONF.get("blender", "blender")})
    last = next((l for l in reversed(r.stdout.splitlines()) if l.startswith("{")), "")
    if r.returncode or not last:
        raise RuntimeError(f"{label}: {(r.stderr or r.stdout).strip()[-300:]}")
    res = json.loads(last)
    if res.get("ok") is False:
        raise RuntimeError(f"{label}: {str(res.get('error'))[-300:]}")
    return res


def main():
    a = json.loads(sys.argv[1])
    out = Path(a["out_dir"])
    work = out / "work"
    work.mkdir(parents=True, exist_ok=True)
    name = a.get("name") or Path(a["glb"]).stem
    cur, done, info = Path(a["glb"]), [], {}
    gamma = float(a.get("gamma", 1.0))
    if abs(gamma - 1) > 1e-3:
        nxt = work / f"{name}_graded.glb"
        info["grade"] = tool([HERE / "texture/grade_glb.py", cur, nxt, gamma], "grade")
        cur = nxt; done.append(f"gamma {gamma:g}")
    if a.get("clean", True):
        nxt = work / f"{name}_clean.glb"
        res = tool([HERE / "mesh/clean_floaters.py", json.dumps({"in": str(cur), "out": str(nxt), "keep_frac": a.get("keep_frac", 0.02)})], "loose bits")
        cur = nxt; done.append(f"{res.get('removed_tris', 0)} loose triangles removed")
    if a.get("mirror_face") and importlib.util.find_spec("rtree") is None:
        done.append("face mirror skipped: rtree is missing on Darrowmere")   # trimesh.proximity behöver rtree
    elif a.get("mirror_face"):
        nxt = work / f"{name}_mirror.glb"
        tool([HERE / "texture/mirror_face.py", json.dumps({"in": str(cur), "out": str(nxt)})], "face mirror")
        cur = nxt; done.append("face mirrored")
    high = out / f"{name}_high.glb"
    shutil.copyfile(cur, high)
    files = [high.name]
    if a.get("game", True):
        quad = bool(a.get("quad"))
        low = out / f"{name}_{'quad' if quad else 'low'}_{int(a.get('tris', 12000)) // 1000}k.glb"
        res = tool([HERE / "mesh/make_low.py", json.dumps({"high": str(high), "out": str(low), "tris": int(a.get("tris", 12000)),
                                                           "tex": int(a.get("tex", 2048)), "voxel": float(a.get("voxel", 0.0035)),
                                                           "quad": quad, "symmetry": quad})], "game model")
        files.append(low.name)
        if quad and (out / f"{low.stem}_quads.blend").exists():
            files.append(f"{low.stem}_quads.blend")
        done.append(f"game model {res.get('tris', a.get('tris'))} tris" + (f", {res.get('quads')} quads" if quad else ""))
    print(json.dumps({"ok": True, "files": files, "done": done}))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)[-400:]}))
        sys.exit(1)
