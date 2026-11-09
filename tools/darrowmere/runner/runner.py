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
import threading
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
# Ett körspår per grafikkort: varje spår har sin ComfyUI och kör en beställning i taget, spåren går samtidigt.
# Beställningen väljer spår med "gpu" (t.ex. "m4000"); utan det går den på det första.
LANES = CONF.get("lanes") or {"t1000": COMFY}
DEFAULT_LANE = next(iter(LANES))
_lane = threading.local()


def comfy_url():
    return getattr(_lane, "url", COMFY)
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
                          **({"files": (t.get("files") or t.get("outputs"))[:24]} if (t.get("files") or t.get("outputs")) else {}), **({"route": t["route"]} if t.get("route") else {}),
                          **({"provider": t["provider"]} if t.get("provider") else {}), **({"credits": t["credits"]} if t.get("credits") else {}),
                          **({"pct": t["pct"]} if t.get("pct") is not None and t.get("status") == "running" else {}),
                          **({"estimate": t["estimate"]} if t.get("status") == "approval" else {})})
        PIPES.mkdir(parents=True, exist_ok=True)
        body = {"id": self.id, "title": self.order.get("title", self.id), "created": self.state["created"], "updated": time.time(),
                "project": self.order.get("project"), "asset": self.order.get("asset"), "use": self.order.get("use"),
                "mission": self.order.get("mission"), "mission_title": self.order.get("mission_title"),
                "operator": self.order.get("operator"),
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
    req = urllib.request.Request(f"{comfy_url()}/upload/image", data=body, headers={"Content-Type": f"multipart/form-data; boundary={b}"})
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
        name, _, part = name.partition("/")
        imgs = [f for f in o.st(name).get("outputs", []) if f["filename"].lower().endswith((".png", ".jpg", ".jpeg", ".webp"))]
        if part:
            imgs = [f for f in imgs if part in f["filename"]]
        if not imgs:
            raise RuntimeError(f"step {name} has no image output{' named ' + part if part else ''}")
        src = out_path(imgs[0])
    else:
        return value
    cache[value] = upload(src, o.id)
    return cache[value]


# Bara ett tungt ComfyUI-jobb åt gången över alla kort ("serial_lanes" i runner.json): med 18 GB RAM räcker minnet inte till
# Krea-2 på T1000 och Klein 4B på M4000 samtidigt (2026-11-08 hängde sig Darrowmere i swap och tappade nätet). Före varje
# jobb släpper de andra korten sina modeller ur RAM. Stängs av när 48 GB sitter i.
SERIAL = bool(CONF.get("serial_lanes"))
HEAVY = threading.Lock()
LAST_MODELS = {}  # kort (ComfyUI-adress) -> modellfilerna i det senaste jobbet där


def free_other_lanes():
    for url in LANES.values():
        if url == comfy_url():
            continue
        try:
            q = http_json(f"{url}/queue", timeout=10)
            if not (q.get("queue_running") or q.get("queue_pending")):
                http_json(f"{url}/free", {"unload_models": True, "free_memory": True}, timeout=30)
        except Exception:
            pass


def comfy_step(o, s):
    if not SERIAL:
        return _comfy_step(o, s)
    noted = False
    while not HEAVY.acquire(timeout=10):
        if (o.dir / "cancel").exists():
            raise RuntimeError("cancelled")
        if not noted:
            o.set(s["key"], note="waiting: one heavy job at a time on Darrowmere"); noted = True
    try:
        free_other_lanes()
        return _comfy_step(o, s)
    finally:
        HEAVY.release()


def _comfy_step(o, s):
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
        # Byter jobbet modeller på samma kort (t.ex. UltraTex med Klein 4B, sedan Krea-2) töms kortets modeller först:
        # ComfyUI behåller annars de förra i RAM, och 2026-11-09 hängde Darrowmere när Krea-2 (14 GB) lades ovanpå Klein 4B
        models = sorted({v for n in g.values() if isinstance(n, dict) for k, v in n.get("inputs", {}).items()
                         if k.endswith("_name") and isinstance(v, str) and v.endswith((".safetensors", ".gguf", ".pt", ".ckpt", ".pth"))})
        url = comfy_url()
        if LAST_MODELS.get(url) != models:
            log(o.id, s["key"], "freeing models before a model change")
            try:   # ComfyUI svarar med en tom kropp, så tolkningen kastar; minnet är ändå tömt
                http_json(f"{url}/free", {"unload_models": True, "free_memory": True}, timeout=30)
            except Exception:
                pass
            LAST_MODELS[url] = models
        r = http_json(f"{url}/prompt", {"prompt": g, "extra_data": extra})
        if r.get("node_errors"):
            raise RuntimeError("node errors: " + json.dumps(r["node_errors"])[:400])
        pid = r["prompt_id"]
        o.set(s["key"], status="running", job=pid, start=time.time(), end=None, note=None)
        log(o.id, s["key"], "queued", pid)
    gone = 0
    while True:
        if (o.dir / "cancel").exists():
            raise RuntimeError("cancelled")
        try:
            h = http_json(f"{comfy_url()}/history/{pid}", timeout=30).get(pid)
        except Exception:
            h = None
        if h and h.get("status", {}).get("completed") is not None:
            break
        if h is None:  # varken klart eller i kön: ComfyUI har startats om och jobbet är borta
            try:
                q = http_json(f"{comfy_url()}/queue", timeout=10)
                listed = any(r[1] == pid for r in q.get("queue_running", []) + q.get("queue_pending", []))
                gone = 0 if listed else gone + 1
            except Exception:
                pass  # ComfyUI svarar inte än: vänta
            if gone >= 3:
                raise RuntimeError("job vanished from ComfyUI (restarted?)")
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
        imgs = [f for f in o.st(name).get("outputs", []) if f["filename"].lower().endswith((".png", ".jpg", ".jpeg", ".webp"))]
        # Ett texturerat steg granskas på renderingen av modellen, inte på texturkartorna (en UV-atlas ser alltid sönderhackad ut)
        previews = [f for f in imgs if "_render_" in f["filename"]] or [f for f in imgs if "_preview" in f["filename"]]
        maps = ("_base_color", "_metallic", "_normal", "_roughness", "_emission")
        return [out_path(f) for f in (previews or [f for f in imgs if not any(m in f["filename"] for m in maps)] or imgs)][:5]
    raise RuntimeError(f"unknown image reference {ref}")


def review(o, s):
    inspect = s.get("inspect", True)
    cand, labels, stats = [], [], None
    for r in s.get("images", []):
        key = r.split(":", 1)[1].split("/")[0] if r.startswith("$step:") else None
        shots = []
        if inspect and key:
            shots, stats = inspect_model(o, key, s.get("front_yaw", 0))
        if shots:
            cand += [out_path(f) for f in shots]
            labels += [describe_shot(f["filename"].split("_inspect_", 1)[1].rsplit(".", 1)[0]) for f in shots]
        else:
            found = files_for(o, r)
            cand += found
            labels += ["candidate"] * len(found)
    refs = [p for r in s.get("refs", []) for p in files_for(o, r)]
    if not cand:
        raise RuntimeError("nothing to review")
    crit = s.get("criteria") or ["The image is clean, without artifacts, extra limbs or broken hands."]
    if s.get("mesh_check"):
        crit = crit + ["As a mesh for rigging and animation: enough geometry around shoulders, elbows, wrists, hips, knees and the face; "
                       "clean armpits, groin and other folds; arms, legs and fingers separate (not fused to the body or each other); "
                       "a neutral pose that is easy to rig; no holes, spikes or stray parts."]
    intro = ("You review a 3D model made for a stylized game. Be relaxed and practical: stylization, small colour or shade differences, "
             "slight softness, simplified details and different lighting are all fine. Only flag clear, obvious problems that a person "
             "would notice at a glance, such as a wrong subject, missing or extra limbs, broken or melted body parts, garbled faces or "
             "hands, large smears or holes, clearly visible texture seams, or colours that are completely wrong. The head and face matter "
             "most: look carefully at every head close-up, both texture and shape. ")
    if stats:
        intro += ("Mesh numbers from Blender (vertices welded at UV seams): " + json.dumps(stats) + ". Separate connected parts and "
                  "boundary edges can be normal for eyes, hair cards or clothing; judge whether they would cause trouble. ")
    intro += "Things the order cares about:\n" + "\n".join(f"- {c}" for c in crit)
    answer = ("\nReply with JSON only: {\"level\": \"pass\" | \"warning\" | \"fail\", \"score\": 0-10, \"issues\": [short strings], "
              "\"summary\": \"one sentence\", \"rigging\": \"one sentence on how well the mesh would rig and deform\", "
              "\"look\": [optional, at most 6 extra camera shots you want before deciding, each {\"yaw\": degrees around from the front, "
              "\"pitch\": degrees up, \"zoom\": 1 = whole figure, \"height\": 0..1 where on the body (0 feet, 1 top of head), "
              "\"mode\": \"texture\" | \"clay\" | \"wire\", \"why\": short}]}. level pass: usable, at most small things. "
              "warning: usable but with a noticeable problem worth a look. fail: a gross error that makes it unusable. "
              "When in doubt, choose pass or warning, not fail. Only ask for look shots if something is unclear.")
    v = deepseek_review(o, s, intro + answer, list(zip(labels, cand)), refs, crit)
    # Andra rundan: DeepSeek bad om egna vinklar (bara när den inte redan godkänt)
    looks = [l for l in (v.get("look") or []) if isinstance(l, dict)][:6]
    if looks and v.get("level") != "pass" and inspect:
        key = next((r.split(":", 1)[1].split("/")[0] for r in s.get("images", []) if r.startswith("$step:")), None)
        glb = main_glb(o.st(key).get("outputs", [])) if key else None
        if glb:
            shots = [{"name": f"look{len(o.st(s['key']).get('looks', [])) + i}", "yaw": float(l.get("yaw", 0)), "pitch": float(l.get("pitch", 0)),
                      "zoom": max(1.0, min(8.0, float(l.get("zoom", 2)))), "height": max(0.0, min(1.0, float(l.get("height", 0.5)))),
                      "mode": l.get("mode") if l.get("mode") in ("texture", "clay", "wire") else "texture", "size": 640} for i, l in enumerate(looks)]
            res = run_blender_job({"glb": str(out_path(glb)), "out_dir": str(out_path(glb).parent), "shots": shots, "front_yaw": s.get("front_yaw", 0)})
            extra = [(f"requested: {l.get('why', '')} (yaw {l.get('yaw')}, pitch {l.get('pitch', 0)}, zoom {l.get('zoom')}, {l.get('mode', 'texture')})",
                      out_path(glb).parent / n) for l, n in zip(looks, res["files"])]
            o.set(s["key"], looks=o.st(s["key"]).get("looks", []) + res["files"])
            follow = (intro + "\nYour first look said: " + json.dumps({k: v.get(k) for k in ("level", "score", "issues", "summary")})
                      + ". Here are the extra shots you asked for. Decide now; do not ask for more shots." + answer.replace('"look": [optional', '"look": [leave empty'))
            v2 = deepseek_review(o, s, follow, extra, refs, crit, round_no=2)
            v2["first_round"] = {k: v.get(k) for k in ("level", "score", "summary")}
            v = v2
    return v


def deepseek_review(o, s, text, labelled, refs, crit, round_no=1):
    content = [{"type": "text", "text": text}]
    for label, path in labelled:
        content += [{"type": "text", "text": f"CANDIDATE · {label}:"}, image_part(path, 512)]
    for path in refs:
        content += [{"type": "text", "text": "REFERENCE:"}, image_part(path, 512)]
    model = s.get("model") or settings()["review"].get("model") or CONF["model"]
    t0 = time.time()
    entry = {"t": t0, "order": o.id, "order_title": o.order.get("title", o.id), "step": s["key"],
             "label": s.get("label", s["key"]) + (" (2nd look)" if round_no == 2 else ""),
             "model": model, "criteria": crit, "images": [str(p) for _, p in labelled], "refs": [str(p) for p in refs]}
    log(o.id, s["key"], f"DeepSeek review round {round_no}", model, len(labelled), "+", len(refs), "images")
    try:
        r = http_json("https://openrouter.ai/api/v1/chat/completions",
                      {"model": model, "messages": [{"role": "user", "content": content}],
                       "response_format": {"type": "json_object"}, "temperature": 0.2, "usage": {"include": True}},
                      headers={"Authorization": f"Bearer {env_key()}", "X-Title": "Darrowmere runner"}, timeout=240)
    except Exception as e:
        ai_log({**entry, "seconds": round(time.time() - t0, 1), "error": str(e)[:300]})
        raise
    text_out = r["choices"][0]["message"]["content"] or ""
    try:
        verdict = json.loads(text_out[text_out.find("{"): text_out.rfind("}") + 1])
    except ValueError:
        verdict = {"level": "warning", "score": 5, "issues": ["unparseable reply"], "summary": text_out[:200]}
    if verdict.get("level") not in ("pass", "warning", "fail"):
        verdict["level"] = "pass" if verdict.get("pass") else "warning" if (verdict.get("score") or 0) >= 4 else "fail"
    verdict["pass"] = verdict["level"] == "pass"
    verdict["model"], verdict["seconds"] = r.get("model", model), round(time.time() - t0, 1)
    verdict["cost_usd"] = (r.get("usage") or {}).get("cost")
    verdict["tokens"] = {k: (r.get("usage") or {}).get(k) for k in ("prompt_tokens", "completion_tokens")}
    (o.dir / f"review_{s['key']}_{o.st(s['key'])['attempt']}_r{round_no}.json").write_text(json.dumps(verdict, indent=1))
    ai_log({**entry, "seconds": verdict["seconds"], "model": verdict["model"], "pass": verdict["pass"], "level": verdict["level"],
            "score": verdict.get("score"), "summary": verdict.get("summary"), "issues": verdict.get("issues"),
            "rigging": verdict.get("rigging"), "looks_requested": len(verdict.get("look") or []),
            "cost_usd": verdict["cost_usd"], "tokens": verdict["tokens"]})
    log(o.id, s["key"], "verdict", verdict["level"], verdict.get("score"), f"{verdict['seconds']} s", verdict["cost_usd"])
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
    model = TRIPO_MODELS.get(c.get("model") or st["routes"]["model"]["cloud"], "P1-20260311")
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
        o.set(s["key"], note=f"Tripo {model} · {(r.get('data') or {}).get('progress', 0)} %", pct=(r.get("data") or {}).get("progress", 0))
        time.sleep(5)
    out = r["data"].get("output", {})
    blob = urllib.request.urlopen(out.get("model_url") or out.get("pbr_model") or out.get("model"), timeout=180).read()
    ext = ".fbx" if blob[:18] == b"Kaydara FBX Binary" else ".glb"
    sub_dir = f"orders/{o.id}/{s['key']}"
    (OUTPUT / sub_dir).mkdir(parents=True, exist_ok=True)
    name = f"{o.order.get('asset') or o.id}_{s['key']}{ext}"
    (OUTPUT / sub_dir / name).write_bytes(blob)
    credits = r["data"].get("consumed_credit")
    files = render_previews(o, s, [{"filename": name, "subfolder": sub_dir, "type": "output"}])
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
        f = main_glb(o.st(name).get("outputs", [])) or next((f for f in o.st(name).get("outputs", [])
                                                             if f["filename"].lower().endswith((".gltf", ".fbx", ".obj"))), None)
        if f:
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
            "enable_original_uv": bool(c.get("keep_uv", opt.get("keep_uv", True))), "enable_pbr": bool(opt.get("pbr", True)),
            "texture_resolution": c.get("resolution") or opt.get("resolution", "2k"), "target_formats": ["glb"]}
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
        o.set(s["key"], note=f"Meshy retexture · {t.get('progress', 0)} %", pct=t.get("progress", 0))
        time.sleep(8)
    sub_dir = f"orders/{o.id}/{s['key']}"
    (OUTPUT / sub_dir).mkdir(parents=True, exist_ok=True)
    stem = f"{o.order.get('asset') or o.id}_{s['key']}"
    files = []
    if (t.get("model_urls") or {}).get("glb"):
        (OUTPUT / sub_dir / f"{stem}.glb").write_bytes(urllib.request.urlopen(t["model_urls"]["glb"], timeout=300).read())
        files.append({"filename": f"{stem}.glb", "subfolder": sub_dir, "type": "output"})
    if t.get("thumbnail_url"):  # Meshys egen rendering av den texturerade modellen: det granskningen ska titta på
        try:
            (OUTPUT / sub_dir / f"{stem}_preview.png").write_bytes(urllib.request.urlopen(t["thumbnail_url"], timeout=120).read())
            files.append({"filename": f"{stem}_preview.png", "subfolder": sub_dir, "type": "output"})
        except Exception as e:
            log(o.id, s["key"], "no Meshy preview:", e)
    for m, url in ((t.get("texture_urls") or [{}])[0] or {}).items():
        if isinstance(url, str) and url.startswith("http"):
            (OUTPUT / sub_dir / f"{stem}_{m}.png").write_bytes(urllib.request.urlopen(url, timeout=300).read())
            files.append({"filename": f"{stem}_{m}.png", "subfolder": sub_dir, "type": "output"})
    files = render_previews(o, s, files)
    credits = t.get("consumed_credits")
    ai_log({"t": t0, "order": o.id, "order_title": o.order.get("title", o.id), "step": s["key"], "label": s.get("label", s["key"]),
            "provider": "meshy", "model": body.get("ai_model", "latest"), "seconds": round(time.time() - t0, 1), "credits": credits,
            "files": files, "texture": True, "resolution": body["texture_resolution"], "views": len(views)}, "cloud.jsonl")
    return files, f"Meshy {body.get('ai_model', 'latest')} · {body['texture_resolution']} · {len(views) or 'style'} views · {credits} credits · {round(time.time() - t0)} s", credits


