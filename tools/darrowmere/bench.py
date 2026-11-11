"""Darrowmeres prestanda, samma mätningar före och efter uppgraderingar (CPU, minne, nät). Bara standardbiblioteket och openssl.

  ssh epatnor@192.168.0.33 'python3 - ' < tools/darrowmere/bench.py
  python3 -I tools/darrowmere/bench.py --remote          kör det över ssh och skriver ut resultatet

Svarar med en rad JSON. Kör när Darrowmere är ledig (inga ComfyUI-jobb); "load_before" visar om den var det.
Resultaten samlas i docs/darrowmere-baseline.md.
"""
import json, os, re, subprocess, sys, time


def sh(cmd, timeout=120):
    try:
        return subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout).stdout
    except Exception:
        return ""


def best(fn, n=3):
    return min(fn() for _ in range(n))


def py_single():
    # Ren Python i en tråd: heltalsloop (speglar skript som runnern, trimesh-förberedelser och liknande)
    t = time.perf_counter(); s = 0
    for i in range(12_000_000):
        s += i * i % 7
    return time.perf_counter() - t


def mem_copy():
    # Minnesbandbredd: kopiera 1 GB i minnet (memcpy via bytes)
    a = bytearray(1 << 30)
    t = time.perf_counter(); b = bytes(a); dt = time.perf_counter() - t
    del a, b
    return (1 << 30) / dt / 1e9


def openssl(alg, multi=None, evp=False):
    out = sh(f"openssl speed -seconds 2 {'-multi %d ' % multi if multi else ''}{'-evp ' if evp else ''}{alg} 2>/dev/null", 120)
    rows = [l for l in out.splitlines() if l.lower().startswith(alg.lower()) or l.lower().startswith("evp")]
    if not rows:
        return None
    vals = re.findall(r"([\d.]+)k", rows[-1])
    return round(float(vals[-1]) / 1000, 1) if vals else None  # MB/s för 16 kB-block


def disk_read(path, mb=2048):
    if not os.path.exists(path):
        return None
    out = sh(f"dd if='{path}' of=/dev/null bs=4M count={mb // 4} iflag=direct 2>&1 | tail -1")
    m = re.search(r"([\d.,]+) ([GM])B/s", out)
    return round(float(m.group(1).replace(",", ".")) * (1000 if m.group(2) == "G" else 1)) if m else None


def net_down(url="https://huggingface.co/black-forest-labs/FLUX.2-klein-4b-fp8/resolve/main/flux-2-klein-4b-fp8.safetensors",
             nbytes=200_000_000):
    t = time.perf_counter()
    out = sh(f"curl -sL --fail -r 0-{nbytes - 1} -o /dev/null -w '%{{size_download}}' '{url}'", 180)
    dt = time.perf_counter() - t
    try:
        return round(int(out) * 8 / dt / 1e6)
    except ValueError:
        return None


def main():
    if "--remote" in sys.argv:
        src = open(__file__).read()
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import machine   # only on the laptop: the script itself runs on the worker
        r = subprocess.run(["ssh", "-o", "BatchMode=yes", machine.ssh_target(), "python3 -"], input=src, capture_output=True, text=True, timeout=900)
        print(r.stdout.strip() or json.dumps({"ok": False, "error": r.stderr.strip()[-300:]}))
        return
    cpu = re.search(r"model name\s*:\s*(.+)", open("/proc/cpuinfo").read()).group(1).strip()
    threads = os.cpu_count()
    flags = open("/proc/cpuinfo").read()
    mem = int(re.search(r"MemTotal:\s+(\d+)", open("/proc/meminfo").read()).group(1)) // 1024
    gpus = [l.strip() for l in sh("nvidia-smi --query-gpu=name,clocks.max.sm,power.limit --format=csv,noheader").splitlines() if l.strip()]
    big = max((os.path.join(d, f) for d in ["/data/modeller/diffusion_models", "/data/modeller/text_encoders"] if os.path.isdir(d)
               for f in os.listdir(d) if f.endswith((".safetensors", ".gguf"))), key=os.path.getsize, default=None)
    res = {
        "ok": True, "when": time.strftime("%Y-%m-%d %H:%M"), "load_before": os.getloadavg()[0],
        "cpu": cpu, "threads": threads, "aes_ni": " aes " in flags, "avx": " avx " in flags, "ram_mb": mem, "gpus": gpus,
        "py_single_s": round(best(py_single), 2),
        "sha256_1t_MBs": openssl("sha256"),
        f"sha256_{threads}t_MBs": openssl("sha256", multi=threads),
        "aes128gcm_1t_MBs": openssl("aes-128-gcm", evp=True),
        "mem_copy_GBs": round(best(mem_copy), 2),
        "disk_read_MBs": disk_read(big) if big else None, "disk_file": os.path.basename(big) if big else None,
        "net_down_Mbit": net_down(),
    }
    print(json.dumps(res))


if __name__ == "__main__":
    main()
