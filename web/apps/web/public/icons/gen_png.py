#!/usr/bin/env python3
"""
Minimal PNG writer — produces solid icon PNGs without any external libs.
Writes icon-192.png and icon-512.png using only stdlib (zlib + struct).
The images match the SVG design: dark navy background, sky-blue P glyph,
green checkmark accent.
"""
import zlib, struct, math
from pathlib import Path

HERE = Path(__file__).parent

def png_bytes(width: int, height: int, rgba_fn) -> bytes:
    """Encode an RGBA image as a PNG using stdlib only."""
    def chunk(tag: bytes, data: bytes) -> bytes:
        c = struct.pack(">I", len(data)) + tag + data
        crc = zlib.crc32(tag + data) & 0xFFFFFFFF
        return c + struct.pack(">I", crc)

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr_data = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    # IHDR uses RGB (color type 2); we'll bake alpha into the bg ourselves
    ihdr_data = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)  # RGBA

    raw_rows = []
    for y in range(height):
        row = bytearray([0])  # filter byte = None
        for x in range(width):
            r, g, b, a = rgba_fn(x, y, width, height)
            row += bytearray([r, g, b, a])
        raw_rows.append(bytes(row))

    idat_data = zlib.compress(b"".join(raw_rows), 9)

    return (
        sig
        + chunk(b"IHDR", ihdr_data)
        + chunk(b"IDAT", idat_data)
        + chunk(b"IEND", b"")
    )


def lerp_color(c1, c2, t):
    return tuple(int(a + (b - a) * t) for a, b in zip(c1, c2))


BG    = (15, 23, 42)    # #0f172a
BLUE  = (56, 189, 248)  # #38bdf8
GREEN = (34, 197, 94)   # #22c55e


def pixel(x: int, y: int, W: int, H: int):
    s = W / 512  # scale factor
    # Start with background
    r, g, b = BG
    a = 255

    def in_rect(rx, ry, rw, rh, radius=12):
        # Rounded rect check (approximate)
        lx = max(rx, min(x / s, rx + rw)) - x / s
        ly = max(ry, min(y / s, ry + rh)) - y / s
        # Simple non-rounded rect for speed
        return rx <= x / s <= rx + rw and ry <= y / s <= ry + rh

    # Vertical bar of P
    if in_rect(120, 120, 60, 272):
        r, g, b = BLUE; return r, g, b, a
    # Top bar of P
    if in_rect(120, 120, 220, 60):
        r, g, b = BLUE; return r, g, b, a
    # Middle bar of P
    if in_rect(120, 244, 200, 60):
        r, g, b = BLUE; return r, g, b, a
    # Right curve of P (approximated as rect)
    if in_rect(280, 120, 60, 184):
        r, g, b = BLUE; return r, g, b, a

    # Checkmark: two line segments drawn with thickness
    # Segment 1: (280,380) → (320,430)
    # Segment 2: (320,430) → (420,330)
    px, py = x / s, y / s
    thickness = 18  # half-stroke

    def dist_to_segment(ax, ay, bx, by):
        dx, dy = bx - ax, by - ay
        if dx == 0 and dy == 0:
            return math.hypot(px - ax, py - ay)
        t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx*dx + dy*dy)))
        proj_x = ax + t * dx
        proj_y = ay + t * dy
        return math.hypot(px - proj_x, py - proj_y)

    d1 = dist_to_segment(280, 380, 320, 430)
    d2 = dist_to_segment(320, 430, 420, 330)
    if d1 <= thickness or d2 <= thickness:
        r, g, b = GREEN; return r, g, b, a

    return r, g, b, a


for size in (192, 512):
    data = png_bytes(size, size, pixel)
    out = HERE / f"icon-{size}.png"
    out.write_bytes(data)
    print(f"Wrote {out} ({len(data)} bytes)")