MESHY3D_PARAMS = ("ai_model", "model_type", "geometry_resolution", "should_texture", "texture_model", "enable_pbr", "texture_resolution",
                  "texture_prompt", "should_remesh", "topology", "target_polycount", "image_enhancement", "pose_mode", "remove_lighting")


def meshy3d_cost(p):
    # Meshys prislista: geometri 5 (meshy-6-lite, meshy-t2, meshy-t2.5) eller 20, textur +10 (+5 i 8K), Ultra-geometri +5
    cost = 5 if p.get("ai_model") in ("meshy-6-lite", "meshy-t2", "meshy-t2.5") else 20
    if p.get("should_texture", True):
        cost += 15 if p.get("texture_resolution") == "8k" else 10
    if p.get("geometry_resolution") in ("2k", "4k"):
        cost += 5
    return cost


def meshy3d_step(o, s):
    """3D-modell med Meshy: en bild (image-to-3d, även smart topology för låg-poly) eller 2–4 vyer (multi-image-to-3d)."""
    p = {k: v for k, v in (s.get("params") or {}).items() if k in MESHY3D_PARAMS}
    imgs = [q for r in (s.get("images") or []) for q in files_for(o, r)][:4]
    if not imgs:
        raise RuntimeError("meshy3d needs images")
    cost = meshy3d_cost(p)
    cloud_gate(o, s, "meshy", cost)
    o.set(s["key"], status="running", route="cloud", provider="meshy", start=time.time(), end=None, pct=0)
    key = env_key("MESHY_API_KEY")
    body = {**p, "target_formats": ["glb"], "multi_view_thumbnails": True}
    if len(imgs) == 1:
        path, body["image_url"] = "/image-to-3d", data_uri_image(imgs[0])
    else:
        path, body["image_urls"] = "/multi-image-to-3d", [data_uri_image(q) for q in imgs]
    t0 = time.time()
    tid = meshy_req("POST", path, key, body)["result"]
    while True:
        t = meshy_req("GET", f"{path}/{tid}", key)
        if t.get("status") == "SUCCEEDED":
            break
        if t.get("status") in ("FAILED", "CANCELED") or time.time() - t0 > 2400:
            raise RuntimeError(f"Meshy task {t.get('status')}: {(t.get('task_error') or {}).get('message', '')}"[:300])
        o.set(s["key"], note=f"Meshy {path[1:]} · {t.get('progress', 0)} %", pct=t.get("progress", 0))
        time.sleep(6)
    sub_dir = f"orders/{o.id}/{s['key']}"
    (OUTPUT / sub_dir).mkdir(parents=True, exist_ok=True)
    stem = f"{o.order.get('asset') or o.id}_{s['key']}"
    files = []
    (OUTPUT / sub_dir / f"{stem}.glb").write_bytes(urllib.request.urlopen(t["model_urls"]["glb"], timeout=300).read())
    files.append({"filename": f"{stem}.glb", "subfolder": sub_dir, "type": "output"})
    for v, url in (t.get("thumbnail_urls") or {"front": t.get("thumbnail_url")}).items():
        if isinstance(url, str) and url.startswith("http"):
            (OUTPUT / sub_dir / f"{stem}_preview_{v}.png").write_bytes(urllib.request.urlopen(url, timeout=120).read())
            files.append({"filename": f"{stem}_preview_{v}.png", "subfolder": sub_dir, "type": "output"})
    files = render_previews(o, s, files)
    credits = t.get("consumed_credits") or cost
    ai_log({"t": t0, "order": o.id, "order_title": o.order.get("title", o.id), "step": s["key"], "label": s.get("label", s["key"]),
            "provider": "meshy", "model": p.get("ai_model", "latest"), "seconds": round(time.time() - t0, 1), "credits": credits,
            "files": files, "texture": p.get("should_texture", True), "views": len(imgs)}, "cloud.jsonl")
    o.set(s["key"], status="done", end=time.time(), outputs=files, files=files, credits=credits,
          note=f"Meshy {p.get('ai_model', 'latest')} · {len(imgs)} view{'s' if len(imgs) > 1 else ''} · {credits} credits · {round(time.time() - t0)} s")


