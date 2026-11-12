"""Figurbeställningar: ett recept från beställningssidan (/character i Darrowmere-panelen) blir en runner-beställning.

  python3 -I tools/darrowmere/character_order.py plan '<recept>'
  python3 -I tools/darrowmere/character_order.py submit '<recept>' [front=bild.png back=bild2.png ...]

Receptets fält och standardvärden står i character/options.json. Kedjan är den som byggdes för trollkvinnorna och kusinen
(docs/character-generator.md): Krea-2-bilder med granskning (eller egna referenser), en modell (Pixal3D, Tripo eller
Meshy), UltraTex-projektion (eller modellens egen textur, eller Meshy), och sist finish_character.py på Darrowmere
(gradering, lösa bitar, ansiktsspegling, spelmodell). plan() svarar med stegen, kostnaden, varningarna, den färdiga
prompten och kamerorna för UltraTex-vyerna (förhandsvisningen). Svarar med en rad JSON.
"""
import copy
import json
import re
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import machine  # noqa: E402

OPTIONS = json.loads((HERE / "character" / "options.json").read_text())
GRAPHS = HERE / "character" / "graphs"
ROLES = ("front", "back", "left", "right", "detail")
# Minuter per steg, medianer ur Darrowmeres beställningar (2026-11-10)
MINUTES = {"krea": 5, "review": 1, "pixal3d": 11, "tripo": 4, "meshy": 5, "ultratex": 9, "ultratex_ring": 4, "ultratex_synced": 6, "bake": 1,
           "meshy_tex": 4, "finish": 4}


def graph(name):
    return json.loads((GRAPHS / f"{name}.json").read_text())


def get(d, path, default=None):
    for p in path.split("."):
        if not isinstance(d, dict) or p not in d:
            return default
        d = d[p]
    return d


def put(d, path, value):
    *head, last = path.split(".")
    for p in head:
        d = d.setdefault(p, {})
    d[last] = value


def defaults():
    r = {}
    for g in OPTIONS["groups"]:
        for f in g["fields"]:
            if "default" in f:
                put(r, f["id"], copy.deepcopy(f["default"]))
    r["source"]["refs"] = []
    return r


def merged(recipe):
    r = defaults()
    for k, v in OPTIONS.get("levels", {}).get(get(recipe, "level") or r.get("level"), {}).items():   # nivåns inställningar, sedan receptets egna
        put(r, k, copy.deepcopy(v))
    for g in OPTIONS["groups"]:
        for f in g["fields"]:
            v = get(recipe, f["id"])
            if v is not None:
                put(r, f["id"], v)
    if get(recipe, "finish.mirror_face") is None and r["source"]["mode"] == "prompt":
        # spegling som standard för grundkroppar; kläder och utrustning får vara osymmetriska (Patrik 2026-11-10)
        r["finish"]["mirror_face"] = r["prompt"].get("outfit_preset") != "custom"
    if r["prompt"].get("creature", "humanoid") != "humanoid" and r["source"]["mode"] == "prompt":
        # Animals and other creatures: no bald / brow / head-size / T-pose rules, no head pick, no face mirror
        # (a fantasy creature ordered 2026-11-11 came out as a humanoid because of them)
        for k, v in (("bald", False), ("no_brows", False), ("normal_head", False), ("pick_head", False), ("front", False)):
            if get(recipe, f"prompt.{k}") is None:
                r["prompt"][k] = v
        if get(recipe, "prompt.pose") is None:
            r["prompt"]["pose"] = "free"
        if get(recipe, "prompt.outfit_preset") is None:
            r["prompt"]["outfit_preset"], r["prompt"]["outfit"] = "custom", ""
        if get(recipe, "review.hard_face") is None:
            r["review"]["hard_face"] = False
        if get(recipe, "finish.mirror_face") is None:
            r["finish"]["mirror_face"] = False
    if r["prompt"].get("creature", "humanoid") != "humanoid" and get(recipe, "texture.ultratex.head_keep") is None:
        r["texture"]["ultratex"]["head_keep"] = 0.0   # the "head" band (top 20 % of the height) is a human idea
    for kind in ("style", "outfit"):   # äldre recept: egen text utan förval
        if (get(recipe, f"prompt.{kind}") or "").strip() and get(recipe, f"prompt.{kind}_preset") is None:
            r["prompt"][f"{kind}_preset"] = "custom"
    return r


