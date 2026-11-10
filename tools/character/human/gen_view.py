"""A new reference picture for an odd angle, made by FLUX.2 Klein 4B on Darrowmere as a runner order (free, local, shown in
the Darrowmere gallery). The render of the figure from that angle is reference image 1 and the start latent; the reference
pictures follow as more reference latents (ReferenceLatent, FLUX.2 editing). Picked by The Character Creator's Generate
this view (studio/human_paint.js, /api/human/genview); compared with Krea-2 in docs/asset-studio.md (2026-11-10).

  python3 -I tools/character/human/gen_view.py '{"render": "build/human/genview/x/render_1.png", "refs": ["build/human/refs/x/front.png"],
      "prompt": "...", "aspect": "2:3", "out": "build/human/refs/x/view_1.png"}'

Recipe: render, refs (at most 4), prompt, aspect (2:3, 1:1 or 3:2), out (never overwritten), denoise (0.75: how much of the
render is painted over), seed, id (the order id), gpu (a lane, or none for the first free card), timeout_s (1800).
Answers with one JSON line: out, order, lane, seconds, seed.
"""
import json, subprocess, sys, time, urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path.insert(0, str(ROOT / "tools/darrowmere"))
import order as darrowmere  # noqa: E402

HOST = "192.168.0.33"
LANES = {"t1000": 8188, "m4000": 8189}  # the runner's lanes (runner.json on Darrowmere)
SIZES = {"2:3": (832, 1248), "1:1": (1024, 1024), "3:2": (1248, 832)}


def fail(msg, **kw):
    print(json.dumps({"ok": False, "error": msg, **kw}))
    sys.exit(1)


def graph(n_refs, w, h, prompt, denoise, seed):
    g = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "flux-2-klein-4b-fp8.safetensors", "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen_3_4b.safetensors", "type": "flux2", "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": "flux2-vae.safetensors"}},
        "4": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["2", 0]}},
        # Image 1: the render at the output size (also the start latent)
        "10": {"class_type": "LoadImage", "inputs": {"image": "$in:render.png"}},
        "11": {"class_type": "ImageScale", "inputs": {"image": ["10", 0], "upscale_method": "lanczos", "width": w, "height": h, "crop": "center"}},
        "12": {"class_type": "VAEEncode", "inputs": {"pixels": ["11", 0], "vae": ["3", 0]}},
        "20": {"class_type": "ReferenceLatent", "inputs": {"conditioning": ["4", 0], "latent": ["12", 0]}},
    }
    last = "20"
    for i in range(n_refs):  # images 2..: the reference pictures, about one megapixel each
        a, b, c, r = (str(100 + 10 * i + k) for k in range(4))
        g[a] = {"class_type": "LoadImage", "inputs": {"image": f"$in:ref{i + 1}.png"}}
        g[b] = {"class_type": "ImageScaleToTotalPixels", "inputs": {"image": [a, 0], "upscale_method": "lanczos", "megapixels": 1.0, "resolution_steps": 16}}
        g[c] = {"class_type": "VAEEncode", "inputs": {"pixels": [b, 0], "vae": ["3", 0]}}
        g[r] = {"class_type": "ReferenceLatent", "inputs": {"conditioning": [last, 0], "latent": [c, 0]}}
        last = r
    g.update({
        "22": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["4", 0]}},
        "30": {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}},
        "31": {"class_type": "CFGGuider", "inputs": {"model": ["1", 0], "positive": [last, 0], "negative": ["22", 0], "cfg": 1.0}},
        "32": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler"}},
        "33": {"class_type": "Flux2Scheduler", "inputs": {"steps": 4, "width": w, "height": h}},
        "35": {"class_type": "SamplerCustomAdvanced", "inputs": {"noise": ["30", 0], "guider": ["31", 0], "sampler": ["32", 0], "sigmas": ["33", 0], "latent_image": ["12", 0]}},
        "36": {"class_type": "VAEDecode", "inputs": {"samples": ["35", 0], "vae": ["3", 0]}},
        "37": {"class_type": "SaveImage", "inputs": {"images": ["36", 0], "filename_prefix": "genview_klein"}},
    })
    if denoise < 1:  # start from the render: only the last part of the schedule runs
        g["38"] = {"class_type": "SplitSigmasDenoise", "inputs": {"sigmas": ["33", 0], "denoise": denoise}}
        g["35"]["inputs"]["sigmas"] = ["38", 1]
    else:
        g["34"] = {"class_type": "EmptyFlux2LatentImage", "inputs": {"width": w, "height": h, "batch_size": 1}}
        g["35"]["inputs"]["latent_image"] = ["34", 0]
    return g


