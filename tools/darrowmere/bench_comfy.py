"""Runs the same ComfyUI jobs on several worker machines at once and measures them (machines.json, one lane each).

  python3 -I tools/darrowmere/bench_comfy.py '{"machines": ["darrowmere", "ravenholdt"], "models": ["krea", "klein"], "runs": 3}'

For each model in turn, every machine first drops its loaded models (/free), then runs `runs` images in a row with
the same prompt and seeds (seed + run, so ComfyUI's cache never skips work). Run 1 is the cold one (models from disk or
the page cache into RAM and VRAM); the rest are warm. Meanwhile each machine's RAM, swap and swap traffic are sampled
over ssh every 2 s. Writes build/bench/comfy_<time>.json and answers with one line of JSON.

Recipe: machines, models ("krea": Krea-2 Turbo 8 steps, "klein": FLUX.2 Klein 4B 4 steps), runs (3), size (1024),
seed (11), lane (T1000), prompt.
"""
import copy
import json
import sys
import threading
import time
import urllib.request
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))
import machine  # noqa: E402

R = {"machines": ["darrowmere", "ravenholdt"], "models": ["krea", "klein"], "runs": 3, "size": 1024, "seed": 11,
     "lane": "T1000", "prompt": "A weathered stone watchtower on a mossy cliff above a misty pine forest at dawn, painterly, soft light",
     **(json.loads(sys.argv[1]) if len(sys.argv) > 1 else {})}


def krea(prompt, seed, size, prefix):
    g = json.loads((HERE / "character" / "graphs" / "krea_t2i.json").read_text())
    g["4"]["inputs"]["text"] = prompt
    g["7"]["inputs"]["seed"] = seed
    g["6"]["inputs"].update(width=size, height=size)
    g["9"]["inputs"]["filename_prefix"] = prefix
    return g


def klein(prompt, seed, size, prefix):
    return {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "flux-2-klein-4b-fp8.safetensors", "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen_3_4b.safetensors", "type": "flux2", "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": "flux2-vae.safetensors"}},
        "4": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["2", 0]}},
        "5": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["4", 0]}},
        "6": {"class_type": "EmptyFlux2LatentImage", "inputs": {"width": size, "height": size, "batch_size": 1}},
        "7": {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}},
        "8": {"class_type": "CFGGuider", "inputs": {"model": ["1", 0], "positive": ["4", 0], "negative": ["5", 0], "cfg": 1.0}},
        "9": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler"}},
        "10": {"class_type": "Flux2Scheduler", "inputs": {"steps": 4, "width": size, "height": size}},
        "11": {"class_type": "SamplerCustomAdvanced", "inputs": {"noise": ["7", 0], "guider": ["8", 0], "sampler": ["9", 0],
                                                                  "sigmas": ["10", 0], "latent_image": ["6", 0]}},
        "12": {"class_type": "VAEDecode", "inputs": {"samples": ["11", 0], "vae": ["3", 0]}},
        "13": {"class_type": "SaveImage", "inputs": {"images": ["12", 0], "filename_prefix": prefix}},
    }


GRAPHS = {"krea": krea, "klein": klein}


def http(url, body=None, timeout=30):
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
    return json.loads(raw) if raw.strip() else {}


SAMPLE = r'''
import time
def mem():
    m = {l.split(":")[0]: int(l.split()[1]) for l in open("/proc/meminfo")}
    v = {l.split()[0]: int(l.split()[1]) for l in open("/proc/vmstat")}
    return (m["MemTotal"] - m["MemAvailable"]) / 1048576, (m["SwapTotal"] - m["SwapFree"]) / 1048576, v["pswpin"], v["pswpout"]
while True:
    print("%.2f %.2f %d %d" % mem(), flush=True)
    time.sleep(2)
'''