def slug(s, n=32):
    return re.sub(r"[^a-z0-9]+", "-", (s or "").lower()).strip("-")[:n].strip("-")


def compose_prompt(p):
    """Motivet först och kort (så ritade Krea-2 skalliga figurer), sedan vy, kläder, pose, bakgrund och stil."""
    if (p.get("final") or "").strip():
        return p["final"].strip()
    subject = (p.get("subject") or "character").strip()
    if p.get("bald") and "bald" not in subject.lower():
        subject = "bald " + subject
    parts = [subject]
    creature = CREATURES.get(p.get("creature") or "humanoid")
    if creature:
        parts.append(creature["view"] + ", " + creature["cameras"].get(p.get("view") or "three_quarter", creature["cameras"]["three_quarter"]))
    if p.get("front"):
        parts.append("straight-on front view, body and face square to the camera, perfectly symmetrical")
    outfit = preset("outfit", p)
    if outfit and creature and re.fullmatch(r"\s*no\s+outfit\s*", outfit, re.I):
        outfit = ""
    if outfit:
        parts.append("wearing " + outfit)
    pose = {"t": "standing in a strict T-pose with both arms straight out horizontally, feet shoulder-width apart",
            "a": "standing in a symmetrical A-pose, arms angled down away from the body, feet shoulder-width apart"}.get(p.get("pose"))
    if pose:
        parts.append(pose)
    parts.append("against flat grey background")
    text = ", ".join(parts)
    if (p.get("body") or "").strip():
        text += ", " + p["body"].strip()
    if p.get("normal_head"):
        text += ", realistic adult proportions with a normal-sized head and normal-sized eyes"
    if p.get("no_brows"):    # positivt formulerat: Krea saknar negativ prompt
        text += ", smooth hairless brow ridges and bare eyelids"
    if creature and p.get("margin"):
        text += ", " + creature["margin"]
    elif p.get("margin") or p.get("pose") == "t":
        text += ", the whole figure small enough that the head, both hands, fingertips and feet are fully inside the frame with clear empty space around it"
    style = preset("style", p)
    if style:
        text += ", " + style
    return text


# Creature types other than humanoid: the view and framing Krea-2 is asked for, and what the review checks
CREATURES = {
    # Rest pose for rigging and mirroring: head in line with the spine (Squiggly 2026-11-12 tilted its head to one side).
    # Positive wording only in the prompt (Krea has no negative prompt); the "not turned" rule lives in the review criterion.
    "quadruped": {"view": "a four-legged animal standing in a neutral symmetrical rest pose on all four legs, legs straight under the "
                          "body, head held straight and level in line with the spine, facing the same way as the body, tail straight back",
                  "cameras": {"three_quarter": "seen in a three-quarter side view so all four legs, the head and the tail are clearly visible",
                              "front": "seen straight from the front at eye level, head and body square to the camera, perfectly symmetrical",
                              "side": "seen exactly from the side in profile at eye level, all four legs and the tail visible"},
                  "margin": "the whole animal small enough that its head, all four feet and the tail are fully inside the frame "
                            "with clear empty space around it",
                  "criterion": "One four-legged animal standing on all four legs, all four legs visible; not a humanoid, not standing upright on two legs. "
                               "Symmetrical rest pose: the head is straight and level in line with the body, not turned, tilted or "
                               "cocked to one side and not looking at the camera; legs not mid-stride."},
    "other": {"view": "a non-human creature shown full body in a neutral symmetrical rest pose, head held straight and level, "
                      "facing the same way as the body",
              "cameras": {"three_quarter": "seen in a three-quarter view",
                          "front": "seen straight from the front at eye level, square to the camera, perfectly symmetrical",
                          "side": "seen exactly from the side in profile at eye level"},
              "margin": "the whole creature small enough that it is fully inside the frame with clear empty space around it",
              "criterion": "One non-human creature shown full body; not a humanoid with human arms, hands and an upright human body. "
                           "Symmetrical rest pose: the head is straight and level in line with the body, not turned, tilted or "
                           "cocked to one side."},
}


def preset(kind, p):
    """Förval ur options.json (presets) eller egen text när förvalet är custom; äldre recept utan förval behåller sin text."""
    key = p.get(f"{kind}_preset")
    if key and key != "custom":
        return OPTIONS["presets"][kind][key]
    return (p.get(kind) or "").strip()


