"""UltraTex 4B-träning på RunPod (docs/ultratex-4b.md, steg 2–3): startar en H100-pod, kör pod_train.sh, följer den,
hämtar checkpoints medan den kör och tar bort poden när den är klar. Syns i Darrowmere-panelen som pipelinen
`ultratex4b-<run>`. Vakten (watch) körs på Darrowmere, som alltid är på (se deploy längst ner).

    python3 -I runpod_train.py price
    python3 -I runpod_train.py start '{"run": "run1", "steps": 10000, "ckpt_steps": 2500, "buckets": ["00", ..., "05"], "max_min": 840}'
    python3 -I runpod_train.py watch '{"run": "run1"}'       # följer, hämtar checkpoints, tar bort poden
    python3 -I runpod_train.py status|fetch|stop '{"run": "run1"}'

Nyckeln RUNPOD_API_KEY läses ur .env (RUNPOD_ENV, annars asset-studio/.env) och skrivs aldrig ut. Säkerhet mot glömda
poddar: vakthunden på poden stoppar den efter max_min minuter (disken med checkpoints finns kvar), poden stoppar sig
själv om ingen hämtat resultatet inom två timmar efter träningen, och watch tar bort den när allt är hämtat.
Varje kommando svarar med en rad JSON.
"""
import json, os, re, subprocess, sys, time, traceback, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path[:0] = [HERE, os.path.join(ROOT, "tools")]
import pipeline  # noqa: E402

