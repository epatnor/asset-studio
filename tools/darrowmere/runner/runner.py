"""Darrowmeres beställningsrunner: kör beställningar steg för steg på Darrowmere, så att Andorhal kan stängas.

Körs som tjänsten darrowmere-runner (install_runner.sh) med ComfyUI:s venv:
  /data/venv/bin/python -I /data/runner/runner.py            (loopen)
  /data/venv/bin/python -I /data/runner/runner.py --once     (en genomgång, för test)

En beställning läggs i /data/orders/inbox/<id>.json av tools/darrowmere/order.py, med indata i /data/orders/<id>/in/.
Stegen körs i ordning:
  comfy    ett ComfyUI-flöde ("graph"). Strängar "$in:<namn>" byts mot beställningens indata och "$step:<nyckel>"
           mot första bilden från ett tidigare steg (båda laddas upp till ComfyUI:s indata). Vid omkörning ändras fröna.
  review   DeepSeek (OpenRouter, modellen i runner.json) granskar bilder mot referenser och kriterier och svarar
           godkänt/underkänt. "retry": {"step": <nyckel>, "max": 2} kör om steget med nytt frö när bilden underkänns.
  manual   ett steg som görs någon annanstans (Blender på Andorhal, rigg …); markeras som väntande och hoppas över.
Läget sparas i /data/orders/<id>/state.json (runnern fortsätter efter omstart) och som pipeline-fil i
/data/utdata/pipelines/<id>.json, som kontrollpanelen visar. Färdiga ComfyUI-jobb levereras av deliver.py som vanligt.
En fil /data/orders/<id>/cancel stoppar beställningen före nästa steg.
"""
import base64
import copy
import io
import json
import os
import shutil
import sys
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
CONF = json.loads((HERE / "runner.json").read_text())
COMFY = CONF.get("comfy", "http://127.0.0.1:8188")
ORDERS = Path(CONF.get("orders", "/data/orders"))
OUTPUT = Path(CONF.get("output", "/data/utdata"))
PIPES = OUTPUT / "pipelines"


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def env_key(name="OPENROUTER_API_KEY"):
    env = HERE / ".env"
    for line in (env.read_text().splitlines() if env.exists() else []):
        if line.startswith(name + "="):
            v = line.split("=", 1)[1].strip().strip('"').strip("'")
            if v:
                return v
    raise RuntimeError(f"{name} is not set (Settings → API keys in the control panel)")


# Inställningarna som kontrollpanelens Settings-sida skriver: lokalt eller moln per sorts jobb, granskning och budget
DEFAULTS = CONF["defaults"]  # samma standardvärden visas på Settings-sidan


def settings():
    s = copy.deepcopy(DEFAULTS)
    try:
        saved = json.loads((HERE / "settings.json").read_text())
    except (OSError, ValueError):
        saved = {}
    for k, v in saved.items():
        if isinstance(v, dict) and isinstance(s.get(k), dict):
            for k2, v2 in v.items():
                if isinstance(v2, dict) and isinstance(s[k].get(k2), dict):
                    s[k][k2].update(v2)
                else:
                    s[k][k2] = v2
    return s


def http_json(url, body=None, headers=None, timeout=60):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json", **(headers or {})})
    return json.load(urllib.request.urlopen(req, timeout=timeout))


# ---- läget -------------------------------------------------------------------------------------------------------

class Order:
    def __init__(self, oid):
        self.dir = ORDERS / oid
        self.order = json.loads((self.dir / "order.json").read_text())
        sf = self.dir / "state.json"
        self.state = json.loads(sf.read_text()) if sf.exists() else {
            "status": "queued", "created": time.time(),
            "steps": {s["key"]: {"status": "planned", "attempt": 0} for s in self.order["steps"]}}
        self.id = oid

    def st(self, key):
        return self.state["steps"][key]

    def save(self):
        tmp = self.dir / "state.tmp"
        tmp.write_text(json.dumps(self.state, indent=1))
        tmp.replace(self.dir / "state.json")
        # Pipeline-filen som panelen läser: planens steg med status, tider, jobb och anteckningar
        steps = []
        for s in self.order["steps"]:
            t = self.st(s["key"])
            steps.append({"key": s["key"], "label": s.get("label", s["key"]),
                          "where": s.get("where", "darrowmere"), "kind": s["kind"],
                          "status": t["status"], "start": t.get("start"), "end": t.get("end"),
                          "note": t.get("note"), **({"job": t["job"]} if t.get("job") else {}),
                          **({"files": t["files"]} if t.get("files") else {}), **({"route": t["route"]} if t.get("route") else {}),
                          **({"estimate": t["estimate"]} if t.get("status") == "approval" else {})})
        PIPES.mkdir(parents=True, exist_ok=True)
        body = {"id": self.id, "title": self.order.get("title", self.id), "created": self.state["created"], "updated": time.time(),
                "project": self.order.get("project"), "asset": self.order.get("asset"), "use": self.order.get("use"),
                "order_status": self.state["status"], "steps": steps}
        tmp = PIPES / f".{self.id}.tmp"
        tmp.write_text(json.dumps(body, ensure_ascii=False))
        tmp.replace(PIPES / f"{self.id}.json")

    def set(self, key, **kw):
        self.st(key).update(kw)
        self.save()


