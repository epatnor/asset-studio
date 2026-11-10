"""Texturbeställning för sysslingens MPFB-kropp: UltraTex (Best-nivån) direkt på det inpassade grundnätet, med Krea-referensen
som framvy (argument: GLB och namn, standard syssling_fit). Ingen modellering; efterbehandlingen utan spelmodell (nätet är redan lågpoly med rigg) och utan städning (ögonen
är egna små delar). Kör: python3 -I build/characters/syssling/texture_mpfb_order.py"""
import base64, json, sys, time
from pathlib import Path
ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tools/darrowmere"))
import character_order as c

GLB = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "assets/characters/syssling_fit/syssling_fit.glb"
NAME = sys.argv[2] if len(sys.argv) > 2 else "syssling_mpfb"
recipe = {"name": NAME, "title": f"Sysslingen: UltraTex on the MPFB body ({GLB.stem})", "level": "best", "source": {"mode": "upload"},
          "finish": {"game": False, "clean": False, "mirror_face": True, "gamma": 1.3}}
order, plan = c.build(recipe, refs=[{"name": "front.png", "role": "front", "w": 832, "h": 1216}])
assert not plan["errors"], plan["errors"]
order["steps"] = [s for s in order["steps"] if s["key"] != "mesh"]
tex = next(s for s in order["steps"] if s["key"] == "texture")
tex["graph"]["22"]["inputs"]["glb_path"] = f"/data/orders/{order['id']}/in/{GLB.name}"
left = [v for n in tex["graph"].values() for v in n["inputs"].values() if isinstance(v, str) and v.startswith("$") and "mesh" in v]
assert not left, left
order["submitted"] = {"t": time.time(), "from": "texture_mpfb_order.py"}
files = {"front.png": (ROOT / "build/characters/syssling/syssling_ref_s11_00001_.png").read_bytes(),
         GLB.name: GLB.read_bytes()}
payload = {"id": order["id"], "order": order, "files": {n: base64.b64encode(b).decode() for n, b in files.items()}}
code = ("import base64,json,os,sys; d=json.load(sys.stdin); o='/data/orders/'+d['id']; os.makedirs(o+'/in',exist_ok=True)\n"
        "for n,b in d['files'].items(): open(o+'/in/'+os.path.basename(n),'wb').write(base64.b64decode(b))\n"
        "t='/data/orders/inbox/.'+d['id']+'.tmp'; json.dump(d['order'],open(t,'w')); os.replace(t,'/data/orders/inbox/'+d['id']+'.json'); print('ok')")
out = c._cli_ssh(["python3", "-c", code], json.dumps(payload).encode())
print(json.dumps({"ok": "ok" in out, "id": order["id"], "steps": [s["key"] for s in order["steps"]], "out": out[-200:]}))