OUT_ROOT = os.environ.get("ULTRATEX_RUNS", os.path.join(ROOT, "build/ultratex4b"))
KEY = os.path.expanduser("~/.ssh/runpod_ed25519")
GPUS = ["NVIDIA H100 80GB HBM3", "NVIDIA H100 NVL"]      # Hopper: UltraTex:s sparse attention-kärnor
IMAGE = "runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04"
SSHO = ["-i", KEY, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
        "-o", "LogLevel=ERROR", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=30"]


def api_key():
    for f in (os.environ.get("RUNPOD_ENV"), os.path.join(HERE, ".env"), os.path.join(ROOT, ".env")):
        if f and os.path.exists(f):
            for line in open(f):
                if line.startswith("RUNPOD_API_KEY="):
                    return line.split("=", 1)[1].strip()
    sys.exit(json.dumps({"ok": False, "error": "RUNPOD_API_KEY saknas"}))


def gql(query, variables=None):
    req = urllib.request.Request("https://api.runpod.io/graphql", json.dumps({"query": query, "variables": variables or {}}).encode(),
                                 {"Authorization": "Bearer " + api_key(), "Content-Type": "application/json"})
    d = json.load(urllib.request.urlopen(req, timeout=60))
    if d.get("errors"):
        raise RuntimeError("; ".join(e.get("message", "?") for e in d["errors"]))
    return d["data"]


class Run:
    def __init__(self, name):
        self.name, self.out = name, os.path.join(OUT_ROOT, name)
        self.state_f = os.path.join(self.out, "pod.json")
        self.s = json.load(open(self.state_f)) if os.path.exists(self.state_f) else {}
        self.pid = f"ultratex4b-{name}"

    def save(self):
        os.makedirs(self.out, exist_ok=True)
        json.dump(self.s, open(self.state_f, "w"), indent=1)

    def ssh(self, cmd, timeout=60):
        return subprocess.run(["ssh", *SSHO, "-p", str(self.s["port"]), f"root@{self.s['ip']}", cmd],
                              capture_output=True, text=True, errors="replace", timeout=timeout)

    def pull(self, remote, local, timeout=1800):
        os.makedirs(os.path.dirname(local), exist_ok=True)
        return subprocess.run(["scp", *SSHO, "-P", str(self.s["port"]), f"root@{self.s['ip']}:{remote}", local],
                              capture_output=True, text=True, errors="replace", timeout=timeout)

    def cost(self):
        end = self.s.get("removed_at") or time.time()
        return round(self.s["cost_per_hr"] * (end - self.s["created"]) / 3600, 2) if self.s.get("cost_per_hr") else None

    def pipe(self):
        return pipeline.Pipeline.load(self.pid)


def price():
    res = []
    for g in GPUS:
        d = gql('query { gpuTypes(input: {id: "%s"}) { communityPrice securePrice lowestPrice(input: {gpuCount: 1, secureCloud: false}) '
                '{ uninterruptablePrice stockStatus } } }' % g)["gpuTypes"][0]
        lp = d.get("lowestPrice") or {}
        res.append({"gpu": g, "community_usd_h": lp.get("uninterruptablePrice"), "stock": lp.get("stockStatus")})
    return {"gpus": res}


def start(r):
    run = Run(r.get("run", "run1"))
    if run.s.get("pod_id") and not run.s.get("removed_at"):
        return {"ok": False, "error": "en pod körs redan för den här körningen", "pod_id": run.s["pod_id"]}
    if not os.path.exists(KEY):
        subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "runpod-ultratex", "-f", KEY], check=True)
    env = {"MAX_MIN": int(r.get("max_min", 150)), "STEPS": r.get("steps", 200), "CKPT_STEPS": r.get("ckpt_steps", 100000),
           "RESOLUTION": r.get("resolution", 1024), "LIMIT": r.get("limit", 0), "EVAL_N": r.get("eval_n", 2),
           "BUCKETS": "'" + " ".join(r.get("buckets", ["00"])) + "'", "GRACE_MIN": r.get("grace_min", 20),
           "TASK": r.get("task", "lora")}
    init = r.get("init")       # fortsätt från en hemhämtad checkpoint, t.ex. /data/texverse/runs/run1/checkpoint-10000
    if init:
        if not os.path.isfile(os.path.join(init, "dit_lora.safetensors")):
            return {"ok": False, "error": f"ingen dit_lora.safetensors i {init}"}
        env["INIT"] = "/workspace/init/" + os.path.basename(init.rstrip("/"))
    pod, errs = None, []
    for g in r.get("gpus", GPUS):           # bara Community Cloud; Secure kostar 50 % mer
        try:
            pod = gql("""mutation($i: PodFindAndDeployOnDemandInput) { podFindAndDeployOnDemand(input: $i) { id costPerHr } }""",
                      {"i": {"cloudType": "COMMUNITY", "gpuCount": 1, "gpuTypeId": g, "name": run.pid, "imageName": IMAGE,
                             "containerDiskInGb": 40, "volumeInGb": int(r.get("volume_gb", 150)), "volumeMountPath": "/workspace",
                             "minVcpuCount": 8, "minMemoryInGb": 32, "ports": "22/tcp", "supportPublicIp": True,
                             "env": [{"key": "PUBLIC_KEY", "value": open(KEY + ".pub").read().strip()}]}})["podFindAndDeployOnDemand"]
            pod["gpu"] = g; break
        except RuntimeError as e:
            errs.append(f"{g}: {e}")
    if not pod:
        return {"ok": False, "error": "ingen H100 ledig på Community Cloud", "details": errs}
    run.s = {"pod_id": pod["id"], "gpu": pod["gpu"], "cost_per_hr": pod["costPerHr"], "created": time.time(), "env": env,
             "max_min": env["MAX_MIN"], "fetched": []}
    run.save()
    p = pipeline.Pipeline(run.pid, f"UltraTex 4B {run.name}: {env['STEPS']} steps on RunPod", [
        ("pod", "Start H100 pod", "runpod"), ("setup", "Install + download models/data", "runpod"),
        ("prep", "Unpack TexVerse buckets", "runpod"), ("train", f"Train {'from ' + os.path.basename(init) + ' to ' if init else ''}{env['STEPS']} steps ({env['RESOLUTION']} px)", "runpod"),
        ("stop", "Fetch checkpoints + remove pod", "runpod")])
    p.save(); p.start("pod", note=f"{pod['gpu']}, {pod['costPerHr']} USD/h")
    for _ in range(90):
        time.sleep(10)
        rt = gql('query { pod(input: {podId: "%s"}) { runtime { ports { ip isIpPublic privatePort publicPort } } } }'
                 % run.s["pod_id"])["pod"]["runtime"]
        ports = [x for x in (rt or {}).get("ports") or [] if x["privatePort"] == 22 and x["isIpPublic"]]
        if ports:
            run.s.update(ip=ports[0]["ip"], port=ports[0]["publicPort"]); run.save()
            if run.ssh("true").returncode == 0:
                break
    else:
        p.fail("pod", note="ssh never came up"); stop({"run": run.name})
        return {"ok": False, "error": "ssh kom aldrig upp, poden borttagen"}
    if init:
        run.ssh(f"mkdir -p {env['INIT']}", 30)
        subprocess.run(["scp", *SSHO, "-P", str(run.s["port"]), os.path.join(init, "dit_lora.safetensors"),
                        f"root@{run.s['ip']}:{env['INIT']}/"], capture_output=True, timeout=900)
    for f in ("pod_train.sh", "prep_texverse.py"):
        subprocess.run(["scp", *SSHO, "-P", str(run.s["port"]), os.path.join(HERE, f), f"root@{run.s['ip']}:/workspace/"],
                       capture_output=True, timeout=120)
    envs = " ".join(f"{k}={v}" for k, v in env.items())
    try:   # ssh kan vänta kvar på det bakgrundade skriptet; det har ändå startat
        run.ssh(f"cd /workspace && {envs} setsid nohup bash pod_train.sh > pod.log 2>&1 < /dev/null &", timeout=30)
    except subprocess.TimeoutExpired:
        pass
    run.s["launched"] = time.time(); run.save()
    p.done("pod", note=f"{pod['gpu']}, {pod['costPerHr']} USD/h"); p.start("setup")
    return {"ok": True, "pod_id": run.s["pod_id"], "gpu": pod["gpu"], "usd_h": pod["costPerHr"], "max_min": env["MAX_MIN"],
            "max_usd": round(pod["costPerHr"] * env["MAX_MIN"] / 60, 1)}


