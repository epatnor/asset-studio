"""Beställningar till Darrowmere: lägg en beställning och stäng locket; runnern på Darrowmere kör den (runner/runner.py).

  python3 -I tools/darrowmere/order.py submit <beställning.json>   lägger beställningen i Darrowmeres inkorg
  python3 -I tools/darrowmere/order.py status [<id>]               läget (alla aktuella, eller en)
  python3 -I tools/darrowmere/order.py approve <id> <steg> <krediter>  godkänner ett molnsteg (som Approve i panelen)
  python3 -I tools/darrowmere/order.py cancel <id>                 stoppar beställningen före nästa steg

En beställning (exempel i runner/examples/):
  {"id": "robot-v3", "title": "Robot android v3", "project": "asset-studio", "asset": "robot-android", "use": "test-only",
   "inputs": {"ref.png": "../../build/robot/edit/robot_ref.png"},
   "steps": [{"key": "img", "label": "Reference image", "kind": "comfy", "graph_file": "krea_t2i.json"},
             {"key": "rev", "label": "Review: image", "kind": "review", "images": ["$step:img"], "refs": ["$in:ref.png"],
              "criteria": ["..."], "retry": {"step": "img", "max": 2}},
             {"key": "rig", "label": "Skeleton rig", "kind": "manual", "where": "andorhal"}]}
Sökvägar i "inputs" och "graph_file" räknas från beställningsfilens mapp. Indata laddas upp till
/data/orders/<id>/in/, flödena läggs in i beställningen. Svarar med en rad JSON.
"""
import json
import re
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import machine  # noqa: E402

HOST = machine.ssh_target()
SSH = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8"]


def ssh(cmd, data=None):
    r = subprocess.run(SSH + [HOST, cmd], input=data, capture_output=True, text=True, timeout=120)
    if r.returncode:
        raise RuntimeError(r.stderr.strip()[-300:] or "ssh failed")
    return r.stdout


def awake():
    """Wakes the worker (Wake-on-LAN) when it has gone to sleep; orders, approvals and cancels need it awake."""
    w = machine.wake()
    if not w["awake"]:
        raise RuntimeError(w.get("error") or "the worker is asleep and did not wake")
    return w


def submit(path):
    path = Path(path).resolve()
    woke = awake()
    o = json.loads(path.read_text())
    oid = o.get("id") or re.sub(r"[^a-z0-9-]+", "-", o.get("title", "order").lower()).strip("-")[:40]
    oid = f"{oid}-{time.strftime('%m%d-%H%M')}" if not o.get("id") else oid
    if not re.fullmatch(r"[A-Za-z0-9._-]+", oid):
        raise ValueError(f"bad order id {oid!r}")
    o["id"] = oid
    for s in o["steps"]:
        if s.get("graph_file"):
            s["graph"] = json.loads((path.parent / s.pop("graph_file")).read_text())
    ssh(f"mkdir -p /data/orders/{oid}/in /data/orders/inbox")
    for name, local in (o.get("inputs") or {}).items():
        src = (path.parent / local).resolve()
        r = subprocess.run(["scp", "-q", "-o", "BatchMode=yes", str(src), f"{HOST}:/data/orders/{oid}/in/{name}"], capture_output=True, text=True)
        if r.returncode:
            raise RuntimeError(f"upload {name}: {r.stderr.strip()[-200:]}")
    o["submitted"] = {"t": time.time(), "from": subprocess.run(["hostname"], capture_output=True, text=True).stdout.strip()}
    ssh(f"cat > /data/orders/inbox/.{oid}.tmp && mv /data/orders/inbox/.{oid}.tmp /data/orders/inbox/{oid}.json", json.dumps(o))
    return {"ok": True, "id": oid, "steps": len(o["steps"]), "inputs": len(o.get("inputs") or {}),
            "panel": "http://192.168.0.17:8790", **({"woke_in_s": woke["seconds"]} if woke["woke"] else {})}


def status(oid=None):
    if not machine.answers(machine.worker()["host"]):
        return {"ok": True, "asleep": True, "orders": []}   # asleep or off: nothing runs, and status does not wake it
    pat = f"/data/utdata/pipelines/{oid}.json" if oid else "/data/utdata/pipelines/*.json"
    out = ssh(f"for f in {pat}; do cat \"$f\"; echo; done 2>/dev/null")
    res = []
    for line in out.splitlines():
        if line.strip():
            p = json.loads(line)
            res.append({"id": p["id"], "title": p.get("title"), "status": p.get("order_status"),
                        "steps": {s["key"]: s["status"] for s in p["steps"]},
                        "notes": {s["key"]: s["note"] for s in p["steps"] if s.get("note")}})
    return {"ok": True, "orders": res}


def approve(oid, step, credits):
    # Godkänner ett molnstegs kostnad, som Approve-knappen i panelen
    code = ("import json,os,sys; p='/data/orders/'+sys.argv[1]+'/approved.json'; d=json.load(open(p)) if os.path.exists(p) else {}; "
            "d.setdefault('steps',{})[sys.argv[2]]=int(sys.argv[3]); json.dump(d,open(p,'w'))")
    import shlex
    awake()
    ssh(shlex.join(["python3", "-c", code, oid, step, str(int(credits))]))
    return {"ok": True, "id": oid, "step": step, "approved_credits": int(credits)}


def cancel(oid):
    awake()
    ssh(f"touch /data/orders/{oid}/cancel")
    return {"ok": True, "id": oid, "cancel": "requested"}


if __name__ == "__main__":
    a = sys.argv[1:]
    try:
        r = (submit(a[1]) if a[0] == "submit" else status(a[1] if len(a) > 1 else None) if a[0] == "status"
             else approve(a[1], a[2], a[3]) if a[0] == "approve" else cancel(a[1]))
    except Exception as e:
        r = {"ok": False, "error": str(e)[-300:]}
    print(json.dumps(r, ensure_ascii=False))
    sys.exit(0 if r["ok"] else 1)
