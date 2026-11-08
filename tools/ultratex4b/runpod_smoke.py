"""UltraTex 4B-provkörningen på RunPod (docs/ultratex-4b.md, steg 2): startar en H100-pod, kör tools/ultratex4b/pod_smoke.sh,
följer den, hämtar loggarna och tar bort poden. Syns i Darrowmere-panelen som pipelinen `ultratex4b-smoke`.

    python3 -I tools/ultratex4b/runpod_smoke.py price            # pris och lager, gratis
    python3 -I tools/ultratex4b/runpod_smoke.py start '{"max_min": 150}'
    python3 -I tools/ultratex4b/runpod_smoke.py watch            # följer, hämtar, tar bort poden (kör i bakgrunden)
    python3 -I tools/ultratex4b/runpod_smoke.py status | fetch | stop

Nyckeln RUNPOD_API_KEY läses ur asset-studio/.env och skrivs aldrig ut. Poden tar bort sig själv efter max_min minuter
(vakthund på poden), och watch tar bort den när körningen är klar, har misslyckats eller har gått över tiden.
Varje kommando svarar med en rad JSON.
"""
import json, os, re, subprocess, sys, time, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "tools"))
import pipeline  # noqa: E402

OUT = os.path.join(ROOT, "build/ultratex4b/smoke")
STATE = os.path.join(OUT, "pod.json")
KEY = os.path.expanduser("~/.ssh/runpod_ed25519")
GPU = "NVIDIA H100 80GB HBM3"
IMAGE = "runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04"
PID = "ultratex4b-smoke"
STEPS = [("pod", "Start H100 pod", "runpod"), ("setup", "Install + download models/data", "runpod"),
         ("train", "Train 200 steps (1024 px)", "runpod"), ("stop", "Fetch logs + remove pod", "runpod")]


def api_key():
    for line in open(os.path.join(ROOT, ".env")):
        if line.startswith("RUNPOD_API_KEY="):
            return line.split("=", 1)[1].strip()
    sys.exit(json.dumps({"ok": False, "error": "RUNPOD_API_KEY saknas i .env"}))


def gql(query, variables=None):
    req = urllib.request.Request("https://api.runpod.io/graphql", json.dumps({"query": query, "variables": variables or {}}).encode(),
                                 {"Authorization": "Bearer " + api_key(), "Content-Type": "application/json"})
    d = json.load(urllib.request.urlopen(req, timeout=60))
    if d.get("errors"):
        raise RuntimeError("; ".join(e.get("message", "?") for e in d["errors"]))
    return d["data"]


def load():
    return json.load(open(STATE)) if os.path.exists(STATE) else {}


def save(s):
    os.makedirs(OUT, exist_ok=True)
    json.dump(s, open(STATE, "w"), indent=1)


def ssh(s, cmd, timeout=60):
    base = ["-i", KEY, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
            "-o", "LogLevel=ERROR", "-o", "ConnectTimeout=10"]
    return subprocess.run(["ssh", *base, "-p", str(s["port"]), f"root@{s['ip']}", cmd],
                          capture_output=True, text=True, errors="replace", timeout=timeout)


def scp(s, src, dst, up=True, timeout=600):
    base = ["-i", KEY, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
            "-o", "LogLevel=ERROR", "-P", str(s["port"])]
    a, b = (src, f"root@{s['ip']}:{dst}") if up else (f"root@{s['ip']}:{src}", dst)
    return subprocess.run(["scp", "-r", *base, a, b], capture_output=True, text=True, errors="replace", timeout=timeout)


def price():
    g = gql('query { gpuTypes(input: {id: "%s"}) { id communityPrice securePrice lowestPrice(input: {gpuCount: 1}) '
            '{ uninterruptablePrice stockStatus } } }' % GPU)["gpuTypes"][0]
    return {"gpu": GPU, "community_usd_h": g["communityPrice"], "secure_usd_h": g["securePrice"],
            "stock": (g.get("lowestPrice") or {}).get("stockStatus")}


def cost(s):
    end = s.get("removed_at") or time.time()
    return round(s["cost_per_hr"] * (end - s["created"]) / 3600, 2) if s.get("cost_per_hr") else None


