"""Väljer vilken ComfyUI verktygen skickar jobb till.

Målen står i tools/comfy.json. Utan inställning provas de i ordning ("order") och det första som svarar
används: Darrowmere som standard, annars laptopens egen ComfyUI. Asset Studios jobbknapp sparar ett val i
build/studio/jobs.json ({"target": "local"}), som då provas först (så att RTX 4070 kan arbeta samtidigt som
Darrowmere). COMFY_TARGET=darrowmere (eller local) väljer bara det målet, COMFY_URL=http://... en exakt adress.

Verktygen körs med python3 -I, så de lägger själva till tools/ i sys.path innan de importerar modulen.
"""
import json
import os
import urllib.request
from pathlib import Path

CONF = Path(__file__).with_name("comfy.json")
CHOICE = Path(__file__).resolve().parents[1] / "build/studio/jobs.json"   # studions val, per dator
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
    if not want:
        try:
            first = json.loads(CHOICE.read_text()).get("target")
        except Exception:
            first = None
        if first in conf["targets"]:
            names = [first] + [n for n in names if n != first]
    return [(n, conf["targets"][n].rstrip("/")) for n in names if n in conf["targets"]]


def comfy_url() -> str | None:
    """Adressen till den första ComfyUI som svarar, eller None om ingen gör det."""
    if "url" not in _cache:
        _cache["url"] = next((url for _, url in targets() if _up(url)), None)
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
