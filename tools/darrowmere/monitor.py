"""Kontrollpanelen för jobbdatorn Darrowmere: hur datorn mår och hur ComfyUI-jobben går.

Körs normalt som tjänst på Darrowmere själv (install_on_darrowmere.sh), nåbar från hemmanätet:
  http://192.168.0.33:8790
Där läses värdena lokalt (DARROWMERE_HOST=localhost) och jobbhistoriken sparas i MONITOR_STATE.

Kan också köras på laptopen, och hämtar då värdena över SSH:
  python3 -I tools/darrowmere/monitor.py [port]        (standard 8791, lyssnar på MONITOR_BIND, normalt 127.0.0.1)

Jobben hämtas från ComfyUI:s API (DARROWMERE_COMFY, annars målet "darrowmere" i tools/comfy.json). Knapparna avbryter
jobbet, tömmer kön eller startar om ComfyUI-tjänsten (sudo-regeln i /etc/sudoers.d/comfyui tillåter bara det).
"""
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
try:
    _default = json.loads((HERE.parent / "comfy.json").read_text())["targets"]["darrowmere"]
except (OSError, ValueError, KeyError):
    _default = "http://127.0.0.1:8188"
COMFY = os.environ.get("DARROWMERE_COMFY", _default).rstrip("/")
# Darrowmere har en ComfyUI per grafikkort (runnerns körspår). Den första är huvudinstansen (enheter, version, knappar
# och bildfiler), övriga visar sina jobb i samma lista och får ett eget kort för det som kör. Utdatamappen är gemensam.
_u = urllib.parse.urlparse(COMFY)
try:
    COMFY_LANES = json.loads(os.environ["DARROWMERE_COMFY_LANES"])
except (KeyError, ValueError):
    COMFY_LANES = {"T1000": COMFY, "M4000": f"{_u.scheme}://{_u.hostname}:8189"}
HOST = os.environ.get("DARROWMERE_HOST", urllib.parse.urlparse(COMFY).hostname)
LOCAL = HOST in ("localhost", "127.0.0.1")
# Kommandon körs direkt när panelen körs på Darrowmere, annars över en delad SSH-anslutning
SSH = [] if LOCAL else ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-o", "ServerAliveInterval=3",
                        "-o", "ServerAliveCountMax=2", "-o", "ControlMaster=auto",
                        "-o", f"ControlPath={Path.home()}/.ssh/cm-darrowmere-%C", "-o", "ControlPersist=120",
                        *(["-i", os.environ["MONITOR_SSH_KEY"]] if os.environ.get("MONITOR_SSH_KEY") else []), f"epatnor@{HOST}"]
POLL = 3.0

# Körs på Darrowmere med python3 -, skriver en rad JSON
PROBE = r'''
import json, os, re, subprocess, time
def stat():
    out = []
    for l in open("/proc/stat"):
        if l.startswith("cpu"):
            p = l.split(); v = list(map(int, p[1:9])); idle = v[3] + v[4]
            out.append((p[0], sum(v), idle))
    return out
a = stat(); time.sleep(0.5); b = stat()
cpu = [round(100 * (1 - (y[2] - x[2]) / max(1, y[1] - x[1])), 1) for x, y in zip(a, b)]
mi = {l.split(":")[0]: int(l.split()[1]) for l in open("/proc/meminfo")}
temps = []
for h in sorted(os.listdir("/sys/class/hwmon")):
    d = f"/sys/class/hwmon/{h}"
    name = open(f"{d}/name").read().strip()
    for f in sorted(os.listdir(d)):
        if re.match(r"temp\d+_input$", f):
            lab = f.replace("_input", "_label")
            label = open(f"{d}/{lab}").read().strip() if os.path.exists(f"{d}/{lab}") else f.split("_")[0]
            temps.append({"chip": name, "label": label, "c": int(open(f"{d}/{f}").read()) / 1000})
def run(cmd):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=8).stdout
    except Exception:
        return ""
gpus = []
q = "index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit,fan.speed,clocks.sm"
for l in run(["nvidia-smi", f"--query-gpu={q}", "--format=csv,noheader,nounits"]).strip().splitlines():
    v = [x.strip() for x in l.split(",")]
    num = lambda s: float(s) if re.match(r"^[\d.]+$", s) else None
    gpus.append({"index": int(v[0]), "name": v[1], "util": num(v[2]), "mem_used": num(v[3]), "mem_total": num(v[4]),
                 "temp": num(v[5]), "power": num(v[6]), "power_limit": num(v[7]), "fan": num(v[8]), "clock": num(v[9])})
disks = []
for m in ("/", "/data"):
    try:
        s = os.statvfs(m); disks.append({"mount": m, "total": s.f_blocks * s.f_frsize, "free": s.f_bavail * s.f_frsize})
    except OSError:
        pass
net = {}
for l in open("/proc/net/dev").readlines()[2:]:
    n, rest = l.split(":", 1)
    n = n.strip()
    if n != "lo":
        f = rest.split(); net[n] = {"rx": int(f[0]), "tx": int(f[8])}
log = run(["journalctl", "-u", "comfyui", "-n", "60", "--no-pager", "-o", "cat"])
log = re.sub(r"\x1b\[[0-9;]*m", "", log).splitlines()
procs = []
for l in run(["ps", "-eo", "pid,pcpu,pmem,rss,comm", "--sort=-pcpu"]).splitlines()[1:7]:
    p = l.split(None, 4)
    if len(p) == 5:
        procs.append({"pid": int(p[0]), "cpu": float(p[1]), "mem": float(p[2]), "rss_mb": int(p[3]) // 1024, "name": p[4]})
pipes = []  # planerna som tools/pipeline.py sparar; de senaste tre dygnen
pd = "/data/utdata/pipelines"
if os.path.isdir(pd):
    fs = sorted((f for f in os.listdir(pd) if f.endswith(".json") and not f.startswith(".")), key=lambda f: -os.path.getmtime(f"{pd}/{f}"))
    for f in fs[:8]:
        if time.time() - os.path.getmtime(f"{pd}/{f}") < 3 * 86400:
            try:
                pipes.append(json.load(open(f"{pd}/{f}")))
            except Exception:
                pass
ai = []  # de senaste DeepSeek- och molnanropen från beställningsrunnern
for fn in ("/data/orders/deepseek.jsonl", "/data/orders/cloud.jsonl"):
    try:
        with open(fn) as f:
            for l in f.readlines()[-40:]:
                try:
                    ai.append(json.loads(l))
                except Exception:
                    pass
    except OSError:
        pass
print(json.dumps({
    "pipelines": pipes, "ai": ai,
    "t": time.time(), "host": os.uname().nodename, "uptime": float(open("/proc/uptime").read().split()[0]),
    "load": open("/proc/loadavg").read().split()[:3], "cpu": cpu[0], "cores": cpu[1:],
    "mem": {"total": mi["MemTotal"] * 1024, "avail": mi["MemAvailable"] * 1024,
            "swap_total": mi["SwapTotal"] * 1024, "swap_free": mi["SwapFree"] * 1024},
    "temps": temps, "gpus": gpus, "disks": disks, "net": net, "procs": procs,
    "service": run(["systemctl", "is-active", "comfyui.service"]).strip(), "log": log[-40:],
}))
'''

state = {"probe": None, "probe_error": None, "comfy": None, "comfy_error": None, "rates": {}, "updated": 0}
hist = deque(maxlen=int(600 / POLL))  # 10 minuter
lock = threading.Lock()

