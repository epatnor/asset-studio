"""Darrowmere: äldre grafikkort (Quadro M4000, Maxwell sm_52) saknar int8-matmul i cuBLAS (torch._int_mm).
ComfyUI antar att alla CUDA-kort klarar det; här säger vi nej under Turing (sm_75), så att int8-modellerna
(Krea-2, TRELLIS.2, Pixal3D) packas upp och räknas i vanlig precision. På T1000 (sm_75) ändras ingenting."""
import torch
import comfy.model_management as mm

_orig = mm.supports_int8_compute


def supports_int8_compute(device=None):
    if not _orig(device):
        return False
    try:
        dev = device if device is not None else mm.get_torch_device()
        if getattr(dev, "type", None) == "cuda" and torch.cuda.get_device_capability(dev) < (7, 5):
            return False
    except Exception:
        pass
    return True


mm.supports_int8_compute = supports_int8_compute
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