# ---- ComfyUI -----------------------------------------------------------------------------------------------------

def upload(path, oid):
    b = uuid.uuid4().hex
    parts = [(f"--{b}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"{path.name}\"\r\n"
              f"Content-Type: application/octet-stream\r\n\r\n").encode() + path.read_bytes() + b"\r\n"]
    for k, v in (("subfolder", f"orders/{oid}"), ("overwrite", "true")):
        parts.append(f"--{b}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode())
    body = b"".join(parts) + f"--{b}--\r\n".encode()
    req = urllib.request.Request(f"{COMFY}/upload/image", data=body, headers={"Content-Type": f"multipart/form-data; boundary={b}"})
    r = json.load(urllib.request.urlopen(req, timeout=120))
    return f"{r['subfolder']}/{r['name']}" if r.get("subfolder") else r["name"]


def out_path(f):
    return OUTPUT / (f.get("subfolder") or "") / f["filename"]


def resolve(o, value, cache):
    """Byter "$in:<namn>" och "$step:<nyckel>" mot filnamn i ComfyUI:s indata."""
    if not isinstance(value, str) or not value.startswith("$"):
        return value
    if value in cache:
        return cache[value]
    kind, _, name = value[1:].partition(":")
    if kind == "in":
        src = o.dir / "in" / name
    elif kind == "step":
        imgs = [f for f in o.st(name).get("outputs", []) if f["filename"].lower().endswith((".png", ".jpg", ".jpeg", ".webp"))]
        if not imgs:
            raise RuntimeError(f"step {name} has no image output")
        src = out_path(imgs[0])
    else:
        return value
    cache[value] = upload(src, o.id)
    return cache[value]


def comfy_step(o, s):
    t = o.st(s["key"])
    if t.get("job") and t["status"] == "running":
        pid = t["job"]  # runnern startades om mitt i jobbet: vänta vidare på samma jobb
    else:
        g = copy.deepcopy(s["graph"])
        cache = {}
        for n in g.values():
            if isinstance(n, dict):
                for k, v in list(n.get("inputs", {}).items()):
                    n["inputs"][k] = resolve(o, v, cache)
                    if k in ("seed", "noise_seed") and isinstance(v, int) and t["attempt"]:
                        n["inputs"][k] = v + 1000 * t["attempt"]
        title = s.get("title") or f"{o.order.get('title', o.id)}: {s.get('label', s['key'])}"
        if t["attempt"]:
            title += f" (retry {t['attempt']})"
        extra = {"job_title": title, "job_tool": "darrowmere-runner", "job_host": "darrowmere",
                 "pipeline": {"id": o.id, "step": s["key"]}, "use": o.order.get("use")}
        r = http_json(f"{COMFY}/prompt", {"prompt": g, "extra_data": extra})
        if r.get("node_errors"):
            raise RuntimeError("node errors: " + json.dumps(r["node_errors"])[:400])
        pid = r["prompt_id"]
        o.set(s["key"], status="running", job=pid, start=time.time(), end=None, note=None)
        log(o.id, s["key"], "queued", pid)
    while True:
        if (o.dir / "cancel").exists():
            raise RuntimeError("cancelled")
        try:
            h = http_json(f"{COMFY}/history/{pid}", timeout=30).get(pid)
        except Exception:
            h = None
        if h and h.get("status", {}).get("completed") is not None:
            break
        time.sleep(10)
    ok = h["status"].get("status_str") == "success"
    files = [{"filename": f["filename"], "subfolder": f.get("subfolder", ""), "type": f.get("type", "output")}
             for out in h.get("outputs", {}).values() for v in out.values() if isinstance(v, list)
             for f in v if isinstance(f, dict) and f.get("filename") and f.get("type", "output") == "output"]
    if not ok:
        err = next((m[1] for m in h["status"].get("messages", []) if m[0] == "execution_error"), {})
        raise RuntimeError(f"{err.get('node_type', '')}: {err.get('exception_message', 'failed')}"[:300])
    o.set(s["key"], status="done", end=time.time(), outputs=files, note=f"{len(files)} files")


# ---- DeepSeek-granskning -------------------------------------------------------------------------------------------

def image_part(path, max_side=768):
    from PIL import Image
    im = Image.open(path).convert("RGB")
    im.thumbnail((max_side, max_side))
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=85)
    return {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()}}


