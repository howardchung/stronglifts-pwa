"""Generate PWA icons (run once: python3 scripts/make_icons.py)."""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "icons"
OUT.mkdir(exist_ok=True)
BG = (18, 20, 24, 255)
ACCENT = (255, 107, 44, 255)


def barbell(d, size, color, scale=1.0):
    c = size / 2
    u = size / 100 * scale
    # bar
    d.rounded_rectangle([c - 40 * u, c - 2.5 * u, c + 40 * u, c + 2.5 * u], radius=2 * u, fill=color)
    # plates (big + small on each side)
    for sgn in (-1, 1):
        for x, w, h in ((22, 7, 44), (31, 6, 32)):
            x0 = c + sgn * x * u
            d.rounded_rectangle([x0 - w / 2 * u, c - h / 2 * u, x0 + w / 2 * u, c + h / 2 * u], radius=2 * u, fill=color)


def icon(size, maskable=False):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if maskable:
        d.rectangle([0, 0, size, size], fill=BG)
        barbell(d, size, ACCENT, 0.7)
    else:
        d.rounded_rectangle([0, 0, size - 1, size - 1], radius=size * 0.22, fill=BG)
        barbell(d, size, ACCENT, 0.95)
    return img


for s in (192, 512):
    icon(s).save(OUT / f"icon-{s}.png")
icon(512, maskable=True).save(OUT / "icon-maskable-512.png")

# Monochrome badge for the Android status bar (white on transparent).
b = Image.new("RGBA", (96, 96), (0, 0, 0, 0))
barbell(ImageDraw.Draw(b), 96, (255, 255, 255, 255), 1.1)
b.save(OUT / "badge-96.png")
print("icons written to", OUT)
