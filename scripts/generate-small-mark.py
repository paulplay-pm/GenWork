#!/usr/bin/env python3
"""Generate the small-size GenWork brand mark for tiny UI contexts.

The detailed gradient owl (`public/genwork.png`) collapses into a blue blob
below ~34px: its eyes, beak, and ear tufts merge and it no longer reads as an
owl. For small usages (16px title bar, 18px context menu, 34px export card)
we ship a simplified "squircle badge": a full-bleed blue squircle carrying a
white owl face (two eyes + beak). It echoes the app icon (squircle plate +
owl) so it stays recognizable, and it holds up at 16px.

The squircle has transparent corners, so the mark works on both light and dark
backgrounds. Emits a single asset:
  public/genwork-small.png    512x512 (browser downscales crisply to any size)

Idempotent; re-run after retuning the geometry.
"""
import os

from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "public", "genwork-small.png")

SIZE = 512

# Brand blue, sampled from the top/bottom of the detailed owl gradient.
TOP = (71, 119, 242)    # #4777F2
BOT = (84, 157, 244)    # #549DF4
PUPIL = (38, 64, 140)   # deep navy for the eye pupils
SUPER_EXP = 4.5        # superellipse exponent for the squircle corners


def squircle_mask(size, exponent=SUPER_EXP):
    """Anti-aliased superellipse (rounded-corner square) mask."""
    half = (size - 1) / 2.0
    buf = bytearray(size * size)
    for y in range(size):
        dy = abs(y - half) / half
        dyp = dy ** exponent
        base = y * size
        for x in range(size):
            dx = abs(x - half) / half
            if dx ** exponent + dyp <= 1.0:
                buf[base + x] = 255
    mask = Image.frombytes("L", (size, size), bytes(buf))
    return mask.filter(ImageFilter.GaussianBlur(0.8))


def vertical_gradient(size, top, bottom):
    """A full-bleed vertical gradient, top color at y=0 to bottom at y=size-1."""
    grad = Image.new("RGBA", (1, size))
    for y in range(size):
        t = y / (size - 1)
        c = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        grad.putpixel((0, y), c + (255,))
    return grad.resize((size, size))


def main():
    mask = squircle_mask(SIZE)
    grad = vertical_gradient(SIZE, TOP, BOT)
    badge = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    badge.paste(grad, (0, 0), mask)

    d = ImageDraw.Draw(badge)
    # Owl face: two white eyes with navy pupils, plus a downward beak.
    eye_cx = [SIZE * 0.32, SIZE * 0.68]
    eye_cy = SIZE * 0.40
    eye_r = SIZE * 0.135
    for cx in eye_cx:
        d.ellipse([cx - eye_r, eye_cy - eye_r, cx + eye_r, eye_cy + eye_r],
                  fill=(255, 255, 255, 255))
        pr = eye_r * 0.46
        d.ellipse([cx - pr, eye_cy - pr, cx + pr, eye_cy + pr],
                  fill=PUPIL + (255,))
    # Beak: a small rounded triangle centered between/below the eyes.
    bx, by = SIZE / 2, eye_cy + eye_r * 0.55
    bw, bh = eye_r * 0.7, eye_r * 1.1
    d.polygon([(bx - bw, by), (bx + bw, by), (bx, by + bh)],
              fill=(255, 255, 255, 255))

    badge.save(OUT)
    print(f"wrote {OUT} ({SIZE}x{SIZE})")


if __name__ == "__main__":
    main()
