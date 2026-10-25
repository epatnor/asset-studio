"""3D-modell ur flera vyer med Tripo (P1, multiview-to-model) -> build/tripo/<name>/<name>.glb

  python3 -I tools/tripo/make_tripo.py '{"name": "male_ref", "views": {"front": "a.png", "left": "b.png", "right": "c.png"}, "face_limit": 8000, "dry_run": true}'

Receptfält: name, views (front krävs, plus left/back/right; PNG eller JPEG upp till 20 MB; bara front ger
image-to-model, flera vyer multiview-to-model), face_limit (50–20000),
texture (standard true), pbr (standard true), texture_quality (standard "standard"), model (standard "P1-20260311";
"P2-20260801" för P2), quad (bara P2: riktigt quadnät, face_limit räknas i quads),
dry_run (true: visa beräknat pris och kontots saldo, skicka ingenting).

Nyckeln läses ur TRIPO_API_KEY i miljön eller i projektets .env och skrivs aldrig ut. Bilderna laddas upp till
Tripo (POST /v3/files), uppgiften skickas (POST /v3/generation/multiview-to-model) och hämtas tills den är klar;
modell-URL:er gäller bara 5 minuter, så GLB-filen laddas ned direkt. Svarar med en rad JSON.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
API = "https://openapi.tripo3d.ai"
# Pris enligt Tripos prislista (docs.tripo3d.ai/get-started/pricing.html): P1 multiview 40 utan textur, 50 med;
# texture_quality standard +10, detailed +20, extreme +30
PRICE = {"base": {False: 40, True: 50}, "quality": {"fast": 0, "standard": 10, "detailed": 20, "extreme": 30}}
# P2 (developers.tripo3d.com changelog): 100 utan textur; med textur standard/detailed/extreme 110/120/130
PRICE_P2 = {"base": {False: 100, True: 100}, "quality": {"fast": 0, "standard": 10, "detailed": 20, "extreme": 30}}


def api_key():
    if os.environ.get("TRIPO_API_KEY"):
        return os.environ["TRIPO_API_KEY"].strip()
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            if line.startswith("TRIPO_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return ""


def request(method, path, key, body=None, headers=None, base=API):
    req = urllib.request.Request(base + path, data=body, method=method, headers={"Authorization": f"Bearer {key}", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return {"code": e.code, "error": e.read().decode("utf8", "replace")[:300]}


def balance(key):
    # v3 saknar dokumenterad saldoändpunkt i snabbstarten; prova v3 och sedan v2
    for base, path in ((API, "/v3/account/balance"), (API, "/v3/wallet"), ("https://api.tripo3d.ai", "/v2/openapi/user/balance")):
        r = request("GET", path, key, base=base)
        if r.get("code") == 0:
            return r.get("data")
    return None


def upload(key, path):
    boundary = uuid.uuid4().hex
    data = Path(path).read_bytes()
    mime = "image/png" if str(path).lower().endswith(".png") else "image/jpeg"
    body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{Path(path).name}\"\r\n"
            f"Content-Type: {mime}\r\n\r\n").encode() + data + f"\r\n--{boundary}--\r\n".encode()
    r = request("POST", "/v3/files", key, body, {"Content-Type": f"multipart/form-data; boundary={boundary}"})
    if r.get("code") != 0:
        raise RuntimeError(f"upload {Path(path).name}: {r}")
    return r["data"]["file_token"]


def main():
    r = json.loads(sys.argv[1])
    name, views = r["name"], r["views"]
    if "front" not in views:
        sys.exit(json.dumps({"ok": False, "error": "front krävs"}))
    single = len(views) == 1  # bara framvyn: image-to-model i stället för multiview-to-model
    texture = bool(r.get("texture", True) or r.get("pbr", True))
    quality = r.get("texture_quality", "standard")
    model = r.get("model", "P1-20260311")
    pr = PRICE_P2 if model.upper().startswith("P2") else PRICE
    cost = pr["base"][texture] + (pr["quality"].get(quality, 0) if texture else 0)
    key = api_key()
    if not key:
        sys.exit(json.dumps({"ok": False, "error": "TRIPO_API_KEY saknas (miljön eller .env)"}))
    if r.get("dry_run"):
        print(json.dumps({"ok": True, "dry_run": True, "name": name, "views": sorted(views), "mode": "image-to-model" if single else "multiview-to-model",
                          "estimated_credits": cost, "balance": balance(key)}))
        return
    tokens = {v: upload(key, ROOT / p if not os.path.isabs(p) else p) for v, p in views.items()}
    body = {"model": model, "texture": texture, "pbr": bool(r.get("pbr", True)), "texture_quality": quality}
    if single:
        body["input"] = tokens["front"]
    else:
        body["inputs"] = [{v: t} for v, t in tokens.items()]
    if r.get("face_limit"):
        body["face_limit"] = int(r["face_limit"])
    if r.get("quad"):
        body["quad"] = True  # bara P2; face_limit räknas då i quads (48–25000)
    endpoint = "/v3/generation/image-to-model" if single else "/v3/generation/multiview-to-model"
    sub = request("POST", endpoint, key, json.dumps(body).encode(), {"Content-Type": "application/json"})
    if sub.get("code") != 0:
        sys.exit(json.dumps({"ok": False, "error": sub}))
    task = sub["data"]["task_id"]
    t0 = time.time()
    while True:
        st = request("GET", f"/v3/tasks/{task}", key)
        status = st.get("data", {}).get("status")
        if status == "success":
            break
        if status in ("failed", "cancelled", "banned", "expired") or time.time() - t0 > 900:
            sys.exit(json.dumps({"ok": False, "task_id": task, "status": status, "data": st.get("data")}))
        time.sleep(3)
    data = st["data"]
    out = data.get("output", {})
    url = out.get("model_url") or out.get("pbr_model") or out.get("model")
    out_dir = ROOT / "build" / "tripo" / name
    out_dir.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(url, timeout=120) as resp:
        blob = resp.read()
    # P2 med quads levererar FBX (glTF har inga quads); välj ändelse efter innehållet
    ext = ".fbx" if blob[:18] == b"Kaydara FBX Binary" else ".glb" if blob[:4] == b"glTF" else ".bin"
    glb = out_dir / f"{name}{ext}"
    glb.write_bytes(blob)
    if out.get("rendered_image_url"):
        try:
            with urllib.request.urlopen(out["rendered_image_url"], timeout=60) as resp:
                (out_dir / f"{name}_render.webp").write_bytes(resp.read())
        except Exception:
            pass
    (out_dir / "task.json").write_text(json.dumps({"task_id": task, "request": {k: v for k, v in body.items() if k not in ("inputs", "input")}, "views": views,
                                                   "consumed_credit": data.get("consumed_credit")}, indent=2))
    print(json.dumps({"ok": True, "name": name, "glb": str(glb.relative_to(ROOT)), "task_id": task, "seconds": round(time.time() - t0),
                      "consumed_credit": data.get("consumed_credit"), "estimated_credits": cost}))


if __name__ == "__main__":
    main()