class Sampler(threading.Thread):
    """RAM in use (total minus available), swap in use and swap pages in and out, every 2 s over ssh."""
    def __init__(self, m):
        super().__init__(daemon=True)
        import subprocess
        self.p = subprocess.Popen(["ssh", "-o", "BatchMode=yes", machine.ssh_target(m["name"]), "python3 -u -"],
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        self.p.stdin.write(SAMPLE)
        self.p.stdin.close()
        self.rows = []

    def run(self):
        for line in self.p.stdout:
            ram, swap, si, so = line.split()
            self.rows.append((time.time(), float(ram), float(swap), int(si), int(so)))

    def window(self, t0, t1):
        rows = [r for r in self.rows if t0 - 2 <= r[0] <= t1 + 2]
        if not rows:
            return {}
        return {"ram_peak_gb": round(max(r[1] for r in rows), 1), "swap_peak_gb": round(max(r[2] for r in rows), 1),
                "swap_in_mb": round((rows[-1][3] - rows[0][3]) * 4 / 1024), "swap_out_mb": round((rows[-1][4] - rows[0][4]) * 4 / 1024)}

    def stop(self):
        self.p.terminate()


def run_machine(m, model, out, start):
    url = m["lanes"].get(R["lane"]) or m["comfy"]
    res = out.setdefault(m["name"], {}).setdefault(model, {"runs": []})
    try:
        http(f"{url}/free", {"unload_models": True, "free_memory": True})
    except Exception:
        pass
    time.sleep(3)
    start.wait()
    cid = str(uuid.uuid4())
    for i in range(R["runs"]):
        g = GRAPHS[model](R["prompt"], R["seed"] + i, R["size"], f"bench_{model}_{m['name']}_{i}")
        t0 = time.time()
        pid = http(f"{url}/prompt", {"prompt": g, "client_id": cid})["prompt_id"]
        while True:
            time.sleep(1)
            h = http(f"{url}/history/{pid}").get(pid)
            if h and h.get("status", {}).get("completed") is not None:
                break
            if time.time() - t0 > 3600:
                h = {"status": {"status_str": "timeout"}}
                break
        st = h.get("status", {})
        msgs = {k: v for k, v in st.get("messages", [])}
        ex = None
        if "execution_start" in msgs and "execution_success" in msgs:
            ex = round((msgs["execution_success"]["timestamp"] - msgs["execution_start"]["timestamp"]) / 1000, 1)
        res["runs"].append({"run": i + 1, "wall_s": round(time.time() - t0, 1), "exec_s": ex, "status": st.get("status_str"),
                            "t0": t0, "t1": time.time()})


def main():
    ms = [machine.worker(n) for n in R["machines"]]
    samplers = {m["name"]: Sampler(m) for m in ms}
    for s in samplers.values():
        s.start()
    out = {}
    for model in R["models"]:
        start = threading.Barrier(len(ms))
        ths = [threading.Thread(target=run_machine, args=(m, model, out, start)) for m in ms]
        for t in ths:
            t.start()
        for t in ths:
            t.join()
        for m in ms:
            res = out[m["name"]][model]
            res.update(samplers[m["name"]].window(res["runs"][0]["t0"], res["runs"][-1]["t1"]))
            res["cold_s"] = res["runs"][0]["exec_s"]
            warm = [r["exec_s"] for r in res["runs"][1:] if r["exec_s"]]
            res["warm_s"] = round(sum(warm) / len(warm), 1) if warm else None
            for r in res["runs"]:
                r.pop("t0"), r.pop("t1")
    for s in samplers.values():
        s.stop()
    d = ROOT / "build" / "bench"
    d.mkdir(parents=True, exist_ok=True)
    f = d / f"comfy_{time.strftime('%Y%m%d_%H%M')}.json"
    f.write_text(json.dumps({"recipe": R, "results": out}, indent=1))
    summary = {m: {k: {x: v[x] for x in ("cold_s", "warm_s", "ram_peak_gb", "swap_peak_gb", "swap_in_mb", "swap_out_mb") if x in v}
                   for k, v in r.items()} for m, r in out.items()}
    ok = all(run["status"] == "success" for r in out.values() for v in r.values() for run in v["runs"])
    print(json.dumps({"ok": ok, "file": str(f.relative_to(ROOT)), "results": summary}))


if __name__ == "__main__":
    main()
