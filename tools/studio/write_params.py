"""Skriver en params.json med en spak per rad (samma format som för hand), så att diffar blir läsbara.

  python3 -I tools/studio/write_params.py <fil.json>    läser filen, formaterar om den på plats
"""
import json
import sys

ORDER = ["_doc", "generator", "label", "kinds", "species", "parts", "groups", "params"]


def write(path, d):
    keys = [k for k in ORDER if k in d] + [k for k in d if k not in ORDER]
    lines = ["{"]
    for i, k in enumerate(keys):
        v, end = d[k], ("," if i < len(keys) - 1 else "")
        if isinstance(v, list) and v and isinstance(v[0], dict):
            lines.append(f'  "{k}": [')
            lines += ["    " + json.dumps(x, ensure_ascii=False) + ("," if j < len(v) - 1 else "") for j, x in enumerate(v)]
            lines.append("  ]" + end)
        else:
            lines.append(f'  "{k}": {json.dumps(v, ensure_ascii=False)}{end}')
    lines.append("}")
    open(path, "w").write("\n".join(lines) + "\n")


if __name__ == "__main__":
    write(sys.argv[1], json.load(open(sys.argv[1])))