TQDM = re.compile(r"(\d+)/(\d+) \[(?:(\d+):)?(\d+):(\d+)<")


def train_rate(log, total):
    """Sekunder per steg (tqdm: steg och förfluten tid; bara träningens stapel), räknat över de senaste ~200 stegen."""
    pts = {}
    for m in TQDM.finditer(log):
        if int(m[2]) == total:
            pts[int(m[1])] = int(m[3] or 0) * 3600 + int(m[4]) * 60 + int(m[5])
    ns = sorted(pts)
    if len(ns) >= 2:
        a = next((n for n in ns if n >= ns[-1] - 200), ns[0])
        if ns[-1] > a:
            return round((pts[ns[-1]] - pts[a]) / (ns[-1] - a), 2), ns[-1]
    return None, ns[-1] if ns else 0


def status(r):
    run = Run(r.get("run", "run1")); s = run.s
    if not s.get("pod_id"):
        return {"ok": False, "error": "ingen pod"}
    out = {"run": run.name, "pod_id": s["pod_id"], "gpu": s.get("gpu"), "usd_so_far": run.cost(), "removed": bool(s.get("removed_at")),
           "fetched": len(s.get("fetched", []))}
    if s.get("removed_at") or not s.get("ip"):
        return {**out, **s.get("result", {})}
    rr = run.ssh("cat /workspace/phases.jsonl; echo ===; tail -c 30000 /workspace/train.log 2>/dev/null; echo ===; "
                 "cut -d, -f1 /workspace/gpu.csv 2>/dev/null | sort -n | tail -1; echo ===; cat /workspace/prep.json 2>/dev/null; echo ===; "
                 "find /workspace/out \\( -name dit_lora.safetensors -o -name 'decoder_step*.pt' \\) -mmin +1 2>/dev/null | sort -V; true", 90)
    if rr.returncode:
        return {**out, "ssh": "no answer"}
    ph, log, mem, prep, ck = (rr.stdout.split("===\n") + [""] * 5)[:5]
    phases = [json.loads(x) for x in ph.splitlines() if x.strip()]
    total = int(s["env"]["STEPS"])
    rate, step = train_rate(log, total)
    out.update(phase=phases[-1]["phase"] if phases else "starting", phases={p["phase"]: p["t"] for p in phases},
               step=step, s_per_step=rate, gpu_mem_max_mb=int(mem.strip()) if mem.strip().isdigit() else None,
               checkpoints=[ck_name(c) for c in ck.split()])
    try:
        pj = json.loads(prep.strip().splitlines()[-1])
        out["prep"] = {k: pj.get(k) for k in ("objects", "train", "eval", "problems", "extracted_GB")}
    except Exception:
        pass
    if rate:
        left_h = rate * (total - step) / 3600
        out["eta_h"] = round(left_h, 1); out["usd_at_end"] = round(run.cost() + left_h * s["cost_per_hr"], 1)
    if "failed" in out["phase"]:
        out["log_tail"] = log[-1500:]
    return out


