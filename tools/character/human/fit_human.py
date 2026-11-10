"""Character creatorns inpassning, omgång 1 (docs/character-creator.md): letar fram reglagevärdena som gör MPFB:s
grundnät likt en AI-form (Pixal3D-GLB) och bygger figuren med make_human.py.

  python3 -I tools/character/human/fit_human.py '{"name": "cousin_fit", "target": "<pixal3d.glb>", "sex": 0}'

Recept: name, target (GLB), sex (låst), age (låst, år), wrap (standard true: grundnätet tight mot AI-ytan efter reglagen,
sparat som wrap.npy och shape key), symmetric (standard true), fine (standard true: två finare steg), ignore_hair (standard false: AI-formen har hår; skalan efter halsen, hjässan följer MPFB), subdiv (proxyns uppdelning, 1), övriga makron som startvärden, fit_macros (standard muscle,
weight, proportions, bust_size), skip_sliders, iterations (5), reg (dragningen mot standardvärdena, 1e-5).
Skriver build/human/fit/<name>/recipe.json och overlay.png (före och efter: rött = AI, blått = mallen, vitt = båda),
och figuren i assets/characters/<name>/ (eller out_dir). Svarar med en rad JSON.
"""
import json, shutil, subprocess, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path.insert(0, str(HERE))
from make_human import blender_cmd  # noqa: E402


def main():
    r = json.loads(sys.argv[1])
    name = r.get("name") or "fit"
    target = Path(r["target"]).expanduser().resolve()
    out = ROOT / "build/human/fit" / name
    job = {**{k: v for k, v in r.items() if k in ("fit_macros", "skip_sliders", "iterations", "reg", "wrap", "symmetric", "fine", "subdiv", "elbows", "ignore_hair")},
           "start": r, "target": str(target), "out": str(out), "catalog": str(HERE / "human_sliders.json")}
    cmd = blender_cmd()
    if cmd[:1] == ["host-spawn"] or cmd[:1] == ["flatpak"]:
        cmd.insert(cmd.index("org.blender.Blender"), f"--filesystem={target.parent}:ro")
    run = subprocess.run(cmd + ["-b", "--python-exit-code", "1", "--python", str(HERE / "fit_blender.py"), "--", json.dumps(job)],
                         capture_output=True, text=True, timeout=1800)
    line = next((l for l in run.stdout.splitlines() if l.startswith("FIT_RESULT ")), None)
    if run.returncode or not line:
        print(json.dumps({"ok": False, "error": (run.stderr + run.stdout).strip()[-800:]}))
        sys.exit(1)
    fit = json.loads(line[len("FIT_RESULT "):])
    recipe = {**fit["recipe"], "name": name}
    if r.get("subdiv") is not None:   # samma uppdelning av proxyn som i wrapen
        recipe["subdiv"] = int(r["subdiv"])
    if r.get("out_dir"):
        recipe["out_dir"] = r["out_dir"]
    made = subprocess.run([sys.executable, "-I", str(HERE / "make_human.py"), json.dumps(recipe)], capture_output=True, text=True)
    human = json.loads(made.stdout.strip().splitlines()[-1]) if made.stdout.strip() else {"ok": False, "error": made.stderr[-400:]}
    better = fit["end"]["mean_mm"] < fit["start"]["mean_mm"]
    print(json.dumps({"ok": bool(human.get("ok")) and better, "checks": {**human.get("checks", {}), "closer_than_start": better},
                      "recipe": recipe, "ai_transform": fit.get("ai_transform"), "start": fit["start"], "end": fit["end"], "wrap": fit.get("wrap"), "overlay": str(Path(fit["overlay"]).relative_to(ROOT)),
                      "glb": human.get("glb"), "pose_glb": human.get("pose_glb")}))


if __name__ == "__main__":
    main()
