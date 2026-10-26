"""HDRI från Poly Haven (CC0) -> third_party/polyhaven_hdri/<id>_<res>.hdr, plus index.json med namn och upphovspersoner.

  python3 -I tools/hdri/fetch_hdri.py '{"ids": ["forest_slope", "qwantani_dusk_2"], "res": "2k"}'

Används som miljöljus i Ateljéns materiallabb (studio/lab3d.js), som komplement till spelsolen. Filerna ligger inte i git
(se third_party/polyhaven_hdri/SOURCE.md). Kontrollsumman (md5) från Poly Havens API jämförs efter nedladdningen.
Svarar med en rad JSON: {"files": [...], "mb": ...} eller {"error": ...}.
"""
import hashlib
import json
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "third_party" / "polyhaven_hdri"
API = "https://api.polyhaven.com"
UA = {"User-Agent": "AzsharaAssetStudio/1.0 (https://github.com/epatnor/asset-studio)"}


def get_json(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
        return json.loads(r.read())


def main():
    r = json.loads(sys.argv[1])
    res = r.get("res", "2k")
    OUT.mkdir(parents=True, exist_ok=True)
    index_file = OUT / "index.json"
    index = json.loads(index_file.read_text()) if index_file.exists() else {}
    files, total = [], 0
    for hid in r["ids"]:
        if not hid.replace("_", "").isalnum():
            sys.exit(json.dumps({"error": f"bad id {hid}"}))
        f = get_json(f"{API}/files/{hid}")["hdri"][res]["hdr"]
        info = get_json(f"{API}/info/{hid}")
        dest = OUT / f"{hid}_{res}.hdr"
        if not (dest.exists() and hashlib.md5(dest.read_bytes()).hexdigest() == f["md5"]):
            with urllib.request.urlopen(urllib.request.Request(f["url"], headers=UA), timeout=600) as resp:
                data = resp.read()
            if hashlib.md5(data).hexdigest() != f["md5"]:
                sys.exit(json.dumps({"error": f"{hid}: checksum does not match"}))
            dest.write_bytes(data)
        index[hid] = {"file": dest.name, "name": info.get("name", hid), "authors": list(info.get("authors", {}).keys()),
                      "license": "CC0", "source": f"https://polyhaven.com/a/{hid}", "res": res}
        files.append(str(dest.relative_to(ROOT)))
        total += dest.stat().st_size
    index_file.write_text(json.dumps(index, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps({"files": files, "mb": round(total / 1e6, 1)}))


if __name__ == "__main__":
    main()
