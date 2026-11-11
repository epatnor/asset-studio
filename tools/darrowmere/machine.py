"""The worker machines (Darrowmere, later the Dell T5810) in one place: tools/darrowmere/machines.json.

Every tool that talks to the worker asks this module instead of hard-coding an address, so a new machine is one entry
in machines.json ("worker" picks the default). Stdlib only: it is also copied to Winterspring with the panel.

  from machine import worker, ssh_target, wake
  worker()             -> {"name", "host", "user", "mac", "comfy", "lanes", ...}   (env DARROWMERE_WORKER picks another)
  ssh_target()         -> "epatnor@192.168.0.33"                                   (env DARROWMERE_HOST overrides the host)
  wake(timeout=150)    -> sends a Wake-on-LAN packet if the worker does not answer on ssh, then waits for it

  python3 -I tools/darrowmere/machine.py [show|ssh|wake] [<machine>]   one line of JSON (ssh prints user@host)
"""
import json
import os
import socket
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
CONF = json.loads((HERE / "machines.json").read_text())


def worker(name=None):
    name = name or os.environ.get("DARROWMERE_WORKER") or CONF["worker"]
    m = dict(CONF["machines"][name], name=name)
    if os.environ.get("DARROWMERE_HOST") and not os.environ.get("DARROWMERE_WORKER"):
        m["host"] = os.environ["DARROWMERE_HOST"]
    if not m.get("host"):
        raise RuntimeError(f"machine {name} has no host yet (tools/darrowmere/machines.json)")
    return m


def ssh_target(name=None):
    m = worker(name)
    return f"{m.get('user') or 'epatnor'}@{m['host']}"


def answers(host, port=22, timeout=2.0):
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def magic_packet(mac):
    raw = bytes.fromhex(mac.replace(":", "").replace("-", ""))
    if len(raw) != 6:
        raise ValueError(f"bad MAC {mac!r}")
    pkt = b"\xff" * 6 + raw * 16
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        for addr in CONF.get("broadcast") or ["255.255.255.255"]:
            for port in (9, 7):
                try:
                    s.sendto(pkt, (addr, port))
                except OSError:
                    pass


def wake(name=None, timeout=150, wait=True):
    """Wakes the worker if it is asleep. Returns {"awake", "woke", "seconds"}; never raises for a sleeping machine."""
    m = worker(name)
    t0 = time.time()
    if answers(m["host"]):
        return {"awake": True, "woke": False, "seconds": 0}
    if not m.get("mac"):
        return {"awake": False, "woke": False, "seconds": 0, "error": f"{m['name']} does not answer and has no MAC for Wake-on-LAN"}
    magic_packet(m["mac"])
    if not wait:
        return {"awake": False, "woke": True, "seconds": 0}
    while time.time() - t0 < timeout:
        time.sleep(3)
        if answers(m["host"]):
            return {"awake": True, "woke": True, "seconds": round(time.time() - t0)}
        if int(time.time() - t0) % 30 < 3:
            magic_packet(m["mac"])   # resend now and then: the first packet can be lost on the way
    return {"awake": False, "woke": True, "seconds": round(time.time() - t0), "error": f"{m['name']} did not wake in {timeout} s"}


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "show"
    name = sys.argv[2] if len(sys.argv) > 2 else None
    try:
        if cmd == "ssh":
            print(ssh_target(name))
            sys.exit(0)
        r = {"ok": True, **worker(name)} if cmd == "show" else {"ok": None, **wake(name)}
        if r["ok"] is None:
            r["ok"] = r["awake"]
    except Exception as e:
        r = {"ok": False, "error": str(e)}
    print(json.dumps(r, ensure_ascii=False))
    sys.exit(0 if r["ok"] else 1)