def image_size(p):
    """auto: kvadrat för T-pose (armspannet), stående format annars."""
    s = p.get("size") or "auto"
    if s == "auto":
        s = "1024x1024" if p.get("pose") == "t" else "832x1216"
    return tuple(map(int, s.split("x")))


def views(t):
    """UltraTex-kamerorna: sex basvyer och fyra per extra ring (azimut 0 = framifrån, 90 = höger sida)."""
    base = [{"name": n, "az": a, "el": e, "pass": 1, "used": True}
            for n, a, e in (("front", 0, 0), ("right", 90, 0), ("back", 180, 0), ("left", 270, 0), ("top", 0, 90), ("bottom", 0, -90))]
    use = {"all": [0, 1, 2, 3, 4, 5], "front only": [0], "back only": [2], "front + back": [0, 2], "no top/bottom": [0, 1, 2, 3]}[t["views_2_use"]]
    extra = []
    for i, ring in enumerate(t.get("rigs") or []):
        for j, (a, e) in enumerate(zip(ring["azimuths"], ring["elevations"])):
            extra.append({"name": f"ring {i + 1} · {j + 1}", "az": a, "el": e, "pass": 2, "ring": i + 1, "used": j in use})
    return base + extra


def check(r, refs):
    errs, warns = [], []
    mode = r["source"]["mode"]
    roles = [x["role"] for x in refs]
    if mode == "upload":
        if not refs:
            errs.append("Add at least one reference image.")
        elif "front" not in roles:
            errs.append("One reference image must be the front view.")
        if len(set(roles)) < len(roles):
            errs.append("Two images have the same view.")
    elif not (r["prompt"].get("subject") or r["prompt"].get("final") or "").strip():
        errs.append("Write a subject.")
    stop = mode == "prompt" and r["stop_after_images"]
    if not stop:
        eng, tex = r["model"]["engine"], r["texture"]["engine"]
        if eng == "pixal3d" and len(refs) > 1:
            warns.append("Pixal3D uses only the front image; the other views go to nothing but the order's inputs.")
        if eng == "meshy" and r["model"]["meshy"]["ai_model"] == "meshy-t2.5" and len(refs) > 1:
            errs.append("Meshy smart topology takes one image; pick another Meshy model or keep only the front view.")
        if tex == "ultratex":
            for i, ring in enumerate(r["texture"]["ultratex"].get("rigs") or []):
                if len(ring.get("azimuths", [])) != 4 or len(ring.get("elevations", [])) != 4:
                    errs.append(f"Ring {i + 1} needs exactly four views.")
            if not r["texture"]["ultratex"].get("mixes"):
                errs.append("Give at least one best-view mix.")
            if r["texture"]["ultratex"].get("method", "synced") == "synced":
                if eng != "pixal3d":
                    warns.append("Synced views start from the model's own colours, which only Pixal3D gives; this order uses the classic method.")
        if r["prompt"].get("pose") == "free" and mode == "prompt" and r["finish"]["mirror_face"]:
            warns.append("Mirroring the face works best in a symmetric pose.")
    if mode == "prompt" and r["prompt"]["pose"] == "t" and image_size(r["prompt"]) == (832, 1216):
        warns.append("A T-pose in portrait format cut off the hands before; use a square image.")
    return errs, warns


def krea_steps(r, asset, prompt):
    p = r["prompt"]
    w, h = image_size(p)
    out = []
    for i in range(int(p["count"])):
        g = graph("krea_t2i")
        g["4"]["inputs"]["text"] = prompt
        g["6"]["inputs"].update(width=w, height=h, batch_size=1)
        g["7"]["inputs"].update(seed=int(p["seed"]) + 11 * i, steps=8, cfg=1.0)
        g["9"]["inputs"]["filename_prefix"] = f"characters/{asset}/{asset}_ref_s{int(p['seed']) + 11 * i}"
        out.append({"key": f"img_{i + 1}", "label": f"Reference image {i + 1} (Krea-2, seed {int(p['seed']) + 11 * i})", "kind": "comfy", "graph": g})
    return out


