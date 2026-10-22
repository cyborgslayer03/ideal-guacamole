"""Draws the Omniverse Forge emblem and writes every Android icon and splash
size, plus the Play Store icon and feature graphic.

    python3 scripts/make-icons.py

The emblem: a glowing cosmic ring around a gold four-point star on deep navy.
Edit the colors or shapes below and re-run to restyle everything at once.
"""

import math
import os
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RES = os.path.join(ROOT, 'android', 'app', 'src', 'main', 'res')
STORE = os.path.join(ROOT, 'store')

BG = (6, 9, 20)
BG2 = (22, 30, 70)
CYAN = (62, 232, 255)
GOLD = (255, 194, 62)
VIOLET = (176, 107, 255)


def background(w, h):
    """Deep navy with a soft radial glow in the middle."""
    img = Image.new('RGB', (w, h), BG)
    glow = Image.new('L', (w, h), 0)
    d = ImageDraw.Draw(glow)
    r = min(w, h) * 0.55
    d.ellipse((w / 2 - r, h / 2 - r, w / 2 + r, h / 2 + r), fill=255)
    glow = glow.filter(ImageFilter.GaussianBlur(min(w, h) * 0.18))
    return Image.composite(Image.new('RGB', (w, h), BG2), img, glow)


def star(cx, cy, outer, inner, points=4, rotation=-math.pi / 2):
    pts = []
    for i in range(points * 2):
        r = outer if i % 2 == 0 else inner
        a = rotation + i * math.pi / points
        pts.append((cx + math.cos(a) * r, cy + math.sin(a) * r))
    return pts


def emblem(size, transparent=True, scale=1.0):
    """The emblem on its own layer, `scale` of the canvas wide."""
    s = size * 4  # draw large, then downsample for smooth edges
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    c = s / 2
    R = s * 0.36 * scale
    width = max(2, int(s * 0.045 * scale))

    glow = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse((c - R, c - R, c + R, c + R), outline=CYAN + (255,), width=width * 3)
    gd.polygon(star(c, c, R * 0.82, R * 0.2), fill=GOLD + (200,))
    glow = glow.filter(ImageFilter.GaussianBlur(s * 0.035 * scale))
    img.alpha_composite(glow)

    d = ImageDraw.Draw(img)
    # Orbit ring with a violet inner band.
    d.ellipse((c - R, c - R, c + R, c + R), outline=CYAN + (255,), width=width)
    r2 = R * 0.86
    d.ellipse((c - r2, c - r2, c + r2, c + r2), outline=VIOLET + (180,), width=max(1, width // 3))
    # Four-point star with a bright core.
    d.polygon(star(c, c, R * 0.82, R * 0.2), fill=GOLD + (255,))
    d.polygon(star(c, c, R * 0.46, R * 0.11, rotation=-math.pi / 4), fill=(255, 236, 170, 255))
    core = R * 0.09
    d.ellipse((c - core, c - core, c + core, c + core), fill=(255, 255, 255, 255))
    out = img.resize((size, size), Image.LANCZOS)
    if transparent:
        return out
    base = background(size, size).convert('RGBA')
    base.alpha_composite(out)
    return base


def save(img, *parts):
    path = os.path.join(*parts)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path)


def round_mask(img):
    mask = Image.new('L', img.size, 0)
    ImageDraw.Draw(mask).ellipse((0, 0, img.size[0] - 1, img.size[1] - 1), fill=255)
    out = Image.new('RGBA', img.size, (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out


def main():
    densities = {'mdpi': 1, 'hdpi': 1.5, 'xhdpi': 2, 'xxhdpi': 3, 'xxxhdpi': 4}
    for name, k in densities.items():
        icon = int(48 * k)
        full = emblem(icon, transparent=False, scale=1.15)
        save(full.convert('RGB'), RES, f'mipmap-{name}', 'ic_launcher.png')
        save(round_mask(full), RES, f'mipmap-{name}', 'ic_launcher_round.png')
        # Adaptive icon: the foreground keeps to the 66% safe zone of a 108dp canvas.
        save(emblem(int(108 * k), transparent=True, scale=0.62), RES, f'mipmap-{name}', 'ic_launcher_foreground.png')

    # Splash screens: emblem centered on the background, portrait and landscape.
    for folder in os.listdir(RES):
        path = os.path.join(RES, folder, 'splash.png')
        if not os.path.exists(path):
            continue
        w, h = Image.open(path).size
        img = background(w, h).convert('RGBA')
        e = emblem(int(min(w, h) * 0.42))
        img.alpha_composite(e, ((w - e.size[0]) // 2, (h - e.size[1]) // 2))
        img.convert('RGB').save(path)

    # Play Store listing art.
    save(emblem(512, transparent=False, scale=1.15).convert('RGB'), STORE, 'icon-512.png')
    fw, fh = 1024, 500
    feature = background(fw, fh).convert('RGBA')
    e = emblem(380)
    feature.alpha_composite(e, (70, (fh - 380) // 2))
    d = ImageDraw.Draw(feature)
    font_path = next((p for p in [
        '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
        '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
    ] if os.path.exists(p)), None)
    title = ImageFont.truetype(font_path, 74) if font_path else ImageFont.load_default()
    sub = ImageFont.truetype(font_path, 24) if font_path else ImageFont.load_default()
    d.text((480, 160), 'OMNIVERSE', font=title, fill=CYAN)
    d.text((480, 240), 'FORGE', font=title, fill=GOLD)
    d.text((484, 340), 'Create heroes. Rule the multiverse.', font=sub, fill=(230, 238, 255))
    save(feature.convert('RGB'), STORE, 'feature-graphic.png')


if __name__ == '__main__':
    main()