def files_for(o, ref):
    kind, _, name = ref.partition(":")
    if kind == "$in":
        return [o.dir / "in" / name]
    if kind == "$step":
        return [out_path(f) for f in o.st(name).get("outputs", []) if f["filename"].lower().endswith((".png", ".jpg", ".jpeg", ".webp"))][:4]
    raise RuntimeError(f"unknown image reference {ref}")


def review(o, s):
    cand = [p for r in s.get("images", []) for p in files_for(o, r)]
    refs = [p for r in s.get("refs", []) for p in files_for(o, r)]
    if not cand:
        raise RuntimeError("nothing to review")
    crit = s.get("criteria") or ["The image is clean, without artifacts, extra limbs or broken hands."]
    content = [{"type": "text", "text": (
        "You review images made for a game asset pipeline. "
        f"The first {len(cand)} image(s) are the CANDIDATE" + (f"; the next {len(refs)} are REFERENCE images." if refs else ".")
        + " Judge the candidate against these criteria:\n" + "\n".join(f"- {c}" for c in crit)
        + "\nReply with JSON only: {\"pass\": true|false, \"score\": 0-10, \"issues\": [short strings], \"summary\": \"one sentence\"}. "
        + f"Pass only if every criterion holds and the score is at least {s.get('min_score', 7)}.")}]
    content += [image_part(p) for p in cand + refs]
    model = s.get("model") or settings()["review"].get("model") or CONF["model"]
    t0 = time.time()
    entry = {"t": t0, "order": o.id, "order_title": o.order.get("title", o.id), "step": s["key"], "label": s.get("label", s["key"]),
             "model": model, "criteria": crit, "images": [str(p) for p in cand], "refs": [str(p) for p in refs]}
    log(o.id, s["key"], "DeepSeek review", model, len(cand), "+", len(refs), "images")
    try:
        r = http_json("https://openrouter.ai/api/v1/chat/completions",
                      {"model": model, "messages": [{"role": "user", "content": content}],
                       "response_format": {"type": "json_object"}, "temperature": 0.2, "usage": {"include": True}},
                      headers={"Authorization": f"Bearer {env_key()}", "X-Title": "Darrowmere runner"}, timeout=180)
    except Exception as e:
        ai_log({**entry, "seconds": round(time.time() - t0, 1), "error": str(e)[:300]})
        raise
    text = r["choices"][0]["message"]["content"] or ""
    try:
        verdict = json.loads(text[text.find("{"): text.rfind("}") + 1])
    except ValueError:
        verdict = {"pass": False, "score": 0, "issues": ["unparseable reply"], "summary": text[:200]}
    verdict["model"], verdict["seconds"] = r.get("model", model), round(time.time() - t0, 1)
    verdict["cost_usd"] = (r.get("usage") or {}).get("cost")
    verdict["tokens"] = {k: (r.get("usage") or {}).get(k) for k in ("prompt_tokens", "completion_tokens")}
    (o.dir / f"review_{s['key']}_{o.st(s['key'])['attempt']}.json").write_text(json.dumps(verdict, indent=1))
    ai_log({**entry, "seconds": verdict["seconds"], "model": verdict["model"], "pass": bool(verdict.get("pass")),
            "score": verdict.get("score"), "summary": verdict.get("summary"), "issues": verdict.get("issues"),
            "cost_usd": verdict["cost_usd"], "tokens": verdict["tokens"]})
    log(o.id, s["key"], "verdict", "pass" if verdict.get("pass") else "fail", verdict.get("score"), f"{verdict['seconds']} s", verdict["cost_usd"])
    return verdict