def review_step(r):
    v, p = r["review"], r["prompt"]
    hard = []
    if p.get("bald"):
        hard.append("Completely bald: a smooth bald scalp with no hair at all on the head" + ("" if p.get("no_brows") else " (eyebrows are fine)") + ", no cap, no headwear.")
    if v.get("hard_face"):
        hard.append("Nothing on the face: no jewellery, face paint or markings; round human ears, not pointed elf ears.")
    if p.get("pose") == "t":
        hard.append("Strict symmetrical T-pose facing the viewer: both arms straight out horizontally at shoulder height, legs straight with feet about shoulder-width apart.")
    elif p.get("pose") == "a":
        hard.append("Symmetrical A-pose facing the viewer: arms angled down away from the body with a gap at the armpits, feet about shoulder-width apart.")
    if p.get("front"):
        hard.append("Straight-on front view: body and face square to the camera, not turned to either side.")
    avoid = [w.strip() for w in (v.get("avoid") or "").split(",") if w.strip()]
    if p.get("bald"):
        avoid += [w for w in ("hair", "hairstyle", "haircut") if w not in avoid]
    if p.get("no_brows"):
        avoid += [w for w in ("eyebrows", "eyelashes", "lashes", "brows") if w not in avoid]
    criteria = [c for c in v["criteria"] if c.strip()]
    if p.get("no_brows"):    # mjukt: Krea ritar ögonbryn ändå (sysslingen), ett hårt krav ger bara omritningar
        criteria.append("No eyebrows and no eyelashes: smooth bare brow ridges and bare eyelids.")
    if CREATURES.get(p.get("creature") or "humanoid"):
        crit = CREATURES[p["creature"]]["criterion"]
        if p.get("view") == "front":   # from the front the hind legs hide behind the front legs
            crit = crit.replace("all four legs visible", "front legs visible, hind legs may be hidden behind them")
            crit += " The camera looks straight at the front of the animal."
        elif p.get("view") == "side":   # in profile the far legs hide behind the near ones
            crit = crit.replace("all four legs visible", "near-side legs visible, far-side legs may be hidden behind them")
            crit += " The camera looks exactly at the side of the animal, in profile."
        hard.append(crit)
    if p.get("normal_head"):
        criteria.append("Head and eyes of normal adult size: the head about one seventh of the body height, not big-headed, chibi or cartoon-like.")
    s = {"key": "rev_1", "label": "Review: reference image", "kind": "review", "images": ["$step:img_1"],
         "criteria": criteria, "hard": hard, "min_score": int(v["min_score"]),
         "retry": {"step": "img_1", "max": int(v["max"]), "rewrite": bool(v["rewrite"])}}
    if p.get("bald") or p.get("no_brows") or v.get("hard_face"):
        s["crops"] = [{"name": "head", "box": [0.3, 0.0, 0.7, 0.18]}]
    if avoid and v["rewrite"]:
        s["rewrite_avoid"] = avoid
    return s


def pixal_step(r, asset, image, scale=1.0):
    q = r["model"]["pixal3d"]
    g = graph("pixal3d")
    g["122"]["inputs"]["image"] = image
    if scale < 0.999:  # Pixal3D ska ha 1024 px (1440 gav lösa strängar)
        g["900"] = {"class_type": "ImageScaleBy", "inputs": {"upscale_method": "lanczos", "scale_by": round(scale, 4), "image": ["122", 0]}}
        for k, n in g.items():
            if k != "900":
                for name, v in n["inputs"].items():
                    if v == ["122", 0]:
                        n["inputs"][name] = ["900", 0]
    seed = int(q["seed"])
    g["18"]["inputs"].update(seed=seed, cfg=float(q["cfg"]))
    g["23"]["inputs"].update(seed=seed, cfg=float(q["cfg"]))
    g["3"]["inputs"]["seed"] = seed + 14
    g["186"]["inputs"]["target_face_count"] = int(q["faces"])
    g["288"]["inputs"]["value"] = int(q["tex"])
    pre = f"characters/{asset}/{asset}_pixal3d"
    g["322"]["inputs"]["filename_prefix"] = pre                 # tät modell med egen PBR-textur (huvudfilen)
    g["323"]["inputs"]["filename_prefix"] = pre + "_vcol"       # samma nät, färg i hörnen
    g["246"]["inputs"]["filename_prefix"] = pre + "_voxel"      # grov voxelform
    return {"key": "mesh", "label": f"3D model (Pixal3D, seed {seed})", "kind": "comfy", "graph": g}, f"{asset}_pixal3d_0*.glb"


def lora_label(name):
    return name.replace("ultratex4b_", "").replace(".safetensors", "").replace("_", " ").replace(" ema", " EMA")


