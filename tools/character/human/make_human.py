"""Character creator, första versionen: en människa ur ett recept med reglage, på MPFB/MakeHumans grundnät (CC0).
Alla figurer delar topologi, UV-karta och skelett (game_engine, samma ben som Quaternius-animationerna). Plan:
docs/character-creator.md. Reglagen och deras namn: human_sliders.json.

  python3 -I tools/character/human/make_human.py '{"name": "cousin_base", "sex": 0, "age": 25, "weight": 0.35,
      "bust_size": 0.65, "sliders": {"thighs": -0.4, "hips": -0.3}, "pose": "T"}'

Recept: name, makroreglagen (sex, age i år, minst 18, muscle, weight, height, proportions, bust_size, bust_firmness), mons (0..1: skötet, utbuktning och veck vid ljumsken), wrap (inpassningens wrap.npz),
sliders (-1..1, se human_sliders.json), targets (vilket MakeHuman-mål som helst med vikt), macro (råa MPFB-värden),
proxy (standard female1605 eller male1591 efter sex), subdiv (1: proxyn delas en gång, ca 12 700 trianglar; 0: ca 3 200),
eyes ("low-poly"), hair (standard inget: håret blir ett eget lager), rig ("game_engine"), pose ("T", "A" eller vinkel).
Skriver assets/characters/<name>/<name>.glb (riggad), <name>_pose.glb (bakad pose) och recipe.json (receptet). Svarar med en rad JSON med checks.
"""
import json, os, shutil, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
HERE = Path(__file__).resolve().parent


def blender_cmd():
    if os.environ.get("BLENDER"):
        return [os.environ["BLENDER"]]
    if shutil.which("blender"):
        return ["blender"]
    # Utan --factory-startup: MPFB laddas ur de sparade inställningarna (med --addons misslyckas dess register)
    flatpak = ["flatpak", "run", f"--filesystem={ROOT}", "org.blender.Blender"]
    return (["host-spawn"] if shutil.which("host-spawn") else []) + flatpak


def main():
    r = json.loads(sys.argv[1])
    name = r.get("name") or "human"
    out = ROOT / r.get("out_dir", f"assets/characters/{name}")
    job = {"recipe": r, "name": name, "out": str(out), "catalog": str(HERE / "human_sliders.json")}
    run = subprocess.run(blender_cmd() + ["-b", "--python-exit-code", "1", "--python", str(HERE / "human_blender.py"), "--", json.dumps(job)],
                         capture_output=True, text=True, timeout=600)
    line = next((l for l in run.stdout.splitlines() if l.startswith("HUMAN_RESULT ")), None)
    if run.returncode or not line:
        print(json.dumps({"ok": False, "error": (run.stderr or run.stdout).strip()[-500:]}))
        sys.exit(1)
    res = json.loads(line[len("HUMAN_RESULT "):])
    budget = int(r.get("budget", 14000))
    checks = {"feet_on_ground": abs(res["feet_z"]) < 0.01, "symmetric": res["asym_m"] < 0.002 or bool(r.get("asymmetric")),
              "within_budget": res["tris"] <= budget, "rigged": res["bones"] > 0, "adult": float(r.get("age", 25)) >= 18}
    # Receptet bredvid figuren: varje figur är en egen enhet som kan byggas om (studions The Character Creator läser det)
    (out / "recipe.json").write_text(json.dumps({k: v for k, v in r.items() if k != "out_dir"}, indent=1) + "\n")
    print(json.dumps({"ok": all(checks.values()), "checks": checks, **res,
                      "glb": str((out / f"{name}.glb").relative_to(ROOT)), "pose_glb": str((out / f"{name}_pose.glb").relative_to(ROOT))}))


if __name__ == "__main__":
    main()
