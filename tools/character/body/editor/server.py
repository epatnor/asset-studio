"""Editorn för kroppen: en liten lokal server. Patrik drar i nätet, och ändringarna sparas som data som bygget läser.

  .venv/bin/python tools/editor/server.py [port] [namn]

Nätet med sina polygoner ligger i build/fit/<namn>_mesh.json. Ändringarna och vad som gjorts ligger i
build/fit/<namn>_edits.json (per hörn i mallen, plus en logg över operationerna), med en kopia per sparning i build/edits/.
Varje sparning bygger en ny robot med tools/editor/build_mesh.py. Inga befintliga modeller skrivs över."""
import http.server
import json
import shutil
import subprocess
import sys
import time
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]   # asset-studio
HERE = ROOT / "build/body"                    # body-gens arbetsyta: build/, out/, images/ (flyttad 2026-11-10)
TOOLS = Path(__file__).resolve().parents[1]
SPEL = ROOT.parents[1]                        # ~/Spelutveckling (img2mesh, lowpoly-test)
PAGE = Path(__file__).resolve().parent / "index.html"
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8772
NAME = sys.argv[2] if len(sys.argv) > 2 else "yvonne"
RECIPE = {"name": NAME, "head": str(SPEL / "lowpoly-test/output/yvonne/p1_texture_mv.glb"), "out": f"out/{NAME}_robot.glb"}
MODEL = HERE / f"build/editor/{NAME}.json"
EDITS = HERE / f"build/fit/{NAME}_edits.json"
MESH = HERE / f"build/fit/{NAME}_mesh.json"
VERSIONS = HERE / "build/versions"
REFS = HERE / "build/editor/refs"
SLOTS = ("front", "back", "left", "right", "top", "bottom")
TARGET = HERE / f"build/editor/{NAME}_target.json"
TARGET_TRIANGLES = 40000


def reference_settings():
    """Referensbilderna per vy. Första gången kopieras personens fyra vyer in som start."""
    settings = REFS / f"{NAME}.json"
    if settings.exists():
        return json.loads(settings.read_text())
    REFS.mkdir(parents=True, exist_ok=True)
    for slot in ("front", "left", "back", "right"):
        source = SPEL / "lowpoly-test/input" / NAME / f"{slot}.png"
        if source.exists() and not (REFS / f"{NAME}_{slot}.png").exists():
            shutil.copy(source, REFS / f"{NAME}_{slot}.png")
    return {slot: {} for slot in SLOTS if (REFS / f"{NAME}_{slot}.png").exists()}


def run_robot(**extra):
    done = subprocess.run([sys.executable, str(TOOLS / "make_robot.py"), json.dumps({**RECIPE, **extra})], cwd=HERE, capture_output=True, text=True)
    if done.returncode:
        raise RuntimeError(done.stderr[-800:])
    return json.loads(done.stdout.strip().splitlines()[-1])


def target_mesh():
    """Den täta ytan, förenklad så att den kan visas som en genomskinlig jämförelse."""
    if not TARGET.exists():
        import numpy as np
        import open3d as o3d
        import trimesh
        dense = trimesh.load(HERE / f"build/fit/{NAME}_ai.glb", force="scene").to_geometry()
        mesh = o3d.geometry.TriangleMesh(o3d.utility.Vector3dVector(np.asarray(dense.vertices)), o3d.utility.Vector3iVector(np.asarray(dense.faces)))
        small = mesh.simplify_quadric_decimation(TARGET_TRIANGLES)
        TARGET.write_text(json.dumps({"positions": np.round(np.asarray(small.vertices), 4).ravel().tolist(), "faces": np.asarray(small.triangles).ravel().tolist()}))
    return TARGET.read_text()


def summary(edits):
    """Hur mycket som ändrats per del, i mm, så att skriptet och Claude kan läsa det utan att titta på nätet."""
    parts = {}
    for key, delta in edits.get("vertices", {}).items():
        part = key.split("|")[0]
        size = sum(value * value for value in delta) ** 0.5 * 1000
        count, largest = parts.get(part, (0, 0.0))
        parts[part] = (count + 1, max(largest, size))
    return {part: {"verts": count, "max_mm": round(largest, 1)} for part, (count, largest) in sorted(parts.items())}