def ck_name(path):
    """checkpoint-N för LoRA-mappar, filnamnet (decoder_stepN.pt) för dekodern."""
    return path.split("/")[-2] if path.endswith("dit_lora.safetensors") else path.split("/")[-1]


def fetch(r, final=False):
    """Hämtar nya färdiga checkpoints (dit_lora.safetensors) och, sist, valideringsbilder och loggar."""
    run = Run(r.get("run", "run1"))
    rr = run.ssh("find /workspace/out \\( -name dit_lora.safetensors -o -name 'decoder_step*.pt' \\) -mmin +1 2>/dev/null | sort -V; true", 60)
    got = []
    for f in rr.stdout.split():
        ck = ck_name(f)
        if ck in run.s.get("fetched", []):
            continue
        local = os.path.join(run.out, ck, "dit_lora.safetensors") if f.endswith("dit_lora.safetensors") else os.path.join(run.out, ck)
        if run.pull(f, local).returncode == 0:
            run.s.setdefault("fetched", []).append(ck); run.save(); got.append(ck)
    if final:
        run.ssh("cd /workspace && tar czf /tmp/logs.tgz pod.log phases.jsonl gpu.csv prep.json pip.log dl_*.log train.log "
                "$(cd /workspace && find out -name '*.webp' -o -name '*.png' 2>/dev/null) 2>/dev/null; true", 300)
        if run.pull("/tmp/logs.tgz", os.path.join(run.out, "logs.tgz")).returncode == 0:
            subprocess.run(["tar", "xzf", os.path.join(run.out, "logs.tgz"), "-C", run.out])
    return {"ok": True, "new": got, "fetched": run.s.get("fetched", []), "out": run.out}


