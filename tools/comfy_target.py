"""Väljer vilken ComfyUI verktygen skickar jobb till.

Målen står i tools/comfy.json. Valet görs per jobb (varje verktygskörning), när jobbet startar: alla mål som svarar
tillfrågas om sin kö (/queue, körs + väntar), och det med minst att göra tar jobbet; vid lika vinner ordningen i "order"
(Darrowmere först). Så arbetar laptopens RTX 4070 och Darrowmeres T1000 samtidigt när det finns flera jobb.
COMFY_TARGET=darrowmere (eller local) väljer bara det målet, COMFY_URL=http://... en exakt adress.

Verktygen körs med python3 -I, så de lägger själva till tools/ i sys.path innan de importerar modulen.
"""
import json
import os
import urllib.request
from pathlib import Path

CONF = Path(__file__).with_name("comfy.json")
_cache: dict[str, str | None] = {}


def _up(url: str) -> bool:
    timeout = 1 if "127.0.0.1" in url or "localhost" in url else 3
    try:
        urllib.request.urlopen(f"{url}/system_stats", timeout=timeout).read()
        return True
    except Exception:
        return False


def targets() -> list[tuple[str, str]]:
    """Målen i den ordning de provas, som (namn, adress)."""
    if os.environ.get("COMFY_URL"):
        return [("COMFY_URL", os.environ["COMFY_URL"].rstrip("/"))]
    conf = json.loads(CONF.read_text())
    want = os.environ.get("COMFY_TARGET")
    names = [want] if want else list(conf["order"])
    return [(n, conf["targets"][n].rstrip("/")) for n in names if n in conf["targets"]]


def queue_length(url: str) -> int | None:
    """Jobb som körs eller väntar i en ComfyUI, eller None om den inte svarar."""
    timeout = 1 if "127.0.0.1" in url or "localhost" in url else 3
    try:
        q = json.loads(urllib.request.urlopen(f"{url}/queue", timeout=timeout).read())
        return len(q.get("queue_running", [])) + len(q.get("queue_pending", []))
    except Exception:
        return None


def comfy_url() -> str | None:
    """Den ComfyUI som har minst att göra just nu (vid lika: ordningen i comfy.json), eller None om ingen svarar.
    Väljs en gång per jobb (process)."""
    if "url" not in _cache:
        free = [(n, i, url) for i, (_, url) in enumerate(targets()) if (n := queue_length(url)) is not None]
        _cache["url"] = min(free)[2] if free else None
    return _cache["url"]


def job_extra(graph: dict, tool: str) -> dict:
    """Extra data till ComfyUI:s /prompt med en kort beskrivning av jobbet, som Darrowmeres kontrollpanel visar.
    COMFY_JOB_TITLE överstyr; annars verktygets namn och början av prompten."""
    title = os.environ.get("COMFY_JOB_TITLE")
    if not title:
        text = next((str(n["inputs"]["text"]) for n in graph.values()
                     if isinstance(n, dict) and isinstance(n.get("inputs", {}).get("text"), str) and n["inputs"]["text"].strip()), "")
        text = " ".join(text.split())
        title = f"{tool}: {text[:80]}{'…' if len(text) > 80 else ''}" if text else tool
    return {"extra_data": {"job_title": title, "job_tool": tool, "job_host": os.uname().nodename}}


def describe() -> str:
    """De provade målen som text, till felmeddelanden."""
    return ", ".join(f"{n} ({u})" for n, u in targets())
