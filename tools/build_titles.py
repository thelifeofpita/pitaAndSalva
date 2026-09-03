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

Scale is matched to the PEN of the line above — not to the width of the line
being replaced, and not to its cap height either.

Width was never a candidate: the placeholder line spanned 1334 units, and
refilling that span with three shorter titles would have set them half again
as large as the four over them.

Cap height was, and it was wrong. Matched cap for cap the two lines measure
the same and read nowhere near it: this sheet is written in a finer, more
condensed hand, so the same letter height comes out in a thinner stroke over a
much shorter line, and the whole row looks like a smaller size of the same
handwriting. What actually has to agree between two lines of one person's
writing is the mark the pen leaves. So the target is taken off the committed
line-1 art — the median of each title's mean horizontal ink run, median across
the four so one unusually heavy title (NUMPAD JAM) does not set the size for
the row — and `solve()` searches the scale that lands the new line on it. The
letters come out taller than line 1's by about a fifth, which is what a
condensed hand at the same weight looks like.

One scale for all three lines, so the differences between them stay the
handwriting's own.

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
DESC = 15      # space kept under the baseline inside the band, as the drawn row had
FLOOR = 992    # where the row's baseline sits in stage units (its drawn 918 + 74)
PAD = 4        # transparent margin left and right, as every other camp file has
RUN = 0.28     # of a line's height: longer ink runs are bars, not pen width


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


def pen(mask):
    """The width of the mark, as a number.

    Every horizontal run of ink in the image, with the long ones dropped —
    past about a quarter of the line's height a run is a crossbar or a
    baseline sweep being measured lengthwise, not a stroke being measured
    across. What is left is dominated by uprights, and its mean tracks the
    pen: it moves with the nib and with nothing else, which is exactly what
    two lines of the same handwriting have to share to look like one block.
    """
    w, h = mask.size
    px = mask.load()
    cap = max(4, round(h * RUN))
    runs = []
    for y in range(h):
        n = 0
        for x in range(w):
            if px[x, y]:
                n += 1
            elif n:
                runs.append(n)
                n = 0
        if n:
            runs.append(n)
    runs = [r for r in runs if r <= cap]
    return sum(runs) / len(runs)


def target_pen():
    """The pen of the line above, off its own committed artwork."""
    pens = sorted(pen(Image.open(OUT / f'camp_l1_{i}.png').getchannel('A'))
                  for i in range(4))
    return (pens[1] + pens[2]) / 2      # median of four


def shrink(crop, k):
    """One line of writing at scale k, hard 1-bit."""
    size = (max(1, round(crop.width * k)), max(1, round(crop.height * k)))
    return crop.resize(size, Image.LANCZOS).point(lambda v: 255 if v >= CUT else 0)


def solve(crops, want):
    """The scale whose finished art writes with the pen we are matching.

    Measured on the output rather than converted from the source: the same
    statistic on the 1755px sheet comes out biased (its runs are five times
    longer and its edges are photographic, not thresholded), and a scale
    derived from it overshoots by about 6% — enough to read as bigger than the
    line above rather than level with it. Bisection on the real thing has no
    such gap to model. Twelve halvings resolve the scale far finer than the
    integer pixel the art is rounded to anyway.
    """
    lo, hi = 0.10, 0.45
    for _ in range(12):
        mid = (lo + hi) / 2
        got = sum(pen(shrink(c, mid)) for c in crops) / len(crops)
        if got < want:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


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

    # one scale for all three, so what differs between them stays the writing's
    want = target_pen()
    k = solve(crops, want)

    # the resize is the only place greys exist; they end in shrink(). unspeck
    # then takes the paper the threshold let through, and the art is re-cropped
    # to the letters, because the sheet's own bbox measured the specks too.
    inks = []
    for c in crops:
        ink = unspeck(shrink(c, k))
        inks.append(ink.crop(ink.getbbox()))

    # one band for the three, tall enough for the tallest of them, with the
    # baseline the same distance off its floor as the drawn row had
    band = max(89, max(i.height for i in inks) + DESC)
    print(f'pen {want:.2f}  scale {k:.4f}  band {band}  ui.json y={FLOOR - band + DESC}')

    for i, ink in enumerate(inks):
        art = Image.new('RGBA', (ink.width + 2 * PAD, band), (255, 255, 255, 0))
        white = Image.new('RGBA', ink.size, (255, 255, 255, 255))
        art.paste(white, (PAD, band - DESC - ink.height), ink)   # on the shared baseline
        path = OUT / f'camp_l2_{i}.png'
        art.save(path)
        print(f'{path.name}  w={art.width} h={art.height}  ink={ink.height}')


if __name__ == '__main__':
    main()