def free_comfy_memory():
    """Ber ComfyUI släppa sina modeller ur RAM och VRAM innan Blender eller projiceringen körs, men bara när kön är tom.
    Darrowmere har 18 GB RAM, och Krea-2 ensam tar cirka 13 GB."""
    try:
        q = http_json(f"{comfy_url()}/queue", timeout=10)
        if q.get("queue_running") or q.get("queue_pending"):
            return False
        http_json(f"{comfy_url()}/free", {"unload_models": True, "free_memory": True}, timeout=30)
        return True
    except Exception:
        return False


def run_blender_job(job, timeout=900):
    import subprocess
    free_comfy_memory()
    blender = CONF.get("blender")
    r = subprocess.run(["nice", "-n", "15", blender, "-b", "--factory-startup", "-P", str(HERE / "render_views.py"), "--", "--json", json.dumps(job)],
                       capture_output=True, text=True, timeout=timeout)
    line = next((l for l in r.stdout.splitlines() if l.startswith("RENDER_RESULT ")), None)
    if not line:
        raise RuntimeError("Blender: " + (r.stderr or r.stdout).strip()[-300:])
    return json.loads(line.split(" ", 1)[1])


SHOT_INFO = {"tex": "textured", "clay": "clay (no texture, shows shape, creases and folds)", "wire": "wireframe over clay (topology)",
             "head": "close-up of the head", "close": "close-up", "face": "close-up of the face"}


