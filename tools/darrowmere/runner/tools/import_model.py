"""Lägger en färdig modell (gjord någon annanstans, t.ex. på laptopen) i en beställnings utdata, så att runnern kan
rendera och granska den som sina egna. In: {"model": "<sökväg>", "name": "<filnamn utan ändelse>", "out_dir": ...}.
Ut: en rad JSON {"files": [...]}."""
import json
import shutil
import sys
from pathlib import Path

a = json.loads(sys.argv[1])
src = Path(a["model"])
if src.suffix.lower() not in (".glb", ".gltf"):
    raise SystemExit(f"not a glTF model: {src.name}")
name = (a.get("name") or src.stem) + src.suffix.lower()
shutil.copy(src, Path(a["out_dir"]) / name)
print(json.dumps({"files": [name]}))
