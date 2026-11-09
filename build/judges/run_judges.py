"""Vilken bildmodell bedömer texturer på spelobjekt som Patrik? (2026-11-09)
Sju jämförelser där Patrik har sagt vilken textur som är bättre (facit nedan). Varje modell får båda texturerna från samma
kameravinklar (renderade platt i Blender, build/judges/renders/) och referensen, i båda ordningarna (A/B och B/A), och
svarar med en rad JSON. Nyckeln läses ur apparition-moodboard/.env (OPENROUTER_API_KEY) och skrivs aldrig ut.

  uv run --no-project --python 3.12 --with pillow python -I build/judges/run_judges.py [modell ...]
"""
import base64, io, json, os, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image

HERE = Path(__file__).parent
R = HERE / "renders"
ROOT = HERE.parents[1]
MODELS = sys.argv[1:] or ["deepseek/deepseek-v4.1-flash-1017", "z-ai/glm-5.3-flash", "qwen/qwen3.8-flash", "anthropic/claude-haiku-5.5",
                          "openai/gpt-6-luna", "google/gemini-3.8-flash", "openai/gpt-6.1-sol", "anthropic/claude-sonnet-5.5", "google/gemini-4-argon"]
MAREN = ["front", "face", "chest"]
STATUE = ["back", "toga"]
MAREN_REF = [ROOT / "build/maren/ref/maren_ref.png"]
STATUE_REF = [R / f"statue_original_j_{v}.png" for v in STATUE]
# (namn, bättre, sämre, vyer, referens, vad Patrik såg)
CASES = [
    ("statue_4000_vs_6000", "statue_4b_s04000_00001_", "statue_4b_s06000_00001_", STATUE, STATUE_REF, "pattern on the toga visible at 4000, flat at 6000"),
    ("statue_9b_vs_10000", "statue_9b_00001_", "statue_4b_00001_", STATUE, STATUE_REF, "9B carries the folds and carvings, 10000 is flat grey"),
    ("maren_8000_vs_2000", "s08000_MarenPBR_00001_", "s02000_MarenPBR_00001_", MAREN, MAREN_REF, "blotchy and blurry early, better at 8000"),
    ("maren_8000_vs_4000", "s08000_MarenPBR_00001_", "s04000_MarenPBR_00001_", MAREN, MAREN_REF, "better each step up to 8000"),
    ("maren_basedec_vs_researchdec", "s08000_basedec_MarenPBR_00001_", "s08000_MarenPBR_00001_", MAREN, MAREN_REF,
     "base decoder: richer colours, freckles visible"),
    ("maren_antibleed_vs_default", "bake_antibleed_s08000_basedec_srgb", "bake_default_s08000_basedec_srgb", MAREN, MAREN_REF,
     "default bake has spots at the nose and temple and in the hair"),
    ("maren_12views_vs_6views", "rig45_s08000_basedec_g1.3", "bake_antibleed_s08000_basedec_g1.3", MAREN, MAREN_REF,
     "12 views remove most of the brown stain on the scarf and the shadow at the belt"),
]
ASK = ("You judge the textures of stylized 3D game models. Texture A and texture B are painted on the SAME mesh and shown from the SAME "
       "cameras; only the texture differs. The REFERENCE shows what the object should look like. Decide which texture is better for a "
       "game: correct, crisp detail (face features, eyes, fabric, carvings, patterns), no smears, blotches or stray spots, no colour "
       "bleeding from one part onto another (for example a scarf colour on a coat), no baked dark shadows, and faithful to the "
       "reference. Look closely at the close-ups. Reply with JSON only: {\"better\": \"A\" or \"B\", \"confidence\": 0..1, "
       "\"why\": \"one short sentence\"}")


def key():
    for l in open(Path.home() / "Spelutveckling/apparition-moodboard/.env"):
        if l.startswith("OPENROUTER_API_KEY="):
            return l.split("=", 1)[1].strip().strip('"')
    raise SystemExit("no OPENROUTER_API_KEY")