def describe_shot(name):
    # "head_tex_090" -> "close-up of the head, textured, 90° around from the front"
    parts = name.split("_")
    words = [SHOT_INFO.get(p, p) for p in parts if not p.isdigit()]
    deg = next((int(p) for p in parts if p.isdigit()), None)
    return ", ".join(words) + (f", {deg}° around from the front" if deg is not None else "")


def main_glb(files):
    """Stegets huvudmodell: den största GLB-filen (Pixal3D och TRELLIS.2 sparar också struktur och otexturerat nät)."""
    glbs = [f for f in files if f["filename"].lower().endswith(".glb")]
    def size(f):
        try:
            return out_path(f).stat().st_size
        except OSError:
            return 0
    return max(glbs, key=size) if glbs else None


def inspect_model(o, key, front_yaw=0):
    """Rundtur i Blender för granskningen: 8 vyer + uppifrån, lera, trådnät, närbilder på leder och huvudet från alla håll,
    och nätets siffror. Sparas bredvid modellen; görs bara en gång per steg."""
    outs = o.st(key).get("outputs", [])
    glb = main_glb(outs)
    if not glb:
        return [], None
    have = [f for f in outs if "_inspect_" in f["filename"]]
    if have and o.st(key).get("mesh_stats"):
        return have, o.st(key)["mesh_stats"]
    res = run_blender_job({"glb": str(out_path(glb)), "out_dir": str(out_path(glb).parent), "size": 512, "preset": "inspect",
                           "front_yaw": front_yaw})
    files = [{"filename": n, "subfolder": glb["subfolder"], "type": "output"} for n in res["files"]]
    o.set(key, outputs=outs + files, mesh_stats=res.get("stats"))
    log(o.id, key, f"inspection: {len(files)} renders")
    return files, res.get("stats")


def render_previews(o, s, files):
    """Darrowmere renderar en ny modell själv (Blender utan skärm, fem vyer) så att granskningen ser hela modellen."""
    import subprocess
    blender = CONF.get("blender")
    glb = main_glb(files)
    if not blender or not glb or not Path(blender).exists():
        return files
    free_comfy_memory()
    out_dir = out_path(glb).parent
    try:
        r = subprocess.run(["nice", "-n", "15", blender, "-b", "--factory-startup", "-P", str(HERE / "render_views.py"), "--",
                            str(out_path(glb)), str(out_dir), "512", CONF.get("render_engine", "WORKBENCH")],
                           capture_output=True, text=True, timeout=600)
        line = next((l for l in r.stdout.splitlines() if l.startswith("RENDER_RESULT ")), None)
        names = json.loads(line.split(" ", 1)[1])["files"] if line else []
    except Exception as e:
        log(o.id, s["key"], "render failed:", e)
        names = []
    log(o.id, s["key"], f"rendered {len(names)} views")
    return files + [{"filename": n, "subfolder": glb["subfolder"], "type": "output"} for n in names]


