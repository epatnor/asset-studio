"""Förbereder G-buffer TexVerse-buckets för UltraTex-träning (plan: docs/ultratex-4b.md).

Packar upp en bucket (zip med en zip per objekt), kontrollerar att varje objekt har det träningen läser, mäter
förgrundsandelen (för UltraTex:s bucket-sortering) och skriver train.json, eval.json och foreground_ratios.json.
Körs där datat ligger (Darrowmere eller den hyrda maskinen) med en Python som har Pillow:

  /data/venv-m4000/bin/python tools/ultratex4b/prep_texverse.py '{"buckets": ["/data/texverse/canonical/bsdf/00.zip"], "out": "/data/texverse/extracted"}'

Recept: buckets (lista), out (uppackat), eval_n (antal objekt till eval, standard 16), fg (mät förgrund, standard true),
seed, limit (högst så många objekt, för provkörningar). Svarar med en rad JSON.
"""
import io, json, os, random, sys, zipfile
from collections import Counter

NEEDED = ["albedo", "position", "bump_normal_world"]          # train_flux2.py: load_and_concat
RENDERS = ["render_0", "render_1", "render_2", "render_ref_0", "render_ref_1", "render_ref_2"]  # dataset.py: indata


def fg_ratio(d):
    from PIL import Image
    tot = 0.0
    for i in range(6):
        im = Image.open(os.path.join(d, "albedo", f"{i:03d}.webp"))
        a = im.getchannel("A") if "A" in im.getbands() else im.convert("L").point(lambda v: 255 if v < 250 else 0)
        a = a.resize((128, 128))
        tot += a.point(lambda v: 255 if v > 8 else 0).histogram()[255] / (128 * 128)
    return tot / 6


def main():
    r = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
    out = r.get("out", "/data/texverse/extracted"); os.makedirs(out, exist_ok=True)
    ids, problems, manifest_keys, pbr, res = [], Counter(), Counter(), 0, Counter()
    manifest_rows = []
    for b in r["buckets"]:
        with zipfile.ZipFile(b) as z:
            for name in z.namelist():
                if name.endswith(".manifest.jsonl"):
                    for line in z.read(name).decode().splitlines():
                        if line.strip():
                            row = json.loads(line); manifest_rows.append(row); manifest_keys.update(row.keys())
                    continue
                if not name.endswith(".zip"):
                    continue
                if r.get("limit") and len(ids) >= r["limit"]:
                    break
                oid = os.path.basename(name)[:-4]
                d = os.path.join(out, oid)
                if not os.path.isdir(d):
                    with zipfile.ZipFile(io.BytesIO(z.read(name))) as iz:
                        iz.extractall(out)
                miss = [s for s in NEEDED if not all(os.path.exists(os.path.join(d, s, f"{i:03d}.webp")) for i in range(6))]
                if miss:
                    problems["missing_" + "+".join(miss)] += 1; continue
                if not any(os.path.isdir(os.path.join(d, s)) for s in RENDERS):
                    problems["no_renders"] += 1; continue
                pbr += os.path.isdir(os.path.join(d, "roughness_metallic"))
                res[oid.rsplit("_", 1)[-1]] += 1
                ids.append(oid)
    rnd = random.Random(r.get("seed", 42)); rnd.shuffle(ids)
    n_eval = min(r.get("eval_n", 16), max(1, len(ids) // 20))
    row = lambda i: {"prompt": "", "image_dir": os.path.join(out, i), "id": i, "id_only": i.rsplit("_", 1)[0]}
    json.dump([row(i) for i in ids[n_eval:]], open(os.path.join(out, "train.json"), "w"), indent=1)
    json.dump([row(i) for i in ids[:n_eval]], open(os.path.join(out, "eval.json"), "w"), indent=1)
    fg = {}
    if r.get("fg", True):
        for i in ids:
            try:
                fg[i] = round(fg_ratio(os.path.join(out, i)), 4)
            except Exception:
                problems["fg_failed"] += 1
        json.dump(fg, open(os.path.join(out, "foreground_ratios.json"), "w"))
    du = sum(os.path.getsize(os.path.join(p, f)) for p, _, fs in os.walk(out) for f in fs)
    ex = manifest_rows[0] if manifest_rows else {}
    print(json.dumps({
        "ok": bool(ids) and not problems.get("missing_albedo"), "objects": len(ids), "train": len(ids) - n_eval, "eval": n_eval,
        "with_roughness_metallic": pbr, "source_res": dict(res), "problems": dict(problems),
        "fg_mean": round(sum(fg.values()) / len(fg), 3) if fg else None,
        "fg_small_lt_0.05": sum(v < 0.05 for v in fg.values()),
        "extracted_GB": round(du / 1e9, 1), "manifest_rows": len(manifest_rows), "manifest_keys": sorted(manifest_keys),
        "manifest_example": {k: (str(v)[:80]) for k, v in ex.items()},
        "out": out,
    }))


if __name__ == "__main__":
    main()
