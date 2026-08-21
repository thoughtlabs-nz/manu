#!/usr/bin/env python3
"""Turn design/Fantail.png into the web logo + favicons. See design/README.md.

    training/venv/bin/python design/make_logo.py
"""
import os
from PIL import Image
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "design", "Fantail.png")
LOGO_HEIGHT_CSS = 72          # keep in sync with .bird-mark in index.css
SCALE = 3                     # retina export factor
ALPHA_FLOOR = 0.10


def main():
    src = Image.open(SRC).convert("RGB")
    a = np.asarray(src).astype(np.float32)

    # Luminance key: the art is dark ink on textured cream, so a colour-key
    # would leave the texture as speckle. Percentiles (not min/max) keep a
    # stray pixel from skewing the range.
    lum = 0.299 * a[..., 0] + 0.587 * a[..., 1] + 0.114 * a[..., 2]
    bg, fg = float(np.percentile(lum, 97)), float(np.percentile(lum, 1))
    alpha = np.clip((bg - lum) / max(bg - fg, 1e-6), 0.0, 1.0)

    # Floor and rescale: the paper texture leaves a faint alpha everywhere,
    # which both speckles the background and makes getbbox() return the whole
    # frame, so nothing would ever crop.
    alpha = np.where(alpha < ALPHA_FLOOR, 0.0, (alpha - ALPHA_FLOOR) / (1 - ALPHA_FLOOR))

    solid = a[alpha > 0.9]
    ink = solid.mean(axis=0) if len(solid) else np.array([98.0, 54.0, 12.0])
    print("ink #%02x%02x%02x" % tuple(int(c) for c in ink))

    rgba = np.zeros((*alpha.shape, 4), dtype=np.uint8)
    rgba[..., 0:3] = ink.astype(np.uint8)
    rgba[..., 3] = (alpha * 255).astype(np.uint8)
    img = Image.fromarray(rgba, "RGBA")
    img = img.crop(img.getbbox())
    print("cropped", img.size)

    h = LOGO_HEIGHT_CSS * SCALE
    logo = img.resize((round(img.size[0] * h / img.size[1]), h), Image.LANCZOS)
    out = os.path.join(ROOT, "web", "src", "assets", "fantail.png")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    logo.save(out, optimize=True)
    print("logo", logo.size, "->", os.path.relpath(out, ROOT))

    side = max(img.size)
    sq = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    sq.paste(img, ((side - img.size[0]) // 2, (side - img.size[1]) // 2))
    pub = os.path.join(ROOT, "web", "public")
    os.makedirs(pub, exist_ok=True)
    for px, name in ((180, "apple-touch-icon.png"), (32, "favicon.png")):
        sq.resize((px, px), Image.LANCZOS).save(os.path.join(pub, name), optimize=True)
        print(name, px)


if __name__ == "__main__":
    main()