def ultratex_step(r, asset, ref, mesh_glob):
    t = r["texture"]["ultratex"]
    g = graph("ultratex")
    g["22"]["inputs"]["glb_path"] = f"$path:mesh/{mesh_glob}"
    g["19"]["inputs"]["image"] = ref
    g["2"]["inputs"].update(reference_alignment=t["alignment"])
    for k in ("4", "41"):
        g[k]["inputs"].update(steps=int(t["steps"]), guidance=float(t["guidance"]), seed=int(t["seed"]))
    g["7"]["inputs"]["lora_name"] = t["lora"]
    g["8"]["inputs"]["decoder_name"] = t["decoder"]
    g["26"]["inputs"]["filename_prefix"] = f"characters/{asset}/{asset}_ut4b_views"
    rings = t.get("rigs") or []
    if rings:
        g["40"]["inputs"].update(azimuths=",".join(str(a) for x in rings for a in x["azimuths"]),
                                 elevations=",".join(str(e) for x in rings for e in x["elevations"]))
        g["42"]["inputs"]["filename_prefix"] = f"characters/{asset}/{asset}_ut4b_views_2"
    else:
        for k in ("40", "41", "42"):
            g.pop(k)
    bake = g.pop("12")
    g.pop("13", None)
    for i, mix in enumerate(t["mixes"]):
        b = copy.deepcopy(bake)
        b["inputs"].update(texture_size=int(t["texture_size"]), view_weight_power=float(t["view_weight_power"]), best_view_mix=float(mix),
                           edge_feather_px=float(t["edge_feather_px"]), views_2_use=t["views_2_use"], views_2_weight=float(t["views_2_weight"]),
                           filename_prefix=f"characters/{asset}/{asset}_ut4b_mix{round(float(mix) * 100)}")
        if not rings:
            for k in ("prep_2", "albedo_views_2", "views_2_use", "views_2_weight"):
                b["inputs"].pop(k, None)
        g[str(500 + i)] = b
    label = f"Texture (UltraTex 4B {lora_label(t['lora'])}, 6 + {4 * len(rings)} views, {len(t['mixes'])} bake{'s' if len(t['mixes']) > 1 else ''})"
    return {"key": "texture", "label": label, "kind": "comfy", "graph": g}


def ultratex_synced_step(r, asset, ref, mesh_glob):
    """v6b (docs/ultratex-4b.md, "Synkade vyer"): the views start from the Pixal3D mesh's own colours (denoise < 1, head kept
    closer to the mesh's paint), are merged on a shared UV latent texture after every denoising step, then tone-matched and
    flow-aligned to the mesh colours before the bake. Six base views; extra rings are not used here."""
    t = r["texture"]["ultratex"]
    g = graph("ultratex_synced")
    glb = f"$path:mesh/{mesh_glob}"
    g["22"]["inputs"]["glb_path"] = glb
    g["300"]["inputs"].update(glb_path=glb, head_keep=float(t["head_keep"]), texture_size=int(t["texture_size"]))
    g["19"]["inputs"]["image"] = ref
    g["2"]["inputs"].update(reference_alignment=t["alignment"])
    g["4"]["inputs"].update(steps=int(t["steps"]), guidance=float(t["guidance"]), seed=int(t["seed"]), denoise=float(t["denoise"]),
                            sync_power=float(t["sync_power"]))
    g["7"]["inputs"]["lora_name"] = t["lora"]
    g["8"]["inputs"]["decoder_name"] = t["decoder"]
    g["26"]["inputs"]["filename_prefix"] = f"characters/{asset}/{asset}_ut4b_views"
    if float(t.get("mesh_detail", 1.0)) <= 0 and float(t.get("mesh_detail_head", 1.0)) <= 0:
        g.pop("320")   # no detail from the mesh: the views go straight from the tone match to the bake
        g["26"]["inputs"]["images"] = ["310", 0]
        g["501"]["inputs"]["albedo_views"] = ["310", 0]
    else:
        g["320"]["inputs"].update(sigma=float(t.get("mesh_detail_sigma", 8.0)), detail=float(t.get("mesh_detail", 1.0)),
                                  head_detail=float(t.get("mesh_detail_head", 1.0)))
    bake = g.pop("501")
    for i, mix in enumerate(t["mixes"]):
        b = copy.deepcopy(bake)
        b["inputs"].update(texture_size=int(t["texture_size"]), view_weight_power=float(t["view_weight_power"]), best_view_mix=float(mix),
                           edge_feather_px=float(t["edge_feather_px"]), detail_sharpness=float(t.get("detail_sharpness", 8)),
                           filename_prefix=f"characters/{asset}/{asset}_ut4b_mix{round(float(mix) * 100)}")
        g[str(500 + i)] = b
    label = (f"Texture (UltraTex 4B {lora_label(t['lora'])}, "
             f"synced views from the model's colours{', its fine detail' if '320' in g else ''}, {len(t['mixes'])} bake{'s' if len(t['mixes']) > 1 else ''})")
    return {"key": "texture", "label": label, "kind": "comfy", "graph": g}


