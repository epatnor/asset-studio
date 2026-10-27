"""Skriver tools/vfx/vfx.json med en spak eller ett recept per rad, så att filen går att läsa och jämföra i git.

Kör: python3 -I tools/vfx/write_vfx.py   (läser vfx.json, skriver tillbaka den formaterad)
"""
import json
import sys
from pathlib import Path

FILE = Path(__file__).with_name('vfx.json')


def one(x):
    return json.dumps(x, ensure_ascii=False)


def write(data):
    out = ['{', f'  "_doc": {one(data["_doc"])},', '  "kinds": [']
    for i, k in enumerate(data['kinds']):
        out.append('    {')
        out.append(f'      "id": {one(k["id"])}, "label": {one(k["label"])}, "help": {one(k["help"])},')
        out.append('      "groups": [')
        out.append(',\n'.join(f'        {one(g)}' for g in k['groups']))
        out.append('      ],')
        out.append('      "params": [')
        out.append(',\n'.join(f'        {one(q)}' for q in k['params']))
        out.append('      ]')
        out.append('    }' + (',' if i < len(data['kinds']) - 1 else ''))
    out.append('  ],')
    if 'spells' in data:
        # Besvärjelsernas tidslinjer: ett lager per rad
        out.append('  "spells": {')
        names = list(data['spells'])
        for i, n in enumerate(names):
            sp = data['spells'][n]
            head = {k: v for k, v in sp.items() if k != 'layers'}
            out.append(f'    {one(n)}: {{')
            for k, v in head.items():
                out.append(f'      {one(k)}: {one(v)},')
            out.append('      "layers": [')
            out.append(',\n'.join(f'        {one(L)}' for L in sp['layers']))
            out.append('      ]')
            out.append('    }' + (',' if i < len(names) - 1 else ''))
        out.append('  },')
    out.append('  "presets": {')
    kinds = list(data['presets'])
    for i, kind in enumerate(kinds):
        out.append(f'    {one(kind)}: {{')
        items = list(data['presets'][kind].items())
        out.append(',\n'.join(f'      {one(n)}: {one(v)}' for n, v in items))
        out.append('    }' + (',' if i < len(kinds) - 1 else ''))
    out.append('  }')
    out.append('}')
    FILE.write_text('\n'.join(out) + '\n')


if __name__ == '__main__':
    write(json.loads(FILE.read_text()))
    print(json.dumps({'ok': True, 'file': str(FILE.relative_to(Path.cwd())) if FILE.is_relative_to(Path.cwd()) else str(FILE)}))
    sys.exit(0)