SCRIPTS = {"split_sheet.py", "project_views.py", "import_model.py"}  # verktyg som får köras som steg, ur /data/runner/tools


def path_for(o, ref):
    # En fil som skriptet ska läsa: "$in:<namn>", "$step:<nyckel>" eller "$step:<nyckel>/<namn>" (bild eller modell)
    kind, _, name = ref.partition(":")
    if kind == "$in":
        return str(o.dir / "in" / name)
    key, _, part = name.partition("/")
    outs = o.st(key).get("outputs", [])
    hit = [f for f in outs if part in f["filename"]] if part else outs
    if not hit:
        raise RuntimeError(f"no file {ref}")
    return str(out_path(hit[0]))


def resolve_paths(o, value):
    if isinstance(value, str) and value.startswith("$"):
        return path_for(o, value)
    if isinstance(value, list):
        return [resolve_paths(o, v) for v in value]
    if isinstance(value, dict):
        return {k: resolve_paths(o, v) for k, v in value.items()}
    return value


def blender_step(o, s):
    """Renderar en modell i Blender på Darrowmere med givna kameror (t.ex. nya vyer att måla över)."""
    a = s.get("args") or {}
    glb = path_for(o, a["glb"])
    sub_dir = f"orders/{o.id}/{s['key']}"
    (OUTPUT / sub_dir).mkdir(parents=True, exist_ok=True)
    o.set(s["key"], status="running", start=time.time(), end=None, note="Blender on Darrowmere")
    t0 = time.time()
    res = run_blender_job({"glb": glb, "out_dir": str(OUTPUT / sub_dir), "size": a.get("size", 864), "shots": a["shots"],
                           "front_yaw": a.get("front_yaw", 0), "prefix": "view_", "stats": False})
    files = [{"filename": n, "subfolder": sub_dir, "type": "output"} for n in res["files"]]
    o.set(s["key"], status="done", end=time.time(), outputs=files, files=files, note=f"{len(files)} renders · {round(time.time() - t0)} s")


def script_step(o, s):
    """Ett av runnerns egna verktyg på Darrowmere (uppdelning av vyark, projicering på modellen) med en rad JSON ut."""
    import subprocess
    if s["script"] not in SCRIPTS:
        raise RuntimeError(f"script {s['script']} is not allowed")
    sub_dir = f"orders/{o.id}/{s['key']}"
    out_dir = OUTPUT / sub_dir
    out_dir.mkdir(parents=True, exist_ok=True)
    args = resolve_paths(o, s.get("args") or {})
    o.set(s["key"], status="running", start=time.time(), end=None, note=f"{s['script']} on Darrowmere")
    if s["script"] == "project_views.py":
        args["out"] = str(out_dir / f"{o.order.get('asset') or o.id}_{s['key']}.glb")
        recipe = o.dir / f"{s['key']}_recipe.json"
        recipe.write_text(json.dumps(args, indent=1))
        cmd = [sys.executable, "-I", str(HERE / "tools" / s["script"]), str(recipe)]
    else:
        args["out_dir"] = str(out_dir)
        cmd = [sys.executable, "-I", str(HERE / "tools" / s["script"]), json.dumps(args)]
    free_comfy_memory()
    t0 = time.time()
    r = subprocess.run(["nice", "-n", "10"] + cmd, capture_output=True, text=True, timeout=3600, cwd=str(o.dir))
    last = next((l for l in reversed(r.stdout.splitlines()) if l.startswith("{")), "")
    if r.returncode or not last:
        raise RuntimeError(f"{s['script']}: {(r.stderr or r.stdout).strip()[-300:]}")
    res = json.loads(last)
    if s["script"] == "project_views.py":
        names = [Path(res["glb"]).name, Path(res["glb"]).stem + "_basecolor.jpg"]
        note = f"projected {len(res.get('views', []))} views · {round(res.get('seen', 0) * 100, 1)} % seen · {round(time.time() - t0)} s"
    else:
        names = res.get("files", [])
        note = f"{len(names)} files · {round(time.time() - t0)} s"
    files = [{"filename": n, "subfolder": sub_dir, "type": "output"} for n in names]
    files = render_previews(o, s, files)
    o.set(s["key"], status="done", end=time.time(), outputs=files, files=files, note=note)


def meshy_remesh_step(o, s):
    """Nytt nät med Meshy Remesh (5 krediter): en befintlig modell ner till target_polycount, trianglar eller quads.
    Används för låg-poly av en högupplöst modell från flera vyer, så att hållningen kommer från alla vyer och inte gissas ur en bild."""
    p = s.get("params") or {}
    mesh = mesh_for(o, s.get("mesh") or "$step:model")
    if mesh.stat().st_size > 70 * 1024 * 1024:
        raise RuntimeError(f"{mesh.name} is {mesh.stat().st_size >> 20} MB; Meshy takes at most about 70 MB as a data URI")
    cost = 5
    cloud_gate(o, s, "meshy", cost)
    o.set(s["key"], status="running", route="cloud", provider="meshy", start=time.time(), end=None, pct=0)
    key = env_key("MESHY_API_KEY")
    body = {"model_url": "data:application/octet-stream;base64," + base64.b64encode(mesh.read_bytes()).decode(),
            "target_formats": ["glb"], "topology": p.get("topology", "triangle"), "target_polycount": int(p.get("target_polycount", 8000))}
    t0 = time.time()
    tid = meshy_req("POST", "/remesh", key, body)["result"]
    while True:
        t = meshy_req("GET", f"/remesh/{tid}", key)
        if t.get("status") == "SUCCEEDED":
            break
        if t.get("status") in ("FAILED", "CANCELED") or time.time() - t0 > 1800:
            raise RuntimeError(f"Meshy task {t.get('status')}: {(t.get('task_error') or {}).get('message', '')}"[:300])
        o.set(s["key"], note=f"Meshy remesh · {t.get('progress', 0)} %", pct=t.get("progress", 0))
        time.sleep(6)
    sub_dir = f"orders/{o.id}/{s['key']}"
    (OUTPUT / sub_dir).mkdir(parents=True, exist_ok=True)
    stem = f"{o.order.get('asset') or o.id}_{s['key']}"
    (OUTPUT / sub_dir / f"{stem}.glb").write_bytes(urllib.request.urlopen(t["model_urls"]["glb"], timeout=300).read())
    files = [{"filename": f"{stem}.glb", "subfolder": sub_dir, "type": "output"}]
    files = render_previews(o, s, files)
    credits = t.get("consumed_credits") or cost
    ai_log({"t": t0, "order": o.id, "order_title": o.order.get("title", o.id), "step": s["key"], "label": s.get("label", s["key"]),
            "provider": "meshy", "model": "remesh", "seconds": round(time.time() - t0, 1), "credits": credits, "files": files,
            "texture": False}, "cloud.jsonl")
    o.set(s["key"], status="done", end=time.time(), outputs=files, files=files, credits=credits,
          note=f"Meshy remesh · {body['topology']} · {body['target_polycount']} · {credits} credits · {round(time.time() - t0)} s")


