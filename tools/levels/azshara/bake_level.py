"""Azshara Island som Tinkertown-bana: höjder, masker och platser -> assets/levels/azshara/.

  python3 -I tools/levels/azshara/bake_level.py <export-mapp>

Exporten gjordes en gång ur Azshara Islands terränggenerator (Godot, export_from_godot.gd, 2026-10-19):
heights.f32 (785 × 785 float32), masks_0..2.png (zone, path, stream / lake, beach, cliff / rock, plot, ledge)
och meta.json (bäck, stig, sjö, vattenfall, bro, hus och lyktor). Höjderna kvantiseras här till uint16
(min/max i level.json), så att banan laddar snabbt. Svarar med en rad JSON.
"""
import json
import shutil
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "assets" / "levels" / "azshara"


def main():
    src = Path(sys.argv[1])
    meta = json.loads((src / "meta.json").read_text())
    raw = (src / "heights.f32").read_bytes()
    n = meta["cells"] + 1
    h = struct.unpack(f"<{n * n}f", raw)
    lo, hi = min(h), max(h)
    q = bytearray(n * n * 2)
    for i, v in enumerate(h):
        struct.pack_into("<H", q, i * 2, round((v - lo) / (hi - lo) * 65535))
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "heights.u16").write_bytes(bytes(q))
    for i in range(3):
        shutil.copy(src / f"masks_{i}.png", OUT / f"masks_{i}.png")
    meta.update({"n": n, "height_min": lo, "height_max": hi, "heights": "heights.u16", "source": "Azshara Island terrain generator (Godot), exported 2026-10-19"})
    (OUT / "level.json").write_text(json.dumps(meta, ensure_ascii=False))
    land = sum(1 for v in h if v > 0)
    print(json.dumps({"level": str(OUT.relative_to(ROOT)), "n": n, "height": [round(lo, 2), round(hi, 2)], "land_share": round(land / len(h), 3),
                      "houses": len(meta["houses"]), "lanterns": len(meta["lanterns"]), "stream_points": len(meta["stream"]["points"]), "path_points": len(meta["path"]["points"])}))


if __name__ == "__main__":
    main()
