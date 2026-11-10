"""Detaljerna från AI-formen (Pixal3D) som normalkarta på MPFB:s UV: nyckelben, navel, revben och de underkläder AI-formen
hade, som svag relief, utan att nätet blir tätare (docs/character-creator.md). Ögonen och brynen tonas bort, så att fransar
och målade bryn inte kommer tillbaka.

  python3 -I tools/character/human/bake_detail.py '{"fit": "build/human/fit/<namn>", "pose": "assets/characters/x/x_pose.glb",
      "rigged": "assets/characters/x/x.glb", "out": "assets/characters/x/x_detail.glb"}'

Recept: fit (inpassningens mapp med wrap_debug.npz: AI-formen och proxyn i samma rum), pose (figuren i inpassningens pose,
med MPFB:s UV), rigged (samma figur riggad), out (ny GLB; skrivs aldrig över), tex (2048), cage (bakningens avstånd i
meter, 0.015), color (hudens grundfärg som hex, "#c9a48c"). Normalkartan hamnar bredvid som <out>_normal.png.
Svarar med en rad JSON.
"""
import json, subprocess, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path.insert(0, str(HERE))
from make_human import blender_cmd  # noqa: E402


def main():
    r = json.loads(sys.argv[1])
    job = {k: str((ROOT / r[k]).resolve()) for k in ("pose", "rigged", "out")}
    job["debug"] = str((ROOT / r["fit"] / "wrap_debug.npz").resolve())
    if Path(job["out"]).exists():
        print(json.dumps({"ok": False, "error": f"{r['out']} finns redan; välj ett nytt namn"}))
        sys.exit(1)
    job.update(tex=int(r.get("tex", 2048)), cage=float(r.get("cage", 0.015)), color=r.get("color", "#c9a48c"))
    run = subprocess.run(blender_cmd() + ["-b", "--factory-startup", "--python-exit-code", "1", "--python", str(HERE / "bake_detail_blender.py"),
                                          "--", json.dumps(job)], capture_output=True, text=True, timeout=3600)
    line = next((l for l in run.stdout.splitlines() if l.startswith("DETAIL_RESULT ")), None)
    if run.returncode or not line:
        print(json.dumps({"ok": False, "error": (run.stderr + run.stdout).strip()[-800:]}))
        sys.exit(1)
    res = json.loads(line[len("DETAIL_RESULT "):])
    for k in ("out", "png"):
        res[k] = str(Path(res[k]).relative_to(ROOT))
    print(json.dumps({"ok": res["align_mm"] < 3 and res["skins"] > 0, **res}))


if __name__ == "__main__":
    main()
