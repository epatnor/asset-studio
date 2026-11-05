"""Levererar färdiga jobb från Darrowmere till Andorhal: bilder, modeller och texturer hamnar i en mapp per jobb.

  python3 -I tools/darrowmere/deliver.py            (körs var tionde minut av en användartimer på Andorhal)

Jobblistan och det som redan är levererat läses från kontrollpanelens tillstånd på Winterspring
(~/.local/state/darrowmere-monitor/jobs.json och delivered.json). Filerna hämtas med rsync från Darrowmeres
/data/utdata. Varje jobb får en mapp i DELIVERY_DIR (standard ~/Darrowmere-leveranser) med datum, jobbtyp och
beskrivning i namnet, filerna och en job.json med prompt och inställningar. Levererade jobb skrivs tillbaka till
delivered.json, så att panelen kan visa dem. Svarar med en rad JSON.
"""
import fcntl
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

WS = os.environ.get("DELIVERY_PANEL_HOST", "epatnor@192.168.0.17")
DM = os.environ.get("DELIVERY_DARROWMERE", "epatnor@192.168.0.33")
DEST = Path(os.environ.get("DELIVERY_DIR", Path.home() / "Darrowmere-leveranser"))
STATE = "~/.local/state/darrowmere-monitor"
SSH = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8"]


def remote_json(path):
    r = subprocess.run(SSH + [WS, f"cat {path} 2>/dev/null || echo '{{}}'"], capture_output=True, text=True, timeout=30)
    if r.returncode:
        raise RuntimeError(f"Winterspring: {r.stderr.strip()[-200:]}")
    return json.loads(r.stdout or "{}")


def slug(text, n=60):
    s = re.sub(r"[^\w\-]+", "-", text, flags=re.UNICODE).strip("-")
    return s[:n].rstrip("-") or "job"


def main():
    DEST.mkdir(parents=True, exist_ok=True)
    lock = open(DEST / ".deliver.lock", "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print(json.dumps({"ok": True, "skipped": "already running"}))
        return
    jobs = remote_json(f"{STATE}/jobs.json")
    jobs = jobs if isinstance(jobs, list) else []
    delivered = remote_json(f"{STATE}/delivered.json")
    new, failed = {}, []
    for j in sorted(jobs, key=lambda j: j.get("start") or 0):
        files = (j.get("images") or []) + (j.get("models") or [])
        if j.get("status") != "success" or not files or j["id"] in delivered:
            continue
        when = time.strftime("%Y-%m-%d_%H%M", time.localtime(j.get("start") or time.time()))
        folder = DEST / f"{when}_{slug(j.get('name', 'job'), 20)}_{slug(re.sub(r'^[\w.-]+\.py: ', '', j.get('title') or ''))}"
        folder.mkdir(parents=True, exist_ok=True)
        rel = [str(Path(f.get("subfolder") or "") / f["filename"]) for f in files if f.get("type", "output") == "output"]
        r = subprocess.run(["rsync", "-t", "--no-relative", "--files-from=-", "-e", " ".join(SSH), f"{DM}:/data/utdata/", str(folder)],
                           input="\n".join(rel) + "\n", capture_output=True, text=True, timeout=600)
        got = [p for p in rel if (folder / Path(p).name).exists()]
        if r.returncode or len(got) < len(rel):
            failed.append({"id": j["id"], "error": (r.stderr or "missing files").strip()[-200:]})
            continue
        (folder / "job.json").write_text(json.dumps({k: j.get(k) for k in ("id", "name", "title", "details", "start", "seconds", "images", "models")},
                                                    indent=1, ensure_ascii=False))
        new[j["id"]] = {"path": str(folder), "files": len(got), "t": time.time(), "host": os.uname().nodename}
    if new:
        # Skriv tillbaka till panelens tillstånd på Winterspring (slås ihop där, så att inget som redan står där försvinner)
        merge = ("import json,sys,os,pathlib; p=pathlib.Path(os.path.expanduser('" + STATE + "/delivered.json')); "
                 "d=json.loads(p.read_text()) if p.exists() else {}; d.update(json.load(sys.stdin)); "
                 "t=p.with_suffix('.tmp'); t.write_text(json.dumps(d,indent=1)); t.replace(p)")
        subprocess.run(SSH + [WS, f"python3 -c \"{merge}\""], input=json.dumps(new), text=True, timeout=30, check=True)
    print(json.dumps({"ok": not failed, "delivered": len(new), "already": len(delivered), "failed": failed, "dest": str(DEST)}))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # t.ex. Darrowmere eller Winterspring avstängd: försök igen nästa gång
        print(json.dumps({"ok": False, "error": str(e)[-300:]}))
        sys.exit(1)