def start(r):
    s = load()
    if s.get("pod_id") and not s.get("removed_at"):
        return {"ok": False, "error": "en pod körs redan", "pod_id": s["pod_id"]}
    if not os.path.exists(KEY):
        subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "runpod-ultratex", "-f", KEY], check=True)
    pub = open(KEY + ".pub").read().strip()
    max_min = int(r.get("max_min", 150))
    env = [{"key": "PUBLIC_KEY", "value": pub}]
    pod = gql("""mutation($i: PodFindAndDeployOnDemandInput) { podFindAndDeployOnDemand(input: $i) { id costPerHr machineId } }""",
              {"i": {"cloudType": r.get("cloud", "COMMUNITY"), "gpuCount": 1, "gpuTypeId": r.get("gpu", GPU), "name": PID,
                     "imageName": IMAGE, "containerDiskInGb": 40, "volumeInGb": 150, "volumeMountPath": "/workspace",
                     "minVcpuCount": r.get("vcpu", 8), "minMemoryInGb": r.get("ram", 32), "ports": "22/tcp", "supportPublicIp": True, "env": env}}
              )["podFindAndDeployOnDemand"]
    s = {"pod_id": pod["id"], "cost_per_hr": pod["costPerHr"], "created": time.time(), "max_min": max_min,
         "env": {"MAX_MIN": max_min, "STEPS": r.get("steps", 200), "RESOLUTION": r.get("resolution", 1024), "LIMIT": r.get("limit", 300)}}
    save(s)
    p = pipeline.Pipeline(PID, "UltraTex 4B: smoke test on RunPod H100", STEPS)
    p.save(); p.start("pod", note=f"{pod['costPerHr']} USD/h")
    # Vänta på ssh (offentlig port 22)
    for _ in range(90):
        time.sleep(10)
        rt = gql('query { pod(input: {podId: "%s"}) { runtime { uptimeInSeconds ports { ip isIpPublic privatePort publicPort } } } }'
                 % s["pod_id"])["pod"]["runtime"]
        ports = [x for x in (rt or {}).get("ports") or [] if x["privatePort"] == 22 and x["isIpPublic"]]
        if ports:
            s.update(ip=ports[0]["ip"], port=ports[0]["publicPort"]); save(s)
            if ssh(s, "true").returncode == 0:
                break
    else:
        p.fail("pod", note="ssh kom aldrig upp"); stop(); return {"ok": False, "error": "ssh kom aldrig upp, poden borttagen"}
    here = os.path.dirname(os.path.abspath(__file__))
    for f in ("pod_smoke.sh", "prep_texverse.py"):
        scp(s, os.path.join(here, f), "/workspace/")
    envs = " ".join(f"{k}={v}" for k, v in s["env"].items())
    ssh(s, f"cd /workspace && {envs} setsid nohup bash pod_smoke.sh > smoke.log 2>&1 < /dev/null &")
    s["launched"] = time.time(); save(s)
    p.done("pod", note=f"{pod['costPerHr']} USD/h"); p.start("setup")
    return {"ok": True, "pod_id": s["pod_id"], "usd_h": s["cost_per_hr"], "max_min": max_min}


TQDM = re.compile(r"(\d+)/(\d+) \[(?:(\d+):)?(\d+):(\d+)<")


def train_rate(log, total=200):
    """Sekunder per steg efter valideringen vid steg 100 (tqdm: steg och förfluten tid; bara träningens stapel)."""
    pts = {}
    for m in TQDM.finditer(log):
        if int(m[2]) != total:
            continue
        n, h, mi, se = int(m[1]), int(m[3] or 0), int(m[4]), int(m[5])
        pts[n] = h * 3600 + mi * 60 + se
    after = sorted(n for n in pts if n >= 105)
    if len(after) >= 2 and after[-1] - after[0] >= 10:
        return round((pts[after[-1]] - pts[after[0]]) / (after[-1] - after[0]), 2), max(pts)
    early = sorted(n for n in pts if 3 <= n < 100)
    if len(early) >= 2:
        return round((pts[early[-1]] - pts[early[0]]) / (early[-1] - early[0]), 2), max(pts)
    return None, max(pts) if pts else 0


