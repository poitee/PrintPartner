# App Icons

The PWA manifest references `icon-192.png` and `icon-512.png`.

Run the generator script to produce them from `icon.svg`:

```bash
# Option A: Python standard library
python3 gen_png.py

# Option B: cairosvg
pip install cairosvg
python3 generate_icons.py

# Option C: rsvg-convert on apt-based systems
sudo apt install librsvg2-bin
python3 generate_icons.py

# Option D: Inkscape CLI
inkscape icon.svg -w 192 -h 192 -o icon-192.png
inkscape icon.svg -w 512 -h 512 -o icon-512.png
```

The source artwork is `icon.svg`. It uses a dark navy background, a sky blue
"P" glyph, and a green checkmark from the app color palette.
