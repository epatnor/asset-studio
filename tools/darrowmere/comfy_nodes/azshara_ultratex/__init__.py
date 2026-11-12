"""Azshara UltraTex helpers (Darrowmere ComfyUI).

UltraTex Init From Mesh Colours: renders an already coloured mesh (Pixal3D's own texture, same file and frame as the
mesh UltraTex textures) from the 6 cameras of an UltraTex prep, as init_views for UltraTexSampler. With denoise below 1
every view starts from the same consistent painting, so features such as the eyebrows land in the same place in every
view instead of each view guessing from noise (the jumps between views in the bake, 2026-11-10).

Uses ComfyUI-UltraTex's own Baker, looked up at run time so that this pack does not depend on load order.
"""
import sys

import numpy as np
import torch


def _ultratex(name):
    for k, m in sys.modules.items():
        if k.endswith("ultratex_core." + name):
            return m
    raise RuntimeError(f"ComfyUI-UltraTex is not loaded (ultratex_core.{name})")


def _vertex_colours(mesh):
    """sRGB 0..1 colour per vertex: vertex colours, or the base colour texture sampled at each vertex's UV."""
    vis = mesh.visual
    if getattr(vis, "kind", None) == "vertex" and getattr(vis, "vertex_colors", None) is not None:
        return np.asarray(vis.vertex_colors, np.float64)[:, :3] / 255.0
    uv = getattr(vis, "uv", None)
    mat = getattr(vis, "material", None)
    img = getattr(mat, "baseColorTexture", None) or getattr(mat, "image", None)
    if uv is None or img is None:
        raise RuntimeError("the mesh has neither vertex colours nor a base colour texture")
    tex = np.asarray(img.convert("RGB"), np.float64) / 255.0
    h, w = tex.shape[:2]
    x = np.clip(np.asarray(uv)[:, 0] % 1.0 * (w - 1), 0, w - 1)
    y = np.clip((1 - np.asarray(uv)[:, 1] % 1.0) * (h - 1), 0, h - 1)
    x0, y0 = np.floor(x).astype(int), np.floor(y).astype(int)
    x1, y1 = np.minimum(x0 + 1, w - 1), np.minimum(y0 + 1, h - 1)
    fx, fy = (x - x0)[:, None], (y - y0)[:, None]
    return (tex[y0, x0] * (1 - fx) * (1 - fy) + tex[y0, x1] * fx * (1 - fy) + tex[y1, x0] * (1 - fx) * fy + tex[y1, x1] * fx * fy)


