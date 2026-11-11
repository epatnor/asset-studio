"""Pipelines: en hel tillgång (bild, 3D-modell, texturer, rigg …) som en kedja av steg i Darrowmeres kontrollpanel.

Planen sparas som JSON i Darrowmeres utmapp (/data/utdata/pipelines/<id>.json), där panelen läser den. ComfyUI-jobb
kopplas till ett steg genom extra_data (p.extra("mesh")), så panelen ser själv när de köar, körs och blir klara. Steg som
körs någon annanstans (Blender, projicering på Andorhal) rapporteras med start/done/fail.

    import pipeline
    p = pipeline.Pipeline("robot-v2", "Robot android v2", [
        ("mesh", "3D mesh"), ("tex_front", "Texture: front"), ("project", "Project textures", "andorhal"), ("rig", "Skeleton rig")])
    p.save()
    payload = {"prompt": graph, **p.extra("mesh", "Robot v2: 3D mesh with Pixal3D")}
    p.start("project"); ...; p.done("project", note="62 % covered")

Fel vid sparandet (Darrowmere avstängd) stoppar aldrig verktyget; de skrivs till stderr.
"""
import json
import os
import subprocess
import sys
import time

def _worker():
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "darrowmere"))
    import machine
    return machine.ssh_target()


HOST = os.environ.get("PIPELINE_HOST") or _worker()
DIR = "/data/utdata/pipelines"
SSH = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=6"]


def _cmd(cmd):
    """PIPELINE_HOST=local: körs på Darrowmere själv (t.ex. en vakt för molnjobb), annars via ssh."""
    return ["bash", "-c", cmd] if HOST == "local" else SSH + [HOST, cmd]


class Pipeline:
    def __init__(self, pid, title, steps):
        """steps: (key, label) eller (key, label, where); where är "darrowmere" (ComfyUI-jobb, standard) eller en annan värd."""
        self.id, self.title = pid, title
        self.steps = [{"key": s[0], "label": s[1], "where": s[2] if len(s) > 2 else "darrowmere"} for s in steps]
        self.created = time.time()

    @classmethod
    def load(cls, pid):
        """Läser en sparad pipeline (för att fortsätta den), eller None."""
        try:   # panelen är bara visning: en seg disk eller ett avbrott får aldrig stoppa jobbet (run3b-bevakaren dog så)
            r = subprocess.run(_cmd(f"cat {DIR}/{pid}.json"), capture_output=True, text=True, timeout=60)
        except (subprocess.TimeoutExpired, OSError):
            return None
        if r.returncode:
            return None
        d = json.loads(r.stdout)
        p = cls(d["id"], d["title"], [])
        p.steps, p.created = d["steps"], d.get("created", time.time())
        return p

    def step(self, key):
        return next(s for s in self.steps if s["key"] == key)

    def save(self):
        body = json.dumps({"id": self.id, "title": self.title, "created": self.created, "updated": time.time(), "steps": self.steps},
                          ensure_ascii=False)
        cmd = f"mkdir -p {DIR} && cat > {DIR}/.{self.id}.tmp && mv {DIR}/.{self.id}.tmp {DIR}/{self.id}.json"
        try:
            r = subprocess.run(_cmd(cmd), input=body, capture_output=True, text=True, timeout=20)
            if r.returncode:
                print(f"pipeline: could not save {self.id}: {r.stderr.strip()[-200:]}", file=sys.stderr)
        except Exception as e:
            print(f"pipeline: could not save {self.id}: {e}", file=sys.stderr)
        return self

    def extra(self, key, title=None, tool=None):
        """extra_data till ComfyUI:s /prompt, så att jobbet hamnar på rätt steg i panelen."""
        s = self.step(key)
        return {"extra_data": {"job_title": title or f"{self.title}: {s['label']}", "job_tool": tool or os.path.basename(sys.argv[0]),
                               "job_host": os.uname().nodename, "pipeline": {"id": self.id, "step": key}}}

    def _set(self, key, **kw):
        self.step(key).update(kw)
        return self.save()

    def start(self, key, note=None):
        return self._set(key, status="running", start=time.time(), end=None, note=note)

    def done(self, key, note=None):
        return self._set(key, status="done", end=time.time(), note=note)

    def fail(self, key, note=None):
        return self._set(key, status="failed", end=time.time(), note=note)

    def skip(self, key, note=None):
        return self._set(key, status="skipped", note=note)
