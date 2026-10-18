"""3D-modell ur flera vyer med Tripo (P1, multiview-to-model) -> build/tripo/<name>/<name>.glb

  python3 -I tools/tripo/make_tripo.py '{"name": "male_ref", "views": {"front": "a.png", "left": "b.png", "right": "c.png"}, "face_limit": 8000, "dry_run": true}'

Receptfält: name, views (front krävs, plus left/back/right; PNG eller JPEG upp till 20 MB), face_limit (50–20000),
texture (standard true), pbr (standard true), texture_quality (standard "standard"), model (standard "P1-20260311"),
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
    if "front" not in views or len(views) < 2:
        sys.exit(json.dumps({"ok": False, "error": "front krävs, och minst två vyer"}))
    texture = bool(r.get("texture", True) or r.get("pbr", True))
    quality = r.get("texture_quality", "standard")
    cost = PRICE["base"][texture] + (PRICE["quality"].get(quality, 0) if texture else 0)
    key = api_key()
    if not key:
        sys.exit(json.dumps({"ok": False, "error": "TRIPO_API_KEY saknas (miljön eller .env)"}))
    if r.get("dry_run"):
        print(json.dumps({"ok": True, "dry_run": True, "name": name, "views": sorted(views), "estimated_credits": cost, "balance": balance(key)}))
        return
    tokens = {v: upload(key, ROOT / p if not os.path.isabs(p) else p) for v, p in views.items()}
    body = {"inputs": [{v: t} for v, t in tokens.items()], "model": r.get("model", "P1-20260311"), "texture": texture,
            "pbr": bool(r.get("pbr", True)), "texture_quality": quality}
    if r.get("face_limit"):
        body["face_limit"] = int(r["face_limit"])
    sub = request("POST", "/v3/generation/multiview-to-model", key, json.dumps(body).encode(), {"Content-Type": "application/json"})
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
    glb = out_dir / f"{name}.glb"
    with urllib.request.urlopen(url, timeout=120) as resp:
        glb.write_bytes(resp.read())
    if out.get("rendered_image_url"):
        try:
            with urllib.request.urlopen(out["rendered_image_url"], timeout=60) as resp:
                (out_dir / f"{name}_render.webp").write_bytes(resp.read())
        except Exception:
            pass
    (out_dir / "task.json").write_text(json.dumps({"task_id": task, "request": {k: v for k, v in body.items() if k != "inputs"}, "views": views,
                                                   "consumed_credit": data.get("consumed_credit")}, indent=2))
    print(json.dumps({"ok": True, "name": name, "glb": str(glb.relative_to(ROOT)), "task_id": task, "seconds": round(time.time() - t0),
                      "consumed_credit": data.get("consumed_credit"), "estimated_credits": cost}))


if __name__ == "__main__":
    main()
