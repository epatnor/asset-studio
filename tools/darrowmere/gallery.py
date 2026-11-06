"""Galleriet i Darrowmere-panelen: allt som finns under /data/utdata (genereringar, renderingar, modeller, texturkartor),
grupperat per beställning, och små förhandsbilder som panelen gör och sparar själv."""
import hashlib, io, json, subprocess, threading, time, urllib.parse, urllib.request
from pathlib import Path

# Körs på Darrowmere med python3 -, skriver en rad JSON: filerna och beställningarnas planer
INDEX = r'''
import json, os, re
ROOT = "/data/utdata"
files = []
for d, dirs, fs in os.walk(ROOT):
    rel = os.path.relpath(d, ROOT)
    if rel != "." and (rel.split("/")[0] == "pipelines" or any(x.startswith(".") for x in rel.split("/"))):
        dirs[:] = []; continue
    dirs[:] = [x for x in dirs if not x.startswith(".")]
    for f in fs:
        if f.startswith(".") or not re.search(r"\.(png|jpe?g|webp|glb|gltf)$", f, re.I):
            continue
        st = os.stat(os.path.join(d, f))
        files.append({"filename": f, "subfolder": "" if rel == "." else rel, "size": st.st_size, "mtime": st.st_mtime})
plans = []
pd = ROOT + "/pipelines"
for f in sorted(os.listdir(pd)) if os.path.isdir(pd) else []:
    if f.endswith(".json"):
        try:
            p = json.load(open(os.path.join(pd, f)))
        except Exception:
            continue
        plans.append({k: p.get(k) for k in ("id", "title", "asset", "project", "use", "created", "updated", "order_status")} |
                     {"steps": [{k: s.get(k) for k in ("key", "label", "kind", "note", "route", "provider", "status", "files")} for s in p.get("steps", [])]})
print(json.dumps({"files": files, "plans": plans}))
'''

MAPS = ("_base_color", "_basecolor", "_normal", "_roughness", "_metallic", "_height", "_ao.", "_orm", "_emission", "_depth")


def kind_of(name):
    n = name.lower()
    if n.endswith((".glb", ".gltf")):
        return "model"
    if "_inspect_" in n:
        return "inspect"
    if any(m in n for m in MAPS):
        return "map"
    if "_render_" in n or n.endswith("_preview.png") or "mesh_view" in n:
        return "render"
    return "image"


def build(raw):
    """Filerna grupperade per beställning (eller lösa genereringar per dag), nyast först."""
    plans = {p["id"]: p for p in raw["plans"] if p.get("id")}
    owner = {}  # (subfolder, filename) -> (beställning, steg) för filer som ComfyUI lade i rotmappen
    for p in plans.values():
        for s in p["steps"]:
            for f in s.get("files") or []:
                owner[(f.get("subfolder") or "", f.get("filename"))] = (p["id"], s.get("key"))
    groups = {}
    by_dir = {}
    for f in raw["files"]:
        by_dir.setdefault(f["subfolder"], set()).add(f["filename"])
    for f in raw["files"]:
        sub, name = f["subfolder"], f["filename"]
        parts = sub.split("/")
        if parts[0] == "orders" and len(parts) > 1:
            oid, step = parts[1], (parts[2] if len(parts) > 2 else "")
        elif (sub, name) in owner:
            oid, step = owner[(sub, name)]
        else:
            oid, step = None, ""
        k = kind_of(name)
        item = {"filename": name, "subfolder": sub, "size": f["size"], "mtime": f["mtime"], "kind": k, "step": step}
        if k == "model":
            # förhandsbilden för en modell: dess egen rendering i samma mapp, om runnern gjort en
            stem = name.rsplit(".", 1)[0]
            for cand in (f"{stem}_render_a.png", f"{stem}_preview.png", f"{stem}_inspect_tex_000.png"):
                if cand in by_dir.get(sub, ()):
                    item["thumb"] = cand
                    break
        if oid:
            gid = "o:" + oid
        else:
            day = time.strftime("%Y-%m-%d", time.localtime(f["mtime"]))
            gid = ("3d:" if parts[0] == "3d" else "c:") + day
        g = groups.setdefault(gid, {"id": gid, "items": []})
        g["items"].append(item)
    out = []
    for gid, g in groups.items():
        items = g["items"]
        last = max(i["mtime"] for i in items)
        if gid.startswith("o:"):
            p = plans.get(gid[2:]) or {}
            steps = {s.get("key"): s for s in p.get("steps", [])}
            for i in items:
                s = steps.get(i["step"]) or {}
                i["step_label"] = s.get("label") or i["step"]
                if s.get("note"):
                    i["note"] = s["note"]
                if s.get("route") == "cloud":
                    i["cloud"] = s.get("provider") or "cloud"
            g.update(title=p.get("title") or gid[2:], order=gid[2:], asset=p.get("asset") or "", status=p.get("order_status") or "",
                     time=p.get("updated") or last)
        else:
            day = gid.split(":", 1)[1]
            g.update(title=("3D models" if gid.startswith("3d:") else "ComfyUI generations") + " · " + day, order=None,
                     asset="", status="", time=last)
        items.sort(key=lambda i: (i["step"], {"model": 0, "render": 1, "image": 2, "map": 3, "inspect": 4}[i["kind"]], i["filename"]))
        out.append(g)
    out.sort(key=lambda g: -g["time"])
    return out


class Gallery:
    def __init__(self, ssh, comfy, cache_dir):
        self.ssh, self.comfy, self.dir = ssh, comfy, Path(cache_dir)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.cached, self.at, self.lock = None, 0, threading.Lock()
        self.thumbing = threading.Semaphore(2)  # Winterspring gör högst två förhandsbilder åt gången

    def index(self, max_age=20):
        with self.lock:
            if self.cached is not None and time.time() - self.at < max_age:
                return self.cached
            r = subprocess.run(self.ssh + ["python3", "-"], input=INDEX, capture_output=True, text=True, timeout=30)
            if r.returncode:
                raise RuntimeError((r.stderr or "ssh failed").strip()[-300:])
            self.cached, self.at = build(json.loads(r.stdout)), time.time()
            return self.cached

    def thumb(self, filename, subfolder, mtime="", size=360):
        """En liten WebP av en bild (sparas, nyckeln innehåller filens ändringstid)."""
        key = hashlib.sha1(f"{subfolder}/{filename}@{mtime}@{size}".encode()).hexdigest()
        p = self.dir / f"{key}.webp"
        if p.exists():
            return p.read_bytes()
        with self.thumbing:
            if p.exists():
                return p.read_bytes()
            from PIL import Image
            q = urllib.parse.urlencode({"filename": filename, "subfolder": subfolder, "type": "output"})
            data = urllib.request.urlopen(f"{self.comfy}/view?{q}", timeout=60).read()
            im = Image.open(io.BytesIO(data))
            im.draft("RGB", (size * 2, size * 2))
            im = im.convert("RGBA") if im.mode in ("RGBA", "LA", "P") else im.convert("RGB")
            im.thumbnail((size, size), Image.LANCZOS)
            buf = io.BytesIO()
            im.save(buf, "WEBP", quality=82, method=4)
            tmp = p.with_suffix(".tmp")
            tmp.write_bytes(buf.getvalue())
            tmp.replace(p)
            return buf.getvalue()