def synced(r):
    """The synced method needs a mesh with its own colours, which only Pixal3D gives here."""
    return r["texture"]["ultratex"].get("method", "synced") == "synced" and r["model"]["engine"] == "pixal3d"


def finish_args(r, glb, name, textured):
    f = r["finish"]
    return {"glb": glb, "name": name, "gamma": float(f["gamma"]) if textured else 1.0, "clean": bool(f["clean"]),
            "mirror_face": bool(f["mirror_face"]) and textured, "game": bool(f["game"]), "tris": int(f["tris"]),
            "tex": int(f["tex"]), "voxel": float(f["voxel"]), "quad": bool(f.get("quad"))}


def build(recipe, refs=None, now=None):
    """Receptet → (beställning, plan). refs: [{"name": "front.png", "role": "front", "w": 1600, "h": 1600}] (filerna läggs till vid submit)."""
    r = merged(recipe)
    refs = refs if refs is not None else (r["source"].get("refs") or [])
    errs, warns = check(r, refs)
    mode = r["source"]["mode"]
    prompt = compose_prompt(r["prompt"]) if mode == "prompt" else None
    asset = slug(r.get("name")) or slug(r["prompt"].get("subject") if mode == "prompt" else "character") or "character"
    stamp = time.strftime("%m%d-%H%M", time.localtime(now))
    oid = f"{asset}-{stamp}"
    title = r.get("title") or (f"{asset.replace('-', ' ').title()}: " + (r["prompt"]["subject"] if mode == "prompt" else "from my references"))
    steps, plan, credits = [], [], {"tripo": 0, "meshy": 0}

    def add(step, where, minutes, cost=None):
        steps.append(step)
        plan.append({"key": step["key"], "label": step["label"], "where": where, "minutes": minutes, **({"credits": cost} if cost else {})})

    lane = "FIRST FREE GPU" if r["gpu"] == "auto" else r["gpu"].upper()
    by_role = {x["role"]: x for x in refs}
    picked = False
    if mode == "prompt":
        imgs = krea_steps(r, asset, prompt)
        # Several images: all of them first, then the one with the most natural head size goes on (pick_reference.py),
        # so a big-headed image 1 no longer becomes the model (Cassandra 2026-11-10)
        picked = len(imgs) > 1 and bool(r["prompt"].get("pick_head", True))
        for s in (imgs if picked else imgs[:1]):
            add(s, lane, MINUTES["krea"])
        front = "$step:img_1"
        if picked:
            add({"key": "pick", "label": "Pick the reference with a natural head size", "kind": "script", "script": "pick_reference.py",
                 "args": {"images": [f"$step:{s['key']}" for s in imgs], "name": asset, "min_heads": float(r["prompt"].get("min_heads", 7.3))}},
                "Darrowmere CPU", 1)
            front = "$step:pick"
        if r["review"]["enabled"]:
            rv = review_step(r)
            if picked:   # judge the picked image; a redraw makes every image again with new seeds and picks again
                rv["images"] = [front]
                rv["retry"]["also"] = [s["key"] for s in imgs[1:]] + ["pick"]
            add(rv, "Claude Haiku", MINUTES["review"])
            plan[-1]["note"] = f"up to {rv['retry']['max']} redraws"
        front_ref, front_px = front, 1024 / max(image_size(r["prompt"]))
        views_in = {"front": front}
    else:
        front_ref, front_px = "$in:front.png", 1.0
        views_in = {role: f"$in:{role}.png" for role in by_role if role in ("front", "back", "left", "right")}
        imgs = []
    stop = mode == "prompt" and r["stop_after_images"]
    mesh_glob = None
    if not stop and not errs:
        eng = r["model"]["engine"]
        if eng == "pixal3d":
            src = front_ref if mode == "prompt" else "$in:front_1024.png"
            st, mesh_glob = pixal_step(r, asset, src, front_px)
            if r["gpu"] in ("auto", "m4000"):   # Pixal3D runs on the T1000 (it failed on the M4000)
                st["gpu"] = "t1000"
            add(st, "T1000", MINUTES["pixal3d"])
        elif eng.startswith("tripo"):
            tex_own = r["texture"]["engine"] == "model"
            cost = (100 if eng == "tripo-p2" else (50 if tex_own else 40)) + (10 if tex_own else 0)
            add({"key": "mesh", "label": f"3D model (Tripo {eng[-2:].upper()}, {len(views_in)} view{'s' if len(views_in) > 1 else ''})", "kind": "model",
                 "force": "cloud", "cloud": {"model": eng, "texture": tex_own, "face_limit": int(r["model"]["tripo"]["face_limit"]), "views": views_in}},
                "Tripo (cloud)", MINUTES["tripo"], cost)
            credits["tripo"] += cost
            mesh_glob = "*.glb"
        else:
            m = r["model"]["meshy"]
            tex_own = r["texture"]["engine"] == "model"
            params = {"ai_model": m["ai_model"], "should_texture": tex_own, "enable_pbr": tex_own, "target_polycount": int(m["target_polycount"]),
                      "should_remesh": True, "topology": "triangle"}
            if m.get("pose_mode"):
                params["pose_mode"] = m["pose_mode"]
            cost = (5 if m["ai_model"] in ("meshy-6-lite", "meshy-t2", "meshy-t2.5") else 20) + (10 if tex_own else 0)
            add({"key": "mesh", "label": f"3D model (Meshy {m['ai_model']}, {len(views_in)} view{'s' if len(views_in) > 1 else ''})", "kind": "meshy3d",
                 "params": params, "images": list(views_in.values())}, "Meshy (cloud)", MINUTES["meshy"], cost)
            credits["meshy"] += cost
            mesh_glob = "*.glb"
        tex = r["texture"]["engine"]
        textured = tex != "none"
        if tex == "ultratex":
            t = r["texture"]["ultratex"]
            if synced(r):
                add(ultratex_synced_step(r, asset, front_ref, mesh_glob), lane, MINUTES["ultratex_synced"] + MINUTES["bake"] * len(t["mixes"]))
            else:
                st = ultratex_step(r, asset, front_ref, mesh_glob)
                add(st, lane, MINUTES["ultratex"] + MINUTES["ultratex_ring"] * len(t.get("rigs") or []) + MINUTES["bake"] * len(t["mixes"]))
            finals = [(f"$step:texture/{asset}_ut4b_mix{round(float(x) * 100)}_*.glb", f"{asset}_ut4b_mix{round(float(x) * 100)}") for x in t["mixes"]]
        elif tex == "meshy":
            cost = 15 if r["texture"]["meshy"]["resolution"] == "8k" else 10
            add({"key": "texture", "label": f"Texture (Meshy retexture {r['texture']['meshy']['resolution'].upper()})", "kind": "texture", "force": "cloud",
                 "cloud": {"provider": "meshy", "mesh": "$step:mesh", "resolution": r["texture"]["meshy"]["resolution"], "keep_uv": True,
                           "views": [v for v in views_in.values()][:4]}}, "Meshy (cloud)", MINUTES["meshy_tex"], cost)
            credits["meshy"] += cost
            finals = [("$step:texture/*.glb", f"{asset}_meshy_tex")]
        else:
            finals = [(f"$step:mesh/{mesh_glob}", f"{asset}_model")]
        f = r["finish"]
        if f["clean"] or f["game"] or (textured and (f["mirror_face"] or abs(float(f["gamma"]) - 1) > 1e-3)):
            for i, (glb, name) in enumerate(finals):
                add({"key": f"finish_{i + 1}" if len(finals) > 1 else "finish", "label": f"Finish {name}: " + ", ".join(
                    x for x, on in (("colour", textured and abs(float(f["gamma"]) - 1) > 1e-3), ("loose bits", f["clean"]),
                                    ("face mirror", textured and f["mirror_face"]), (f"game model {int(f['tris']) // 1000}k" + (" quads" if f.get("quad") else ""), f["game"])) if on),
                     "kind": "script", "script": "finish_character.py", "args": finish_args(r, glb, name, textured)}, "Darrowmere CPU", MINUTES["finish"])
    for s in ([] if picked else imgs[1:]):
        add(s, lane, MINUTES["krea"])
    inputs = {}
    if mode == "upload":
        for x in refs:
            inputs[f"{x['role']}.png"] = x["role"]
        if "front" in by_role:
            inputs["front_1024.png"] = "front_1024"
    order = {"id": oid, "title": title, "project": "asset-studio", "asset": asset, "use": "test-only", "gpu": r["gpu"],
             "mission": asset, "mission_title": title, "steps": steps, "recipe": r}
    t = r["texture"]["ultratex"]
    plan_out = {"ok": not errs, "errors": errs, "warnings": warns, "id": oid, "title": title, "asset": asset, "prompt": prompt,
                "steps": plan, "minutes": sum(p["minutes"] for p in plan), "credits": {k: v for k, v in credits.items() if v},
                "views": views({**t, "rigs": []} if synced(r) else t) if (not stop and r["texture"]["engine"] == "ultratex") else [],
                "pose": r["prompt"]["pose"] if mode == "prompt" else "t", "inputs": inputs,
                "gallery": f"characters/{asset}"}
    return order, plan_out


