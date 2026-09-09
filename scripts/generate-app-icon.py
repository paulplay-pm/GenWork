#!/usr/bin/env python3
"""Generate the GenWork app icon for macOS and Windows.

Sources public/genwork.png (owl logo on an opaque white square) and composites
it onto a rounded-square plate (superellipse/squircle corners, subtle vertical
gradient). Emits:
  resources/app-icon/app-icon.png    1024x1024 macOS icon (inset squircle, dev
                                      Dock / window icon)
  resources/app-icon/icon.icns       macOS packaging iconset (all mac sizes)
  resources/app-icon/app-icon.ico    Windows multi-size icon (16..256, full-bleed
                                      squircle) for the taskbar / window icon

The macOS icon is inset to Apple's 824px Dock grid; the Windows icon is
full-bleed (taskbar icons fill the box). Idempotent; re-run after swapping the
source logo.
"""
import os
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFilter
from PIL.ImageDraw import floodfill

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "public", "genwork.png")
OUT_DIR = os.path.join(ROOT, "resources", "app-icon")
OUT_PNG = os.path.join(OUT_DIR, "app-icon.png")
OUT_ICNS = os.path.join(OUT_DIR, "icon.icns")
OUT_ICO = os.path.join(OUT_DIR, "app-icon.ico")

CANVAS = 1024
# Apple's macOS icon grid: the squircle occupies 824px centered on the 1024
# canvas (100px transparent margin per side). A full-bleed plate renders ~24%
# wider than neighboring apps in the Dock, so the plate is inset, not full-bleed.
PLATE_INSET = 100
PLATE_SIZE = CANVAS - 2 * PLATE_INSET  # 824
GLYPH_FRAC = 0.72   # glyph sized relative to the plate so the owl sits comfortably inside
SUPER_EXP = 5.0     # superellipse exponent: 5.0 approximates the macOS squircle curvature
# Windows .ico entries (includes 256 for crisp high-DPI taskbar rendering).
WIN_ICO_SIZES = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
# A soft off-white/cool plate. Subtle vertical gradient for a touch of depth;
# light enough that the blue owl reads crisply while the squircle edge is still
# visible against a light Dock.
TOP = (248, 250, 255)
BOT = (233, 239, 252)


def squircle_mask(size, exponent, inset=0):
    """An anti-aliased superellipse mask (continuous-curvature corners)."""
    half = (size - 1 - 2 * inset) / 2.0
    cx = cy = inset + half
    buf = bytearray(size * size)
    for y in range(size):
        dy = abs(y - cy) / half
        dyp = dy ** exponent
        base = y * size
        for x in range(size):
            dx = abs(x - cx) / half
            if dx ** exponent + dyp <= 1.0:
                buf[base + x] = 255
    mask = Image.frombytes("L", (size, size), bytes(buf))
    # Feather the staircase edge into a clean anti-aliased boundary.
    return mask.filter(ImageFilter.GaussianBlur(0.7))


def rounded_plate(size, mask, top, bottom):
    """A full-bleed superellipse plate with a soft vertical gradient."""
    plate = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    grad = Image.new("RGBA", (1, size))
    for y in range(size):
        t = y / (size - 1)
        c = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)) + (255,)
        grad.putpixel((0, y), c)
    grad = grad.resize((size, size))
    plate.paste(grad, (0, 0), mask)
    return plate


def content_bbox(img):
    """Bounding box of the non-transparent region, else the full image."""
    alpha = img.getchannel("A")
    bbox = alpha.getbbox()
    return bbox if bbox else (0, 0, img.width, img.height)


def compose_plate(plate_size, logo):
    """Build a full-bleed squircle plate (given size) with the owl glyph sized
    to GLYPH_FRAC of the plate and clipped to the squircle. The plate's corners
    are transparent (from the mask), so the glyph can never poke past them."""
    mask = squircle_mask(plate_size, SUPER_EXP)
    plate = rounded_plate(plate_size, mask, TOP, BOT)

    target = int(plate_size * GLYPH_FRAC)
    scale = target / max(logo.width, logo.height)
    new_w, new_h = int(logo.width * scale), int(logo.height * scale)
    # Supersample the glyph 2x for smoother edges before downscaling.
    logo_big = logo.resize((new_w * 2, new_h * 2), Image.LANCZOS)
    glyph = logo_big.resize((new_w, new_h), Image.LANCZOS)

    x = (plate_size - new_w) // 2
    y = (plate_size - new_h) // 2
    plate.alpha_composite(glyph, (x, y))
    return plate


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    logo = Image.open(SRC).convert("RGBA")

    # The source sits on an opaque white square. Flood-fill the background white
    # away from the border (the owl's interior white face is enclosed by blue,
    # so it is not connected to the edge and stays white).
    for corner in [(0, 0), (logo.width - 1, 0), (0, logo.height - 1), (logo.width - 1, logo.height - 1)]:
        floodfill(logo, corner, (0, 0, 0, 0), thresh=40)

    # Crop the owl to its content so it centers regardless of file padding.
    bbox = content_bbox(logo)
    if bbox:
        logo = logo.crop(bbox)
    # Feather the anti-aliased edge so it sits cleanly on the plate.
    r, g, b, a = logo.split()
    a = a.filter(ImageFilter.GaussianBlur(0.6))
    logo = Image.merge("RGBA", (r, g, b, a))

    # --- macOS: inset the 824px squircle on the 1024 Dock grid ---
    mac_plate = compose_plate(PLATE_SIZE, logo)
    final = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    final.alpha_composite(mac_plate, (PLATE_INSET, PLATE_INSET))
    final.save(OUT_PNG)
    print(f"wrote {OUT_PNG}")

    # Build the .iconset for a native .icns (macOS sizes).
    iconset = os.path.join(OUT_DIR, "GenWork.iconset")
    os.makedirs(iconset, exist_ok=True)
    # (filename, pixel size)
    specs = [
        ("icon_16x16.png", 16),
        ("icon_16x16@2x.png", 32),
        ("icon_32x32.png", 32),
        ("icon_32x32@2x.png", 64),
        ("icon_128x128.png", 128),
        ("icon_128x128@2x.png", 256),
        ("icon_256x256.png", 256),
        ("icon_256x256@2x.png", 512),
        ("icon_512x512.png", 512),
        ("icon_512x512@2x.png", 1024),
    ]
    for name, px in specs:
        final.resize((px, px), Image.LANCZOS).save(os.path.join(iconset, name))
    if subprocess.run(["iconutil", "-c", "icns", iconset, "-o", OUT_ICNS]).returncode != 0:
        print("iconutil failed (iconutil only exists on macOS)", file=sys.stderr)
        sys.exit(1)
    for name, _ in specs:
        os.remove(os.path.join(iconset, name))
    os.rmdir(iconset)
    print(f"wrote {OUT_ICNS}")

    # --- Windows: full-bleed squircle, multi-size .ico ---
    # Windows taskbar/window icons fill the box (no Dock-style inset), so the
    # squircle is rendered edge-to-edge at the full 1024 canvas. PIL writes each
    # size downsampled from this high-res source (256 entry keeps it crisp on
    # high-DPI displays).
    win_plate = compose_plate(CANVAS, logo)
    win_plate.save(OUT_ICO, sizes=WIN_ICO_SIZES)
    print(f"wrote {OUT_ICO}")


if __name__ == "__main__":
    main()
