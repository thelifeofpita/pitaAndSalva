#!/usr/bin/env python3
"""Cuts the site's favicon out of a landing frame.

The tab icon is the dap itself: `dap0_02`, the one frame in the six daps where
the two hands are fully clasped and both sets of fingers still read as fingers.
The site's frame is 1.9:1 and a favicon is square, so this crops hard into the
clasp — 420 units of the 1920 frame, centred on the grip — and lets both arms
run off the sides the way they run off the frame on the landing.

Two treatments, because a favicon is looked at from 16px to 180px:

  solid  the ink blurred and thresholded into a clean silhouette. The plate is
         1-bit dithered, and dither resampled to 32px is grey mush, not grain —
         the shape survives the size, the texture does not. Used for the .ico
         and for the SVG, which has to stay crisp at whatever size a tab asks
         for.
  grain  a straight downsample, dither and all. Only used at 180px, where there
         are enough pixels for the grain to still be the grain.

Everything is written with the ink as alpha over white, so the background is
transparent. `favicon.svg` carries the shape as a luminance mask over a filled
rect instead, so the ink can flip to black under `prefers-color-scheme: light`
— white-on-transparent is invisible in a light tab strip, and the point of the
icon is that someone can see it.

    python3 tools/build_favicon.py      # from the repo root
"""

import base64
import io
import pathlib

from PIL import Image, ImageFilter

ROOT = pathlib.Path(__file__).resolve().parent.parent
FRAME = ROOT / 'img' / 'dap0_02.png'
# the grip, in the frame's own 1920x1080 coordinates
CENTRE = (960, 520)
CROP = 420


def crop():
    src = Image.open(FRAME).convert('L')
    x, y = CENTRE
    return src.crop((x - CROP // 2, y - CROP // 2, x + CROP // 2, y + CROP // 2))


def solid(img):
    """The silhouette, with the finger gaps still cut into it.

    The median pass is what takes the dither out. Thresholding a dithered plate
    leaves single-pixel specks scattered through the mass, which read as dirt on
    an icon rather than as grain; nine pixels of a 420-unit crop is wide enough
    to swallow them and far narrower than the gap between two fingers."""
    return (img.filter(ImageFilter.GaussianBlur(2.4))
               .point(lambda v: 255 if v > 96 else 0)
               .filter(ImageFilter.MedianFilter(9))
               .filter(ImageFilter.GaussianBlur(1.0)))


def cutout(mask, size):
    """White ink, alpha from the ink itself — so the background is nothing."""
    a = mask.resize((size, size), Image.LANCZOS)
    out = Image.new('RGBA', (size, size), (255, 255, 255, 0))
    out.putalpha(a)
    return out


def main():
    raw = crop()
    ink = solid(raw)

    # .ico, the fallback for anything that will not take the SVG
    ico = ROOT / 'favicon.ico'
    cutout(ink, 48).save(ico, sizes=[(16, 16), (32, 32), (48, 48)])

    # the home-screen icon, big enough to keep the plate's own grain
    cutout(raw, 180).save(ROOT / 'apple-touch-icon.png')

    # the SVG: the shape as a mask, the colour a media query away
    buf = io.BytesIO()
    ink.resize((256, 256), Image.LANCZOS).save(buf, format='PNG', optimize=True)
    b64 = base64.b64encode(buf.getvalue()).decode('ascii')
    (ROOT / 'favicon.svg').write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">\n'
        '<title>PITA &amp; SALVA</title>\n'
        '<style>.ink{fill:#111}'
        '@media (prefers-color-scheme:dark){.ink{fill:#fff}}</style>\n'
        '<mask id="hand" maskUnits="userSpaceOnUse" x="0" y="0" '
        'width="256" height="256">\n'
        f'<image width="256" height="256" href="data:image/png;base64,{b64}"/>\n'
        '</mask>\n'
        '<rect class="ink" width="256" height="256" mask="url(#hand)"/>\n'
        '</svg>\n')

    for f in ('favicon.ico', 'favicon.svg', 'apple-touch-icon.png'):
        print(f, (ROOT / f).stat().st_size, 'bytes')


if __name__ == '__main__':
    main()
