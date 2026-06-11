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

# Faction theme colors (match FACTIONS/TYRANT_DEF in src/app.js) — card interiors
# are re-tinted to these so each card visibly reads as its faction.
THEME = {
    'grid':      (243, 156, 18),
    'syndicate': (231, 76, 60),
    'commune':   (46, 204, 113),
    'ghost':     (155, 89, 182),
    'tyrant':    (123, 31, 162),
}


def tint_interior(im, color, base=0.80, texture=0.6, thresh=110):
    """Recolor the card's flat interior fill to the faction color.

    Multi-seed flood fill from the card's center region over pixels whose color
    is near the dominant interior fill — it spreads to the frame's true inner
    boundary (whatever its shape) but never crosses it, so ornaments and the
    frame itself stay intact. Luminance deltas are re-applied on top of the
    theme color to keep the fill's texture; edges blend by color distance.
    """
    im = im.convert('RGBA')
    w, h = im.size
    px = im.load()
    box = (int(w * 0.18), int(h * 0.18), int(w * 0.82), int(h * 0.82))
    # Dominant fill color = median of a sparse sample of the inner box
    sample = sorted(px[x, y][:3] for x in range(box[0], box[2], 13)
                    for y in range(box[1], box[3], 13))
    med = sample[len(sample) // 2]
    med_lum = sum(med) / 3
    tgt = tuple(c * base for c in color)
    dist = lambda r, g, b: abs(r - med[0]) + abs(g - med[1]) + abs(b - med[2])
    # Seeds: every fill-colored pixel on a coarse lattice inside the center box
    # (multiple seeds so fill regions separated by ornaments are still reached).
    stack = [(x, y) for x in range(box[0], box[2], 24)
             for y in range(box[1], box[3], 24) if dist(*px[x, y][:3]) < 60]
    seen = bytearray(w * h)
    while stack:
        x, y = stack.pop()
        if x < 0 or y < 0 or x >= w or y >= h or seen[y * w + x]:
            continue
        seen[y * w + x] = 1
        r, g, b, a = px[x, y]
        d = dist(r, g, b)
        if a == 0 or d > thresh:
            continue
        t = min(1.0, (thresh - d) / (thresh * 0.75))   # soft edge near the frame
        dl = ((r + g + b) / 3 - med_lum) * texture
        px[x, y] = (int(r + (max(0, min(255, tgt[0] + dl)) - r) * t),
                    int(g + (max(0, min(255, tgt[1] + dl)) - g) * t),
                    int(b + (max(0, min(255, tgt[2] + dl)) - b) * t), a)
        stack.extend(((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)))
    return im


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
        # The Tyrant keeps its original black interior (red accents) so it stays
        # visually distinct from the Ghost's purple — every other card is tinted.
        if fk != 'tyrant':
            im = tint_interior(im, THEME[fk])
        out = OUT / f'card_{fk}.png'
        im.save(out, optimize=True)
        print(f'{out}: {im.size}, {out.stat().st_size // 1024}KB')


if __name__ == '__main__':
    main()