def cloud_gate(o, s, provider, cost):
    # Budget per beställning och tjänst, och godkännande före varje molnsteg om det är påslaget
    st = settings()
    cap = int(st["budget"].get(f"{provider}_credits_per_order") or 0)
    spent = sum(o.st(x["key"]).get("credits") or 0 for x in o.order["steps"] if o.st(x["key"]).get("provider") == provider)
    if spent + cost > cap:
        raise RuntimeError(f"over budget: ~{cost} {provider} credits needed, {cap - spent} left of {cap} per order (Settings → Budget)")
    if st["budget"].get("ask_before_cloud", True) and not approved(o, s["key"], cost):
        o.set(s["key"], status="approval", note=f"needs approval: ~{cost} {provider.capitalize()} credits", estimate=cost,
              provider=provider, route="cloud")
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
            cost = meshy_cost((s.get("cloud") or {}).get("resolution") or (route.get("meshy") or {}).get("resolution", "2k"))
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
    c = s.get("cloud") or {}  # beställningen kan välja modell och textur själv: {"model": "tripo-p2", "texture": true}
    tex = bool(c["texture"]) if "texture" in c else (tr["use"] == "cloud" and tr.get("cloud") == "tripo")
    model = TRIPO_MODELS.get(c.get("model") or route["cloud"], "P1-20260311")
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
    level = v.get("level") or ("pass" if v.get("pass") else "fail")
    note = f"{level} {v.get('score')}/10: {v.get('summary', '')}"[:240]
    if v.get("rigging"):
        note += f" · rigging: {v['rigging']}"[:200]
    if v.get("issues"):
        note += " · " + "; ".join(map(str, v["issues"]))[:200]
    if v.get("pass"):
        o.set(s["key"], status="done", end=time.time(), note=note, verdict=v)
        return None
    if level == "warning":  # användbar men värd en titt: inget omtag, beställningen fortsätter
        o.set(s["key"], status="warning", end=time.time(), note=note, verdict=v)
        return None
    retry = s.get("retry") or {}
    target = retry.get("step")
    if target and o.st(target)["attempt"] < retry.get("max", 1):
        o.st(target)["attempt"] += 1
        o.set(s["key"], status="planned", end=time.time(), note="retrying · " + note, verdict=v, attempt=t["attempt"] + 1)
        o.set(target, status="planned", job=None)
        return target  # kör om från målsteget
    # Underkänd bild är inget tekniskt fel: "warning" när den är nära (poäng ≥ 4), annars "rejected"
    o.set(s["key"], status="rejected", end=time.time(), note=note, verdict=v)
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
        if t["status"] in ("done", "skipped", "waiting", "warning", "rejected") or (t["status"] == "failed" and s["kind"] != "comfy"):
            i += 1
            continue
        if (o.dir / "cancel").exists():
            o.state["status"] = "cancelled"
            o.save()
            return
        try:
            if s["kind"] == "comfy":
                comfy_step(o, s)
            elif s["kind"] == "script":
                script_step(o, s)
            elif s["kind"] == "blender":
                blender_step(o, s)
            elif s["kind"] in ("meshy3d", "remesh"):
                try:
                    (meshy3d_step if s["kind"] == "meshy3d" else meshy_remesh_step)(o, s)
                except Paused:
                    log(o.id, s["key"], "waiting for approval")
                    return
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
                if o.st(s["key"])["status"] == "rejected" and s.get("stop_on_fail", True):
                    o.state["status"] = "stopped"  # stoppad av granskningen, inte trasig
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
    warned = any(o.st(k)["status"] in ("warning", "rejected") for k in keys)
    o.state["status"] = "waiting" if waiting else "done with warnings" if warned else "done"
    o.save()
    log(o.id, o.state["status"])


# ---- operatören: DeepSeek väljer nästa varv ur en spelbok (docs/operator.md) -------------------------------------

PLAYBOOKS = HERE / "playbooks"
MISSIONS = OUTPUT / "missions"
FINAL = ("done", "done with warnings", "stopped", "failed", "waiting", "cancelled")


def playbook(name):
    pb = json.loads((PLAYBOOKS / f"{name}.json").read_text())
    pb["_dir"] = PLAYBOOKS / pb.get("dir", name)  # flera spelböcker kan dela graf och indata
    return pb


def mission_rounds(mission):
    """Alla varv i uppdraget: spakar, status, betyg och granskningens fel, äldst först."""
    rounds = []
    for d in ORDERS.iterdir():
        f = d / "order.json"
        if not (d.is_dir() and f.exists()):
            continue
        try:
            od = json.loads(f.read_text())
        except ValueError:
            continue
        if od.get("mission") != mission or not od.get("operator"):
            continue
        st = json.loads((d / "state.json").read_text()) if (d / "state.json").exists() else {}
        v = {}
        for r in sorted(d.glob("review_*_r*.json"), key=lambda p: p.stat().st_mtime):
            try:
                v = json.loads(r.read_text())
            except ValueError:
                pass
        failed = next((t.get("note") for t in (st.get("steps") or {}).values() if t.get("status") == "failed"), None)
        rounds.append({"order": d.name, "round": od["operator"].get("round"), "gpu": od.get("gpu") or DEFAULT_LANE, "levers": od["operator"].get("levers"),
                       "why": od["operator"].get("why"), "status": st.get("status"), "score": v.get("score"), "level": v.get("level"),
                       "summary": v.get("summary"), "issues": (v.get("issues") or [])[:5], "error": failed,
                       "created": st.get("created", d.stat().st_mtime)})
    return sorted(rounds, key=lambda r: (r["round"] or 0, r["created"]))


def lane_caps(pb, lane, levers):
    """Spelbokens tak per spår ("lane_limits": {"m4000": {"resolution": {"max": 1280}}}): ett långsammare kort får lättare varv."""
    for k, lim in ((pb.get("lane_limits") or {}).get(lane) or {}).items():
        if k in levers and isinstance(levers[k], (int, float)):
            v = min(max(levers[k], lim.get("min", levers[k])), lim.get("max", levers[k]))
            levers[k] = int(v) if isinstance(levers[k], int) else v
    return levers


