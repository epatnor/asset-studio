"""Skriver workshop.json kompakt: en spak, ett färdigt material eller en profil per rad, så att diffar blir läsbara.

  python3 -I tools/texture/write_workshop.py [fil.json]    (standard tools/texture/workshop.json), formaterar om på plats
"""
import json
import sys
from pathlib import Path


def one_line(v):
    s = json.dumps(v, ensure_ascii=False)
    return isinstance(v, dict) and ("key" in v or "recipe" in v) or len(s) <= 220


def fmt(v, ind=0):
    pad = "  " * (ind + 1)
    if not isinstance(v, (dict, list)) or one_line(v):
        return json.dumps(v, ensure_ascii=False)
    if isinstance(v, list):
        return "[\n" + ",\n".join(pad + fmt(x, ind + 1) for x in v) + "\n" + "  " * ind + "]"
    return "{\n" + ",\n".join(f"{pad}{json.dumps(k, ensure_ascii=False)}: {fmt(x, ind + 1)}" for k, x in v.items()) + "\n" + "  " * ind + "}"


if __name__ == "__main__":
    p = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parent / "workshop.json")
    p.write_text(fmt(json.loads(p.read_text())) + "\n")