def plan(recipe, refs=None):
    return build(recipe, refs)[1]


def submit(recipe, files, ssh_run, now=None):
    """files: {"front": bytes, ...} (PNG). ssh_run(cmd_list, stdin_bytes) kör på Darrowmere. Lägger indata och beställningen i inkorgen."""
    import base64
    w = machine.wake()   # the worker may be asleep (runner auto-suspend): Wake-on-LAN first
    if not w["awake"]:
        return {"ok": False, "error": w.get("error") or "the worker is asleep and did not wake"}
    refs = [{"name": f"{role}.png", "role": role} for role in files if role != "front_1024"]
    order, pl = build(recipe, refs, now)
    if pl["errors"]:
        return {"ok": False, "error": " ".join(pl["errors"]), "plan": pl}
    order["submitted"] = {"t": time.time(), "from": "character order page"}
    payload = {"id": order["id"], "order": order,
               "files": {name: base64.b64encode(files[key]).decode() for name, key in pl["inputs"].items()}}
    code = ("import base64,json,os,sys; d=json.load(sys.stdin); o='/data/orders/'+d['id']; os.makedirs(o+'/in',exist_ok=True); "
            "os.makedirs('/data/orders/inbox',exist_ok=True)\n"
            "for n,b in d['files'].items(): open(o+'/in/'+os.path.basename(n),'wb').write(base64.b64decode(b))\n"
            "t='/data/orders/inbox/.'+d['id']+'.tmp'; json.dump(d['order'],open(t,'w')); os.replace(t,'/data/orders/inbox/'+d['id']+'.json'); print('ok')")
    out = ssh_run(["python3", "-c", code], json.dumps(payload).encode())
    if "ok" not in out:
        return {"ok": False, "error": out[-300:] or "Darrowmere did not take the order", "plan": pl}
    return {"ok": True, "id": order["id"], "plan": pl}


def _cli_ssh(cmd, data):
    import shlex, subprocess
    r = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", machine.ssh_target(), shlex.join(cmd)],
                       input=data, capture_output=True, timeout=180)
    return (r.stdout + r.stderr).decode(errors="replace")


if __name__ == "__main__":
    a = sys.argv[1:]
    try:
        rec = json.loads(a[1]) if len(a) > 1 else {}
        if a[0] == "plan":
            res = plan(rec, [{"name": x.split("=")[1], "role": x.split("=")[0]} for x in a[2:]] or None)
            res = {k: v for k, v in res.items() if k != "views"} | {"views": len(res["views"])}
        else:
            import io
            from PIL import Image
            files = {}
            for x in a[2:]:
                role, path = x.split("=", 1)
                files[role] = Path(path).read_bytes()
                if role == "front":
                    im = Image.open(path).convert("RGB")
                    im.thumbnail((1024, 1024), Image.LANCZOS)
                    buf = io.BytesIO(); im.save(buf, "PNG"); files["front_1024"] = buf.getvalue()
            res = submit(rec, files, _cli_ssh)
    except Exception as e:
        res = {"ok": False, "error": str(e)[-300:]}
    print(json.dumps(res, ensure_ascii=False))
