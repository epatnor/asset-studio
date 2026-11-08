"""Förbereder G-buffer TexVerse-buckets för UltraTex-träning (plan: docs/ultratex-4b.md).

Packar upp buckets (zip med en zip per objekt), kontrollerar att varje objekt har det träningen läser, mäter
förgrundsandelen (för UltraTex:s bucket-sortering) och skriver train.json, eval.json och foreground_ratios.json.
Objekten behandlas parallellt (workers processer). Körs där datat ligger (Darrowmere eller den hyrda maskinen) med en
Python som har Pillow:

  /data/venv-m4000/bin/python -I tools/ultratex4b/prep_texverse.py '{"buckets": ["/data/texverse/canonical/bsdf/00.zip"], "out": "/data/texverse/extracted"}'

Recept: buckets (lista), out (uppackat), eval_n (antal objekt till eval, standard 16), fg (mät förgrund, standard true),
seed, limit (högst så många objekt, för provkörningar), workers (standard: antal kärnor, högst 32), delete_zips (ta bort
varje bucket när den är uppackad). Svarar med en rad JSON.
"""
import io, json, os, random, sys, zipfile
from collections import Counter
from multiprocessing import Pool

NEEDED = ["albedo", "position", "bump_normal_world"]          # train_flux2.py: load_and_concat
RENDERS = ["render_0", "render_1", "render_2", "render_ref_0", "render_ref_1", "render_ref_2"]  # dataset.py: indata
_ZIPS = {}


def fg_ratio(d):
    from PIL import Image
    tot = 0.0
    for i in range(6):
        im = Image.open(os.path.join(d, "albedo", f"{i:03d}.webp"))
        a = im.getchannel("A") if "A" in im.getbands() else im.convert("L").point(lambda v: 255 if v < 250 else 0)
        a = a.resize((128, 128))
        tot += a.point(lambda v: 255 if v > 8 else 0).histogram()[255] / (128 * 128)
    return tot / 6


def one(task):
    """Ett objekt: packa upp (om det inte redan är gjort), kontrollera, mät förgrunden."""
    bucket, name, out, fg = task
    oid = os.path.basename(name)[:-4]
    d = os.path.join(out, oid)
    try:
        if not os.path.isdir(d):
            z = _ZIPS.get(bucket) or _ZIPS.setdefault(bucket, zipfile.ZipFile(bucket))
            with zipfile.ZipFile(io.BytesIO(z.read(name))) as iz:
                iz.extractall(out)
        miss = [s for s in NEEDED if not all(os.path.exists(os.path.join(d, s, f"{i:03d}.webp")) for i in range(6))]
        if miss:
            return oid, "missing_" + "+".join(miss), None
        if not any(os.path.isdir(os.path.join(d, s)) for s in RENDERS):
            return oid, "no_renders", None
        info = {"pbr": os.path.isdir(os.path.join(d, "roughness_metallic")), "res": oid.rsplit("_", 1)[-1]}
        if fg:
            try:
                info["fg"] = round(fg_ratio(d), 4)
            except Exception:
                info["fg_failed"] = True
        return oid, None, info
    except Exception as e:
        return oid, "error_" + type(e).__name__, None


def main():
    r = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
    out = r.get("out", "/data/texverse/extracted"); os.makedirs(out, exist_ok=True)
    fg_on = r.get("fg", True)
    tasks, manifest_rows, manifest_keys = [], [], Counter()
    for b in r["buckets"]:
        with zipfile.ZipFile(b) as z:
            for name in z.namelist():
                if name.endswith(".manifest.jsonl"):
                    for line in z.read(name).decode().splitlines():
                        if line.strip():
                            row = json.loads(line); manifest_rows.append(row); manifest_keys.update(row.keys())
                elif name.endswith(".zip"):
                    tasks.append((b, name, out, fg_on))
    if r.get("limit"):
        tasks = tasks[: r["limit"]]
    workers = int(r.get("workers") or min(32, os.cpu_count() or 4))
    ids, problems, pbr, res, fg = [], Counter(), 0, Counter(), {}
    with Pool(workers) as pool:
        for oid, prob, info in pool.imap_unordered(one, tasks, chunksize=4):
            if prob:
                problems[prob] += 1; continue
            ids.append(oid); pbr += info["pbr"]; res[info["res"]] += 1
            if "fg" in info:
                fg[oid] = info["fg"]
            if info.get("fg_failed"):
                problems["fg_failed"] += 1
    if r.get("delete_zips"):
        for b in r["buckets"]:
            os.remove(b)
    ids.sort()
    rnd = random.Random(r.get("seed", 42)); rnd.shuffle(ids)
    n_eval = min(r.get("eval_n", 16), max(1, len(ids) // 20))
    row = lambda i: {"prompt": "", "image_dir": os.path.join(out, i), "id": i, "id_only": i.rsplit("_", 1)[0]}
    json.dump([row(i) for i in ids[n_eval:]], open(os.path.join(out, "train.json"), "w"), indent=1)
    json.dump([row(i) for i in ids[:n_eval]], open(os.path.join(out, "eval.json"), "w"), indent=1)
    if fg_on:
        json.dump(fg, open(os.path.join(out, "foreground_ratios.json"), "w"))
    du = sum(os.path.getsize(os.path.join(p, f)) for p, _, fs in os.walk(out) for f in fs)
    ex = manifest_rows[0] if manifest_rows else {}
    print(json.dumps({
        "ok": bool(ids) and not problems.get("missing_albedo"), "objects": len(ids), "train": len(ids) - n_eval, "eval": n_eval,
        "with_roughness_metallic": pbr, "source_res": dict(res), "problems": dict(problems), "workers": workers,
        "fg_mean": round(sum(fg.values()) / len(fg), 3) if fg else None,
        "fg_small_lt_0.05": sum(v < 0.05 for v in fg.values()),
        "extracted_GB": round(du / 1e9, 1), "manifest_rows": len(manifest_rows), "manifest_keys": sorted(manifest_keys),
        "manifest_example": {k: (str(v)[:80]) for k, v in ex.items()},
        "out": out,
    }))


if __name__ == "__main__":
    main()