def status():
    s = load()
    if not s.get("pod_id"):
        return {"ok": False, "error": "ingen pod"}
    out = {"pod_id": s["pod_id"], "usd_so_far": cost(s), "removed": bool(s.get("removed_at"))}
    if s.get("removed_at") or not s.get("ip"):
        return {**out, **s.get("result", {})}
    r = ssh(s, "cat /workspace/phases.jsonl; echo ===; tail -c 20000 /workspace/train.log 2>/dev/null; echo ===; "
               "cut -d, -f1 /workspace/gpu.csv 2>/dev/null | sort -n | tail -1; echo ===; cat /workspace/prep.json 2>/dev/null; true", 60)
    if r.returncode:
        return {**out, "ssh": "no answer"}
    ph, log, mem, prep = (r.stdout.split("===\n") + ["", "", "", ""])[:4]
    phases = [json.loads(x) for x in ph.splitlines() if x.strip()]
    rate, step = train_rate(log, int(s["env"]["STEPS"]))
    out.update(phase=phases[-1]["phase"] if phases else "starting", phases={p["phase"]: p["t"] for p in phases},
               step=step, s_per_step=rate, gpu_mem_max_mb=int(mem.strip()) if mem.strip().isdigit() else None)
    try:
        pj = json.loads(prep.strip().splitlines()[-1])
        out["prep"] = {k: pj.get(k) for k in ("objects", "train", "eval", "problems")}
    except Exception:
        pass
    if rate:
        h = rate * 15000 / 3600
        out["full_15k"] = {"hours": round(h, 1), "usd": round(h * s["cost_per_hr"], 0)}
    if "failed" in out["phase"]:
        out["log_tail"] = log[-1500:]
    return out


def fetch():
    s = load()
    os.makedirs(OUT, exist_ok=True)
    ssh(s, "cd /workspace && tar czf /tmp/smoke_logs.tgz smoke.log phases.jsonl gpu.csv prep.json pip.log dl_*.log train.log "
           "$(find out -name '*.png' -size -3M 2>/dev/null | head -8) 2>/dev/null; true", 120)
    r = scp(s, "/tmp/smoke_logs.tgz", OUT + "/", up=False)
    if r.returncode == 0:
        subprocess.run(["tar", "xzf", os.path.join(OUT, "smoke_logs.tgz"), "-C", OUT])
    return {"ok": r.returncode == 0, "out": OUT}


def stop():
    s = load()
    if s.get("pod_id") and not s.get("removed_at"):
        try:
            gql('mutation { podTerminate(input: {podId: "%s"}) }' % s["pod_id"])
        except RuntimeError as e:          # redan borttagen av vakthunden
            if "not found" not in str(e).lower():
                raise
        s["removed_at"] = time.time(); save(s)
    return {"ok": True, "pod_id": s.get("pod_id"), "usd_total": cost(s)}


def watch():
    s = load(); p = pipeline.Pipeline.load(PID)
    seen = set()
    while True:
        st = status()
        ph = st.get("phase", "")
        if ph in ("prep", "train") and "setup" not in seen and p:
            seen.add("setup"); p.done("setup", note=ph); p.start("train") if ph == "train" else None
        if ph == "train" and "train" not in seen and p:
            seen.add("train"); p.start("train")
        if p and st.get("step"):
            p._set("train", note=f"step {st['step']}, {st.get('s_per_step')} s/step, {st.get('usd_so_far')} USD")
        over = time.time() - s["created"] > s["max_min"] * 60
        if ph == "done" or "failed" in ph or "watchdog" in ph or over:
            st = status()
            if p:
                (p.done if ph == "done" else p.fail)("train", note=f"{ph}: {st.get('s_per_step')} s/step, GPU {st.get('gpu_mem_max_mb')} MB")
                p.start("stop")
            fetch()
            res = stop()
            s = load(); s["result"] = {k: st.get(k) for k in ("phase", "phases", "step", "s_per_step", "gpu_mem_max_mb", "prep", "full_15k")}
            save(s)
            if p:
                p.done("stop", note=f"{res['usd_total']} USD total")
            return {**s["result"], "usd_total": res["usd_total"], "out": OUT}
        time.sleep(60)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    rec = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
    try:
        res = {"price": price, "status": status, "fetch": fetch, "stop": stop, "watch": watch}.get(cmd)
        print(json.dumps(start(rec) if cmd == "start" else res()))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)[:500]}))
