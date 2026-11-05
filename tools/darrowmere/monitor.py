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
HOST = os.environ.get("DARROWMERE_HOST", urllib.parse.urlparse(COMFY).hostname)
LOCAL = HOST in ("localhost", "127.0.0.1")
# Kommandon körs direkt när panelen körs på Darrowmere, annars över en delad SSH-anslutning
SSH = [] if LOCAL else ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-o", "ControlMaster=auto",
                        "-o", f"ControlPath={Path.home()}/.ssh/cm-darrowmere-%C", "-o", "ControlPersist=120", f"epatnor@{HOST}"]
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
print(json.dumps({
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
    if changed:
        save_jobs()


def job_list(include_acked=False, limit=50):
    out = [j for j in jobs.values() if include_acked or not j.get("acked")]
    return sorted(out, key=lambda j: j.get("start") or 0, reverse=True)[:limit]


def get_json(path, timeout=5):
    return json.load(urllib.request.urlopen(f"{COMFY}{path}", timeout=timeout))


def job_title(item):
    # Beskrivningen som verktyget skickade med (comfy_target.job_extra), om någon
    extra = item[3] if len(item) > 3 and isinstance(item[3], dict) else {}
    return str(extra.get("job_title") or "")[:160]


def job_name(prompt):
    types = [n.get("class_type", "") for n in prompt.values()]
    joined = " ".join(types)
    if "UltraTex" in joined:
        return "UltraTex"
    if "Pixal3D" in joined or "Trellis2" in joined:
        return "Pixal3D"
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


def ws_listener():
    import base64
    import socket
    import struct
    u = urllib.parse.urlparse(COMFY)
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
                    if typ in ("execution_start", "execution_cached", "executing", "progress_state"):
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


def live_progress(prompt_id, graph):
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
    cells = [{"k": "cached", "n": nodes[n]["class_type"]} for n in cached for _ in range(node_weight(nodes[n]))]
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
    q = get_json("/queue")
    hist_raw = get_json("/history?max_items=15")
    stats = get_json("/system_stats")
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
        jobs.append({"id": pid, "name": job_name(h["prompt"][2]), "title": job_title(h["prompt"]),
                     "status": h.get("status", {}).get("status_str", "?"),
                     "start": start / 1000 if start else None, "seconds": (end - start) / 1000 if start and end else None,
                     "outputs": len(files), "models": models, "images": images[:60],
                     "error": f"{err.get('node_type', '')}: {err.get('exception_message', '')}"[:300] if err else None})
    jobs.sort(key=lambda j: j["start"] or 0, reverse=True)
    running = [{"id": r[1], "name": job_name(r[2]), "title": job_title(r),
                "queued_at": r[3].get("create_time", 0) / 1000 if isinstance(r[3], dict) else None}
               for r in q.get("queue_running", [])]
    pending = [{"id": r[1], "name": job_name(r[2]), "title": job_title(r)} for r in q.get("queue_pending", [])]
    RUN_GRAPHS.clear()
    RUN_GRAPHS.update({r[1]: r[2] for r in q.get("queue_running", [])})
    return {"running": running, "pending": pending, "history": jobs, "version": stats["system"].get("comfyui_version"),
            "devices": [{"name": d["name"], "vram_total": d["vram_total"], "vram_free": d["vram_free"]} for d in stats.get("devices", [])]}


def poller():
    last_net = None
    while True:
        t0 = time.time()
        probe = perr = comfy = cerr = None
        try:
            r = subprocess.run(SSH + ["python3", "-"], input=PROBE, capture_output=True, text=True, timeout=20)
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
                rid = comfy["running"][0]["id"] if comfy["running"] else None
                comfy["progress"] = (live_progress(rid, RUN_GRAPHS.get(rid, {})) or progress(probe["log"])) if rid else None
            m = probe["mem"]
            g = probe["gpus"][0] if probe["gpus"] else {}
            point = {"t": probe["t"], "cpu": probe["cpu"], "ram": 100 * (1 - m["avail"] / m["total"]),
                     "swap": 100 * (1 - m["swap_free"] / m["swap_total"]) if m["swap_total"] else 0,
                     "gpu": g.get("util"), "vram": 100 * g["mem_used"] / g["mem_total"] if g.get("mem_total") else None,
                     "net": sum(r["rx"] + r["tx"] for r in rates.values()) / 1e6 if rates else None}
        with lock:
            if comfy is not None:
                merge_jobs(comfy["history"])
                comfy["history"] = job_list()
            state.update(probe=probe or state["probe"], probe_error=perr, comfy=comfy or state["comfy"], comfy_error=cerr,
                         rates=rates or state["rates"], updated=time.time(), online=probe is not None)
            if probe:
                hist.append(point)
                if len(hist) % 5 == 0:
                    save_metrics()
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


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, body, ctype):
        data = body if isinstance(body, bytes) else body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
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
        if self.path == "/api/jobs":
            with lock:
                return self.send(200, json.dumps({"jobs": job_list(include_acked=True, limit=500)}), "application/json")
        if self.path == "/api/log":
            # De senaste 400 raderna ur tjänstens logg, hämtade när loggfönstret frågar
            r = subprocess.run(SSH + ["journalctl", "-u", "comfyui", "-n", "400", "--no-pager", "-o", "short-iso"],
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
    signal.signal(signal.SIGTERM, lambda *_: (save_metrics(), save_live(), sys.exit(0)))
    threading.Thread(target=poller, daemon=True).start()
    threading.Thread(target=ws_listener, daemon=True).start()
    print(json.dumps({"ok": True, "url": f"http://{bind}:{port}", "darrowmere": HOST, "local": LOCAL, "state": str(STORE)}), flush=True)
    ThreadingHTTPServer((bind, port), Handler).serve_forever()
