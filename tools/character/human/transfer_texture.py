"""Texturen från en texturerad figur (t.ex. UltraTex, med egen UV) bakas till MPFB:s egen UV och läggs på den riggade
figuren, så att färgen följer med riggen och blir densamma för alla kroppar på grundnätet (docs/character-creator.md).

  python3 -I tools/character/human/transfer_texture.py '{"source": "<texturerad.glb>", "pose": "assets/characters/x/x_pose.glb",
      "rigged": "assets/characters/x/x.glb", "out": "assets/characters/x/x_tex.glb"}'

Recept: source (texturerad modell i samma pose som pose-filen; flyttning räknas bort efter omslutande låda), pose (MPFB-figuren
i referensens pose, med MPFB:s UV), rigged (samma figur riggad, i vilopose), out (ny GLB; skrivs aldrig över), tex (2048),
cage (bakningens avstånd i meter, 0.02), margin (påfyllning runt öarna i pixlar, 16). Färgen bakas i Blender (Cycles, CPU)
från källans basfärg; ögonen behåller MPFB:s egna. Bilden hamnar bredvid som <out>_color.png. Svarar med en rad JSON.
"""
import json, subprocess, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path.insert(0, str(HERE))
from make_human import blender_cmd  # noqa: E402


def main():
    r = json.loads(sys.argv[1])
    job = {k: str((ROOT / r[k]).resolve()) for k in ("source", "pose", "rigged", "out")}
    if Path(job["out"]).exists():
        print(json.dumps({"ok": False, "error": f"{r['out']} finns redan; välj ett nytt namn"}))
        sys.exit(1)
    job.update(tex=int(r.get("tex", 2048)), cage=float(r.get("cage", 0.02)), margin=int(r.get("margin", 16)))
    Path(job["out"]).parent.mkdir(parents=True, exist_ok=True)
    cmd = blender_cmd()
    if "org.blender.Blender" in cmd:
        for k in ("source", "pose", "rigged"):   # bara mappar utanför projektet (projektet är redan skrivbart)
            if ROOT not in Path(job[k]).parents:
                cmd.insert(cmd.index("org.blender.Blender"), f"--filesystem={Path(job[k]).parent}:ro")
    run = subprocess.run(cmd + ["-b", "--factory-startup", "--python-exit-code", "1", "--python", str(HERE / "transfer_blender.py"), "--",
                                json.dumps(job)], capture_output=True, text=True, timeout=1800)
    line = next((l for l in run.stdout.splitlines() if l.startswith("TRANSFER_RESULT ")), None)
    if run.returncode or not line:
        print(json.dumps({"ok": False, "error": (run.stderr + run.stdout).strip()[-800:]}))
        sys.exit(1)
    res = json.loads(line[len("TRANSFER_RESULT "):])
    for k in ("out", "png"):
        res[k] = str(Path(res[k]).relative_to(ROOT))
    print(json.dumps({"ok": res["coverage"] > 0.95 and res["skins"] > 0, **res}))


if __name__ == "__main__":
    main()
