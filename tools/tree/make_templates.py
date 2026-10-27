"""Bygger Smedjans mallar (tools/tree/templates.json) med trädgeneratorn: en tillgång per familj i assets/trees/<id>/.

  python3 -I tools/tree/make_templates.py                      alla mallar
  python3 -I tools/tree/make_templates.py '{"only": ["oak"]}'  bara några

Svarar med en rad JSON: {"built": [...], "failed": [...]} där varje rad har id, tris och checks.ok.
"""
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPEC = ROOT / "tools" / "tree" / "templates.json"


def merge(a, b):
    out = dict(a)
    for k, v in b.items():
        out[k] = merge(out[k], v) if isinstance(v, dict) and isinstance(out.get(k), dict) else v
    return out


def main():
    req = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
    data = json.loads(SPEC.read_text())
    only = set(req.get("only") or [])
    built, failed = [], []
    for kind in ("tree", "bush"):
        for t in data[kind]:
            if only and t["id"] not in only:
                continue
            r = t["recipe"]
            recipe = merge(data["defaults"].get(r["preset"], {}), r)
            recipe["name"] = t["id"]
            out = subprocess.run([sys.executable, "-I", str(ROOT / "tools/tree/make_tree.py"), json.dumps(recipe)],
                                 capture_output=True, text=True, cwd=ROOT)
            try:
                res = json.loads(out.stdout.strip().splitlines()[-1])
                row = {"id": t["id"], "tris": res["tris_lod"][0], "ok": res["checks"]["ok"]}
                (built if row["ok"] else failed).append(row)
            except Exception:
                failed.append({"id": t["id"], "error": (out.stderr or out.stdout).strip()[-300:]})
    print(json.dumps({"built": built, "failed": failed}))


if __name__ == "__main__":
    main()
