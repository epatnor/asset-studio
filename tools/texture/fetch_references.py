"""Referensbiblioteket (patriks_input/AAA_Reference_Guided_Procedural_Textures_Tiling_ThreeJS_Reference.md, avsnitt 2):
hämtar några få CC0-texturer från Poly Haven som mätmål för våra procedurella material (inte som färdiga texturer).

  python3 -I tools/texture/fetch_references.py '{"ids": ["jolcham_oak_bark_01"], "res": "1k"}'
  python3 -I tools/texture/fetch_references.py            alla i material-references/wanted.json

Varje referens får färg- och höjdkarta i material-references/cache/<id>/ (ignoreras av git) och ett manifest i
material-references/manifests/<id>.json med källa, licens (CC0-1.0), hämtdatum, fysisk storlek (Poly Havens
dimensions i mm, confidence "provider") och sha256 per fil. Poly Havens API kräver en egen User-Agent och att källan
visas ("Powered by Poly Haven"); se docs/texture-workshop.md. Svarar med en rad JSON.
"""
import datetime
import hashlib
import json
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
REF = ROOT / "material-references"
UA = "AzsharaAssetStudio-ReferenceFetcher/1.0"
API = "https://api.polyhaven.com"


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def fetch(pid, res, want):
    info = json.loads(get(f"{API}/info/{pid}"))
    files = json.loads(get(f"{API}/files/{pid}"))
    out = REF / "cache" / pid
    out.mkdir(parents=True, exist_ok=True)
    saved = {}
    for name, (key, fmt) in {"color": ("Diffuse", "jpg"), "height": ("Displacement", "png")}.items():
        if name not in want:
            continue
        node = files.get(key, {}).get(res, {}).get(fmt) or files.get(key, {}).get(res, {}).get("jpg")
        if not node:
            continue
        data = get(node["url"])
        p = out / f"{name}.{node['url'].rsplit('.', 1)[-1]}"
        p.write_bytes(data)
        saved[name] = {"file": str(p.relative_to(ROOT)), "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}
    dims = info.get("dimensions")
    manifest = {
        "id": pid,
        "source": "polyhaven",
        "sourceUrl": f"https://polyhaven.com/a/{pid}",
        "name": info.get("name"),
        "authors": list((info.get("authors") or {}).keys()),
        "license": "CC0-1.0",
        "downloadedAt": datetime.date.today().isoformat(),
        "resolution": res,
        "maps": saved,
        "physicalWidthMeters": round(dims[0] / 1000, 3) if dims else None,
        "physicalHeightMeters": round(dims[1] / 1000, 3) if dims and len(dims) > 1 else None,
        "scaleConfidence": "provider" if dims else "unknown",
        "tags": info.get("tags", []),
        "categories": info.get("categories", []),
    }
    (REF / "manifests").mkdir(parents=True, exist_ok=True)
    (REF / "manifests" / f"{pid}.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
    return {"id": pid, "maps": list(saved), "meters": manifest["physicalWidthMeters"]}


def main():
    req = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
    ids = req.get("ids") or json.loads((REF / "wanted.json").read_text())["ids"]
    res, want = req.get("res", "1k"), set(req.get("maps", ["color", "height"]))
    done, failed = [], []
    for pid in ids:
        try:
            done.append(fetch(pid, res, want))
        except Exception as e:  # noqa: BLE001 – en referens som saknas stoppar inte de andra
            failed.append({"id": pid, "error": str(e)[:200]})
    print(json.dumps({"fetched": done, "failed": failed}))


if __name__ == "__main__":
    main()
