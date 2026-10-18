"""Konceptbild av en arketyp med Krea-2: python3 -I concept.py '{"archetype":"hero","seed":1}'

Prompten byggs ur characters.json (concept, heads, frisyr, kläder, färger valda med seed) följt av
prompt.character_art och prompt.character_remove i style.json. Bilden är en referens för proportioner
och färger, inte en textur. Ut: build/character/concepts/<archetype>_<seed>.png och en rad JSON."""
import json, os, random, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
HERE = os.path.join(ROOT, "tools", "character")

# Färgnamn som bildmodellen förstår; hex mappas till närmaste.
NAMES = {
    "dark brown": "#3B2A20", "brown": "#6B4A2E", "tan": "#B98260", "silver gray": "#D2CBC0", "cream": "#E2D8C4", "light gray": "#B0AAA2",
    "charcoal": "#33343A", "slate gray": "#5B595D", "slate blue": "#4D6478", "navy blue": "#1C3453",
    "forest green": "#3F5443", "olive green": "#6E8C4A", "umber": "#5A4636", "auburn": "#9A5228",
    "black": "#22201E", "blonde": "#C9A060", "steel blue": "#4C7A9E", "moss green": "#5E7A3E",
    "crimson": "#B3263A", "gold": "#D9A423", "cyan": "#3FC6CF", "violet": "#8A4FD8", "orange": "#E07A1F",
    "emerald green": "#2FA866", "teal": "#3E859C",
}
SKIN = {"fair": "#F0C29E", "light": "#E9B48A", "tan": "#C98E64", "brown": "#8D5A3B", "green": "#6E8C4A"}
# Förenklat hår: några få stora, släta former (som hårgeneratorn bygger), inga enskilda strån
HAIR = {"bald": "bald head", "short": "short simplified {} hair in a few smooth chunky shapes",
        "spiky": "short simplified {} hair swept back in a few large smooth chunky locks",
        "bob": "simplified {} bob haircut as one smooth rounded shape",
        "bun": "simplified {} hair in a smooth shape tied up in a round bun",
        "long": "shoulder-length simplified {} hair as one smooth draped shape framing the face"}
SLEEVES = ["sleeveless tunic", "short-sleeved tunic", "long-sleeved tunic"]
PANTS = ["shorts", "knee-length breeches", "trousers"]
BOOTS = ["simple shoes", "mid-calf leather boots", "knee-high leather boots"]


def rgb(h):
    return [int(h[i:i + 2], 16) for i in (1, 3, 5)]


def name(h, table=NAMES):
    c = rgb(h)
    return min(table, key=lambda n: sum((a - b) ** 2 for a, b in zip(c, rgb(table[n]))))


def build_prompt(a, seed):
    r = random.Random(seed)
    col = {k: r.choice(v) for k, v in a["colors"].items()}
    accent_on = r.choice(a["accentOn"])
    n = {k: name(v) for k, v in col.items()}
    for region in ("cloth", "shoes"):
        if accent_on == region:
            n[region] = n["accent"]
    parts = [
        f"{a['concept']}, full body from head to toe, standing hero pose, three-quarter view",
        f"stylized proportions about {a['heads']:g} heads tall",
        f"{name(col['skin'], SKIN)} skin",
        HAIR[a["hair"]].format(n["hair"]),
        f"{n['eyes']} eyes",
    ]
    if a["ears"] == "pointy":
        parts.append("large pointed ears")
    if a["beard"] > 0.7:
        parts.append(f"a big full {n['hair']} beard")
    elif a["beard"] > 0.3:
        parts.append(f"a short trimmed {n['hair']} beard")
    parts.append(f"{n['cloth']} {SLEEVES[a['sleeves']]}")
    parts.append(f"{n['pants']} {PANTS[a['pants']]}")
    parts.append(f"{n['shoes']} {BOOTS[a['boots']]}")
    if accent_on == "trim":
        parts.append(f"{n['accent']} trim on the hems as the only saturated accent")
    elif accent_on == "belt":
        parts.append(f"a {n['accent']} belt as the only saturated accent")
    elif accent_on == "shoes":
        parts.append(f"the {n['accent']} shoes are the only saturated accent")
    else:
        parts.append(f"the {n['accent']} tunic is the only saturated accent")
    return ", ".join(parts), col, accent_on


def main():
    rec = json.loads(sys.argv[1])
    arche = rec["archetype"]
    seed = int(rec.get("seed", 1))
    w, h = int(rec.get("w", 768)), int(rec.get("h", 1152))
    a = json.load(open(os.path.join(HERE, "characters.json")))[arche]
    st = json.load(open(os.path.join(ROOT, "tools", "style.json")))["prompt"]
    subject, col, accent_on = build_prompt(a, seed)
    prompt = f"{subject}. {st['character_art']} {st['character_remove']}"
    out = os.path.join(ROOT, "build", "character", "concepts", f"{arche}_{seed}.png")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    p = subprocess.run([sys.executable, "-I", os.path.join(ROOT, "tools", "texture", "krea2.py"), prompt, str(w), str(h), out, str(seed)],
                       capture_output=True, text=True)
    if p.returncode:
        print(json.dumps({"ok": False, "error": (p.stderr or p.stdout)[-500:]}))
        sys.exit(1)
    print(json.dumps({"ok": True, "path": os.path.relpath(out, ROOT), "seed": seed, "subject": subject, "colors": col, "accentOn": accent_on}))


if __name__ == "__main__":
    main()