def img(path, size=640):
    im = Image.open(path).convert("RGB"); im.thumbnail((size, size))
    b = io.BytesIO(); im.save(b, "JPEG", quality=85)
    return {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + base64.b64encode(b.getvalue()).decode()}}


def content(case, swap):
    name, good, bad, views, refs, _ = case
    a, b = (bad, good) if swap else (good, bad)
    c = [{"type": "text", "text": ASK}]
    for p in refs:
        c += [{"type": "text", "text": "REFERENCE:"}, img(p)]
    for label, stem in (("A", a), ("B", b)):
        for v in views:
            c += [{"type": "text", "text": f"TEXTURE {label} · {v}:"}, img(R / f"{stem}_j_{v}.png")]
    return c


def ask(model, case, swap, k):
    t0 = time.time()
    body = {"model": model, "messages": [{"role": "user", "content": content(case, swap)}], "temperature": 0,
            "max_tokens": 4000, "response_format": {"type": "json_object"}, "usage": {"include": True}}
    req = urllib.request.Request("https://openrouter.ai/api/v1/chat/completions", json.dumps(body).encode(),
                                 {"Content-Type": "application/json", "Authorization": "Bearer " + k, "X-Title": "Azshara judge test"})
    try:
        r = json.load(urllib.request.urlopen(req, timeout=300))
        out = r["choices"][0]["message"]["content"] or ""
        try:
            j = json.loads(out[out.find("{"): out.rfind("}") + 1])
        except ValueError:   # svar utan giltig JSON: leta efter "better": "A"/"B"
            import re
            m = re.search(r'better"?\s*[:=]\s*"?([AB])', out)
            if not m:
                raise
            j = {"better": m.group(1), "why": "(parsed from text)"}
        pick = str(j.get("better", "")).strip().upper()[:1]
        correct = pick == ("B" if swap else "A")
        return {"model": model, "case": case[0], "swap": swap, "pick": pick, "correct": correct, "why": str(j.get("why", ""))[:200],
                "confidence": j.get("confidence"), "cost": (r.get("usage") or {}).get("cost"), "s": round(time.time() - t0, 1)}
    except Exception as e:
        return {"model": model, "case": case[0], "swap": swap, "error": str(e)[:200], "s": round(time.time() - t0, 1)}


def main():
    k = key()
    jobs = [(m, c, s) for m in MODELS for c in CASES for s in (False, True)]
    with ThreadPoolExecutor(8) as ex:
        res = list(ex.map(lambda j: ask(j[0], j[1], j[2], k), jobs))
    old = json.loads((HERE / "results.json").read_text()) if (HERE / "results.json").exists() else []
    res = [r for r in old if r["model"] not in MODELS] + res
    (HERE / "results.json").write_text(json.dumps(res, indent=1))
    global_models = sorted({r["model"] for r in res}, key=lambda m: [x["model"] for x in res].index(m))
    summary = []
    for m in global_models:
        rs = [r for r in res if r["model"] == m]
        ok = [r for r in rs if "error" not in r]
        both = sum(1 for c in CASES if all(r.get("correct") for r in rs if r["case"] == c[0]) and len([r for r in rs if r["case"] == c[0] and "error" not in r]) == 2)
        summary.append({"model": m, "correct": sum(r["correct"] for r in ok), "answered": len(ok), "of": len(rs),
                        "cases_right_both_orders": both, "picked_A": sum(r["pick"] == "A" for r in ok),
                        "usd": round(sum(r.get("cost") or 0 for r in ok), 4), "avg_s": round(sum(r["s"] for r in ok) / max(1, len(ok)), 1)})
    (HERE / "summary.json").write_text(json.dumps(summary, indent=1))
    print(json.dumps(summary))


if __name__ == "__main__":
    main()
