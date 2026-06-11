#!/usr/bin/env python3
"""crop_hex.py — turn a square piece of tile artwork into a game-ready faction hex asset.

Crops the source image to the hexagon, masks everything outside a flat-top hex
to transparent, and emits a 480x480 RGBA PNG whose opaque footprint matches the
existing faction art (hex region ~465x408, the game's 100:87 hex proportions).

Usage:
    python3 tools/crop_hex.py SOURCE OUT.png [--bbox L,T,R,B]

--bbox: pixel box of the hexagon in the SOURCE image (left,top,right,bottom).
        Defaults to the largest centered 100:87 box that fits the source —
        right for artwork where the hex fills the frame edge-to-edge.
"""
import argparse
from PIL import Image, ImageDraw

OUT_SIZE = 480          # canvas, matches existing assets
HEX_W, HEX_H = 465, 408 # opaque hex footprint of existing faction art
# The game's hex polygon (viewBox 100x87): flat top/bottom, points at left/right.
HEX_POLY = [(25, 2), (75, 2), (98, 43.5), (75, 85), (25, 85), (2, 43.5)]
SS = 4                  # supersample factor for a smooth mask edge


def default_bbox(w, h):
    """Largest centered box with the hex's 100:87 aspect."""
    target = 87 / 100
    bw, bh = w, int(w * target)
    if bh > h:
        bh, bw = h, int(h / target)
    left, top = (w - bw) // 2, (h - bh) // 2
    return (left, top, left + bw, top + bh)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('source')
    ap.add_argument('out')
    ap.add_argument('--bbox', help='hexagon pixel box in source: L,T,R,B')
    args = ap.parse_args()

    src = Image.open(args.source).convert('RGBA')
    bbox = tuple(int(v) for v in args.bbox.split(',')) if args.bbox else default_bbox(*src.size)
    art = src.crop(bbox).resize((HEX_W * SS, HEX_H * SS), Image.LANCZOS)

    # Supersampled hex mask — the game's polygon normalized so its extent exactly
    # fills the HEX_W x HEX_H footprint (the SVG viewBox has padding we don't want).
    xs, ys = [p[0] for p in HEX_POLY], [p[1] for p in HEX_POLY]
    minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)
    pts = [((x - minx) / (maxx - minx) * HEX_W * SS,
            (y - miny) / (maxy - miny) * HEX_H * SS) for x, y in HEX_POLY]
    mask = Image.new('L', (HEX_W * SS, HEX_H * SS), 0)
    ImageDraw.Draw(mask).polygon(pts, fill=255)

    hex_img = Image.new('RGBA', (HEX_W * SS, HEX_H * SS), (0, 0, 0, 0))
    hex_img.paste(art, (0, 0), mask)
    hex_img = hex_img.resize((HEX_W, HEX_H), Image.LANCZOS)

    canvas = Image.new('RGBA', (OUT_SIZE, OUT_SIZE), (0, 0, 0, 0))
    canvas.paste(hex_img, ((OUT_SIZE - HEX_W) // 2, (OUT_SIZE - HEX_H) // 2), hex_img)
    canvas.save(args.out)
    print(f'wrote {args.out}: {canvas.size}, opaque bbox {canvas.getchannel("A").getbbox()}')


if __name__ == '__main__':
    main()
