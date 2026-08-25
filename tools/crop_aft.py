#!/usr/bin/env python3
"""Crop the Ads from Trash photographs into the nine squares the page shows.

The originals are all portrait — 2:3 for the four hung garments and the pile,
roughly 3:4 for the four lettering close-ups — and the page lays them out as a
3x3 of equal squares, so every one of them has to lose a strip. Which strip is
the only decision here, and it is not the middle: a centred square through a
2:3 photograph of a t-shirt hung on a wall cuts the shirt in half and keeps a
lot of pavement.

Most crops are full width (the square is as wide as the file) and placed
vertically by hand, at the fraction below, to sit the subject in the frame: the
garment centred on its own centre for the hung shots, and the close-ups placed
on their letters rather than on the fabric under them. The fractions are the top
edge of the square as a fraction of the file's height, clamped so a crop can
never run off the bottom.

Two of them need more than a vertical nudge, so a job can also name a `side`
narrower than the file and its own `left` edge. The originals are 2048px for a
900px output, so there is room to crop inside the frame and still be over 2x.

Output is 900px square WebP — twice the ~450px a cell measures on a 1920
layout, so the grid stays sharp on a 2x display.

    python3 tools/crop_aft.py <src-dir> [<out-dir>]

<src-dir> is the folder of originals (01-tshirt-full-2x.png and friends);
out-dir defaults to img/projects/ads-from-trash.
"""
import sys
from collections import namedtuple
from pathlib import Path

from PIL import Image

Image.MAX_IMAGE_PIXELS = None

SIZE = 900
QUALITY = 82

# `top` and `left` are the square's top and left edges as fractions of the
# file's height and width; `side` is how wide the square is as a fraction of the
# file's width. Left defaults to centred, side to the full width.
Job = namedtuple('Job', 'src dst top side left', defaults=(1.0, None))

JOBS = [
    Job('01-tshirt-full-2x.png', 'full-tshirt.webp', 0.000),
    Job('02-sequin-dress-full-2x.png', 'full-dress.webp', 0.057),
    Job('03-blood-stained-gamer-hoodie-full-2x.png', 'full-hoodie.webp', 0.097),
    # The overalls carry their line high on the bib, and cropping to the
    # garment's own centre left it sitting in the top third with a lot of empty
    # trouser under it. Taken from the top of the file instead: the straps come
    # in, the legs run out of the bottom of the square, and the line lands in
    # the middle of the frame where it belongs.
    Job('04-grease-oil-overalls-full-2x.png', 'full-overalls.webp', 0.000),
    # The pile runs diagonally across a lit floor, so a full-width square hung
    # off the top of it kept a wedge of empty floor in the top right. Dropped
    # lower and pulled in from the right edge, the corner is garment and all
    # four lines still read.
    Job('05-four-garments-window-light-pile-2x.png', 'pile.webp', 0.182, 0.903, 0.000),
    Job('01-tshirt-closeup.png', 'close-tshirt.webp', 0.167),
    Job('02-sequin-dress-closeup.png', 'close-dress.webp', 0.100),
    Job('03-blood-stained-gamer-hoodie-closeup.png', 'close-hoodie.webp', 0.000),
    Job('04-grease-oil-overalls-closeup.png', 'close-overalls.webp', 0.000),
]


def main():
    src = Path(sys.argv[1])
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else Path('img/projects/ads-from-trash')
    out.mkdir(parents=True, exist_ok=True)

    for job in JOBS:
        im = Image.open(src / job.src).convert('RGB')
        w, h = im.size
        s = min(round(job.side * w), h)
        y = max(0, min(h - s, round(job.top * h)))
        x = (w - s) // 2 if job.left is None else max(0, min(w - s, round(job.left * w)))
        sq = im.crop((x, y, x + s, y + s)).resize((SIZE, SIZE), Image.LANCZOS)
        sq.save(out / job.dst, quality=QUALITY, method=6)
        print(f'{job.src} {w}x{h} -> {job.dst} @ {x},{y} {s}px')


if __name__ == '__main__':
    main()
