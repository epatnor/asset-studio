"""Bild från en bildmodell via OpenRouter (samma API som Apparition): en rad JSON ut.

  python3 -I tools/texture/openrouter_image.py '<recept>'
  recept: {"prompt": "...", "out": "studio/img/smedjan.png", "model": "openai/gpt-image-2", "aspect": "3:2",
           "refs": ["bild.png", ...]}

Nyckeln är OPENROUTER_API_KEY i miljön, annars i ../apparition-moodboard/.env. Den skrivs aldrig ut. Svaret:
{"out", "model", "cost" (dollar, om OpenRouter anger det), "ms"} eller {"error"}. Varje anrop kostar pengar.
"""
import base64
import json
import mimetypes
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ENV = ROOT.parents[1] / "apparition-moodboard" / ".env"


def api_key():
    if os.environ.get("OPENROUTER_API_KEY"):
        return os.environ["OPENROUTER_API_KEY"]
    if ENV.exists():
        for line in ENV.read_text().splitlines():
            k, _, v = line.partition("=")
            if k.strip() == "OPENROUTER_API_KEY":
                return v.strip().strip("'\"")
    return None


def main():
    r = json.loads(sys.argv[1])
    key = api_key()
    if not key:
        sys.exit(json.dumps({"error": f"ingen OPENROUTER_API_KEY i miljön eller i {ENV}"}))
    out = (ROOT / r["out"]).resolve()
    if ROOT not in out.parents:
        sys.exit(json.dumps({"error": "out måste ligga under projektroten"}))
    body = {"model": r.get("model", "openai/gpt-image-2"), "prompt": r["prompt"], "aspect_ratio": r.get("aspect", "1:1")}
    refs = []
    for f in r.get("refs", []):
        p = (ROOT / f).resolve()
        mime = mimetypes.guess_type(p.name)[0] or "image/png"
        refs.append({"type": "image_url", "image_url": {"url": f"data:{mime};base64,{base64.b64encode(p.read_bytes()).decode()}"}})
    if refs:
        body["input_references"] = refs
    req = urllib.request.Request("https://openrouter.ai/api/v1/images", data=json.dumps(body).encode(), headers={
        "authorization": f"Bearer {key}", "content-type": "application/json",
        "http-referer": "https://github.com/epatnor/asset-studio", "x-title": "Azshara Asset Studio"})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=600) as res:
            j = json.loads(res.read())
    except urllib.error.HTTPError as e:
        msg = e.read().decode(errors="replace")
        try:
            msg = json.loads(msg).get("error", {}).get("message", msg)
        except (ValueError, AttributeError):
            pass
        sys.exit(json.dumps({"error": f"OpenRouter {e.code}: {str(msg)[:300]}"}))
    data = [d for d in j.get("data", []) if d.get("b64_json")]
    if not data:
        sys.exit(json.dumps({"error": "OpenRouter gav ingen bild"}))
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(base64.b64decode(data[0]["b64_json"]))
    cost = (j.get("usage") or {}).get("cost")
    print(json.dumps({"out": str(out.relative_to(ROOT)), "model": body["model"], "cost": cost, "ms": int((time.time() - t0) * 1000)}))


if __name__ == "__main__":
    main()
