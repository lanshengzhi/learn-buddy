#!/usr/bin/env python3
"""Generates the LearnBuddy PNG icons (stdlib only, no PIL).

Draws the "sentence card" motif: a rounded green square with three white
rounded bars (text lines), the last bar shorter — a stack of sentence cards.
Maskable-safe: the motif stays within the central 80% safe zone.

Usage: python3 server/tools/make_icons.py   (writes web/icons/*.png)
"""

import os
import struct
import zlib

OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "web", "icons")

BG = (47, 111, 79)      # #2f6f4f — primary green
BAR = (247, 246, 243)   # #f7f6f3 — light surface

SIZES = [192, 512, 180]  # 180 → apple-touch-icon


def write_png(path, size, pixels):
    """pixels: list of rows, each a list of (r, g, b) tuples."""
    raw = b""
    for row in pixels:
        raw += b"\x00" + b"".join(bytes(px) for px in row)
    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as fh:
        fh.write(png)


def rounded_rect_mask(size, x0, y0, x1, y1, radius):
    """Returns a set of (x, y) inside the rounded rectangle."""
    mask = set()
    for y in range(y0, y1):
        for x in range(x0, x1):
            # corner rounding: distance to nearest corner center
            cx = min(max(x, x0 + radius), x1 - radius - 1)
            cy = min(max(y, y0 + radius), y1 - radius - 1)
            if (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius:
                mask.add((x, y))
    return mask


def draw_icon(size):
    px = [[BG] * size for _ in range(size)]

    # Background rounded square (slightly inset so the tile is visible).
    margin = 0
    bg_radius = size // 5
    bg = rounded_rect_mask(size, margin, margin, size - margin, size - margin, bg_radius)
    for x, y in bg:
        px[y][x] = BG

    # Three sentence-card bars, centered vertically, widths 70% / 70% / 45%.
    bar_radius = max(2, size // 40)
    bar_height = max(4, size // 16)
    gap = bar_height + max(3, size // 32)
    total = 3 * bar_height + 2 * gap
    start_y = (size - total) // 2
    widths = (0.70, 0.70, 0.45)
    for i, w in enumerate(widths):
        bar_w = int(size * w)
        x0 = (size - bar_w) // 2
        y0 = start_y + i * (bar_height + gap)
        for x, y in rounded_rect_mask(size, x0, y0, x0 + bar_w, y0 + bar_height, bar_radius):
            px[y][x] = BAR
    return px


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in SIZES:
        name = "apple-touch-icon.png" if size == 180 else f"icon-{size}.png"
        write_png(os.path.join(OUT_DIR, name), size, draw_icon(size))
        print(f"wrote web/icons/{name} ({size}x{size})")


if __name__ == "__main__":
    main()