class UltraTexInitFromMeshColours:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "prep": ("ULTRATEX_PREP", {"tooltip": "The UltraTex prep of the mesh being textured."}),
            "glb_path": ("STRING", {"default": "", "tooltip": "The coloured mesh (same file or same frame as the textured mesh)."}),
            "resolution": ("INT", {"default": 1024, "min": 256, "max": 4096, "step": 16, "tooltip": "The sampler's resolution."}),
            "texture_size": ("INT", {"default": 2048, "min": 512, "max": 4096, "step": 256, "tooltip": "Size of the intermediate atlas."}),
        }, "optional": {
            "colour": (["compensate", "as_is"], {"default": "compensate", "tooltip": "compensate: lift the colours by the inverse of the darkening in UltraTex's encode/decode; as_is: the mesh colours unchanged."}),
            "lift": ("FLOAT", {"default": 1.7, "min": 1.0, "max": 3.0, "step": 0.05, "tooltip": "Exponent of the lift (colour ** (1 / lift)): 1 = none; the darkening measured on the man needs about 1.7."}),
            "head_from": ("FLOAT", {"default": 0.80, "min": 0.5, "max": 1.0, "step": 0.01, "tooltip": "keep_mask: the head and neck from this share of the figure's height (0.80 is just below the collar of an adult)."}),
            "head_feather": ("FLOAT", {"default": 0.03, "min": 0.0, "max": 0.2, "step": 0.005, "tooltip": "keep_mask: soft edge, as a share of the height."}),
            "head_keep": ("FLOAT", {"default": 0.6, "min": 0.0, "max": 1.0, "step": 0.05, "tooltip": "keep_mask value on the head (1 = the mesh's own paint exactly, 0 = repaint freely); the body is 0."}),
        }}

    RETURN_TYPES = ("IMAGE", "IMAGE", "MASK", "MASK")
    RETURN_NAMES = ("init_views", "colour_views", "cover", "head_keep")
    FUNCTION = "render"
    CATEGORY = "UltraTex"

    def render(self, prep, glb_path, resolution, texture_size, colour="compensate", lift=1.7, head_from=0.80, head_feather=0.03, head_keep=0.6):
        import trimesh
        from scipy.spatial import cKDTree
        bake = _ultratex("bake")
        src = trimesh.load(glb_path, force="mesh")
        col = _vertex_colours(src)
        pos = (np.asarray(src.vertices, np.float64) - np.asarray(prep.centre)) * float(prep.scale)   # into the prep's frame
        baker = bake.Baker(prep, texture_size)
        try:
            d, idx = cKDTree(pos).query(baker.texel_pos, k=4)
            w = 1.0 / np.maximum(d, 1e-6)
            tex = np.zeros((texture_size, texture_size, 3))
            tex[baker.cover] = (col[idx] * w[..., None]).sum(1) / w.sum(1, keepdims=True)
            # the gutter between UV islands gets the nearest island colour, not white: bilinear lookups at the island
            # edges otherwise pulled white into the views (white dotted lines along every seam, 2026-11-10)
            from scipy.ndimage import distance_transform_edt
            _, (iy, ix) = distance_transform_edt(~baker.cover, return_indices=True)
            tex = tex[iy, ix]
            # UltraTex's encode -> decode darkens (Pixal3D 63.7 -> albedo 29.7 mean, like sRGB -> linear), so the colours
            # are lifted by the inverse before they are encoded
            # (the full sRGB inverse overshot: 74.2; lift is the exponent, 1 = unchanged, about 1.7 lands near UltraTex's own)
            rig = None if np.allclose(prep.rig, np.eye(3)) else prep.rig
            plain, cover, _ = baker.render_views(tex.astype(np.float32), None, resolution, rig)
            # keep_mask: the head and neck (up is +y, as in the glTF the mesh came from), rendered like a texture
            yy = baker.texel_pos[:, 1]
            t = (yy - yy.min()) / max(float(np.ptp(yy)), 1e-9)
            hk = np.clip((t - head_from) / max(head_feather, 1e-6), 0, 1)
            hk = hk * hk * (3 - 2 * hk) * float(head_keep)
            htex = np.zeros((texture_size, texture_size, 3)); htex[baker.cover] = hk[:, None]
            htex = htex[iy, ix]
            hv, _, _ = baker.render_views(htex.astype(np.float32), None, resolution, rig)
            keep = hv[..., 0] * cover
            rows = np.arange(resolution)[:, None] * np.ones((1, resolution))
            print(f"[azshara] head keep: {float((hk > 0).mean()):.3f} of the texels; front view: head mean row "
                  f"{float((rows * (keep[0] > 0.3)).sum() / max((keep[0] > 0.3).sum(), 1)):.0f} of {resolution} "
                  f"(figure {float((rows * cover[0]).sum() / max(cover[0].sum(), 1)):.0f})", flush=True)
            if colour == "compensate":
                tex = np.power(np.clip(tex, 0, 1), 1.0 / max(float(lift), 0.1))
                views, _, _ = baker.render_views(tex.astype(np.float32), None, resolution, rig)
            else:
                views = plain
        finally:
            baker.release()
        print(f"[azshara] init views from {glb_path.rsplit('/', 1)[-1]}: {len(col)} coloured vertices, "
              f"texel match median {np.median(d[:, 0]) / float(prep.scale) * 1000:.2f} mm", flush=True)
        return (torch.from_numpy(np.ascontiguousarray(views)), torch.from_numpy(np.ascontiguousarray(plain)),
                torch.from_numpy(np.ascontiguousarray(cover.astype(np.float32))), torch.from_numpy(np.ascontiguousarray(keep.astype(np.float32))))