def check_levers(pb, levers, previous):
    """Spakarna mot spelboken: bara kända spakar, tillåtna värden och gränser. Saknade spakar ärver förra varvet."""
    out = {**pb["start"], **(previous or {})}  # spakar som kommit till sedan förra varvet tar startvärdet
    for k, v in (levers or {}).items():
        spec = pb["levers"].get(k)
        if spec is None:
            raise ValueError(f"unknown lever {k}")
        if "values" in spec:
            if v not in spec["values"] and str(v) in spec["values"]:
                v = str(v)
            if v not in spec["values"]:
                raise ValueError(f"{k}={v!r} not in {list(spec['values'])}")
        else:
            v = float(v)
            if not spec["min"] <= v <= spec["max"]:
                raise ValueError(f"{k}={v} outside {spec['min']}..{spec['max']}")
            if spec.get("step"):
                v = spec["min"] + round((v - spec["min"]) / spec["step"]) * spec["step"]
            if spec.get("type") == "int":
                v = int(round(v))
        out[k] = v
    return out


OPERATOR_LOCK = threading.Lock()  # två spår som blir klara samtidigt får inte bygga samma varv


def next_round(pb):
    """Nästa lediga varvsnummer: räknar även varv som ännu ligger i inkorgen."""
    pre = f"{pb['mission']}-r"
    names = [d.name for d in ORDERS.iterdir() if d.name.startswith(pre)] + [f.stem for f in (ORDERS / "inbox").glob(pre + "*.json")]
    nums = [int(x[len(pre):]) for x in names if x[len(pre):].isdigit()]
    return max(nums, default=0) + 1


def build_round(pb, levers, n, why, lane=None):
    """Nästa beställning ur spelbokens mall: grafen med spakarna insatta, indata kopierade från spelbokens mapp."""
    tpl = json.loads(json.dumps(pb["template"]))
    if lane:
        tpl["gpu"] = lane
    graph = json.loads((pb["_dir"] / pb["graph"]).read_text())
    for name, value in levers.items():
        spec = pb["levers"][name]
        sets = spec["values"][value] if "values" in spec else [{**b, "value": value + b.get("add", 0)} for b in spec["bind"]]
        for b in sets:
            graph[b["node"]]["inputs"][b["input"]] = b["value"]
    oid = f"{pb['mission']}-r{n:02d}"
    for k, node in graph.items():  # varje varv sparar under sitt eget namn
        if isinstance(node, dict) and node.get("class_type") == "SaveGLB":
            node["inputs"]["filename_prefix"] = f"3d/{pb['mission']}/{oid}_{k}"
    tpl.update(id=oid, mission=pb["mission"], mission_title=pb["mission_title"],
               operator={"playbook": pb["id"], "round": n, "levers": levers, "why": why, "gpu": lane},
               title=pb["round_title"].format(n=n, **levers))
    for s in tpl["steps"]:
        if s.get("graph") == "$graph":
            s["graph"] = graph
    d = ORDERS / oid
    (d / "in").mkdir(parents=True, exist_ok=True)
    for name, src in tpl.pop("inputs_from_playbook", {}).items():
        shutil.copy(pb["_dir"] / src, d / "in" / name)
    tmp = ORDERS / "inbox" / f".{oid}.tmp"
    tmp.write_text(json.dumps(tpl))
    tmp.replace(ORDERS / "inbox" / f"{oid}.json")
    return oid


def mission_note(pb, rounds, status, message):
    MISSIONS.mkdir(parents=True, exist_ok=True)
    best = max((r for r in rounds if r.get("score") is not None), key=lambda r: r["score"], default=None)
    body = {"mission": pb["mission"], "title": pb["mission_title"], "playbook": pb["id"], "status": status, "message": message,
            "rounds": len(rounds), "max_rounds": pb["limits"]["max_rounds"], "best": best, "updated": time.time()}
    tmp = MISSIONS / f".{pb['mission']}.tmp"
    tmp.write_text(json.dumps(body, ensure_ascii=False, indent=1))
    tmp.replace(MISSIONS / f"{pb['mission']}.json")


def operator_ask(pb, rounds, lane=None):
    lever_text = "\n".join(f"- {k}: " + (f"one of {list(v['values'])}" if "values" in v else f"{v['min']}..{v['max']}" + (f" (step {v['step']})" if v.get("step") else "")) + f" — {v['help']}"
                           for k, v in pb["levers"].items())
    hist = json.dumps([{k: r.get(k) for k in ("round", "gpu", "levers", "status", "score", "level", "summary", "issues", "error")} for r in rounds],
                      ensure_ascii=False)
    caps = (pb.get("lane_limits") or {}).get(lane)
    lane_text = (f"\n\nTHE NEXT ROUND RUNS ON: {lane}." + (f" Limits on this GPU (values above are clamped): {json.dumps(caps)}." if caps else "")) if lane else ""
    prompt = (f"You are the operator of an automated 3D asset pipeline. You never invent new steps; you only choose lever values "
              f"from the playbook below for the next round, or stop.\n\nGOAL: {pb['goal']}\n\nLEVERS:\n{lever_text}\n\n"
              f"KNOWN MOVES:\n" + "\n".join(f"- {m}" for m in pb.get("moves", [])) +
              f"\n\nROUNDS SO FAR (oldest first):\n{hist}{lane_text}\n\nRounds left: {pb['limits']['max_rounds'] - len(rounds)}.\n"
              "Explore both models and several seeds before fine-tuning; do not repeat an identical lever set. "
              "Answer with one JSON object only: {\"action\": \"retry\" | \"done\" | \"escalate\", \"levers\": {...only levers you change...}, "
              "\"why\": \"one sentence\"}. Use done when the goal is met, escalate when something outside the levers is needed.")
    model = pb.get("model") or settings()["review"].get("model") or CONF["model"]
    t0 = time.time()
    r = http_json("https://openrouter.ai/api/v1/chat/completions",
                  {"model": model, "messages": [{"role": "user", "content": prompt}], "response_format": {"type": "json_object"},
                   "temperature": 0.4, "usage": {"include": True}},
                  headers={"Authorization": f"Bearer {env_key()}", "X-Title": "Darrowmere operator"}, timeout=120)
    text = r["choices"][0]["message"]["content"] or ""
    ans = json.loads(text[text.find("{"): text.rfind("}") + 1])
    ai_log({"t": t0, "order": pb["mission"], "order_title": pb["mission_title"], "step": "operator", "label": "Operator: next round",
            "model": r.get("model", model), "seconds": round(time.time() - t0, 1), "summary": ans.get("why"), "action": ans.get("action"),
            "levers": ans.get("levers"), "cost_usd": (r.get("usage") or {}).get("cost")})
    return ans