def ai_log(entry, name="deepseek.jsonl"):
    # Varje DeepSeek- och molnanrop, en rad JSON; kontrollpanelen visar dem som jobb
    with open(ORDERS / name, "a") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")


# ---- moln: Tripo -------------------------------------------------------------------------------------------------

TRIPO = "https://openapi.tripo3d.ai"
TRIPO_MODELS = {"tripo-p1": "P1-20260311", "tripo-p2": "P2-20260801"}


def tripo_cost(model, texture, quality="standard"):
    # Tripos prislista: P1 40 utan textur, 50 med; P2 100; textur standard +10
    base = 100 if model.startswith("P2") else (50 if texture else 40)
    return base + ({"standard": 10, "detailed": 20}.get(quality, 0) if texture else 0)


def tripo_req(method, path, key, body=None, headers=None):
    req = urllib.request.Request(TRIPO + path, data=body, method=method, headers={"Authorization": f"Bearer {key}", **(headers or {})})
    try:
        return json.load(urllib.request.urlopen(req, timeout=60))
    except urllib.error.HTTPError as e:
        return {"code": e.code, "error": e.read().decode("utf8", "replace")[:300]}


def tripo_model(o, s, texture):
    """3D-modell (och textur) från beställningens vyer med Tripo. Sparas under /data/utdata/orders/<id>/<steg>/."""
    st = settings()
    c = s.get("cloud") or {}
    model = TRIPO_MODELS.get(st["routes"]["model"]["cloud"], "P1-20260311")
    face_limit = int(c.get("face_limit") or st["routes"]["model"].get("face_limit") or 3000)
    key = env_key("TRIPO_API_KEY")
    views = {v: files_for(o, ref)[0] for v, ref in (c.get("views") or {}).items()}
    if "front" not in views:
        raise RuntimeError("cloud model needs a front view")
    t0 = time.time()
    tokens = {}
    for v, p in views.items():
        b = uuid.uuid4().hex
        body = (f"--{b}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{p.name}\"\r\nContent-Type: "
                f"{'image/png' if p.suffix.lower() == '.png' else 'image/jpeg'}\r\n\r\n").encode() + p.read_bytes() + f"\r\n--{b}--\r\n".encode()
        r = tripo_req("POST", "/v3/files", key, body, {"Content-Type": f"multipart/form-data; boundary={b}"})
        if r.get("code") != 0:
            raise RuntimeError(f"Tripo upload {v}: {r}"[:300])
        tokens[v] = r["data"]["file_token"]
    body = {"model": model, "texture": texture, "pbr": texture, "texture_quality": "standard", "face_limit": face_limit}
    if len(tokens) == 1:
        body["input"], path = tokens["front"], "/v3/generation/image-to-model"
    else:
        body["inputs"], path = [{v: t} for v, t in tokens.items()], "/v3/generation/multiview-to-model"
    sub = tripo_req("POST", path, key, json.dumps(body).encode(), {"Content-Type": "application/json"})
    if sub.get("code") != 0:
        raise RuntimeError(f"Tripo: {sub}"[:300])
    task = sub["data"]["task_id"]
    o.set(s["key"], note=f"Tripo {model} · task {task[:8]}")
    while True:
        r = tripo_req("GET", f"/v3/tasks/{task}", key)
        status = (r.get("data") or {}).get("status")
        if status == "success":
            break
        if status in ("failed", "cancelled", "banned", "expired") or time.time() - t0 > 1200:
            raise RuntimeError(f"Tripo task {status}")
        time.sleep(5)
    out = r["data"].get("output", {})
    blob = urllib.request.urlopen(out.get("model_url") or out.get("pbr_model") or out.get("model"), timeout=180).read()
    ext = ".fbx" if blob[:18] == b"Kaydara FBX Binary" else ".glb"
    sub_dir = f"orders/{o.id}/{s['key']}"
    (OUTPUT / sub_dir).mkdir(parents=True, exist_ok=True)
    name = f"{o.order.get('asset') or o.id}_{s['key']}{ext}"
    (OUTPUT / sub_dir / name).write_bytes(blob)
    credits = r["data"].get("consumed_credit")
    files = [{"filename": name, "subfolder": sub_dir, "type": "output"}]
    ai_log({"t": t0, "order": o.id, "order_title": o.order.get("title", o.id), "step": s["key"], "label": s.get("label", s["key"]),
            "provider": "tripo", "model": model, "seconds": round(time.time() - t0, 1), "credits": credits, "files": files,
            "texture": texture, "face_limit": face_limit}, "cloud.jsonl")
    return files, f"Tripo {model} · {face_limit} faces · {credits} credits · {round(time.time() - t0)} s"


