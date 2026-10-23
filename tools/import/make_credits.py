"""Skriv assets/CREDITS.md från importrecepten (assets/imported/*/recipe.json) och third_party/*/SOURCE.md.

  python3 -I tools/import/make_credits.py

Receptfälten som läses: origin (varifrån modellen kommer, gärna en URL), license (t.ex. CC0-1.0, CC-BY-4.0,
MIT, egen) och author (upphovsperson). Licenser som inte tillåter spel (NC, ND, editorial) och CC-BY utan
upphovsperson räknas som problem. make_import.py kör det här efter varje import.

Svarar med en rad JSON: antal poster och problem per modell.
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "assets" / "CREDITS.md"
FORBIDDEN = re.compile(r"\b(NC|ND|non-?commercial|no-?derivatives|editorial)\b", re.I)
ATTRIBUTION = re.compile(r"\bBY\b", re.I)


def problems(recipe):
    """Det som saknas eller är fel i ett recepts licensuppgifter (tom lista = ok)."""
    lic, out = (recipe.get("license") or "").strip(), []
    if not lic:
        out.append("licens saknas")
    elif FORBIDDEN.search(lic):
        out.append(f"licensen {lic} tillåter inte användning i spelet (NC, ND eller editorial)")
    if not (recipe.get("origin") or "").strip():
        out.append("källa (origin) saknas")
    if ATTRIBUTION.search(lic) and not (recipe.get("author") or "").strip():
        out.append(f"{lic} kräver upphovsperson (author)")
    return out


def cell(text):
    text = (text or "").replace("|", "\\|").strip()
    return f"<{text}>" if text.startswith("http") else text or "–"


def third_party():
    rows = []
    for src in sorted(ROOT.glob("third_party/*/SOURCE.md")):
        text = src.read_text()
        title = next((l[2:].strip() for l in text.splitlines() if l.startswith("# ")), src.parent.name)
        licenses = sorted(set(re.findall(r"\*\*Licens: ([^*]+)\*\*", text))) or ["se SOURCE.md"]
        url = re.search(r"https://\S+?(?=[)\s`]|$)", text)
        rows.append((src.parent.name, title, ", ".join(licenses), url.group(0) if url else "", src.relative_to(ROOT)))
    return rows


def main():
    models = []
    for rec in sorted(ROOT.glob("assets/imported/*/recipe.json")):
        recipe = json.loads(rec.read_text())
        models.append((rec.parent.name, recipe, problems(recipe)))
    tp = third_party()

    lines = ["# Credits", "",
             "Genereras av `tools/import/make_credits.py` från importrecepten och `third_party/*/SOURCE.md`. "
             "Redigera inte för hand: ändra `origin`, `license` och `author` i receptet och importera om.", "",
             "## Importerade modeller", "", "| Modell | Upphovsperson | Licens | Källa |", "|---|---|---|---|"]
    lines += [f"| `{name}` | {cell(r.get('author'))} | {cell(r.get('license'))} | {cell(r.get('origin'))} |" for name, r, _ in models]
    if tp:
        lines += ["", "## Tredjepartsdata", "", "| Mapp | Innehåll | Licens | Källa |", "|---|---|---|---|"]
        lines += [f"| `third_party/{d}` | {cell(t)} | {cell(l)} | {cell(u)} ([SOURCE.md](../{s})) |" for d, t, l, u, s in tp]
    bad = [(name, p) for name, _, p in models if p]
    if bad:
        lines += ["", "## Saknar licensuppgifter", ""] + [f"- `{name}`: {'; '.join(p)}" for name, p in bad]
    OUT.write_text("\n".join(lines) + "\n")
    print(json.dumps({"credits": str(OUT.relative_to(ROOT)), "models": len(models), "third_party": len(tp),
                      "problems": {name: p for name, p in bad}}, ensure_ascii=False))


if __name__ == "__main__":
    main()
