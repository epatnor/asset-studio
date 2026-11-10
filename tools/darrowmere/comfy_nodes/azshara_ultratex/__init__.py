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
        }}

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("init_views",)
    FUNCTION = "render"
    CATEGORY = "UltraTex"

    def render(self, prep, glb_path, resolution, texture_size):
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
            tex = np.ones((texture_size, texture_size, 3))
            tex[baker.cover] = (col[idx] * w[..., None]).sum(1) / w.sum(1, keepdims=True)
            rig = None if np.allclose(prep.rig, np.eye(3)) else prep.rig
            views, _, _ = baker.render_views(tex.astype(np.float32), None, resolution, rig)
        finally:
            baker.release()
        print(f"[azshara] init views from {glb_path.rsplit('/', 1)[-1]}: {len(col)} coloured vertices, "
              f"texel match median {np.median(d[:, 0]) / float(prep.scale) * 1000:.2f} mm", flush=True)
        return (torch.from_numpy(np.ascontiguousarray(views)),)


NODE_CLASS_MAPPINGS = {"UltraTexInitFromMeshColours": UltraTexInitFromMeshColours}
NODE_DISPLAY_NAME_MAPPINGS = {"UltraTexInitFromMeshColours": "UltraTex Init From Mesh Colours"}
