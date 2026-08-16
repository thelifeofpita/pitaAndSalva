#!/usr/bin/env python3
"""Cuts the BACK control's hands out of the landing plate.

The back control is the other person's hand reaching in from the edge the
landing is behind, so the art has to be the same two hands the landing shows —
Salva's from the left, Pita's from the right — not a new drawing.

Every other overlay asset is baked at its final 1920x1080 stage size, and this
one has to be too: the plate is 1-bit dither, so scaling a 650px hand down to
150px in the browser averages the noise into grey and the crunch is gone. Each
hand is therefore area-downsampled to its on-screen size and re-dithered there,
white with probability equal to the local tone — the same trade the frame build
makes, at the size the pixel actually lands on.

Writes site/img/ui/hand_{pita,salva}.png (fingers pointing in from the side) and
hand_{pita,salva}_v.png (the same hand turned to point up, for the & and the
campaign pages, where the control sits on a horizontal edge).

    python3 tools/build_hands.py
"""

from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
PLATE = ROOT / 'site' / 'img' / 'landing_plate.png'
OUT = ROOT / 'site' / 'img' / 'ui'

# Generous boxes around each hand, cutting the arm off well before the frame
# edge: the crop edge is what reads as the arm continuing off screen. The stray
# overlay glyphs that fall inside them are dropped by the component pass below.
CROPS = {
    'salva': (300, 250, 948, 760),    # left hand  — arm at the crop's left edge
    'pita': (985, 205, 1690, 760),    # right hand — arm at the crop's right edge
}

WIDE = 150   # on-screen width of the hand on Pita's and Salva's pages
TALL = 150   # on-screen length of the hand on the & and the campaign pages
INK = 30     # tone above which a blurred plate pixel counts as subject
BRIDGE = 8   # blur radius used to read that tone — see solid()


def solid(grey):
    """A filled mask of where the subject is.

    The plate is dither, so the hand is not one connected run of white pixels —
    thresholding it directly gives thousands of speckles, and the largest of
    those is a highlight, not a hand. Blurring first turns local dither density
    back into tone, which is connected.

    The blur has to be wide enough to bridge the black gap between Salva's
    thumb and his fingers — cut narrower, the thumb is its own component and the
    hand comes out as a flat paddle — and no wider, or it also bridges the
    lettering that this is here to drop.
    """
    blur = Image.fromarray(grey).filter(ImageFilter.GaussianBlur(BRIDGE))
    return largest_blob(np.asarray(blur) > INK)


def largest_blob(mask):
    """The hand, without the overlay lettering that shares its crop."""
    seen = np.zeros(mask.shape, bool)
    best = None
    for sy, sx in zip(*np.nonzero(mask)):
        if seen[sy, sx]:
            continue
        blob = []
        q = deque([(sy, sx)])
        seen[sy, sx] = True
        while q:
            y, x = q.popleft()
            blob.append((y, x))
            for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
                if 0 <= ny < mask.shape[0] and 0 <= nx < mask.shape[1] \
                        and mask[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = True
                    q.append((ny, nx))
        if best is None or len(blob) > len(best):
            best = blob
    out = np.zeros(mask.shape, bool)
    ys, xs = zip(*best)
    out[list(ys), list(xs)] = True
    return out


def bake(grey, width, rng):
    """Area-downsample to `width`, then re-dither at that size."""
    h = max(1, round(grey.shape[0] * width / grey.shape[1]))
    small = np.asarray(
        Image.fromarray(grey).resize((width, h), Image.BOX), np.float32) / 255
    # The dither the plate itself uses, read backwards: the tone of a patch is
    # how much of it is white, so tone is the probability each pixel is white.
    alpha = (rng.random(small.shape) < small) * 255
    rgba = np.zeros(small.shape + (4,), np.uint8)
    rgba[..., 0:3] = 255                       # the art is white on black
    rgba[..., 3] = alpha.astype(np.uint8)
    return Image.fromarray(rgba)


def main():
    plate = np.asarray(Image.open(PLATE).convert('L'))
    rng = np.random.default_rng(7)             # reproducible builds
    OUT.mkdir(parents=True, exist_ok=True)

    for who, (x0, y0, x1, y1) in CROPS.items():
        grey = plate[y0:y1, x0:x1].copy()
        grey[~solid(grey)] = 0
        ys, xs = np.nonzero(grey)
        grey = grey[ys.min():ys.max() + 1, xs.min():xs.max() + 1]

        bake(grey, WIDE, rng).save(OUT / f'hand_{who}.png')
        # Turned so the fingers point up, arm hanging off the bottom. Salva's
        # hand comes in from the left, so it turns anticlockwise; Pita's, from
        # the right, turns the other way. Both then face the same way they face
        # each other on the landing.
        turn = Image.ROTATE_90 if who == 'salva' else Image.ROTATE_270
        bake(grey, TALL, rng).transpose(turn).save(OUT / f'hand_{who}_v.png')

        for suffix in ('', '_v'):
            im = Image.open(OUT / f'hand_{who}{suffix}.png')
            print(f'hand_{who}{suffix}.png  {im.width}x{im.height}')


if __name__ == '__main__':
    main()
