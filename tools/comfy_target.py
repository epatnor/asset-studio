"""Väljer vilken ComfyUI verktygen skickar jobb till.

Målen står i tools/comfy.json. Utan inställning provas de i ordning ("order") och det första som svarar
används: laptopens egen ComfyUI om den är igång, annars Darrowmere. COMFY_TARGET=darrowmere (eller local)
väljer ett mål, COMFY_URL=http://... en exakt adress.

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
    names = [want] if want else conf["order"]
    return [(n, conf["targets"][n].rstrip("/")) for n in names if n in conf["targets"]]


def comfy_url() -> str | None:
    """Adressen till den första ComfyUI som svarar, eller None om ingen gör det."""
    if "url" not in _cache:
        _cache["url"] = next((url for _, url in targets() if _up(url)), None)
    return _cache["url"]


def describe() -> str:
    """De provade målen som text, till felmeddelanden."""
    return ", ".join(f"{n} ({u})" for n, u in targets())
