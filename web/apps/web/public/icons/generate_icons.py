#!/usr/bin/env python3
"""
Generate icon-192.png and icon-512.png from icon.svg.
Run from web/apps/web/public/icons/:
  python3 generate_icons.py

Requires: pip install cairosvg  OR  apt install librsvg2-bin
Falls back to rsvg-convert CLI if cairosvg is not available.
"""
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).parent

def try_cairosvg():
    try:
        import cairosvg
        for size in (192, 512):
            cairosvg.svg2png(
                url=str(HERE / "icon.svg"),
                write_to=str(HERE / f"icon-{size}.png"),
                output_width=size,
                output_height=size,
            )
            print(f"  icon-{size}.png written via cairosvg")
        return True
    except ImportError:
        return False

def try_rsvg():
    for size in (192, 512):
        result = subprocess.run(
            [
                "rsvg-convert",
                "-w", str(size),
                "-h", str(size),
                "-o", str(HERE / f"icon-{size}.png"),
                str(HERE / "icon.svg"),
            ],
            capture_output=True,
        )
        if result.returncode != 0:
            return False
        print(f"  icon-{size}.png written via rsvg-convert")
    return True

if try_cairosvg() or try_rsvg():
    print("Done.")
else:
    print(
        "Neither cairosvg nor rsvg-convert found.\n"
        "Install one and re-run, or manually export icon.svg at 192×192 and 512×512."
    )
    sys.exit(1)