# ---- moln: Meshy Retexture ---------------------------------------------------------------------------------------

MESHY = "https://api.meshy.ai/openapi/v1"


def meshy_cost(resolution):
    return 15 if resolution == "8k" else 10  # Meshys prislista: 2K/4K 10 krediter, 8K 15


def mesh_for(o, ref):
    # En modellfil: "$in:<namn>" eller första GLB/glTF/FBX/OBJ från ett tidigare steg
    kind, _, name = ref.partition(":")
    if kind == "$in":
        return o.dir / "in" / name
    if kind == "$step":
        for f in o.st(name).get("outputs", []):
            if f["filename"].lower().endswith((".glb", ".gltf", ".fbx", ".obj")):
                return out_path(f)
        raise RuntimeError(f"step {name} has no model output")
    raise RuntimeError(f"unknown model reference {ref}")


def data_uri_image(path, max_side=2048):
    from PIL import Image
    im = Image.open(path).convert("RGB")
    im.thumbnail((max_side, max_side))
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=92)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


def meshy_req(method, path, key, body=None):
    req = urllib.request.Request(MESHY + path, data=json.dumps(body).encode() if body is not None else None, method=method,
                                 headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    try:
        return json.load(urllib.request.urlopen(req, timeout=300))
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Meshy {e.code}: {e.read().decode('utf8', 'replace')[:300]}")


def meshy_retexture(o, s):
    """Textur på en befintlig modell med Meshy Retexture: vår UV behålls, stilen från 1–4 vyer, en stilbild eller text."""
    opt = settings()["routes"]["texture"].get("meshy") or {}
    c = s.get("cloud") or {}
    key = env_key("MESHY_API_KEY")
    mesh = mesh_for(o, c.get("mesh") or "$step:model")
    if mesh.stat().st_size > 70 * 1024 * 1024:  # data-URI:n får vara högst 100 MB, base64 växer med en tredjedel
        raise RuntimeError(f"{mesh.name} is {mesh.stat().st_size >> 20} MB; Meshy takes at most about 70 MB this way (use the low-poly mesh)")
    body = {"model_url": "data:application/octet-stream;base64," + base64.b64encode(mesh.read_bytes()).decode(),
            "enable_original_uv": bool(opt.get("keep_uv", True)), "enable_pbr": bool(opt.get("pbr", True)),
            "texture_resolution": opt.get("resolution", "2k"), "target_formats": ["glb"]}
    views = [p for r in (c.get("views") or []) for p in files_for(o, r)][:4]
    if views:
        body.update(ai_model="meshy-7", multiview_image_urls=[data_uri_image(p) for p in views])
    elif c.get("style_image"):
        body["image_style_url"] = data_uri_image(files_for(o, c["style_image"])[0])
    elif c.get("prompt"):
        body["text_style_prompt"] = str(c["prompt"])[:800]
    else:
        raise RuntimeError("cloud texture needs views, a style image or a prompt")
    t0 = time.time()
    tid = meshy_req("POST", "/retexture", key, body)["result"]
    o.set(s["key"], note=f"Meshy retexture · task {tid[:8]}")
    while True:
        t = meshy_req("GET", f"/retexture/{tid}", key)
        if t.get("status") == "SUCCEEDED":
            break
        if t.get("status") in ("FAILED", "CANCELED") or time.time() - t0 > 1800:
            raise RuntimeError(f"Meshy task {t.get('status')}: {(t.get('task_error') or {}).get('message', '')}"[:300])
        o.set(s["key"], note=f"Meshy retexture · {t.get('progress', 0)} %")
        time.sleep(8)
    sub_dir = f"orders/{o.id}/{s['key']}"
    (OUTPUT / sub_dir).mkdir(parents=True, exist_ok=True)
    stem = f"{o.order.get('asset') or o.id}_{s['key']}"
    files = []
    if (t.get("model_urls") or {}).get("glb"):
        (OUTPUT / sub_dir / f"{stem}.glb").write_bytes(urllib.request.urlopen(t["model_urls"]["glb"], timeout=300).read())
        files.append({"filename": f"{stem}.glb", "subfolder": sub_dir, "type": "output"})
    for m, url in ((t.get("texture_urls") or [{}])[0] or {}).items():
        if isinstance(url, str) and url.startswith("http"):
            (OUTPUT / sub_dir / f"{stem}_{m}.png").write_bytes(urllib.request.urlopen(url, timeout=300).read())
            files.append({"filename": f"{stem}_{m}.png", "subfolder": sub_dir, "type": "output"})
    credits = t.get("consumed_credits")
    ai_log({"t": t0, "order": o.id, "order_title": o.order.get("title", o.id), "step": s["key"], "label": s.get("label", s["key"]),
            "provider": "meshy", "model": body.get("ai_model", "latest"), "seconds": round(time.time() - t0, 1), "credits": credits,
            "files": files, "texture": True, "resolution": body["texture_resolution"], "views": len(views)}, "cloud.jsonl")
    return files, f"Meshy {body.get('ai_model', 'latest')} · {body['texture_resolution']} · {len(views) or 'style'} views · {credits} credits · {round(time.time() - t0)} s", credits


def cloud_gate(o, s, provider, cost):
    # Budget per beställning och tjänst, och godkännande före varje molnsteg om det är påslaget
    st = settings()
    cap = int(st["budget"].get(f"{provider}_credits_per_order") or 0)
    spent = sum(o.st(x["key"]).get("credits") or 0 for x in o.order["steps"] if o.st(x["key"]).get("provider") == provider)
    if spent + cost > cap:
        raise RuntimeError(f"over budget: ~{cost} {provider} credits needed, {cap - spent} left of {cap} per order (Settings → Budget)")
    if st["budget"].get("ask_before_cloud", True) and not approved(o, s["key"], cost):
        o.set(s["key"], status="approval", note=f"needs approval: ~{cost} {provider.capitalize()} credits", estimate=cost)
        o.state["status"] = "approval"
        o.save()
        raise Paused()


def approved(o, key, cost):
    # Godkännandet gäller ett steg och ett belopp: {"steps": {"<nyckel>": <krediter>}} (panelen eller order.py approve)
    try:
        return (json.loads((o.dir / "approved.json").read_text()).get("steps") or {}).get(key, 0) >= cost
    except (OSError, ValueError):
        return False


def routed_step(o, s):
    """Steg som kan köras lokalt eller i molnet ("model", "texture"), efter valet i Settings."""
    st = settings()
    route = st["routes"][s["kind"]]
    use = s.get("force") or route["use"]
    if s["kind"] == "texture" and use == "cloud":
        if route.get("cloud") == "meshy":
            cost = meshy_cost((route.get("meshy") or {}).get("resolution", "2k"))
            cloud_gate(o, s, "meshy", cost)
            o.set(s["key"], status="running", route="cloud", provider="meshy", start=time.time(), end=None)
            files, note, credits = meshy_retexture(o, s)
            o.set(s["key"], status="done", end=time.time(), outputs=files, files=files, note=note, credits=credits or cost)
            return
        mk = next((x["key"] for x in o.order["steps"] if x["kind"] == "model"), None)
        if mk and o.st(mk).get("route") == "cloud":
            o.set(s["key"], status="skipped", route="cloud", note="textured by Tripo together with the model")
            return
        raise RuntimeError("Tripo texturing needs the model step on Tripo too (Settings → 3D models → Cloud), or pick Meshy")
    if use == "local":
        if not s.get("local"):
            raise RuntimeError("no local version of this step in the order")
        o.st(s["key"])["route"] = "local"
        comfy_step(o, {**s, **s["local"], "key": s["key"], "label": s.get("label")})
        return
    # moln: Tripo, med textur om texturen också ska göras av Tripo
    tr = st["routes"]["texture"]
    tex = tr["use"] == "cloud" and tr.get("cloud") == "tripo"
    model = TRIPO_MODELS.get(route["cloud"], "P1-20260311")
    cost = tripo_cost(model, tex)
    cloud_gate(o, s, "tripo", cost)
    o.set(s["key"], status="running", route="cloud", provider="tripo", start=time.time(), end=None)
    files, note = tripo_model(o, s, tex)
    o.set(s["key"], status="done", end=time.time(), outputs=files, files=files, note=note,
          credits=tripo_cost(model, tex))


class Paused(Exception):
    """Beställningen väntar på godkännande; den tas upp igen när approved.json finns."""


def review_step(o, s):
    t = o.st(s["key"])
    if not settings()["review"].get("enabled", True):
        o.set(s["key"], status="skipped", note="AI review is off in Settings")
        return None
    o.set(s["key"], status="running", start=time.time(), end=None)
    v = review(o, s)
    note = f"{'pass' if v.get('pass') else 'fail'} {v.get('score')}/10: {v.get('summary', '')}"[:240]
    if v.get("issues"):
        note += " · " + "; ".join(map(str, v["issues"]))[:200]
    if v.get("pass"):
        o.set(s["key"], status="done", end=time.time(), note=note, verdict=v)
        return None
    retry = s.get("retry") or {}
    target = retry.get("step")
    if target and o.st(target)["attempt"] < retry.get("max", 1):
        o.st(target)["attempt"] += 1
        o.set(s["key"], status="planned", end=time.time(), note="retrying · " + note, verdict=v, attempt=t["attempt"] + 1)
        o.set(target, status="planned", job=None)
        return target  # kör om från målsteget
    o.set(s["key"], status="failed", end=time.time(), note=note, verdict=v)
    return None


# ---- loopen -------------------------------------------------------------------------------------------------------

def run_order(o):
    keys = [s["key"] for s in o.order["steps"]]
    o.state["status"] = "running"
    o.save()
    i = 0
    while i < len(keys):
        s = o.order["steps"][i]
        t = o.st(s["key"])
        if t["status"] in ("done", "skipped", "waiting") or (t["status"] == "failed" and s["kind"] != "comfy"):
            i += 1
            continue
        if (o.dir / "cancel").exists():
            o.state["status"] = "cancelled"
            o.save()
            return
        try:
            if s["kind"] == "comfy":
                comfy_step(o, s)
            elif s["kind"] in ("model", "texture"):
                try:
                    routed_step(o, s)
                except Paused:
                    log(o.id, s["key"], "waiting for approval")
                    return
            elif s["kind"] == "review":
                back = review_step(o, s)
                if back:
                    i = keys.index(back)
                    continue
                if o.st(s["key"])["status"] == "failed" and s.get("stop_on_fail", True):
                    o.state["status"] = "failed"
                    o.save()
                    return
            else:  # manual: görs någon annanstans
                o.set(s["key"], status="waiting", note=s.get("note") or f"to do on {s.get('where', 'andorhal')}")
        except Exception as e:
            log(o.id, s["key"], "failed:", e)
            o.set(s["key"], status="failed", end=time.time(), note=str(e)[:300])
            o.state["status"] = "failed"
            o.save()
            return
        i += 1
    waiting = any(o.st(k)["status"] == "waiting" for k in keys)
    o.state["status"] = "waiting" if waiting else "done"
    o.save()
    log(o.id, o.state["status"])


def take_inbox():
    inbox = ORDERS / "inbox"
    inbox.mkdir(parents=True, exist_ok=True)
    for f in sorted(inbox.glob("*.json"), key=lambda p: p.stat().st_mtime):
        oid = f.stem
        d = ORDERS / oid
        d.mkdir(parents=True, exist_ok=True)
        shutil.move(str(f), d / "order.json")
        log("new order", oid)


def active():
    out = []
    for d in ORDERS.iterdir():
        if d.is_dir() and (d / "order.json").exists():
            st = json.loads((d / "state.json").read_text()) if (d / "state.json").exists() else {"status": "queued", "created": d.stat().st_mtime}
            if st["status"] in ("queued", "running") or (st["status"] == "approval" and (d / "approved.json").exists()):
                out.append((st.get("created", 0), d.name))
    return [oid for _, oid in sorted(out)]


def tick():
    take_inbox()
    for oid in active():
        try:
            run_order(Order(oid))
        except Exception:
            log(oid, "crashed:", traceback.format_exc()[-600:])


if __name__ == "__main__":
    log("runner up", COMFY, ORDERS, CONF["model"])
    if "--once" in sys.argv:
        tick()
        sys.exit(0)
    while True:
        tick()
        time.sleep(10)