# Jobbhistoriken sparas här, så att den finns kvar när ComfyUI startas om; kvitterade jobb visas bara i historikfönstret
STORE = Path(os.environ.get("MONITOR_STATE") or Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local/state")) / "darrowmere-monitor" / "jobs.json")
try:
    jobs = {j["id"]: j for j in json.loads(STORE.read_text())}
except (OSError, ValueError):
    jobs = {}


# Mätpunkterna för diagrammet sparas också, så att kurvan fortsätter när panelen startas om
METRICS = STORE.with_name("metrics.json")
try:
    hist.extend(p for p in json.loads(METRICS.read_text()) if time.time() - p.get("t", 0) < 600)
except (OSError, ValueError):
    pass


def save_metrics():
    try:
        METRICS.parent.mkdir(parents=True, exist_ok=True)
        tmp = METRICS.with_suffix(".tmp")
        tmp.write_text(json.dumps(list(hist)))
        tmp.replace(METRICS)
    except OSError:
        pass


def save_jobs():
    STORE.parent.mkdir(parents=True, exist_ok=True)
    keep = sorted(jobs.values(), key=lambda j: j.get("start") or 0, reverse=True)[:500]
    tmp = STORE.with_suffix(".tmp")
    tmp.write_text(json.dumps(keep, indent=0))
    tmp.replace(STORE)


def merge_jobs(history):
    changed = False
    for j in history:
        old = jobs.get(j["id"])
        new = {**j, "acked": old.get("acked", False) if old else False}
        if old != new:
            jobs[j["id"]] = new
            changed = True
    # Huvudsidan visar högst fem jobb; de äldre läggs i History (kvitteras automatiskt), så de inte kommer tillbaka
    open_jobs = sorted((j for j in jobs.values() if not j.get("acked")), key=lambda j: j.get("start") or 0, reverse=True)
    for j in open_jobs[5:]:
        j["acked"] = True
        changed = True
    if changed:
        save_jobs()


DELIVERED = STORE.with_name("delivered.json")  # skrivs av deliver.py på Andorhal: jobb-id -> mapp, antal filer, tid


def delivered_map():
    try:
        return json.loads(DELIVERED.read_text())
    except (OSError, ValueError):
        return {}


def job_list(include_acked=False, limit=50):
    dmap = delivered_map()
    out = [{**j, "delivered": dmap.get(j["id"])} for j in jobs.values() if include_acked or not j.get("acked")]
    return sorted(out, key=lambda j: j.get("start") or 0, reverse=True)[:limit]


def get_json(path, timeout=8, base=None):
    return json.load(urllib.request.urlopen(f"{base or COMFY}{path}", timeout=timeout))


def job_details(graph):
    # Det som behövs för att förstå eller göra om jobbet: prompter, frö, steg, storlek och modeller
    d = {"prompts": [], "params": {}, "models": []}
    for n in graph.values():
        if not isinstance(n, dict):
            continue
        inp, ct = n.get("inputs", {}), n.get("class_type", "")
        t = inp.get("text")
        if isinstance(t, str) and t.strip() and t.strip() not in d["prompts"]:
            d["prompts"].append(t.strip())
        for k in ("seed", "noise_seed", "steps", "cfg", "denoise", "sampler_name", "scheduler", "guidance"):
            v = inp.get(k)
            if isinstance(v, (int, float, str)) and not isinstance(v, bool) and k not in d["params"]:
                d["params"][k] = v
        if ct in ("EmptyLatentImage", "EmptySD3LatentImage", "EmptyFlux2LatentImage") and isinstance(inp.get("width"), int):
            d["params"].setdefault("size", f"{inp['width']}×{inp['height']}")
        for k in ("unet_name", "ckpt_name", "clip_name", "lora_name"):
            v = inp.get(k)
            if isinstance(v, str) and v not in d["models"]:
                d["models"].append(v)
    return d


def job_title(item):
    # Beskrivningen som verktyget skickade med (comfy_target.job_extra), om någon
    extra = item[3] if len(item) > 3 and isinstance(item[3], dict) else {}
    return str(extra.get("job_title") or "")[:160]


def job_pipeline(item):
    # Vilken pipeline och vilket steg jobbet hör till (tools/pipeline.py), om något
    extra = item[3] if len(item) > 3 and isinstance(item[3], dict) else {}
    p = extra.get("pipeline")
    return {"id": str(p["id"]), "step": str(p["step"])} if isinstance(p, dict) and p.get("id") and p.get("step") else None


# ---- Inställningar och API-nycklar ---------------------------------------------------------------------------------
# Inställningarna och nycklarna ligger på Darrowmere, där runnern läser dem: /data/runner/settings.json och
# /data/runner/.env (läge 600). Nycklar skickas dit över SSH på stdin och läses aldrig tillbaka till webbläsaren; sidan
# får bara veta om en nyckel finns, dess fyra sista tecken och när den sparades.
PROVIDERS = {
    "openrouter": {"label": "OpenRouter", "env": "OPENROUTER_API_KEY", "used_for": "DeepSeek review",
                   "url": "https://openrouter.ai/settings/keys"},
    "tripo": {"label": "Tripo 3D", "env": "TRIPO_API_KEY", "used_for": "Cloud 3D models and their textures",
              "url": "https://platform.tripo3d.ai/api-keys"},
    "meshy": {"label": "Meshy", "env": "MESHY_API_KEY", "used_for": "Cloud textures on our own meshes (Retexture)",
              "url": "https://www.meshy.ai/settings/api"},
}
KEYTOOL = r'''
import json, os, sys, time, urllib.request, urllib.error
D = "/data/runner"; ENV = D + "/.env"; META = D + "/keys_meta.json"
req = json.load(sys.stdin)
def read():
    out = {}
    if os.path.exists(ENV):
        for l in open(ENV):
            if "=" in l and not l.startswith("#"):
                k, v = l.rstrip("\n").split("=", 1); out[k] = v.strip().strip('"').strip("'")
    return out
def meta():
    try: return json.load(open(META))
    except Exception: return {}
def write(d, m):
    fd = os.open(ENV + ".tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f: f.write("".join(f"{k}={v}\n" for k, v in d.items() if v))
    os.replace(ENV + ".tmp", ENV); os.chmod(ENV, 0o600)
    json.dump(m, open(META, "w")); os.chmod(META, 0o600)
def get(url, key):
    r = urllib.request.Request(url, headers={"Authorization": "Bearer " + key})
    try: return json.load(urllib.request.urlopen(r, timeout=20))
    except urllib.error.HTTPError as e: return {"http": e.code}
    except Exception as e: return {"error": str(e)[:120]}
op = req["op"]; e = read(); m = meta(); out = {"ok": True}
if op == "status":
    out["keys"] = {k: {"set": bool(e.get(k)), **m.get(k, {})} for k in req["envs"]}
    try: out["settings"] = json.load(open(D + "/settings.json"))
    except Exception: out["settings"] = {}
    try: out["defaults"] = json.load(open(D + "/runner.json")).get("defaults", {})
    except Exception: out["defaults"] = {}
elif op == "set":
    v = req["value"]
    e[req["env"]] = v; m[req["env"]] = {"hint": v[-4:], "saved": time.time(), "by": req.get("by")}; write(e, m)
elif op == "delete":
    e.pop(req["env"], None); m.pop(req["env"], None); write(e, m)
elif op == "settings":
    tmp = D + "/settings.tmp"; json.dump(req["settings"], open(tmp, "w"), indent=1); os.replace(tmp, D + "/settings.json")
elif op == "test":
    k = e.get(req["env"])
    if not k: out = {"ok": False, "message": "No key saved."}
    elif req["provider"] == "openrouter":
        r = get("https://openrouter.ai/api/v1/key", k); d = r.get("data") or {}
        out = {"ok": bool(d), "message": (f"Key works · used ${d.get('usage', 0):.2f}" + (f" of ${d['limit']:.2f}" if d.get("limit") else "")
               + (f" · expires {d['expires_at'][:10]}" if d.get("expires_at") else "")) if d else f"Rejected ({r.get('http') or r.get('error')})"}
    elif req["provider"] == "tripo":
        for url in ("https://openapi.tripo3d.ai/v3/account/balance", "https://openapi.tripo3d.ai/v3/wallet", "https://api.tripo3d.ai/v2/openapi/user/balance"):
            r = get(url, k)
            if r.get("code") == 0:
                d = r.get("data") or {}; out = {"ok": True, "message": f"Key works · balance {d.get('balance', d)}"}; break
        else:
            out = {"ok": False, "message": f"Rejected ({r.get('http') or r.get('error') or r.get('code')})"}
    elif req["provider"] == "meshy":
        r = get("https://api.meshy.ai/openapi/v1/balance", k)
        if "balance" in r:
            out = {"ok": True, "message": f"Key works · balance {r['balance']} credits"}
        else:
            r2 = get("https://api.meshy.ai/openapi/v1/retexture?page_size=1", k)
            out = {"ok": isinstance(r2, list) or "http" not in r2,
                   "message": "Key works" if isinstance(r2, list) or "http" not in r2 else f"Rejected ({r2.get('http') or r2.get('error')})"}
print(json.dumps(out))
'''


def rcmd(args):
    # Ett kommando på Darrowmere: direkt när panelen körs där, annars över SSH (den andra sidans skal tolkar om raden)
    import shlex
    return list(args) if LOCAL else SSH + [shlex.join(args)]


def keytool(req):
    r = subprocess.run(rcmd(["python3", "-c", KEYTOOL]), input=json.dumps(req), capture_output=True, text=True, timeout=40)
    if r.returncode:
        raise RuntimeError((r.stderr or "Darrowmere did not answer").strip()[-200:])
    return json.loads(r.stdout)


AUDIT = STORE.with_name("settings_audit.log")


def audit(user, what):
    # Vem ändrade vad och när (aldrig själva nyckeln)
    with open(AUDIT, "a") as f:
        f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {user} {what}\n")


def clean_settings(s, defaults):
    # Bara kända fält, med rimliga värden
    r = json.loads(json.dumps(defaults))
    rt = s.get("routes", {})
    for kind in ("model", "texture"):
        v = rt.get(kind, {})
        if v.get("use") in ("local", "cloud"):
            r["routes"][kind]["use"] = v["use"]
    tx = rt.get("texture", {})
    if tx.get("cloud") in ("meshy", "tripo"):
        r["routes"]["texture"]["cloud"] = tx["cloud"]
    mo = tx.get("meshy") or {}
    if mo.get("resolution") in ("2k", "4k", "8k"):
        r["routes"]["texture"]["meshy"]["resolution"] = mo["resolution"]
    for f in ("pbr", "keep_uv"):
        if isinstance(mo.get(f), bool):
            r["routes"]["texture"]["meshy"][f] = mo[f]
    if r["routes"]["texture"]["cloud"] == "tripo" and r["routes"]["model"]["use"] != "cloud":
        r["routes"]["texture"]["cloud"] = "meshy"  # Tripo texturerar bara sina egna modeller
    if rt.get("model", {}).get("cloud") in ("tripo-p1", "tripo-p2"):
        r["routes"]["model"]["cloud"] = rt["model"]["cloud"]
    fl = rt.get("model", {}).get("face_limit")
    if isinstance(fl, int) and 500 <= fl <= 20000:
        r["routes"]["model"]["face_limit"] = fl
    rv = s.get("review", {})
    if isinstance(rv.get("enabled"), bool):
        r["review"]["enabled"] = rv["enabled"]
    if isinstance(rv.get("model"), str) and re.fullmatch(r"~?[\w.-]+/[\w.:-]+", rv["model"]):
        r["review"]["model"] = rv["model"]
    b = s.get("budget", {})
    if isinstance(b.get("tripo_credits_per_order"), int) and 0 <= b["tripo_credits_per_order"] <= 5000:
        r["budget"]["tripo_credits_per_order"] = b["tripo_credits_per_order"]
    if isinstance(b.get("meshy_credits_per_order"), int) and 0 <= b["meshy_credits_per_order"] <= 5000:
        r["budget"]["meshy_credits_per_order"] = b["meshy_credits_per_order"]
    if isinstance(b.get("ask_before_cloud"), bool):
        r["budget"]["ask_before_cloud"] = b["ask_before_cloud"]
    return r


def ai_jobs(entries):
    # DeepSeek-granskningar som rader i jobblistan: namn "DeepSeek", godkänt eller underkänt, tid, poäng och kostnad
    out = []
    for e in entries or []:
        if e.get("provider"):  # ett molnjobb (Tripo): en rad med 3D-knapp för modellen
            files = e.get("files") or []
            out.append({"id": f"cloud-{e.get('order')}-{e.get('step')}-{int(e.get('t', 0) * 1000)}", "name": str(e["provider"]).capitalize(), "cloud": True,
                        "title": f"{e.get('order_title', e.get('order'))}: {e.get('label', e.get('step'))}"
                                 + (f" · {e.get('credits')} credits" if e.get("credits") is not None else ""),
                        "status": "error" if e.get("error") else "success", "start": e.get("t"), "seconds": e.get("seconds"),
                        "outputs": len(files), "models": [f for f in files if f["filename"].lower().endswith((".glb", ".gltf"))],
                        "images": [], "pipeline": {"id": e.get("order"), "step": e.get("step")}, "kind": "ai",
                        "details": {"prompts": [], "params": {k: e[k] for k in ("credits", "face_limit", "texture") if e.get(k) is not None},
                                    "models": [e.get("model")]}, "error": e.get("error")})
            continue
        ok = e.get("pass")
        cost = e.get("cost_usd")
        out.append({"id": f"ai-{e.get('order')}-{e.get('step')}-{int(e.get('t', 0) * 1000)}", "name": "DeepSeek", "cloud": True,
                    "title": f"{e.get('order_title', e.get('order'))}: {e.get('label', e.get('step'))}"
                             + (f" · {e.get('score')}/10" if e.get("score") is not None else "")
                             + (f" · ${cost:.4f}" if isinstance(cost, (int, float)) else ""),
                    # Nivåer: error = tekniskt fel (nyckel, krediter, nätet), annars granskningens omdöme pass / warning / fail
                    "status": "error" if e.get("error") else e.get("level") or ("pass" if ok else "warning" if (e.get("score") or 0) >= 4 else "fail"),
                    "start": e.get("t"), "seconds": e.get("seconds"), "outputs": 0, "models": [], "images": [],
                    "pipeline": {"id": e.get("order"), "step": e.get("step")}, "kind": "ai",
                    "details": {"prompts": ["\n".join(f"- {c}" for c in e.get("criteria") or [])] + ([e["summary"]] if e.get("summary") else []),
                                "params": {k: v for k, v in (("score", e.get("score")), ("cost_usd", cost),
                                                             ("prompt_tokens", (e.get("tokens") or {}).get("prompt_tokens")),
                                                             ("completion_tokens", (e.get("tokens") or {}).get("completion_tokens")))
                                           if v is not None},
                                "models": [e.get("model")]},
                    "error": e.get("error") or (None if ok else "; ".join(map(str, e.get("issues") or [])) or e.get("summary"))})
    return out


def pipeline_views(plans, comfy):
    """Planerna med status per steg. ComfyUI-steg får sin status från jobben (det senaste jobbet för steget gäller),
    övriga steg från planfilen. Bara pipelines som pågår eller ändrades de senaste tolv timmarna visas."""
    run = comfy["running"] if comfy else []
    pend = comfy["pending"] if comfy else []
    by_step = {}
    for j in sorted(jobs.values(), key=lambda j: j.get("start") or 0):
        if j.get("pipeline") and j.get("kind") != "ai":  # granskningarnas läge står i planfilen
            by_step[(j["pipeline"]["id"], j["pipeline"]["step"])] = j
    out = []
    for pl in plans or []:
        # Ett steg kan också peka ut sitt jobb direkt ("job": prompt-id), t.ex. ett jobb som skickades innan planen fanns
        for s in pl.get("steps", []):
            jid = s.get("job")
            if jid:
                ref = {"id": pl["id"], "step": s["key"]}
                if jid in jobs:
                    by_step[(pl["id"], s["key"])] = jobs[jid]
                for r in run + pend:
                    if r["id"] == jid and not r.get("pipeline"):
                        r["pipeline"] = ref
        steps = []
        for s in pl.get("steps", []):
            key = (pl["id"], s["key"])
            v = {"key": s["key"], "label": s.get("label", s["key"]), "where": s.get("where", "darrowmere"), "kind": s.get("kind"),
                 "status": s.get("status") or "planned", "note": s.get("note"), "start": s.get("start"), "end": s.get("end"),
                 "estimate": s.get("estimate"), "route": s.get("route"), "provider": s.get("provider"),
                 "credits": s.get("credits"), "pct": s.get("pct"), "eta": s.get("eta"), "files": s.get("files"), "job": s.get("job")}
            j = by_step.get(key)
            if j:
                if not v.get("files"):
                    v["files"] = ((j.get("models") or []) + (j.get("images") or []))[:24]
                v.update(status="done" if j.get("status") == "success" else "failed", job=j["id"], start=j.get("start"),
                         end=(j["start"] + j["seconds"]) if j.get("start") and j.get("seconds") is not None else None)
            if any(p.get("pipeline") and (p["pipeline"]["id"], p["pipeline"]["step"]) == key for p in pend):
                v.update(status="queued", end=None)
            r = next((r for r in run if r.get("pipeline") and (r["pipeline"]["id"], r["pipeline"]["step"]) == key), None)
            if r:
                pr = comfy.get("progress") or {}
                v.update(status="running", job=r["id"], start=r.get("queued_at"), end=None, pct=pr.get("pct"))
            steps.append(v)
        active = any(s["status"] in ("running", "queued", "approval") for s in steps)
        if not active and time.time() - pl.get("updated", 0) > 12 * 3600 and not any(
                (s.get("end") or 0) > time.time() - 12 * 3600 for s in steps):
            continue
        out.append({"id": pl["id"], "title": pl.get("title", pl["id"]), "steps": steps, "active": active,
                    "done": sum(s["status"] in ("done", "skipped") for s in steps), "updated": pl.get("updated")})
    out.sort(key=lambda p: (not p["active"], -(p.get("updated") or 0)))
    return out


def job_name(prompt):
    types = [n.get("class_type", "") for n in prompt.values()]
    joined = " ".join(types)
    if "UltraTex" in joined:
        return "UltraTex"
    if "Pixal3D" in joined or "Trellis2" in joined:
        # Samma graf kör båda modellerna: TRELLIS.2 när en TRELLIS-vikt är laddad (Pixal3D-laddaren står kvar i grafen)
        unets = " ".join(str(n.get("inputs", {}).get("unet_name", "")).lower() for n in prompt.values())
        if "trellis" in unets:
            return "TRELLIS.2"
        return "Pixal3D multiview" if "multiview" in unets else "Pixal3D"
    for n in prompt.values():
        name = str(n.get("inputs", {}).get("unet_name", ""))
        if "krea" in name.lower():
            return "Krea-2"
        if name:
            return Path(name).stem
    for n in prompt.values():
        if n.get("class_type") in ("SaveImage", "SaveImageAdvanced"):
            return str(n["inputs"].get("filename_prefix", "image"))
    return types[0] if types else "job"


# ComfyUI:s websocket skickar steg ("progress") och vilken nod som körs ("executing") i realtid. Verktygen skickar
# inget client_id, så meddelandena går till alla anslutna, även hit. Ett minimalt websocket-klient med standardbiblioteket.
live = {}
LIVES = {}  # körspår -> samma sorts läge som live, för de andra ComfyUI-instanserna (bara i minnet)
RUN_GRAPHS = {}
# Stegen för det pågående jobbet sparas på disken, så att rutorna finns kvar om panelen startas om mitt i ett jobb
LIVE_FILE = STORE.with_name("live.json")
try:
    live.update(json.loads(LIVE_FILE.read_text()))
except (OSError, ValueError):
    pass


def save_live():
    try:
        tmp = LIVE_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(live))
        tmp.replace(LIVE_FILE)
    except OSError:
        pass