class Handler(http.server.BaseHTTPRequestHandler):
    def reply(self, body, kind="application/json", status=200):
        data = body.encode() if isinstance(body, str) else body
        self.send_response(status)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(url.query)
        if url.path == "/api/versions":
            found = sorted(VERSIONS.glob(f"{NAME}_*.json"), key=lambda path: path.stat().st_mtime, reverse=True) if VERSIONS.exists() else []
            self.reply(json.dumps([{"name": path.stem, "time": time.strftime("%H:%M", time.localtime(path.stat().st_mtime))} for path in found]))
        elif url.path == "/api/version":
            # Bara namn som finns i listan, så att sökvägar utifrån inte kan läsas.
            wanted = query.get("name", [""])[0]
            names = {path.stem: path for path in VERSIONS.glob(f"{NAME}_*.json")} if VERSIONS.exists() else {}
            if wanted not in names:
                return self.reply(json.dumps({"error": "no such version"}), status=404)
            self.reply(names[wanted].read_bytes())
        elif url.path == "/api/refs":
            self.reply(json.dumps(reference_settings()))
        elif url.path == "/ref":
            slot = query.get("slot", [""])[0]
            image = REFS / f"{NAME}_{slot}.png"
            if slot not in SLOTS or not image.exists():
                return self.reply(json.dumps({"error": "no image"}), status=404)
            self.reply(image.read_bytes(), "image/png")
        elif self.path == "/":
            self.reply(PAGE.read_bytes(), "text/html; charset=utf-8")
        elif self.path == "/api/model":
            self.reply(MODEL.read_bytes())
        elif self.path == "/api/edits":
            self.reply(EDITS.read_bytes() if EDITS.exists() else b"{}")
        elif self.path == "/api/mesh":
            self.reply(MESH.read_bytes() if MESH.exists() else b"{}")
        elif self.path == "/api/target":
            self.reply(target_mesh())
        else:
            self.reply(json.dumps({"error": "not found"}), status=404)

    def do_POST(self):
        url = urllib.parse.urlparse(self.path)
        if url.path == "/api/import":
            file_name = urllib.parse.unquote(self.headers.get("X-File-Name", "model.glb"))
            data = self.rfile.read(int(self.headers["Content-Length"]))
            try:
                sys.path.insert(0, str(PAGE.parent))
                from import_glb import import_glb
                return self.reply(json.dumps(import_glb(data, file_name, VERSIONS, json.loads(MODEL.read_text()))))
            except Exception as error:
                return self.reply(json.dumps({"error": f"Could not read {file_name}: {error}"}), status=400)
        if url.path == "/api/refs":
            REFS.mkdir(parents=True, exist_ok=True)
            (REFS / f"{NAME}.json").write_text(self.rfile.read(int(self.headers["Content-Length"])).decode())
            return self.reply(json.dumps({"ok": True}))
        if url.path == "/api/ref_image":
            slot = urllib.parse.parse_qs(url.query).get("slot", [""])[0]
            if slot not in SLOTS:
                return self.reply(json.dumps({"error": "unknown slot"}), status=400)
            # Webbläsaren har redan ritat bilden som PNG.
            REFS.mkdir(parents=True, exist_ok=True)
            (REFS / f"{NAME}_{slot}.png").write_bytes(self.rfile.read(int(self.headers["Content-Length"])))
            return self.reply(json.dumps({"ok": True}))
        if self.path != "/api/save":
            return self.reply(json.dumps({"error": "not found"}), status=404)
        payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        mesh, edits = payload["mesh"], payload["edits"]
        MESH.write_text(json.dumps(mesh))
        EDITS.write_text(json.dumps(edits, indent=1))
        history = HERE / "build/edits"
        history.mkdir(parents=True, exist_ok=True)
        (history / f"{NAME}_{time.strftime('%Y%m%d_%H%M%S')}.json").write_text(json.dumps(edits, indent=1))
        shading = "faceted" if payload.get("shading") == "faceted" else "smooth"
        done = subprocess.run([sys.executable, str(TOOLS / "editor/build_mesh.py"), NAME, shading], cwd=HERE, capture_output=True, text=True)
        if done.returncode:
            return self.reply(json.dumps({"error": done.stderr[-800:]}), status=500)
        built = json.loads(done.stdout.strip().splitlines()[-1])
        VERSIONS.mkdir(parents=True, exist_ok=True)
        (VERSIONS / f"{Path(built['out']).stem}.json").write_text(json.dumps({"mesh": mesh, "edits": edits}))
        self.reply(json.dumps({**built, "summary": summary(edits), "notes": len(edits.get("notes", [])), "operations": len(edits.get("operations", []))}))

    def log_message(self, *args):
        pass


if not MODEL.exists():
    run_robot(data_only=True)
print(f"Body Editor on http://127.0.0.1:{PORT}", flush=True)
http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
