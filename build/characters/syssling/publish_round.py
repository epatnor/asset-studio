"""Sysslingens MPFB-omgångar i Darrowmere-galleriet: ett kort (beställningen syssling-mpfb) med ett steg per omgång.
Filerna läggs i /data/utdata/orders/syssling-mpfb/<omgång>/ och stegets anteckning i /data/utdata/pipelines/syssling-mpfb.json.
En modells förhandsbild är <stem>_render_a.png i samma mapp (här lerjämförelsen: Pixal3D | förra | denna).

  python3 -I build/characters/syssling/publish_round.py '{"key": "r9", "label": "...", "note": "...",
      "files": {"<lokal fil>": "<namn i galleriet>"}}'
"""
import json, subprocess, sys, time

HOST = "epatnor@192.168.0.33"
OID = "syssling-mpfb"
SSH = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", HOST]


def main():
    r = json.loads(sys.argv[1])
    dest = f"/data/utdata/orders/{OID}/{r['key']}"
    subprocess.run(SSH + [f"mkdir -p {dest}"], check=True)
    for src, name in r["files"].items():
        subprocess.run(["scp", "-q", src, f"{HOST}:{dest}/{name}"], check=True)
    plan_path = f"/data/utdata/pipelines/{OID}.json"
    got = subprocess.run(SSH + [f"cat {plan_path} 2>/dev/null"], capture_output=True, text=True).stdout
    plan = json.loads(got) if got.strip() else {"id": OID, "title": "Sysslingen: MPFB body fitted to Pixal3D", "asset": "syssling",
                                                "mission": "syssling-mpfb", "mission_title": "Sysslingen: MPFB base body",
                                                "project": "asset-studio", "use": "test-only", "created": time.time(), "steps": []}
    plan["steps"] = [s for s in plan["steps"] if s["key"] != r["key"]] + [
        {"key": r["key"], "label": r["label"], "kind": "script", "status": "done", "note": r.get("note", ""),
         "files": list(r["files"].values()), "end": time.time()}]
    plan["steps"].sort(key=lambda s: s["key"])
    plan["updated"] = time.time(); plan["order_status"] = "done"
    subprocess.run(SSH + [f"mkdir -p /data/utdata/pipelines && cat > {plan_path}.tmp && mv {plan_path}.tmp {plan_path}"],
                   input=json.dumps(plan, ensure_ascii=False), text=True, check=True)
    print(json.dumps({"ok": True, "order": OID, "step": r["key"], "files": list(r["files"].values())}))


if __name__ == "__main__":
    main()