def operate(oid):
    """Efter en beställning med "operator": nästa varv, eller ett besked till Patrik och Claude. Görs en gång per beställning."""
    d = ORDERS / oid
    od = json.loads((d / "order.json").read_text())
    op = od.get("operator") or {}
    if not op.get("playbook") or (d / "operated").exists():
        return
    st = json.loads((d / "state.json").read_text()) if (d / "state.json").exists() else {}
    if st.get("status") not in FINAL:
        return
    (d / "operated").write_text(str(time.time()))
    with OPERATOR_LOCK:
        operate_locked(op, od)


def operate_locked(op, od):
    pb = playbook(op["playbook"])
    rounds = mission_rounds(pb["mission"])
    if (MISSIONS / f"{pb['mission']}.json").exists() and json.loads((MISSIONS / f"{pb['mission']}.json").read_text()).get("status") in ("done", "escalated", "stopped"):
        return
    scores = [r["score"] for r in rounds if r.get("score") is not None]
    lim = pb["limits"]
    if scores and max(scores) >= lim["stop_score"]:
        mission_note(pb, rounds, "done", f"goal reached: {max(scores)}/10")
        return
    if len(rounds) >= lim["max_rounds"]:
        mission_note(pb, rounds, "done", f"all {lim['max_rounds']} rounds used; best {max(scores) if scores else '-'}/10")
        return
    lane_rounds = [r for r in rounds if r.get("gpu") == (od.get("gpu") or DEFAULT_LANE)]  # tre fel i rad räknas per kort
    if sum(1 for r in lane_rounds[-3:] if r["status"] == "failed") >= 3:
        mission_note(pb, rounds, "escalated", "three failed rounds in a row: " + str(lane_rounds[-1].get("error"))[:200])
        return
    try:
        ans = operator_ask(pb, rounds, od.get("gpu"))
        action = ans.get("action")
        if action in ("done", "escalate"):
            mission_note(pb, rounds, "done" if action == "done" else "escalated", ans.get("why") or action)
            return
        levers = lane_caps(pb, od.get("gpu"), check_levers(pb, ans.get("levers"), op.get("levers")))
        if any(r.get("levers") == levers for r in rounds):  # samma spakar igen: nytt frö i stället
            spec = pb["levers"]["seed"]
            levers["seed"] = int(spec["min"] + (levers["seed"] * 7919 + len(rounds) * 104729) % (spec["max"] - spec["min"]))
    except Exception as e:
        mission_note(pb, rounds, "escalated", f"operator reply outside the playbook: {e}"[:300])
        return
    n = next_round(pb)
    nid = build_round(pb, levers, n, (ans.get("why") or "")[:300], od.get("gpu"))
    mission_note(pb, rounds, "running", f"round {n}: {ans.get('why', '')}"[:300])
    log(od.get("id"), "operator ->", nid, levers)


def start_mission(name):
    """python runner.py --mission <spelbok>: ett första varv med spelbokens startvärden på varje spår som spelboken
    nämner ("lanes") och som inte redan har ett varv igång. Går att köra igen när ett spår har tillkommit."""
    pb = playbook(name)
    rounds = mission_rounds(pb["mission"])
    busy = set()
    for r in rounds:
        if r.get("status") in (None, "queued", "running"):
            busy.add(json.loads((ORDERS / r["order"] / "order.json").read_text()).get("gpu") or DEFAULT_LANE)
    started = []
    for i, lane in enumerate(pb.get("lanes") or [DEFAULT_LANE]):
        if lane in busy:
            continue
        levers = lane_caps(pb, lane, dict(pb["start"]))
        if started or rounds:  # fler spår samtidigt: samma startvärden men eget frö, så att varven inte blir likadana
            levers["seed"] = levers["seed"] + 1000 * (i + len(rounds))
        n = next_round(pb)
        started.append(build_round(pb, levers, n, f"start values from the playbook ({lane})", lane))
    mission_note(pb, rounds, "running", f"started {', '.join(started) or 'nothing (every lane busy)'}")
    print(json.dumps({"ok": True, "orders": started}))


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


def lane_of(oid):
    try:
        lane = json.loads((ORDERS / oid / "order.json").read_text()).get("gpu")
    except (OSError, ValueError):
        lane = None
    return lane if lane in LANES else DEFAULT_LANE


LANE_THREADS = {}


def run_lane(lane, oids):
    _lane.url = LANES[lane]
    for oid in oids:
        try:
            run_order(Order(oid))
        except Exception:
            log(oid, "crashed:", traceback.format_exc()[-600:])
        try:
            operate(oid)
        except Exception:
            log(oid, "operator crashed:", traceback.format_exc()[-600:])


def tick():
    take_inbox()
    by_lane = {}
    for oid in active():
        by_lane.setdefault(lane_of(oid), []).append(oid)
    for lane, oids in by_lane.items():
        th = LANE_THREADS.get(lane)
        if th and th.is_alive():
            continue  # spåret jobbar redan; nya beställningar tas vid nästa varv
        th = LANE_THREADS[lane] = threading.Thread(target=run_lane, args=(lane, oids), name=f"lane-{lane}", daemon=True)
        th.start()


def rereview(oid, key):
    """Granskar ett steg igen: renderar modellen från stegen granskningen tittar på (om det saknas) och kör DeepSeek."""
    o = Order(oid)
    s = next(x for x in o.order["steps"] if x["key"] == key)
    for ref in s.get("images", []):
        if ref.startswith("$step:"):
            src = ref.split(":", 1)[1]
            outs = o.st(src).get("outputs", [])
            if not any("_render_" in f["filename"] for f in outs):
                o.set(src, outputs=render_previews(o, {"key": src}, outs))
    o.st(key)["attempt"] = o.st(key).get("attempt", 0)
    review_step(o, s)
    print(json.dumps({"order": oid, "step": key, "status": o.st(key)["status"], "note": o.st(key).get("note")}))


if __name__ == "__main__":
    if "--mission" in sys.argv:  # python runner.py --mission <spelbok>
        start_mission(sys.argv[sys.argv.index("--mission") + 1])
        sys.exit(0)
    if "--rereview" in sys.argv:  # python runner.py --rereview <beställning> <granskningssteg>
        i = sys.argv.index("--rereview")
        rereview(sys.argv[i + 1], sys.argv[i + 2])
        sys.exit(0)
    log("runner up", LANES, ORDERS, CONF["model"])
    if "--once" in sys.argv:
        tick()
        for th in LANE_THREADS.values():
            th.join()
        sys.exit(0)
    while True:
        tick()
        time.sleep(10)
