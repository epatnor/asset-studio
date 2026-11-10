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


NODE_CLASS_MAPPINGS = {"UltraTexInitFromMeshColours": UltraTexInitFromMeshColours, "UltraTexMatchViewTone": UltraTexMatchViewTone}
NODE_DISPLAY_NAME_MAPPINGS = {"UltraTexInitFromMeshColours": "UltraTex Init From Mesh Colours", "UltraTexMatchViewTone": "UltraTex Match View Tone"}
