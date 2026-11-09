"""Galleriet i Darrowmere-panelen: allt som finns under /data/utdata (genereringar, renderingar, modeller, texturkartor),
grupperat per beställning, och små förhandsbilder som panelen gör och sparar själv."""
import hashlib, io, json, re, shlex, subprocess, threading, time, urllib.parse, urllib.request
from pathlib import Path

# Körs på Darrowmere med python3 -, skriver en rad JSON: filerna och beställningarnas planer
INDEX = r'''
import json, os, re
ROOT = "/data/utdata"
files = []
for d, dirs, fs in os.walk(ROOT):
    rel = os.path.relpath(d, ROOT)
    if rel != "." and (rel.split("/")[0] in ("pipelines", "missions") or any(x.startswith(".") for x in rel.split("/"))):
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
        plans.append({k: p.get(k) for k in ("id", "title", "asset", "project", "use", "created", "updated", "order_status", "mission", "mission_title", "operator")} |
                     {"steps": [{k: s.get(k) for k in ("key", "label", "kind", "note", "route", "provider", "status", "files")} for s in p.get("steps", [])]})
missions = {}
md = ROOT + "/missions"
for f in os.listdir(md) if os.path.isdir(md) else []:
    if f.endswith(".json") and not f.startswith("."):
        try:
            m = json.load(open(os.path.join(md, f)))
            missions[m["mission"]] = m
        except Exception:
            pass
print(json.dumps({"files": files, "plans": plans, "missions": missions}))
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
    notes = raw.get("missions") or {}
    owner = {}  # (subfolder, filename) -> (beställning, steg) för filer som ComfyUI lade i rotmappen
    for p in plans.values():
        for s in p["steps"]:
            for f in s.get("files") or []:
                owner[(f.get("subfolder") or "", f.get("filename"))] = (p["id"], s.get("key"))
    groups = {}
    by_dir = {}
    for f in raw["files"]:
        by_dir.setdefault(f["subfolder"], set()).add(f["filename"])
    # Filer som gjorts för hand bredvid en beställnings filer (graderade GLB:er, förhandsbilder, sRGB-versioner) hör till den
    # beställning vars filnamn (utan löpnummer) är början på deras namn; annars till det uppdrag som äger de flesta filerna i mappen
    prefixes, mission_votes = {}, {}
    for (sub, name), (oid, step) in owner.items():
        st = re.sub(r"_?\d{5}_?$", "", name.rsplit(".", 1)[0])
        if len(st) >= 6:
            prefixes.setdefault(sub, []).append((st, oid, step))
        m = (plans.get(oid) or {}).get("mission")
        if m:
            mission_votes.setdefault(sub, {}).setdefault(m, 0)
            mission_votes[sub][m] += 1
    for f in raw["files"]:
        key = (f["subfolder"], f["filename"])
        if key in owner or f["subfolder"].split("/")[0] == "orders":
            continue
        hits = [x for x in prefixes.get(f["subfolder"], []) if f["filename"].startswith(x[0])]
        if hits:
            st, oid, step = max(hits, key=lambda x: len(x[0]))
            owner[key] = (oid, step)
        elif f["subfolder"] and mission_votes.get(f["subfolder"]):   # inte rotmappen, där ComfyUI lägger lösa genereringar
            votes = mission_votes[f["subfolder"]]
            m, n = max(votes.items(), key=lambda kv: kv[1])
            if n >= 0.6 * sum(votes.values()):   # bara när ett uppdrag tydligt äger mappen
                f["_mission"] = m
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
        elif f.get("_mission"):
            gid = "x:" + f["_mission"] + ":" + sub
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
            # granskningens betyg ("pass 8/10: ..."): det bästa i beställningen, så att uppdraget kan sorteras efter det
            score, verdict = None, ""
            for s in p.get("steps", []):
                m = re.match(r"\s*(pass|warning|fail|rejected)\s+(\d+(?:\.\d+)?)/10", s.get("note") or "") if s.get("kind") == "review" else None
                if m and (score is None or float(m.group(2)) > score):
                    score, verdict = float(m.group(2)), m.group(1)
            g.update(title=p.get("title") or gid[2:], order=gid[2:], asset=p.get("asset") or "", status=p.get("order_status") or "",
                     time=p.get("updated") or last, mission=p.get("mission") or "", mission_title=p.get("mission_title") or "",
                     score=score, verdict=verdict, operator=p.get("operator") or None, mission_note=notes.get(p.get("mission") or ""))
        elif gid.startswith("x:"):
            m, sub = gid[2:].split(":", 1)
            mt = next((p.get("mission_title") for p in plans.values() if p.get("mission") == m and p.get("mission_title")), "")
            # Tiden från uppdragets beställningar, inte från filerna (galleriets egna förhandsbilder är nya men hör till gamla jobb)
            mtime = max((p.get("updated") or 0 for p in plans.values() if p.get("mission") == m), default=last)
            g.update(title=f"More files in {sub}", order=None, asset="", status="", time=mtime, mission=m, mission_title=mt,
                     score=None, verdict="", operator=None, mission_note=notes.get(m))
        else:
            day = gid.split(":", 1)[1]
            g.update(title=("3D models" if gid.startswith("3d:") else "ComfyUI generations") + " · " + day, order=None,
                     asset="", status="", time=last, mission="", mission_title="", score=None, verdict="", operator=None)
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
        self.rendering = threading.Semaphore(1)  # Darrowmere renderar högst en modell åt gången (Blender, utan skärm)

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


    def model_thumb(self, filename, subfolder, mtime="", size=360):
        """Förhandsbild för en 3D-modell som saknar en: Blender på Darrowmere renderar <namn>_render_a.png bredvid modellen
        (platt textur, snett framifrån). Den blir sedan modellens vanliga förhandsbild i galleriet."""
        render = filename.rsplit(".", 1)[0] + "_render_a.png"
        key = hashlib.sha1(f"{subfolder}/{render}@{mtime}@{size}".encode()).hexdigest()
        if (self.dir / f"{key}.webp").exists():
            return (self.dir / f"{key}.webp").read_bytes()
        d = f"/data/utdata/{subfolder}" if subfolder else "/data/utdata"
        # Bara när ComfyUI-korten är lediga, så att förhandsbilden aldrig konkurrerar med ett jobb om minnet
        for port in (8188, 8189):
            try:
                base = re.sub(r":\d+$", f":{port}", self.comfy.rstrip("/"))
                q = json.load(urllib.request.urlopen(f"{base}/queue", timeout=5))
                if q.get("queue_running") or q.get("queue_pending"):
                    raise RuntimeError("Darrowmere is busy; the preview is made when it is idle")
            except RuntimeError:
                raise
            except Exception:
                pass
        with self.rendering:
            job = {"glb": f"{d}/{filename}", "out_dir": d, "size": 512, "prefix": "render_",
                   "shots": [{"name": "a", "yaw": 30, "pitch": 10, "mode": "texture"}]}
            cmd = (f"test -f {shlex.quote(d + '/' + render)} || nice -n 15 systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 /data/blender/current/blender -b --factory-startup "
                   f"-P /data/runner/render_views.py -- --json {shlex.quote(json.dumps(job))} > /dev/null 2>&1; test -f {shlex.quote(d + '/' + render)}")
            r = subprocess.run(self.ssh + [cmd] if self.ssh else ["bash", "-c", cmd], capture_output=True, text=True, timeout=300)
            if r.returncode:
                raise RuntimeError("Blender could not render the model")
        return self.thumb(render, subfolder, mtime, size)
