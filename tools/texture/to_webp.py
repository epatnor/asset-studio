# /// script
# requires-python = ">=3.12"
# dependencies = ["pillow==11.1.0"]
# ///
"""Gör WebP-versioner av texturerna för nedladdning (PNG behålls som källa för verktygen).

  uv run --quiet --script tools/texture/to_webp.py [mapp ...]   (standard: assets/textures och assets/textures/gray)

Färgtexturer blir förlustkomprimerade med hög kvalitet, normalkartor med ännu högre, och alfa bevaras
(lövkort). Bara filer som saknar WebP eller är nyare än sin WebP görs om. Svarar med en rad JSON.
"""
import json
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]


def main():
    dirs = [Path(a) for a in sys.argv[1:]] or [ROOT / "assets" / "textures", ROOT / "assets" / "textures" / "gray"]
    done, before, after = 0, 0, 0
    for d in dirs:
        for png in sorted(d.glob("*.png")):
            webp = png.with_suffix(".webp")
            before += png.stat().st_size
            if not webp.exists() or webp.stat().st_mtime < png.stat().st_mtime:
                im = Image.open(png)
                normal = png.stem.endswith("_normal")
                if im.mode in ("RGBA", "LA") and im.getextrema()[-1][0] < 255:
                    im.convert("RGBA").save(webp, "WEBP", quality=90, alpha_quality=100, method=6)
                else:
                    im.convert("RGB").save(webp, "WEBP", quality=95 if normal else 88, method=6)
                done += 1
            after += webp.stat().st_size
    print(json.dumps({"converted": done, "png_mb": round(before / 1e6, 1), "webp_mb": round(after / 1e6, 1)}))


if __name__ == "__main__":
    main()
