#!/usr/bin/env python3
"""make_cards.py — process the raw sidebar card frames in assets/raw/ into
game-ready assets/card_<faction>.png files.

For each card: flood the white matte around the frame to transparency (from the
image corners, so light pixels INSIDE the frame are untouched), crop to content,
resize to CARD px wide, and save optimized RGBA PNGs. The Syndicate card's gold
hues are rotated to the faction's red.
"""
import colorsys
from pathlib import Path
from PIL import Image, ImageDraw

RAW = Path('assets/raw')
OUT = Path('assets')
CARD = 600          # output width/height (sidebar rows render ~300px wide; 2x for retina)
WHITE_THRESH = 242  # min channel value treated as matte white

SOURCES = {
    'ghost':     'ChatGPT Image Jun 11, 2026, 08_26_46 AM (1).png',
    'commune':   'ChatGPT Image Jun 11, 2026, 08_26_46 AM (2).png',
    'grid':      'ChatGPT Image Jun 11, 2026, 08_26_46 AM (3).png',
    'tyrant':    'ChatGPT Image Jun 11, 2026, 08_26_47 AM (4).png',
    'syndicate': 'ChatGPT Image Jun 11, 2026, 08_26_47 AM (5).png',
}


def matte_to_alpha(im):
    """Flood-fill the white matte from the corners into transparency."""
    im = im.convert('RGBA')
    w, h = im.size
    px = im.load()
    seen = bytearray(w * h)
    stack = [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]
    while stack:
        x, y = stack.pop()
        if x < 0 or y < 0 or x >= w or y >= h or seen[y * w + x]:
            continue
        seen[y * w + x] = 1
        r, g, b, a = px[x, y]
        if min(r, g, b) < WHITE_THRESH:
            continue
        px[x, y] = (r, g, b, 0)
        stack.extend(((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)))
    return im


def gold_to_red(im):
    """Rotate warm gold/yellow hues (20°-70°) into the Syndicate red (~5°)."""
    im = im.convert('RGBA')
    px = im.load()
    w, h = im.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            hh, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
            deg = hh * 360
            if 20 <= deg <= 70 and s > 0.25:
                # gold → red, keeping the metallic value range
                nh = (5 + (deg - 20) * 0.2) / 360
                r2, g2, b2 = colorsys.hsv_to_rgb(nh, min(1.0, s * 1.1), v)
                px[x, y] = (int(r2 * 255), int(g2 * 255), int(b2 * 255), a)
    return im


def main():
    for fk, name in SOURCES.items():
        src = RAW / name
        im = matte_to_alpha(Image.open(src))
        im = im.crop(im.getchannel('A').getbbox())
        im = im.resize((CARD, int(CARD * im.height / im.width)), Image.LANCZOS)
        if fk == 'syndicate':
            im = gold_to_red(im)
        out = OUT / f'card_{fk}.png'
        im.save(out, optimize=True)
        print(f'{out}: {im.size}, {out.stat().st_size // 1024}KB')


if __name__ == '__main__':
    main()
