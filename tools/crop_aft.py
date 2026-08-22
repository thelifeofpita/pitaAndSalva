#!/usr/bin/env python3
"""Crop the Ads from Trash photographs into the nine squares the page shows.

The originals are all portrait — 2:3 for the four hung garments and the pile,
roughly 3:4 for the four lettering close-ups — and the page lays them out as a
3x3 of equal squares, so every one of them has to lose a strip. Which strip is
the only decision here, and it is not the middle: a centred square through a
2:3 photograph of a t-shirt hung on a wall cuts the shirt in half and keeps a
lot of pavement.

So each crop is full width (the square is always as wide as the file) and
placed vertically by hand, at the fraction below, to sit the subject in the
frame: the garment centred on its own centre for the hung shots, the pile
placed high enough that all four of its garments still read their own line,
and the close-ups placed on their letters rather than on the fabric under
them. The fractions are the top edge of the square as a
fraction of the file's height, clamped so a crop can never run off the bottom.

Output is 900px square WebP — twice the ~450px a cell measures on a 1920
layout, so the grid stays sharp on a 2x display.

    python3 tools/crop_aft.py <src-dir> [<out-dir>]

<src-dir> is the folder of originals (01-tshirt-full-2x.png and friends);
out-dir defaults to img/projects/ads-from-trash.
"""
import sys
from pathlib import Path

from PIL import Image

Image.MAX_IMAGE_PIXELS = None

SIZE = 900
QUALITY = 82

# src, out, top edge of the square as a fraction of the source's height
JOBS = [
    ('01-tshirt-full-2x.png', 'full-tshirt.webp', 0.000),
    ('02-sequin-dress-full-2x.png', 'full-dress.webp', 0.057),
    ('03-blood-stained-gamer-hoodie-full-2x.png', 'full-hoodie.webp', 0.097),
    ('04-grease-oil-overalls-full-2x.png', 'full-overalls.webp', 0.142),
    ('05-four-garments-window-light-pile-2x.png', 'pile.webp', 0.100),
    ('01-tshirt-closeup.png', 'close-tshirt.webp', 0.167),
    ('02-sequin-dress-closeup.png', 'close-dress.webp', 0.100),
    ('03-blood-stained-gamer-hoodie-closeup.png', 'close-hoodie.webp', 0.000),
    ('04-grease-oil-overalls-closeup.png', 'close-overalls.webp', 0.000),
]


def main():
    src = Path(sys.argv[1])
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else Path('img/projects/ads-from-trash')
    out.mkdir(parents=True, exist_ok=True)

    for name, dst, top in JOBS:
        im = Image.open(src / name).convert('RGB')
        w, h = im.size
        s = min(w, h)
        y = max(0, min(h - s, round(top * h)))
        x = (w - s) // 2
        sq = im.crop((x, y, x + s, y + s)).resize((SIZE, SIZE), Image.LANCZOS)
        sq.save(out / dst, quality=QUALITY, method=6)
        print(f'{name} {w}x{h} -> {dst} @ y={y}')


if __name__ == '__main__':
    main()
