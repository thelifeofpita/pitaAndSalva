#!/usr/bin/env python3
"""Cuts the second line of campaign titles out of a sheet of handwriting.

The landing's campaign block is two drawn lines. The first is four campaigns;
the second was, until this script ran, three of those same four repeated — a
placeholder standing in for titles that did not exist yet. This turns one photo
of three new titles into the three PNGs that line sets:

    update/more_titles.jpeg  ->  img/ui/camp_l2_{0,1,2}.png

Both thresholds are set by WEIGHT, not by where the ink obviously ends. A
marker stroke on photographed paper has a soft shoulder, and cutting it at the
middle of that shoulder comes out visibly lighter than the four titles on the
line above — the same words at the same height in a thinner pen. INK=135 keeps
the shoulder, and CUT=108 after the downscale keeps the half-pixel the resize
would otherwise round away; together they land on the drawn line's weight.

1-bit, not dither. Every other overlay asset is cut out of the landing
photograph, which is 1-bit dithered *art*; this is lettering shot on white
paper, and the existing camp art it has to sit beside is pure white-on-
transparent with hard edges (camp_l1_2.png holds exactly two colours). So the
ink is thresholded, downsampled, and thresholded again — the second pass is
what matters, because a LANCZOS resize of a hard mask comes back with a grey
fringe and grey is the one thing this row does not have.

Scale is matched to the CAP HEIGHT of the line above, not to the width of the
line being replaced. The placeholder line spanned 1334 units, and refilling
that span with three shorter titles would have set them ~15% larger than the
four above them — one block of one person's handwriting at two different sizes.
The new line simply comes out narrower and is centred in img/ui.json instead.

One scale for all three lines, so the differences between them are the
handwriting's own (SURF THE SPIKE is written taller than PASTA FOR PASTA, and
the drawn line above varies by just as much: caps there run 59-63).

    python3 tools/build_titles.py
"""

from collections import deque
from pathlib import Path

from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'update' / 'more_titles.jpeg'
OUT = ROOT / 'img' / 'ui'

INK = 135      # luminance below which a pixel is marker rather than paper
CUT = 108      # the same call again after the downscale, in the resize's greys
OPEN = 5       # px; an opening this wide clears anything thinner than a stroke
SPECK = 12     # px; a blob smaller than this at final size is paper, not letter
GAP = 24       # rows of blank paper that separate one line of writing from the next
CAP = 61.0     # target cap height, the mean of the four titles on the line above
BAND = 89      # the row's height in stage units, as the placeholder art had it
BASE = 74      # baseline inside that band — where the line above rests its feet
PAD = 4        # transparent margin left and right, as every other camp file has


def mask_of(img):
    """Marker as a 1-bit mask.

    INK is set for the weight of the stroke rather than for the cleanest
    separation, so a few of the paper's grid dots come through with it. They
    are dealt with by size, twice, rather than by tone: despeckle() here and
    unspeck() at the finished size.
    """
    return img.convert('L').point(lambda v: 255 if v < INK else 0)


def despeckle(mask):
    """Whatever the threshold let through that is too small to be a letter.

    An opening — erode, then dilate back — rather than a hunt for small blobs:
    the marker lays down strokes ~18px wide on this sheet, so five pixels off
    every edge and five back on costs the letters nothing and leaves nothing
    thinner than a stroke standing. The sheet is 2.4M pixels; a blob pass in
    Python over that is minutes, and this is a filter call.
    """
    return (mask.filter(ImageFilter.MinFilter(OPEN))
                .filter(ImageFilter.MaxFilter(OPEN)))


def unspeck(mask):
    """The last of the paper, dropped at the size it will actually be seen.

    The opening on the sheet is sized to the marker's own stroke and leaves a
    handful of grid dots standing where two of them nearly touch. Nobody sees
    them on a 1700px sheet; the campaign title is drawn at ~500px on a wide
    window, upscaled from ~320, so a 2px blob becomes a 3px fleck floating
    beside the lettering. This runs on the finished 1-bit art — a few hundred
    ink pixels — where a blob pass costs nothing.
    """
    w, h = mask.size
    px = mask.load()
    for sy in range(h):
        for sx in range(w):
            if not px[sx, sy]:
                continue
            blob = [(sx, sy)]
            q = deque(blob)
            px[sx, sy] = 0            # claimed; repainted below if it is big enough
            while q:
                x, y = q.popleft()
                for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                    if 0 <= nx < w and 0 <= ny < h and px[nx, ny]:
                        px[nx, ny] = 0
                        blob.append((nx, ny))
                        q.append((nx, ny))
            if len(blob) >= SPECK:
                for x, y in blob:
                    px[x, y] = 255
    return mask


def lines(mask):
    """The sheet split into rows of writing, by where the paper is empty."""
    w, h = mask.size
    px = mask.load()
    filled = [any(px[x, y] for x in range(w)) for y in range(h)]
    out = []
    y = 0
    while y < h:
        if not filled[y]:
            y += 1
            continue
        end = y
        blank = 0
        while end < h and blank < GAP:
            end += 1
            blank = blank + 1 if end < h and not filled[end] else 0
        out.append((y, end - blank))
        y = end
    return out


def main():
    sheet = Image.open(SRC)
    mask = despeckle(mask_of(sheet))
    rows = lines(mask)
    if len(rows) != 3:
        raise SystemExit(f'expected three lines of writing, found {len(rows)}: {rows}')

    crops = []
    for top, bottom in rows:
        band = mask.crop((0, top, mask.width, bottom))
        crops.append(band.crop(band.getbbox()))

    # one scale for all three: the mean of what is written, onto the mean of
    # what is drawn on the line above
    k = CAP / (sum(c.height for c in crops) / len(crops))

    for i, c in enumerate(crops):
        w = max(1, round(c.width * k))
        h = max(1, round(c.height * k))
        # the resize is the only place greys exist; they end here
        ink = unspeck(c.resize((w, h), Image.LANCZOS).point(lambda v: 255 if v >= CUT else 0))
        # the crop was measured before the specks went; re-tighten to the letters
        box = ink.getbbox()
        ink = ink.crop(box)
        w, h = ink.size
        art = Image.new('RGBA', (w + 2 * PAD, BAND), (255, 255, 255, 0))
        white = Image.new('RGBA', ink.size, (255, 255, 255, 255))
        art.paste(white, (PAD, BASE - h), ink)     # sitting on the shared baseline
        path = OUT / f'camp_l2_{i}.png'
        art.save(path)
        print(f'{path.name}  w={art.width} h={art.height}  cap={h}')


if __name__ == '__main__':
    main()
