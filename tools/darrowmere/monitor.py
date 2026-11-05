"""Övervakning av jobbdatorn Darrowmere: en sida på laptopen som visar hur datorn mår och hur ComfyUI-jobben går.

  python3 -I tools/darrowmere/monitor.py [port]        (standard 8791, lyssnar bara på 127.0.0.1)

Datorns värden hämtas över SSH (ett litet Python-skript körs på Darrowmere var tredje sekund, över en delad
anslutning), jobben direkt från ComfyUI:s API. Adressen tas från tools/comfy.json (målet "darrowmere");
DARROWMERE_HOST överstyr. Knapparna avbryter jobbet, tömmer kön eller startar om ComfyUI-tjänsten
(sudo-regeln i /etc/sudoers.d/comfyui tillåter bara det).
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
CONF = json.loads((HERE.parent / "comfy.json").read_text())
COMFY = os.environ.get("DARROWMERE_COMFY", CONF["targets"]["darrowmere"]).rstrip("/")
HOST = os.environ.get("DARROWMERE_HOST", urllib.parse.urlparse(COMFY).hostname)
SSH = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-o", "ControlMaster=auto",
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


def get_json(path, timeout=5):
    return json.load(urllib.request.urlopen(f"{COMFY}{path}", timeout=timeout))


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


def progress(log):
    # Senaste tqdm-raden, t.ex. " 40%|####      | 10/25 [01:02<01:33, 6.20s/it]"
    for line in reversed(log):
        m = re.findall(r"(\d+)%\|[^|]*\|\s*(\d+)/(\d+)\s*\[([^\]]*)\]", line)
        if m:
            pct, done, total, timing = m[-1]
            return {"pct": int(pct), "done": int(done), "total": int(total), "timing": timing.strip()}
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
        jobs.append({"id": pid, "name": job_name(h["prompt"][2]), "status": h.get("status", {}).get("status_str", "?"),
                     "start": start / 1000 if start else None, "seconds": (end - start) / 1000 if start and end else None,
                     "outputs": len(files), "models": models,
                     "error": f"{err.get('node_type', '')}: {err.get('exception_message', '')}"[:300] if err else None})
    jobs.sort(key=lambda j: j["start"] or 0, reverse=True)
    running = [{"id": r[1], "name": job_name(r[2]), "queued_at": r[3].get("create_time", 0) / 1000 if isinstance(r[3], dict) else None}
               for r in q.get("queue_running", [])]
    pending = [{"id": r[1], "name": job_name(r[2])} for r in q.get("queue_pending", [])]
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
                comfy["progress"] = progress(probe["log"]) if comfy["running"] else None
            m = probe["mem"]
            g = probe["gpus"][0] if probe["gpus"] else {}
            point = {"t": probe["t"], "cpu": probe["cpu"], "ram": 100 * (1 - m["avail"] / m["total"]),
                     "swap": 100 * (1 - m["swap_free"] / m["swap_total"]) if m["swap_total"] else 0,
                     "gpu": g.get("util"), "vram": 100 * g["mem_used"] / g["mem_total"] if g.get("mem_total") else None}
        with lock:
            state.update(probe=probe or state["probe"], probe_error=perr, comfy=comfy or state["comfy"], comfy_error=cerr,
                         rates=rates or state["rates"], updated=time.time(), online=probe is not None)
            if probe:
                hist.append(point)
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
        m = re.match(r"^/api/action/(\w+)$", self.path)
        if not m:
            return self.send(404, "not found", "text/plain")
        try:
            return self.send(200, json.dumps({"ok": True, "message": action(m.group(1))}), "application/json")
        except Exception as e:
            return self.send(500, json.dumps({"ok": False, "message": str(e)}), "application/json")


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8791
    threading.Thread(target=poller, daemon=True).start()
    print(json.dumps({"ok": True, "url": f"http://127.0.0.1:{port}", "darrowmere": HOST}), flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