def ws_listener(url=None, live=live, persist=True):
    import base64
    import socket
    import struct
    u = urllib.parse.urlparse(url or COMFY)
    while True:
        try:
            s = socket.create_connection((u.hostname, u.port or 80), timeout=30)
            key = base64.b64encode(os.urandom(16)).decode()
            s.sendall((f"GET /ws?clientId=darrowmere-monitor HTTP/1.1\r\nHost: {u.hostname}:{u.port}\r\nUpgrade: websocket\r\n"
                       f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
            buf = b""
            while b"\r\n\r\n" not in buf:
                chunk = s.recv(4096)
                if not chunk:
                    raise ConnectionError("closed during handshake")
                buf += chunk
            if b" 101 " not in buf.split(b"\r\n", 1)[0]:
                raise ConnectionError("no websocket upgrade")
            buf = buf.split(b"\r\n\r\n", 1)[1]
            s.settimeout(120)

            def take(n):
                nonlocal buf
                while len(buf) < n:
                    chunk = s.recv(65536)
                    if not chunk:
                        raise ConnectionError("closed")
                    buf += chunk
                out, buf = buf[:n], buf[n:]
                return out

            while True:
                b1, b2 = take(2)
                op, n = b1 & 0x0F, b2 & 0x7F
                if n == 126:
                    n = struct.unpack(">H", take(2))[0]
                elif n == 127:
                    n = struct.unpack(">Q", take(8))[0]
                data = take(n)
                if op == 9:  # ping -> pong (klientens ramar ska vara maskade)
                    s.sendall(bytes([0x8A, 0x80 | len(data)]) + b"\0\0\0\0" + data)
                elif op == 8:
                    raise ConnectionError("closed by server")
                elif op == 1:
                    msg = json.loads(data)
                    d = msg.get("data") or {}
                    typ, now = msg.get("type"), time.time()
                    if d.get("prompt_id") and d.get("prompt_id") != live.get("prompt_id"):
                        live.clear()
                        live.update(prompt_id=d["prompt_id"], done=[], cached=[])
                    if typ == "execution_start":
                        live.update(done=[], cached=[], node=None, value=None, max=None, t=now)
                    elif typ == "progress_state":
                        # Nyare ComfyUI skickar alla noders läge (running/finished) i ett meddelande, i körordning
                        live["states"] = {str(k): {"state": v.get("state"), "value": v.get("value"), "max": v.get("max")}
                                          for k, v in (d.get("nodes") or {}).items()}
                        live["t"] = now
                    elif typ == "execution_cached":
                        live["cached"] = [str(n) for n in d.get("nodes", [])]
                        live["t"] = now
                    elif typ == "progress":
                        if live.get("node") != str(d.get("node")) or live.get("max") is None or (d.get("value") or 0) < (live.get("value") or 0):
                            live["t0"] = now  # ny fas: räkna takten från här
                        live.update(node=str(d.get("node")), value=d.get("value"), max=d.get("max"), t=now)
                    elif typ == "executing":
                        # En ny nod börjar, så den förra är klar
                        if live.get("node") is not None and live.get("node") not in live.setdefault("done", []):
                            live["done"].append(live["node"])
                        live.update(node=str(d["node"]) if d.get("node") is not None else None, value=None, max=None, t=now)
                    if persist and typ in ("execution_start", "execution_cached", "executing", "progress_state"):
                        save_live()
        except Exception:
            time.sleep(5)


def node_kind(class_type):
    # Färgkategori för en nod i stegrutorna
    c = class_type or ""
    if re.search(r"Save|Preview|ToFile", c):
        return "save"
    if re.search(r"Sampler|Stage$|KSampler", c):
        return "sample"
    if re.search(r"Load|Loader", c):
        return "load"
    if re.search(r"TextEncode|Conditioning|CLIP|Prompt", c):
        return "text"
    if re.search(r"Decode|Encode|VAE", c):
        return "vae"
    if re.search(r"Mesh|Bake|Voxel|Unwrap|Remesh|Decimate|Trellis|Pixal|UltraTex|Render|MoGe|Texture", c):
        return "mesh"
    return "other"


def node_weight(n):
    # Hur många rutor en nod får: provtagare en per steg, allt annat en
    steps = n.get("inputs", {}).get("steps")
    return int(steps) if node_kind(n.get("class_type")) == "sample" and isinstance(steps, int) and 0 < steps <= 200 else 1


def live_progress(prompt_id, graph, live=live):
    # Hela flödet som rutor: klara noder i sin kategorifärg, den pågående blinkar, resten grå
    if not live or live.get("prompt_id") != prompt_id or time.time() - live.get("t", 0) > 600:
        return None
    nodes = {k: v for k, v in graph.items() if isinstance(v, dict) and v.get("class_type")}
    cached = [n for n in live.get("cached", []) if n in nodes]
    done = [n for n in live.get("done", []) if n in nodes and n not in cached]
    states = live.get("states") or {}
    if states:  # progress_state är säkrast: klara noder i körordning, och den som kör nu
        # Noder utan inkommande länkar (laddare) som inte syns i progress_state har ComfyUI hoppat över: de är cachade
        roots = [n for n, v in nodes.items() if not any(isinstance(x, list) for x in v.get("inputs", {}).values())]
        cached = cached + [n for n in roots if n not in states and n not in cached]
        done = [n for n, st in states.items() if st.get("state") == "finished" and n in nodes and n not in cached]
        running = [n for n, st in states.items() if st.get("state") == "running" and n in nodes]
        if running:
            live["node"] = running[-1]
            st = states[running[-1]]
            if st.get("max"):
                live["value"], live["max"] = st.get("value"), st.get("max")
    cells = [{"k": "cached", "c": node_kind(nodes[n]["class_type"]), "n": nodes[n]["class_type"] + " (cached)"}
             for n in cached for _ in range(node_weight(nodes[n]))]
    cells += [{"k": node_kind(nodes[n]["class_type"]), "n": nodes[n]["class_type"]} for n in done for _ in range(node_weight(nodes[n]))]
    plan = sum(node_weight(n) for n in nodes.values())
    cur = nodes.get(str(live.get("node"))) if live.get("node") is not None else None
    kind = cur["class_type"] if cur else "working"
    out = {"pct": int(100 * len(cells) / plan) if plan else 0, "done": 0, "total": 0, "timing": "", "note": kind, "node": kind,
           "plan": plan, "cells": cells, "cur": {"k": node_kind(kind), "n": kind, "w": node_weight(cur) if cur else 1, "v": 0}}
    if live.get("max"):
        v, m = int(live["value"]), int(live["max"])
        out.update(done=v, total=m, note=f"{kind} · step {v} of {m}")
        out["cur"].update(w=max(m, out["cur"]["w"]) if out["cur"]["k"] == "sample" else 1, v=v if out["cur"]["k"] == "sample" else 0)
        if v > 1 and live.get("t0") and live["t"] - live["t0"] > 1:
            per = (live["t"] - live["t0"]) / (v - 1)  # första steget räknas från t0, så takten mäts över v-1 steg
            left, gone = per * (m - v), live["t"] - live["t0"]
            out["timing"] = f"{int(gone // 60):02d}:{int(gone % 60):02d}<{int(left // 60):02d}:{int(left % 60):02d}, {per:.1f}s/it"
    out["plan"] = max(plan, len(cells) + out["cur"]["w"])
    return out


def progress(log):
    # Vad jobbet gör just nu, ur loggens senaste rader. Ett tqdm-streck (" 40%|####   | 10/25 [01:02<01:33, 6.20s/it]")
    # gäller bara om inget annat har hänt efter det; står det 8/8 och en modell laddas efteråt är det den fasen som pågår.
    for line in reversed(log[-25:]):
        m = re.findall(r"(\d+)%\|[^|]*\|\s*(\d+)/(\d+)\s*\[([^\]]*)\]", line)
        if m:
            pct, done, total, timing = m[-1]
            p = {"pct": int(pct), "done": int(done), "total": int(total), "timing": timing.strip()}
            if p["done"] >= p["total"]:
                p["note"] = "finishing (decode and save)"
            return p
        if "Requested to load" in line:
            name = line.split("Requested to load", 1)[1].strip().split()[0] if line.split("Requested to load", 1)[1].strip() else "model"
            return {"pct": 0, "done": 0, "total": 0, "timing": "", "note": f"loading {name}"}
        if "got prompt" in line:
            return {"pct": 0, "done": 0, "total": 0, "timing": "", "note": "starting"}
    return None


def comfy_status():
    """Alla ComfyUI-instanser i en lista: jobb märkta med körspåret ("gpu"), enheter och version från den första."""
    lanes = list(COMFY_LANES.items())
    out = comfy_one(lanes[0][1], lanes[0][0] if len(lanes) > 1 else None)
    for name, url in lanes[1:]:
        try:
            o = comfy_one(url, name)
        except Exception:
            continue  # en extra instans som inte svarar (avstängd, startar om) döljer inte huvudinstansen
        out["running"] += o["running"]
        out["graphs"].update(o["graphs"])
        out["pending"] += o["pending"]
        out["history"] = sorted(out["history"] + o["history"], key=lambda j: j["start"] or 0, reverse=True)
    RUN_GRAPHS.clear()
    RUN_GRAPHS.update(out.pop("graphs"))
    out["lanes"] = [name for name, _ in lanes]
    return out


def comfy_one(base, gpu):
    get = lambda path: get_json(path, base=base)
    q = get("/queue")
    hist_raw = get("/history?max_items=15")
    stats = get("/system_stats")
    jobs = []
    for pid, h in hist_raw.items():
        msgs = {m[0]: m[1] for m in h.get("status", {}).get("messages", [])}
        start = msgs.get("execution_start", {}).get("timestamp")
        end = (msgs.get("execution_success") or msgs.get("execution_error") or msgs.get("execution_interrupted") or {}).get("timestamp")
        err = msgs.get("execution_error")
        files = [f for o in h.get("outputs", {}).values() for v in o.values() if isinstance(v, list) for f in v
                 if isinstance(f, dict) and f.get("filename")]
        models = [{"filename": f["filename"], "subfolder": f.get("subfolder", ""), "type": f.get("type", "output")}
                  for f in files if f["filename"].lower().endswith((".glb", ".gltf"))]
        images = [{"filename": f["filename"], "subfolder": f.get("subfolder", ""), "type": f.get("type", "output")}
                  for f in files if f["filename"].lower().endswith((".png", ".jpg", ".jpeg", ".webp")) and f.get("type", "output") == "output"]
        jobs.append({"id": pid, "name": job_name(h["prompt"][2]), "title": job_title(h["prompt"]), "details": job_details(h["prompt"][2]),
                     "pipeline": job_pipeline(h["prompt"]),
                     "status": h.get("status", {}).get("status_str", "?"),
                     "start": start / 1000 if start else None, "seconds": (end - start) / 1000 if start and end else None,
                     "outputs": len(files), "models": models, "images": images[:60],
                     "error": f"{err.get('node_type', '')}: {err.get('exception_message', '')}"[:300] if err else None})
    jobs.sort(key=lambda j: j["start"] or 0, reverse=True)
    running = [{"id": r[1], "name": job_name(r[2]), "title": job_title(r), "details": job_details(r[2]), "pipeline": job_pipeline(r),
                "queued_at": r[3].get("create_time", 0) / 1000 if isinstance(r[3], dict) else None}
               for r in q.get("queue_running", [])]
    pending = [{"id": r[1], "name": job_name(r[2]), "title": job_title(r), "pipeline": job_pipeline(r)} for r in q.get("queue_pending", [])]
    if gpu:
        for j in jobs + running + pending:
            j["gpu"] = gpu
    return {"running": running, "pending": pending, "history": jobs, "version": stats["system"].get("comfyui_version"),
            "graphs": {r[1]: r[2] for r in q.get("queue_running", [])},
            "devices": [{"name": d["name"], "vram_total": d["vram_total"], "vram_free": d["vram_free"]} for d in stats.get("devices", [])]}


SNAPSHOT = STORE.with_name("state.json")  # senaste läget, så att panelen har värden direkt efter en omstart
try:
    _snap = json.loads(SNAPSHOT.read_text())
    if time.time() - _snap.get("updated", 0) < 120:
        state.update({k: _snap.get(k) for k in ("probe", "comfy", "pipelines")}, updated=time.time(), online=True)
except (OSError, ValueError):
    pass


def save_snapshot():
    try:
        tmp = SNAPSHOT.with_suffix(".tmp")
        tmp.write_text(json.dumps({k: state.get(k) for k in ("probe", "comfy", "pipelines", "updated")}))
        tmp.replace(SNAPSHOT)
    except OSError:
        pass


MISSES = 3  # så många missade svar i rad (cirka 10–30 s) innan panelen säger offline eller "not answering"


def poller():
    last_net = None
    probe_miss = comfy_miss = 0
    while True:
        t0 = time.time()
        probe = perr = comfy = cerr = None
        try:
            r = subprocess.run(SSH + ["python3", "-"], input=PROBE, capture_output=True, text=True, timeout=15)
            if r.returncode:
                perr = (r.stderr or "ssh failed").strip()[-300:]
            else:
                probe = json.loads(r.stdout)
        except Exception as e:
            perr = str(e)
        try:
            comfy = comfy_status()
        except Exception as e:
            cerr = str(e)
        rates = {}
        if probe:
            if last_net:
                dt = probe["t"] - last_net[0]
                for n, v in probe["net"].items():
                    if n in last_net[1] and dt > 0:
                        rates[n] = {"rx": (v["rx"] - last_net[1][n]["rx"]) / dt, "tx": (v["tx"] - last_net[1][n]["tx"]) / dt}
            last_net = (probe["t"], probe["net"])
            if comfy is not None:
                # Förloppet per pågående jobb: huvudinstansens ur dess websocket (annars loggen), övriga kort ur sin egen
                extra = list(COMFY_LANES)[1:]

                def prog(r, log=probe["log"]):
                    if r.get("gpu") in extra:
                        return live_progress(r["id"], RUN_GRAPHS.get(r["id"], {}), LIVES.get(r["gpu"], {}))
                    return live_progress(r["id"], RUN_GRAPHS.get(r["id"], {})) or progress(log)
                comfy["progresses"] = {r["id"]: prog(r) for r in comfy["running"]}
                comfy["progress"] = comfy["progresses"].get(comfy["running"][0]["id"]) if comfy["running"] else None
            m = probe["mem"]
            g = probe["gpus"][0] if probe["gpus"] else {}
            point = {"t": probe["t"], "cpu": probe["cpu"], "ram": 100 * (1 - m["avail"] / m["total"]),
                     "swap": 100 * (1 - m["swap_free"] / m["swap_total"]) if m["swap_total"] else 0,
                     "gpu": g.get("util"), "vram": 100 * g["mem_used"] / g["mem_total"] if g.get("mem_total") else None,
                     "net": sum(r["rx"] + r["tx"] for r in rates.values()) / 1e6 if rates else None}
            for i, gx in enumerate(probe["gpus"][1:], 1):  # fler grafikkort: gpu1/vram1 … (det första heter gpu/vram som förut)
                point[f"gpu{i}"] = gx.get("util")
                point[f"vram{i}"] = 100 * gx["mem_used"] / gx["mem_total"] if gx.get("mem_total") else None
        # Ett enstaka uteblivet svar (Darrowmere laddar en modell, RAM och swap fulla) är inget avbrott: behåll senaste värdena
        probe_miss = 0 if probe is not None else probe_miss + 1
        comfy_miss = 0 if comfy is not None else comfy_miss + 1
        slow = probe is None and probe_miss < MISSES and state.get("probe")
        if comfy is None and comfy_miss < MISSES and state.get("comfy"):
            comfy, cerr = state["comfy"], None
        if slow:
            with lock:
                state.update(comfy=comfy, comfy_error=cerr, slow=probe_miss)
            time.sleep(max(0.5, POLL - (time.time() - t0)))
            continue
        with lock:
            state["slow"] = 0
            if comfy is not None and comfy is not state.get("comfy"):
                merge_jobs(comfy["history"] + (ai_jobs(probe.get("ai")) if probe else []))
                comfy["history"] = job_list()
            if probe is not None:
                state["pipelines"] = pipeline_views(probe.get("pipelines"), comfy)
            if probe is None and state.get("online", True):
                state["offline_since"] = time.time()  # Darrowmere slutade svara
            elif probe is not None:
                state["offline_since"] = None
            state.update(probe=probe or state["probe"], probe_error=perr, comfy=comfy if probe else (comfy or state["comfy"]),
                         comfy_error=cerr, rates=rates if probe else {}, updated=time.time(), online=probe is not None)
            # Diagrammet fortsätter även när Darrowmere är borta: då ligger alla kurvor på noll
            hist.append(point if probe else {"t": time.time(), "cpu": 0, "ram": 0, "swap": 0, "gpu": 0, "vram": 0, "net": 0, "off": True})
            if len(hist) % 5 == 0:
                save_metrics()
                save_snapshot()
        time.sleep(max(0.5, POLL - (time.time() - t0)))


def action(name):
    if name == "interrupt":
        urllib.request.urlopen(urllib.request.Request(f"{COMFY}/interrupt", data=b"{}", headers={"Content-Type": "application/json"}), timeout=5)
        return "Interrupt sent"
    if name == "clear":
        urllib.request.urlopen(urllib.request.Request(f"{COMFY}/queue", data=json.dumps({"clear": True}).encode(),
                                                      headers={"Content-Type": "application/json"}), timeout=5)
        return "Pending queue cleared"
    if name == "restart":
        r = subprocess.run(SSH + ["sudo", "-n", "/usr/bin/systemctl", "restart", "comfyui.service"], capture_output=True, text=True, timeout=60)
        if r.returncode:
            raise RuntimeError((r.stderr or "restart failed").strip()[-200:])
        return "ComfyUI is restarting"
    raise ValueError(f"unknown action {name}")


sys.path.insert(0, str(HERE))
from auth import COOKIE, Auth, is_private  # noqa: E402

AUTH = Auth(STORE.parent)
from gallery import Gallery  # noqa: E402
GALLERY = Gallery(SSH, COMFY, STORE.parent / "thumbs")
PUBLIC_GET = {"/login", "/api/auth-state", "/favicon.ico"}
PUBLIC_POST = {"/api/login", "/api/setup"}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, body, ctype, headers=None):
        data = body if isinstance(body, bytes) else body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    # Inloggning
    def client_ip(self):
        return (self.headers.get("Cf-Connecting-Ip") or (self.headers.get("X-Forwarded-For") or "").split(",")[0].strip()
                or self.client_address[0])

    def from_home_network(self):
        # Direkt från hemmanätet, inte via Cloudflare eller en annan proxy
        return not self.headers.get("Cf-Connecting-Ip") and not self.headers.get("X-Forwarded-For") and is_private(self.client_address[0])

    def token(self):
        from http.cookies import SimpleCookie
        c = SimpleCookie(self.headers.get("Cookie") or "")
        return c[COOKIE].value if COOKIE in c else None

    def user(self):
        return AUTH.session_user(self.token())

    def cookie(self, value, max_age):
        secure = self.headers.get("X-Forwarded-Proto") == "https" or "https" in (self.headers.get("Cf-Visitor") or "")
        return f"{COOKIE}={value}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}" + ("; Secure" if secure else "")

    def body_json(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > 100_000:
            raise ValueError("too large")
        return json.loads(self.rfile.read(n) or b"{}") if n else {}

    def same_origin(self):
        # Skydd mot förfalskade anrop från andra sidor: kräv JSON och, om webbläsaren skickar Origin, samma värd
        if not (self.headers.get("Content-Type") or "").startswith("application/json"):
            return False
        origin = self.headers.get("Origin")
        return not origin or urllib.parse.urlparse(origin).netloc == self.headers.get("Host")

    def deny(self):
        if self.path.startswith("/api/"):
            return self.send(401, json.dumps({"ok": False, "login": True}), "application/json")
        return self.send(302, "", "text/plain", {"Location": "/login?next=" + urllib.parse.quote(self.path)})

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/login":
            return self.send(200, (HERE / "login.html").read_bytes(), "text/html; charset=utf-8")
        if path == "/api/auth-state":
            return self.send(200, json.dumps({"user": self.user(), "setup_needed": not AUTH.has_users(),
                                              "setup_allowed": self.from_home_network()}), "application/json")
        if path == "/favicon.ico":
            return self.send(204, b"", "image/x-icon")
        if path.startswith("/static/"):
            f = (HERE / "static" / path[len("/static/"):]).resolve()
            types = {".png": "image/png", ".svg": "image/svg+xml", ".webp": "image/webp", ".webmanifest": "application/manifest+json"}
            if f.parent != (HERE / "static").resolve() or f.suffix not in types or not f.is_file():
                return self.send(404, b"not found", "text/plain")
            return self.send(200, f.read_bytes(), types[f.suffix])
        me = self.user()
        if not me:
            return self.deny()
        if path == "/accounts":
            return self.send(200, (HERE / "accounts.html").read_bytes(), "text/html; charset=utf-8")
        if path == "/api/accounts":
            return self.send(200, json.dumps({"me": me, "users": AUTH.list_users()}), "application/json")
        if path == "/settings":
            return self.send(200, (HERE / "settings.html").read_bytes(), "text/html; charset=utf-8")
        if path == "/api/settings":
            try:
                r = keytool({"op": "status", "envs": [p["env"] for p in PROVIDERS.values()]})
            except Exception as e:
                return self.send(502, json.dumps({"ok": False, "message": f"Darrowmere: {e}"}), "application/json")
            defaults = r.get("defaults") or {}
            return self.send(200, json.dumps({
                "ok": True, "settings": clean_settings(r.get("settings") or {}, defaults) if defaults else r.get("settings"),
                "defaults": defaults, "keys_editable": self.from_home_network(),
                "providers": {k: {**p, "key": r["keys"].get(p["env"], {"set": False})} for k, p in PROVIDERS.items()}}), "application/json")
        if self.path in ("/", "/index.html"):
            return self.send(200, (HERE / "monitor.html").read_bytes(), "text/html; charset=utf-8")
        if self.path.startswith("/viewer"):
            return self.send(200, (HERE / "viewer.html").read_bytes(), "text/html; charset=utf-8")
        if self.path == "/log":
            return self.send(200, (HERE / "log.html").read_bytes(), "text/html; charset=utf-8")
        if self.path.startswith("/images"):
            return self.send(200, (HERE / "images.html").read_bytes(), "text/html; charset=utf-8")
        if self.path == "/history":
            return self.send(200, (HERE / "history.html").read_bytes(), "text/html; charset=utf-8")
        if path == "/gallery":
            return self.send(200, (HERE / "gallery.html").read_bytes(), "text/html; charset=utf-8")
        if path == "/api/gallery":
            try:
                fresh = "fresh" in urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
                return self.send(200, json.dumps({"ok": True, "groups": GALLERY.index(0 if fresh else 20)}), "application/json")
            except Exception as e:
                return self.send(502, json.dumps({"ok": False, "message": f"Darrowmere: {e}"}), "application/json")
        if path == "/api/thumb":
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            name, sub = q.get("filename", [""])[0], q.get("subfolder", [""])[0]
            if not name or "/" in name or name.startswith(".") or ".." in sub.split("/"):
                return self.send(400, "bad filename", "text/plain")
            try:
                data = GALLERY.thumb(name, sub, q.get("m", [""])[0])
            except Exception as e:
                return self.send(502, f"thumb: {e}", "text/plain")
            self.send_response(200)
            self.send_header("Content-Type", "image/webp")
            self.send_header("Cache-Control", "private, max-age=604800")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            return self.wfile.write(data)
        if self.path == "/api/jobs":
            with lock:
                return self.send(200, json.dumps({"jobs": job_list(include_acked=True, limit=500)}), "application/json")
        if self.path.split("?")[0] == "/api/log":
            # De senaste 400 raderna ur en tjänsts logg (ComfyUI eller beställningsrunnern), hämtade när loggfönstret frågar
            src = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).get("src", ["comfyui"])[0]
            unit = {"comfyui": "comfyui", "runner": "darrowmere-runner"}.get(src, "comfyui")
            r = subprocess.run(SSH + ["journalctl", "-u", unit, "-n", "400", "--no-pager", "-o", "short-iso"],
                               capture_output=True, text=True, timeout=20)
            lines = [re.sub(r"\x1b\[[0-9;]*m", "", l) for l in r.stdout.splitlines()]
            return self.send(200, json.dumps({"lines": lines, "error": r.stderr.strip()[-200:] if r.returncode else None}), "application/json")
        if self.path.startswith("/api/file?"):
            return self.proxy_file()
        if self.path == "/api/status":
            with lock:
                body = {**state, "history": list(hist), "host": HOST, "comfy_url": COMFY, "now": time.time()}
            return self.send(200, json.dumps(body), "application/json")
        self.send(404, "not found", "text/plain")

    def proxy_file(self):
        # En fil från ComfyUI:s /view, så att 3D-visaren kan läsa den från samma adress som sidan
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        name = q.get("filename", [""])[0]
        if not name or "/" in name or "\\" in name or name.startswith("."):
            return self.send(400, "bad filename", "text/plain")
        params = urllib.parse.urlencode({"filename": name, "subfolder": q.get("subfolder", [""])[0], "type": q.get("type", ["output"])[0]})
        try:
            r = urllib.request.urlopen(f"{COMFY}/view?{params}", timeout=120)
        except Exception as e:
            return self.send(502, f"ComfyUI: {e}", "text/plain")
        ctype = "model/gltf-binary" if name.lower().endswith(".glb") else r.headers.get("Content-Type", "application/octet-stream")
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "max-age=3600")
        if r.headers.get("Content-Length"):
            self.send_header("Content-Length", r.headers["Content-Length"])
        self.end_headers()
        while chunk := r.read(1 << 20):
            self.wfile.write(chunk)

    def do_POST(self):
        if not self.same_origin():
            return self.send(403, json.dumps({"ok": False, "message": "rejected"}), "application/json")
        try:
            data = self.body_json()
        except ValueError:
            return self.send(400, json.dumps({"ok": False, "message": "bad request"}), "application/json")
        ok = lambda msg="": self.send(200, json.dumps({"ok": True, "message": msg}), "application/json")
        bad = lambda code, msg: self.send(code, json.dumps({"ok": False, "message": msg}), "application/json")
        ip = self.client_ip()
        if self.path == "/api/setup":
            # Första kontot, bara när inga konton finns och bara från hemmanätet
            if AUTH.has_users() or not self.from_home_network():
                return bad(403, "Setup is closed.")
            try:
                AUTH.add_user(data.get("username", ""), data.get("password", ""))
            except ValueError as e:
                return bad(400, str(e))
            t = AUTH.new_session(data["username"])
            return self.send(200, json.dumps({"ok": True}), "application/json", {"Set-Cookie": self.cookie(t, 30 * 86400)})
        if self.path == "/api/login":
            if AUTH.blocked(ip):
                return bad(429, "Too many attempts. Try again in a few minutes.")
            if not AUTH.verify(data.get("username", ""), data.get("password", "")):
                AUTH.failed(ip)
                time.sleep(0.8)
                return bad(401, "Wrong name or password.")
            t = AUTH.new_session(data["username"])
            return self.send(200, json.dumps({"ok": True}), "application/json", {"Set-Cookie": self.cookie(t, 30 * 86400)})
        me = self.user()
        if not me:
            return self.deny()
        if self.path == "/api/logout":
            AUTH.end_session(self.token())
            return self.send(200, json.dumps({"ok": True}), "application/json", {"Set-Cookie": self.cookie("", 0)})
        if self.path.startswith("/api/accounts/"):
            try:
                if self.path == "/api/accounts/add":
                    AUTH.add_user(data.get("username", ""), data.get("password", ""))
                    return ok("Account created.")
                if self.path == "/api/accounts/delete":
                    if data.get("username") == me:
                        return bad(400, "You cannot remove your own account while logged in.")
                    AUTH.delete_user(data.get("username", ""))
                    return ok("Account removed.")
                if self.path == "/api/accounts/password":
                    if not AUTH.verify(me, data.get("old", "")):
                        AUTH.failed(ip)
                        return bad(401, "The current password is wrong.")
                    AUTH.set_password(me, data.get("new", ""))
                    return ok("Password changed.")
            except ValueError as e:
                return bad(400, str(e))
            return bad(404, "not found")
        if self.path == "/api/settings":
            try:
                cur = keytool({"op": "status", "envs": []})
                s = clean_settings(data.get("settings") or {}, cur.get("defaults") or {})
                keytool({"op": "settings", "settings": s})
            except Exception as e:
                return bad(502, f"Could not save: {e}")
            audit(me, "settings " + json.dumps(s, separators=(",", ":")))
            return self.send(200, json.dumps({"ok": True, "message": "Settings saved.", "settings": s}), "application/json")
        k = re.match(r"^/api/keys/(set|delete|test)$", self.path)
        if k:
            p = PROVIDERS.get(data.get("provider", ""))
            if not p:
                return bad(400, "Unknown service.")
            if k.group(1) != "test" and not self.from_home_network():
                return bad(403, "API keys can only be changed from the home network.")
            try:
                if k.group(1) == "set":
                    v = str(data.get("key", "")).strip()
                    if not re.fullmatch(r"[\x21-\x7e]{8,512}", v):
                        return bad(400, "That does not look like an API key (8–512 characters, no spaces).")
                    keytool({"op": "set", "env": p["env"], "value": v, "by": me})
                    audit(me, f"key set {data['provider']}")
                    return ok(f"{p['label']} key saved on Darrowmere.")
                if k.group(1) == "delete":
                    keytool({"op": "delete", "env": p["env"]})
                    audit(me, f"key removed {data['provider']}")
                    return ok(f"{p['label']} key removed.")
                r = keytool({"op": "test", "env": p["env"], "provider": data["provider"]})
                return self.send(200, json.dumps({"ok": r.get("ok", False), "message": r.get("message", "")}), "application/json")
            except Exception as e:
                return bad(502, f"Darrowmere: {e}")
        ap = re.match(r"^/api/orders/([A-Za-z0-9._-]+)/approve$", self.path)
        if ap:
            step, credits = str(data.get("step", "")), data.get("credits")
            if not re.fullmatch(r"[\w.-]+", step) or not isinstance(credits, int) or not 0 < credits <= 5000:
                return bad(400, "bad approval")
            code = ("import json,os,sys; p='/data/orders/'+sys.argv[1]+'/approved.json'; d=json.load(open(p)) if os.path.exists(p) else {}; "
                    "d.setdefault('steps',{})[sys.argv[2]]=int(sys.argv[3]); json.dump(d,open(p,'w'))")
            r = subprocess.run(rcmd(["python3", "-c", code, ap.group(1), step, str(credits)]), capture_output=True, text=True, timeout=20)
            if r.returncode:
                return bad(502, (r.stderr or "failed").strip()[-200:])
            audit(me, f"approved {ap.group(1)}/{step} {credits} credits")
            return ok(f"Approved ~{credits} credits; the runner continues.")
        a = re.match(r"^/api/(ack|unack)/([\w-]+)$", self.path)
        if a:
            with lock:
                ids = [j["id"] for j in job_list()] if a.group(2) == "all" else [a.group(2)]
                for i in ids:
                    if i in jobs:
                        jobs[i]["acked"] = a.group(1) == "ack"
                save_jobs()
                if state["comfy"]:
                    state["comfy"]["history"] = job_list()
            return self.send(200, json.dumps({"ok": True, "count": len(ids)}), "application/json")
        m = re.match(r"^/api/action/(\w+)$", self.path)
        if not m:
            return self.send(404, "not found", "text/plain")
        try:
            return self.send(200, json.dumps({"ok": True, "message": action(m.group(1))}), "application/json")
        except Exception as e:
            return self.send(500, json.dumps({"ok": False, "message": str(e)}), "application/json")


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8791
    bind = os.environ.get("MONITOR_BIND", "127.0.0.1")
    import signal
    signal.signal(signal.SIGTERM, lambda *_: (save_metrics(), save_live(), save_snapshot(), sys.exit(0)))
    threading.Thread(target=poller, daemon=True).start()
    threading.Thread(target=ws_listener, daemon=True).start()
    for name, url in list(COMFY_LANES.items())[1:]:
        threading.Thread(target=ws_listener, args=(url, LIVES.setdefault(name, {}), False), daemon=True).start()
    print(json.dumps({"ok": True, "url": f"http://{bind}:{port}", "darrowmere": HOST, "local": LOCAL, "state": str(STORE)}), flush=True)
    ThreadingHTTPServer((bind, port), Handler).serve_forever()
