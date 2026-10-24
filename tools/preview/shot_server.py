"""Lokal visningsserver som också tar emot skärmdumpar från klienten.

  python3 -I tools/preview/shot_server.py [port]

Serverar projektroten (som `python3 -m http.server`). POST /__shot?name=<namn> med en PNG i kroppen sparas
som build/shots/<namn>.png, så att bilder renderade med klientens riktiga shaders kan läggas på
Apparition-tavlan eller i kontaktark. Bara för lokal utveckling: lyssnar på 127.0.0.1.
"""
import http.server
import json
import re
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parents[2]
SHOTS = ROOT / "build" / "shots"


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def do_POST(self):
        url = urlparse(self.path)
        name = parse_qs(url.query).get("name", [""])[0]
        if url.path != "/__shot" or not re.fullmatch(r"[A-Za-z0-9_\-]{1,64}", name):
            self.send_error(400, "POST /__shot?name=<a-z0-9_->")
            return
        data = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        SHOTS.mkdir(parents=True, exist_ok=True)
        out = SHOTS / f"{name}.png"
        out.write_bytes(data)
        body = json.dumps({"out": str(out.relative_to(ROOT)), "bytes": len(data)}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8766
    http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