def remote_json(path):
    r = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", f"epatnor@{HOST}", f"cat {path}"], capture_output=True, text=True, timeout=60)
    return json.loads(r.stdout) if r.returncode == 0 and r.stdout.strip() else None


def main():
    r = json.loads(sys.argv[1])
    render, out = ROOT / r["render"], ROOT / r["out"]
    refs = [ROOT / f for f in r.get("refs", [])][:4]
    if not render.exists():
        fail(f"no render {r['render']}")
    if out.exists():
        fail(f"{r['out']} already exists")
    if r.get("aspect", "2:3") not in SIZES:
        fail("aspect must be 2:3, 1:1 or 3:2")
    w, h = SIZES[r.get("aspect", "2:3")]
    denoise = max(0.15, min(1.0, float(r.get("denoise", 0.75))))
    seed = int(r.get("seed", int(time.time()) % 2**31))
    oid = r.get("id") or f"genview-{out.stem}-{time.strftime('%m%d-%H%M%S')}"
    work = ROOT / "build/human/genview/orders" / oid
    work.mkdir(parents=True, exist_ok=True)
    (work / "graph.json").write_text(json.dumps(graph(len(refs), w, h, r["prompt"], denoise, seed)))
    o = {"id": oid, "title": f"Generate this view: {out.stem} (Klein 4B)", "project": "asset-studio", "asset": r.get("asset", out.parent.name), "use": "reference",
         "mission": "genview", "mission_title": "Generate this view",
         "inputs": {"render.png": str(render), **{f"ref{i + 1}.png": str(p) for i, p in enumerate(refs)}},
         "steps": [{"key": "view", "label": "Klein 4B view from the render", "kind": "comfy", "graph_file": "graph.json"}]}
    if r.get("gpu"):
        o["gpu"] = r["gpu"]
    (work / "order.json").write_text(json.dumps(o, indent=1))
    t0 = time.time()
    try:
        darrowmere.submit(work / "order.json")
    except Exception as e:  # noqa: BLE001
        fail(f"could not order on Darrowmere: {e}", order=oid)
    # Wait for the runner: the step's state names the output file, the order its lane (card)
    st = None
    while time.time() - t0 < float(r.get("timeout_s", 1800)):
        time.sleep(5)
        s = remote_json(f"/data/orders/{oid}/state.json")
        st = (s or {}).get("steps", {}).get("view")
        if st and st.get("status") in ("done", "failed", "error", "cancelled"):
            break
    else:
        fail("Darrowmere did not finish in time", order=oid)
    if st.get("status") != "done" or not st.get("outputs"):
        fail(f"the order ended {st.get('status')}: {st.get('error', '')}"[:300], order=oid)
    lane = (remote_json(f"/data/orders/{oid}/order.json") or {}).get("gpu") or "t1000"
    f = st["outputs"][0]
    url = f"http://{HOST}:{LANES.get(lane, 8188)}/view?filename={f['filename']}&subfolder={f.get('subfolder', '')}&type={f.get('type', 'output')}"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(urllib.request.urlopen(url, timeout=60).read())
    print(json.dumps({"ok": True, "out": str(out.relative_to(ROOT)), "order": oid, "lane": lane, "seed": seed, "denoise": denoise,
                      "seconds": round(st.get("end", time.time()) - st.get("start", t0)), "total_s": round(time.time() - t0)}))


if __name__ == "__main__":
    main()
