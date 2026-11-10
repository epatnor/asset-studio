"""Bakar en passning till mallens UV i Blender (Flatpak på värden), genom GPU-kön.

  python3 -I tools/bake.py <namn> <nivå> [--tex 2048] [--targets namn2 ...] [--cpu]

Skriver build/export/<namn>_L<nivå>.glb (mallen, export.py), bakar AI-kroppen build/fit/<namn>_ai.glb till den
(blender/bake_template.py) och lägger kartorna i build/maps/ och den färdiga modellen i out/<namn>_L<nivå>.glb."""
import json, shutil, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]   # asset-studio
HERE = ROOT / "build/body"                    # body-gens arbetsyta: build/, out/, images/ (flyttad 2026-11-10)
TOOLS = Path(__file__).resolve().parent
SPEL = ROOT.parents[1]                        # ~/Spelutveckling (img2mesh, lowpoly-test)
sys.path.insert(0, str(SPEL / "img2mesh"))
import gpuq  # noqa: E402

a = sys.argv[1:]
cpu = "--cpu" in a
tex = int(a[a.index("--tex") + 1]) if "--tex" in a else 2048
targets = a[a.index("--targets") + 1:] if "--targets" in a else []
name, level = a[0], a[1]   # nivån: 1, 2, 3, 6 eller 1f
tag = f"{name}_L{level}"
# Varje försök blir en ny fil: en färdig modell skrivs aldrig över (Patrik, 2026-11-03).
version = 1
while (HERE / f"out/{tag}.glb").exists():
    version += 1
    tag = f"{name}_L{level}_v{version}"
low =HERE / f"build/export/{tag}.glb"
low.parent.mkdir(parents=True, exist_ok=True)
for d in ("build/maps", "out"):
    (HERE / d).mkdir(parents=True, exist_ok=True)
subprocess.run([sys.executable, str(TOOLS / "export.py"), name, str(level), str(low),
                *(["--targets", *targets] if targets else [])], check=True)
args = {"high": str(HERE / f"build/fit/{name}_ai.glb"), "low": str(low), "out": str(HERE / f"out/{tag}.glb"),
        "maps": str(HERE / "build/maps"), "name": tag, "tex": tex, "cpu": cpu}
# Den glesa nivån ligger längre från AI-ytan, så strålarna måste nå längre.
if level == "s":
    args.update(extrusion=0.03, ray=0.09)
pre =["host-spawn"] if shutil.which("host-spawn") else []
cmd = pre + ["flatpak", "run", f"--filesystem={ROOT}", "--device=all", "org.blender.Blender", "--background", "--factory-startup",
             "--python", str(TOOLS / "blender/bake_template.py"), "--", json.dumps(args)]
with gpuq.slot("blender", name, "bake", note=f"L{level} {tex}px", lock=not cpu):
    r = subprocess.run(cmd, capture_output=True, text=True, errors="replace")
line = next((l for l in r.stdout.splitlines() if l.startswith("BODYGEN_RESULT ")), None)
if not line:
    sys.exit(r.stdout[-2000:] + r.stderr[-2000:])
print(line[len("BODYGEN_RESULT "):])