def resume(r):
    """Startar en stoppad pod igen (t.ex. efter vakthunden) för att hämta det som ligger kvar på dess disk, med en egen
    vakthund på poden (max_min, standard 20) så att den stoppas även om ingen hämtar. Svarar när ssh är uppe."""
    run = Run(r.get("run", "run1"))
    if not run.s.get("pod_id") or run.s.get("removed_at"):
        return {"ok": False, "error": "ingen stoppad pod"}
    try:
        res = gql('mutation { podResume(input: {podId: "%s", gpuCount: 1}) { id desiredStatus costPerHr } }' % run.s["pod_id"])["podResume"]
    except RuntimeError as e:   # kortet upptaget: starta utan GPU, det räcker för att hämta filer (och kostar mindre)
        if "not enough free gpus" not in str(e).lower():
            raise
        res = gql('mutation { podResume(input: {podId: "%s", gpuCount: 0}) { id desiredStatus costPerHr } }' % run.s["pod_id"])["podResume"]
        res["gpus"] = 0
    run.s["resumed_at"] = time.time(); run.s.pop("ip", None); run.save()
    for _ in range(60):
        time.sleep(10)
        rt = gql('query { pod(input: {podId: "%s"}) { runtime { ports { ip isIpPublic privatePort publicPort } } } }'
                 % run.s["pod_id"])["pod"]["runtime"]
        ports = [x for x in (rt or {}).get("ports") or [] if x["privatePort"] == 22 and x["isIpPublic"]]
        if ports:
            run.s.update(ip=ports[0]["ip"], port=ports[0]["publicPort"]); run.save()
            if run.ssh("true").returncode == 0:
                break
    else:
        gql('mutation { podStop(input: {podId: "%s"}) { id } }' % run.s["pod_id"])
        return {"ok": False, "error": "ssh kom aldrig upp, poden stoppad igen"}
    mm = int(r.get("max_min", 20))
    try:
        run.ssh("while IFS= read -r -d '' kv; do case $kv in RUNPOD_*) export \"$kv\";; esac; done < /proc/1/environ; "
                f"setsid nohup bash -c 'sleep {mm * 60}; runpodctl stop pod $RUNPOD_POD_ID' > /dev/null 2>&1 < /dev/null &", timeout=20)
    except subprocess.TimeoutExpired:
        pass
    return {"ok": True, "pod_id": run.s["pod_id"], "status": res.get("desiredStatus"), "gpus": res.get("gpus", 1), "usd_h": res.get("costPerHr"),
            "max_min": mm, "max_usd": round((res.get("costPerHr") or run.s["cost_per_hr"]) * mm / 60, 2)}


def recover(r):
    """För en pod som stoppats innan allt hämtats: försök starta den var `every_min` minut i högst `hours` timmar (kortet kan
    vara upptaget på värden), hämta sedan alla checkpoints, loggar och hela sista checkpointmappen (med optimerarens läge,
    så att träningen kan fortsätta senare), och ta bort poden när den sista finns hemma. Körs i bakgrunden på Darrowmere."""
    run = Run(r.get("run", "run1")); total = int(run.s["env"]["STEPS"])
    last = f"decoder_step{total}.pt" if run.s["env"].get("TASK") == "decoder" else f"checkpoint-{total}"
    p = run.pipe(); every, until = int(r.get("every_min", 10)), time.time() + float(r.get("hours", 24)) * 3600
    tries = 0
    while True:
        tries += 1
        try:
            up = bool(run.s.get("ip")) and run.ssh("true", 20).returncode == 0
            res = {"ok": True} if up else (run.s.pop("ip", None), run.save(), resume(r))[2]
        except (RuntimeError, subprocess.TimeoutExpired) as e:
            res = {"ok": False, "error": str(e)}
        if res.get("ok"):
            break
        if time.time() > until or "not enough free gpus" not in res.get("error", "").lower():
            if p: p.fail("stop", note=f"could not restart the pod: {res.get('error', '')[:80]}")
            return {"ok": False, "tries": tries, **res}
        if p: (p.start if tries == 1 else lambda k, note: p._set(k, note=note))(
            "stop", note=f"waiting for a free H100 to fetch the last checkpoints (try {tries})")
        time.sleep(every * 60)
        run = Run(run.name)
    if p: p.start("stop", note="pod restarted, fetching")
    got = fetch({"run": run.name}, final=True)
    run = Run(run.name)
    rr = run.ssh(f"cd /workspace/out && tar cf /tmp/{last}.tar {last}; true", 600)
    full = run.pull(f"/tmp/{last}.tar", os.path.join(run.out, f"{last}_full.tar"), 3600).returncode == 0
    if last in run.s.get("fetched", []) and full:
        res = stop({"run": run.name})
        if p: p.done("stop", note=f"{len(run.s.get('fetched', []))} checkpoints home, pod removed, {res['usd_total']} USD")
        return {"ok": True, "tries": tries, "new": got["new"], "full_state": f"{last}_full.tar", **res}
    gql('mutation { podStop(input: {podId: "%s"}) { id } }' % run.s["pod_id"])
    run.s.pop("ip", None); run.save()
    if p: p.fail("stop", note=f"{last} missing on the pod; pod stopped, not removed")
    return {"ok": False, "error": f"{last} saknas", "new": got["new"], "full_state": full}