class UltraTexMatchViewTone:
    """Tone from a consistent painting, detail from UltraTex: each generated view's low frequencies (colour and
    brightness blurred over sigma px) are set to those of the same view of the reference (the mesh's own colours, from
    UltraTex Init From Mesh Colours), while its detail is kept. Removes the per-view tone shifts (the man's back a shade
    lighter than his shoulders, 2026-11-10) and the overall darkening and red cast."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "views": ("IMAGE", {"tooltip": "The UltraTex sampler's 6 views."}),
            "reference": ("IMAGE", {"tooltip": "colour_views of UltraTex Init From Mesh Colours (same cameras)."}),
            "cover": ("MASK", {"tooltip": "cover of UltraTex Init From Mesh Colours."}),
            "sigma": ("FLOAT", {"default": 24.0, "min": 2.0, "max": 128.0, "step": 1.0, "tooltip": "Blur of the tone in px at 1024 (larger = only broad tone)."}),
            "strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.05, "tooltip": "1 = the reference's tone, 0 = unchanged."}),
        }, "optional": {
            "align": ("BOOLEAN", {"default": False, "tooltip": "Also move each view's painting onto the reference's features (optical flow), so that eyebrows, eyes and the collar sit where the mesh's own colours have them."}),
            "max_shift": ("FLOAT", {"default": 24.0, "min": 1.0, "max": 96.0, "step": 1.0, "tooltip": "Largest move in px at 1024."}),
            "flow_smooth": ("FLOAT", {"default": 6.0, "min": 0.0, "max": 32.0, "step": 0.5, "tooltip": "Blur of the flow in px at 1024: moves features without bending fine detail."}),
        }}

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("views",)
    FUNCTION = "match"
    CATEGORY = "UltraTex"

    @staticmethod
    def _align(out, ref, mask, max_shift, smooth):
        """Warps each view so its painting lands on the reference's features: DIS optical flow from the reference to the
        (tone-matched) view on grey levels, limited to max_shift px, blurred, and only inside the figure."""
        import cv2
        res, moved = [], []
        for i in range(out.shape[0]):
            o = (out[i].permute(1, 2, 0).cpu().numpy() * 255).astype(np.uint8)
            rr = (ref[i].permute(1, 2, 0).cpu().numpy() * 255).astype(np.uint8)
            mk = mask[i, 0].cpu().numpy() > 0.5
            go, gr = cv2.cvtColor(o, cv2.COLOR_RGB2GRAY), cv2.cvtColor(rr, cv2.COLOR_RGB2GRAY)
            go[~mk] = gr[~mk] = 255
            dis = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)
            f = dis.calc(gr, go, None)   # for each reference pixel: where the same feature is in the view
            if smooth > 0:
                f = cv2.GaussianBlur(f, (0, 0), smooth)
            mag = np.linalg.norm(f, axis=2)
            f *= np.minimum(1.0, max_shift / np.maximum(mag, 1e-6))[..., None]
            f[~mk] = 0
            h, w = gr.shape
            gx, gy = np.meshgrid(np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32))
            warped = cv2.remap(o, gx + f[..., 0], gy + f[..., 1], cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
            warped[~mk] = o[~mk]
            res.append(torch.from_numpy(warped.astype(np.float32) / 255.0).permute(2, 0, 1))
            mm = np.linalg.norm(f, axis=2)[mk]
            moved.append((round(float(np.median(mm)), 1), round(float(np.percentile(mm, 95)), 1)))
        return torch.stack(res).to(out.device), moved

    def match(self, views, reference, cover, sigma, strength, align=False, max_shift=24.0, flow_smooth=6.0):
        import torch.nn.functional as F
        v = views.float().permute(0, 3, 1, 2)[:, :3]
        r = F.interpolate(reference.float().permute(0, 3, 1, 2)[:, :3], size=v.shape[-2:], mode="bilinear", align_corners=False)
        m = F.interpolate(cover.float()[:, None], size=v.shape[-2:], mode="nearest")
        s = float(sigma) * v.shape[-1] / 1024.0
        k = int(s * 3) | 1
        x = torch.arange(k, dtype=torch.float32) - k // 2
        g = torch.exp(-0.5 * (x / s) ** 2); g = g / g.sum()
        def blur(t):
            c = t.shape[1]
            t = F.conv2d(F.pad(t, (k // 2, k // 2, 0, 0), mode="replicate"), g.view(1, 1, 1, k).repeat(c, 1, 1, 1), groups=c)
            return F.conv2d(F.pad(t, (0, 0, k // 2, k // 2), mode="replicate"), g.view(1, 1, k, 1).repeat(c, 1, 1, 1), groups=c)
        wm = blur(m).clamp_min(1e-4)
        low_v, low_r = blur(v * m) / wm, blur(r * m) / wm
        gain = ((low_r + 0.02) / (low_v + 0.02)).clamp(0.5, 2.0) ** float(strength)
        out = torch.where(m > 0.5, (v * gain).clamp(0, 1), v)
        if align:
            out, moved = self._align(out, r, m, float(max_shift) * v.shape[-1] / 1024.0, float(flow_smooth) * v.shape[-1] / 1024.0)
            print(f"[azshara] align: median / p95 move per view (px) {moved}", flush=True)
        before = [round(float((v[i] * m[i]).sum() / m[i].sum() / 3 * 255), 1) for i in range(len(v))]
        after = [round(float((out[i] * m[i]).sum() / m[i].sum() / 3 * 255), 1) for i in range(len(v))]
        print(f"[azshara] tone match: view brightness {before} -> {after}", flush=True)
        return (out.permute(0, 2, 3, 1).contiguous(),)


class UltraTexDetailFromMesh:
    """Colour from UltraTex, fine detail from the mesh's own paint: each view keeps its low frequencies (UltraTex's colour
    regions, closer to the reference image) and takes its high frequencies from the same view of the mesh's own colours
    (Pixal3D's texture). That detail comes from one texture, so it agrees between views: no ghosts, and Pixal3D's paint is
    about twice as sharp as UltraTex's (2026-11-12). The head can keep UltraTex's own detail, since Pixal3D sometimes
    spoils faces."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "views": ("IMAGE", {"tooltip": "The painted views (after UltraTex Match View Tone)."}),
            "reference": ("IMAGE", {"tooltip": "colour_views of UltraTex Init From Mesh Colours (same cameras)."}),
            "cover": ("MASK", {"tooltip": "cover of UltraTex Init From Mesh Colours."}),
            "sigma": ("FLOAT", {"default": 4.0, "min": 0.5, "max": 64.0, "step": 0.5, "tooltip": "Split between colour and detail, as a blur in px at 1024: detail finer than this comes from the mesh."}),
            "detail": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.05, "tooltip": "Share of the fine detail taken from the mesh on the body (1 = all of it, 0 = UltraTex's own)."}),
            "head_detail": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.05, "tooltip": "The same on the head (0 = keep UltraTex's face detail)."}),
        }, "optional": {
            "head": ("MASK", {"tooltip": "head_keep of UltraTex Init From Mesh Colours; without it the whole figure counts as body."}),
        }}

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("views",)
    FUNCTION = "mix"
    CATEGORY = "UltraTex"

    def mix(self, views, reference, cover, sigma, detail, head_detail, head=None):
        import torch.nn.functional as F
        v = views.float().permute(0, 3, 1, 2)[:, :3]
        r = F.interpolate(reference.float().permute(0, 3, 1, 2)[:, :3], size=v.shape[-2:], mode="bilinear", align_corners=False)
        m = F.interpolate(cover.float()[:, None], size=v.shape[-2:], mode="nearest")
        s = float(sigma) * v.shape[-1] / 1024.0
        k = int(s * 3) | 1
        x = torch.arange(k, dtype=torch.float32) - k // 2
        g = torch.exp(-0.5 * (x / s) ** 2); g = g / g.sum()
        def blur(t):
            c = t.shape[1]
            t = F.conv2d(F.pad(t, (k // 2, k // 2, 0, 0), mode="replicate"), g.view(1, 1, 1, k).repeat(c, 1, 1, 1), groups=c)
            return F.conv2d(F.pad(t, (0, 0, k // 2, k // 2), mode="replicate"), g.view(1, 1, k, 1).repeat(c, 1, 1, 1), groups=c)
        wm = blur(m).clamp_min(1e-4)
        low_v, low_r = blur(v * m) / wm, blur(r * m) / wm   # masked blur: the background does not bleed into the edge
        w = torch.full_like(m, float(detail))
        if head is not None:
            h = F.interpolate(head.float()[:, None], size=v.shape[-2:], mode="bilinear", align_corners=False)
            h = h / h.max().clamp_min(1e-6)
            w = w * (1 - h) + float(head_detail) * h
        out = low_v + w * (r - low_r) + (1 - w) * (v - low_v)
        out = torch.where(m > 0.5, out.clamp(0, 1), v)
        print(f"[azshara] detail from mesh: sigma {float(sigma)}, body {float(detail)}, head {float(head_detail)}"
              f"{'' if head is not None else ' (no head mask)'}", flush=True)
        return (out.permute(0, 2, 3, 1).contiguous(),)


# --------------------------------------------------------------------------- synced sampling
# UltraTex paints its 6 views together but bakes them onto the surface only at the end, so the views can place a feature
# (an eyebrow, a collar) a little differently and the bake jumps between them. Here the views are kept in agreement while
# they are painted, as SyncMVD/MVPaint do: after every denoising step the predicted clean latents of all views are
# splatted onto one shared latent texture in UV space (weighted by how head-on each view sees the surface), and rendered
# back into every view before the next step. This happens in latent space, so no decode/encode round trip shifts colours.
# UltraTex's own sample() is reused: at run time its source is compiled with the Euler update line replaced by a hook.

_SYNC = {}


class _LatentProjector:
    def __init__(self, prep, size, tex, power):
        render = _ultratex("render")
        from scipy.ndimage import distance_transform_edt
        self.size, self.tex = size, tex
        r = render.GLRenderer(prep.vertices, prep.normals, prep.faces, prep.uvs)
        rig = None if np.allclose(prep.rig, np.eye(3)) else prep.rig
        self.views = []
        try:
            for v in range(6):
                vr = render.rig_for_view(rig, v)
                _, nrm, dep = r.render_view(v, size, vr)
                cover = dep[..., 3] > 0
                mv = render.view_matrix(v, vr)
                n = nrm[..., :3][cover].astype(np.float64)
                n = n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-8)
                cos = np.clip((n @ mv[:3, :3].T)[:, 2], 0, 1)   # camera looks down -z: facing surfaces have +z
                x = np.clip(dep[..., 1][cover] * tex - 0.5, 0, tex - 1)
                y = np.clip((1 - dep[..., 2][cover]) * tex - 0.5, 0, tex - 1)
                tidx = np.rint(y).astype(np.int64) * tex + np.rint(x).astype(np.int64)
                self.views.append((np.flatnonzero(cover), tidx, cos ** power + 1e-6, x, y))
        finally:
            r.release()
        hit = np.zeros(tex * tex, bool)
        for _, tidx, _, _, _ in self.views:
            hit[tidx] = True
        _, (iy, ix) = distance_transform_edt(~hit.reshape(tex, tex), return_indices=True)
        self.fill = (iy * tex + ix).ravel()   # every texel -> the nearest texel some view sees

    def __call__(self, tiles):
        """tiles (6, C, h, w) float -> the same with every covered pixel replaced by the shared texture's value."""
        c = tiles.shape[1]
        flat = tiles.reshape(6, c, -1)
        acc = np.zeros((self.tex * self.tex, c)); wsum = np.zeros(self.tex * self.tex)
        for v, (pix, tidx, w, _, _) in enumerate(self.views):
            np.add.at(acc, tidx, flat[v][:, pix].T * w[:, None]); np.add.at(wsum, tidx, w)
        tex = (acc / np.maximum(wsum, 1e-12)[:, None])[self.fill].reshape(self.tex, self.tex, c)
        out = flat.copy()
        for v, (pix, _, _, x, y) in enumerate(self.views):
            x0, y0 = np.floor(x).astype(int), np.floor(y).astype(int)
            x1, y1 = np.minimum(x0 + 1, self.tex - 1), np.minimum(y0 + 1, self.tex - 1)
            fx, fy = (x - x0)[:, None], (y - y0)[:, None]
            val = tex[y0, x0] * (1 - fx) * (1 - fy) + tex[y0, x1] * fx * (1 - fy) + tex[y1, x0] * (1 - fx) * fy + tex[y1, x1] * fx * fy
            out[v][:, pix] = val.T
        return out.reshape(tiles.shape)


def _sync_hook(x_fg, pred, t_curr, t_prev, i, start, L):
    """Replaces UltraTex's Euler step x_fg + (t_prev - t_curr) * pred: x0 is synced across the views, then re-noised."""
    x0 = x_fg - t_curr * pred           # rectified flow: x_t = (1 - t) x0 + t noise, pred = noise - x0
    eps = x_fg + (1 - t_curr) * pred
    s = float(_SYNC.get("last" if t_prev <= 0 else "strength", 1.0))
    if s > 0:
        sampling = _ultratex("sampling")
        bb, th, tw, tgt = L["bb"], L["th"], L["tw"], L["tgt_idx_d"]
        full = L["bg_tokens"].to(x0.device).float().clone()
        full[:, tgt] = x0.float()
        tiles = sampling.grid_to_tiles(bb.unpack(full, th, tw)).cpu().numpy().astype(np.float64)
        key = (tiles.shape[-1], int(_SYNC["tex_scale"] * tiles.shape[-1]))
        proj = _SYNC.get("proj", {}).get(key)
        if proj is None:
            proj = _LatentProjector(L["prep"], key[0], key[1], float(_SYNC["power"]))
            _SYNC.setdefault("proj", {})[key] = proj
        synced = torch.from_numpy(proj(tiles)).float()
        tok = bb.pack(sampling.tiles_to_grid(synced)).to(x0.device)[:, tgt]
        moved = float((tok - x0.float()).abs().mean() / max(float(x0.float().abs().mean()), 1e-8))
        print(f"[azshara] sync step {i}: t {t_curr:.2f} -> {t_prev:.2f}, strength {s}, latents changed {moved:.1%}", flush=True)
        x0 = x0 + s * (tok.to(x0.dtype) - x0)
    return (1 - t_prev) * x0 + t_prev * eps


def _synced_sample():
    import inspect
    sampling = _ultratex("sampling")
    if getattr(sampling, "_azshara_synced", None) is not None:
        return sampling._azshara_synced
    src = inspect.getsource(sampling.sample)
    line = "            x_new = x_fg + (t_prev - t_curr) * pred\n"
    if src.count(line) != 1:
        raise RuntimeError("UltraTex's sample() changed: the Euler update line for the sync hook was not found")
    src = src.replace(line, "            x_new = _sync_hook(x_fg, pred, t_curr, t_prev, i, start, locals())\n")
    src = src.replace("def sample(", "def sample_synced(", 1)
    g = dict(sampling.__dict__); g["_sync_hook"] = _sync_hook
    exec(compile(src, sampling.__file__ + " (azshara sync)", "exec"), g)
    sampling._azshara_synced = g["sample_synced"]
    return sampling._azshara_synced


def _ultratex_nodes():
    for k, m in list(sys.modules.items()):   # strict: torch.ops answers any attribute name
        f = getattr(m, "__file__", None) or ""
        if "UltraTex" in f and f.endswith("nodes.py") and isinstance(getattr(m, "__dict__", {}).get("UltraTexSampler"), type):
            return m
    raise RuntimeError("ComfyUI-UltraTex is not loaded")


class UltraTexSamplerSynced:
    """UltraTex Sampler with the views synced through the surface after every step (see above)."""

    @classmethod
    def INPUT_TYPES(cls):
        base = _ultratex_nodes().UltraTexSampler.INPUT_TYPES()
        opt = dict(base.get("optional", {}))
        opt.update({
            "sync_strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.05, "tooltip": "How far each step's views are pulled to the shared surface (1 = fully)."}),
            "sync_last": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.05, "tooltip": "The same for the last step (lower lets the last step sharpen freely)."}),
            "sync_power": ("FLOAT", {"default": 8.0, "min": 0.0, "max": 32.0, "step": 0.5, "tooltip": "View weight cos^power when the views are merged (higher = the most head-on view wins)."}),
            "sync_tex_scale": ("FLOAT", {"default": 2.0, "min": 1.0, "max": 4.0, "step": 0.25, "tooltip": "Size of the shared latent texture, in times the latent view size."}),
        })
        return {"required": base["required"], "optional": opt}

    RETURN_TYPES = ("IMAGE", "MASK", "IMAGE")
    RETURN_NAMES = ("views", "masks", "atlas")
    FUNCTION = "sample"
    CATEGORY = "UltraTex"

    def sample(self, sync_strength=1.0, sync_last=1.0, sync_power=8.0, sync_tex_scale=2.0, **kw):
        nodes = _ultratex_nodes()
        sampling = nodes.sampling
        synced = _synced_sample()
        _SYNC.clear(); _SYNC.update(strength=sync_strength, last=sync_last, power=sync_power, tex_scale=sync_tex_scale)
        orig = sampling.sample
        sampling.sample = synced
        try:
            return nodes.UltraTexSampler().sample(**kw)
        finally:
            sampling.sample = orig
            _SYNC.clear()


NODE_CLASS_MAPPINGS = {"UltraTexInitFromMeshColours": UltraTexInitFromMeshColours, "UltraTexMatchViewTone": UltraTexMatchViewTone,
                       "UltraTexSamplerSynced": UltraTexSamplerSynced, "UltraTexDetailFromMesh": UltraTexDetailFromMesh}
NODE_DISPLAY_NAME_MAPPINGS = {"UltraTexInitFromMeshColours": "UltraTex Init From Mesh Colours", "UltraTexMatchViewTone": "UltraTex Match View Tone",
                              "UltraTexSamplerSynced": "UltraTex Sampler (synced views)", "UltraTexDetailFromMesh": "UltraTex Detail From Mesh"}
