"""Den färdiga modellen i The Character Creator (docs/asset-studio.md, flödets sista steg): den riggade figuren (med sina
ändringar, ögon och game_engine-skelett) får hudens material med detaljernas normalkarta (bake_detail.py) och färgen
(transfer_texture.py) i en enda GLB, med kontroller. Alla figurer på grundnätet delar MPFB:s UV, så en karta från figuren
som en ändrad figur byggdes ur (receptets "from") passar också.

  python3 -I tools/character/human/make_final.py '{"name": "syssling_wrap20"}'

Recept: name (figuren i assets/characters/<name>/), normal och color (PNG; "auto" = den senaste bredvid figuren eller dess
ursprung, null = ingen), skin (hudens färg som hex när färgkarta saknas, "#c9a48c"), roughness (0.55), normal_strength (1.0),
out (ny GLB; standard <name>_final.glb, sedan _final_v2 ...; skrivs aldrig över). Skriver också <out>.json med källorna och
kontrollerna. Svarar med en rad JSON.
"""
import json, subprocess, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
CHARS = ROOT / "assets/characters"
sys.path.insert(0, str(HERE))
from make_human import blender_cmd  # noqa: E402


def fail(msg):
    print(json.dumps({"ok": False, "error": msg}))
    sys.exit(1)


def newest(dirs, pattern):
    files = [f for d in dirs if d.is_dir() for f in d.glob(pattern)]
    return max(files, key=lambda f: f.stat().st_mtime) if files else None


def main():
    r = json.loads(sys.argv[1])
    name = r.get("name", "")
    fig = CHARS / name
    rigged = fig / f"{name}.glb"
    if not name or not rigged.exists():
        fail(f"no figure {name!r} in assets/characters")
    recipe = {}
    if (fig / "recipe.json").exists():
        recipe = json.loads((fig / "recipe.json").read_text())
    # Kartorna: figurens egen mapp först, sedan figuren den byggdes ur (samma UV)
    dirs = [fig] + ([CHARS / recipe["from"]] if isinstance(recipe.get("from"), str) and recipe["from"] != "fit" else [])
    src = {}
    for key, pat in (("normal", "*_detail*_normal.png"), ("color", "*_color.png")):
        v = r.get(key, "auto")
        p = newest(dirs, pat) if v == "auto" else (ROOT / v if v else None)
        if p is not None and not p.exists():
            fail(f"{key} map {v} not found")
        src[key] = p
    if r.get("out"):
        out = ROOT / r["out"]
    else:
        out, v = fig / f"{name}_final.glb", 2
        while out.exists():
            out = fig / f"{name}_final_v{v}.glb"; v += 1
    if out.exists():
        fail(f"{out.relative_to(ROOT)} already exists; choose a new name")
    job = {"rigged": str(rigged), "out": str(out), "normal": str(src["normal"]) if src["normal"] else None,
           "color": str(src["color"]) if src["color"] else None, "skin": r.get("skin", "#c9a48c"),
           "roughness": float(r.get("roughness", 0.55)), "normal_strength": float(r.get("normal_strength", 1.0))}
    run = subprocess.run(blender_cmd() + ["-b", "--factory-startup", "--python-exit-code", "1", "--python", str(HERE / "final_blender.py"),
                                          "--", json.dumps(job)], capture_output=True, text=True, timeout=1200)
    line = next((l for l in run.stdout.splitlines() if l.startswith("FINAL_RESULT ")), None)
    if run.returncode or not line or not out.exists():
        fail((run.stderr + run.stdout).strip()[-800:] or "Blender gave no result")
    res = json.loads(line[len("FINAL_RESULT "):])
    # Ytan: vända ytor och självskärning i den färdiga filen (check_normals.mjs)
    cn = subprocess.run(["node", str(ROOT / "tools/mesh/check_normals.mjs"), json.dumps({"paths": [str(out.relative_to(ROOT))]})],
                        capture_output=True, text=True, timeout=600, cwd=ROOT)
    try:
        surf = json.loads(cn.stdout.strip().splitlines()[-1])
    except Exception:
        surf = {"ok": False, "error": (cn.stderr or cn.stdout).strip()[-300:]}
    mb = out.stat().st_size / 1e6
    checks = {
        "rigged": res["bones"] > 0 and res["skinned"],
        "eyes": res["eyes"],
        "normal_map": src["normal"] is None or res["normal_map"],
        "color_map": src["color"] is None or res["color_map"],
        "textures_square": all(w == h and w & (w - 1) == 0 for w, h in res["images"].values()),
        "surface": bool(surf.get("ok")),
        "size_under_40mb": mb < 40,
    }
    relp = lambda p: str(p.relative_to(ROOT)) if p else None
    summary = {"ok": all(checks.values()), "name": name, "out": relp(out), "mb": round(mb, 2), "tris": res["tris"], "bones": res["bones"],
               "height_m": res["height_m"], "normal": relp(src["normal"]), "color": relp(src["color"]),
               "skin": None if src["color"] else job["skin"], "roughness": job["roughness"], "images": res["images"],
               "edits": recipe.get("edits"), "target": recipe.get("target"), "checks": checks,
               "surface": {k: surf.get(k) for k in ("ok", "problems", "bad", "error") if k in surf}}
    out.with_suffix(".json").write_text(json.dumps(summary, indent=1) + "\n")
    print(json.dumps(summary))


if __name__ == "__main__":
    main()