def stop(r):
    run = Run(r.get("run", "run1"))
    if run.s.get("pod_id") and not run.s.get("removed_at"):
        try:
            gql('mutation { podTerminate(input: {podId: "%s"}) }' % run.s["pod_id"])
        except RuntimeError as e:
            if "not found" not in str(e).lower():
                raise
        run.s["removed_at"] = time.time(); run.save()
    return {"ok": True, "pod_id": run.s.get("pod_id"), "usd_total": run.cost()}


def watch(r):
    name = r.get("run", "run1")
    seen, last_fetch, log = set(), 0, open(os.path.join(Run(name).out, "watch.log"), "a")
    while True:
        try:
            run = Run(name); p = run.pipe(); st = status(r); ph = st.get("phase", "")
            for key, when in (("setup", ("prep", "train", "done")), ("prep", ("train", "done"))):
                if ph in when and key not in seen and p:
                    seen.add(key)
                    if p.step(key).get("status") != "done":     # en omstartad vakt nollställer inte stegens tider
                        p.done(key)
                        nxt = {"setup": "prep", "prep": "train"}[key]
                        p.start(nxt, note=json.dumps(st.get("prep")) if key == "prep" else None)
            if p and ph == "train" and st.get("step"):
                total = int(run.s["env"]["STEPS"])
                p._set("train", note=f"step {st['step']}/{total}, {st.get('s_per_step')} s/step, {st.get('usd_so_far')} USD",
                       pct=round(100 * st["step"] / total), eta=round(st["eta_h"] * 3600) if st.get("eta_h") is not None else None)
            if time.time() - last_fetch > 600 and ph in ("train", "done"):
                fetch(r); last_fetch = time.time()
            over = time.time() - run.s["created"] > (run.s["max_min"] + 20) * 60
            if ph == "done" or "failed" in ph or "watchdog" in ph or "grace" in ph or over:
                if p:
                    (p.done if ph == "done" else p.fail)("train", note=f"{ph}: step {st.get('step')}, {st.get('s_per_step')} s/step")
                    p.start("stop")
                if st.get("ssh") == "no answer":
                    # Stoppad av vakthunden: disken med checkpoints finns kvar; ta inte bort den utan att någon tittat
                    ds = gql('query { pod(input: {podId: "%s"}) { desiredStatus } }' % run.s["pod_id"])["pod"]
                    if ds and ds.get("desiredStatus") != "RUNNING":
                        if p:
                            p.fail("stop", note="pod stopped by watchdog, disk kept: check before removing")
                        return {"ok": False, "pod": "stopped, disk kept", "fetched": run.s.get("fetched"), "out": run.out}
                else:
                    fetch(r, final=True); run.ssh("touch /workspace/fetched")
                res = stop(r)
                run = Run(name)
                run.s["result"] = {k: st.get(k) for k in ("phase", "phases", "step", "s_per_step", "gpu_mem_max_mb", "prep", "checkpoints")}
                run.save()
                if p:
                    p.done("stop", note=f"{len(run.s.get('fetched', []))} checkpoints, {res['usd_total']} USD total")
                return {**run.s["result"], "usd_total": res["usd_total"], "fetched": run.s.get("fetched"), "out": run.out}
        except Exception:
            log.write(time.strftime("%F %T ") + traceback.format_exc() + "\n"); log.flush()
        time.sleep(60)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    rec = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
    try:
        fn = {"price": lambda r: price(), "start": start, "status": status, "fetch": fetch, "resume": resume, "recover": recover, "stop": stop, "watch": watch}[cmd]
        print(json.dumps(fn(rec)))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)[:500]}))
