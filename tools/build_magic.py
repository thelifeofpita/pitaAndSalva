#!/usr/bin/env python3
"""Build the MAGIC nav word, the eye symbols and the shooting-star trails from
the hand-drawn source sheet (assets/magic.jpeg).

Same treatment as the rest of the site's handwriting: local threshold to lift
the ink off the paper, drop the printed dot grid, then hard 1-bit white ink.
The nav word and the trails ship as plain white-on-black cutouts; the eye
symbols carry a black halo so they read on top of a photographed eye, which is
white on one face and black on the other.

Run after build_static.py, which is what clears the & page's plate for live copy
to sit on.
"""

import math
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets" / "magic.jpeg"
UI = ROOT / "site" / "img" / "ui"

# The printed dot grid on the paper survives thresholding at around 150px of
# area; the smallest real ink on the sheet — the dots a trail fades out into —
# is four times that.
SPECK = 400
# how far a mark's recorded corner may have moved for it still to be that mark
CORNER_SLACK = 8

# --- source geometry, in pixels of assets/magic.jpeg -----------------------

# the word, drawn three times: one boil frame each
MAGIC = ((200, 1430, 1260, 1900), (180, 1950, 1260, 2380), (180, 2430, 1220, 2900))

# four drawings of each symbol, top to bottom in the sheet's three columns
SYMBOLS = {
    "star":  (1520, 1840, ((1550, 1830), (1990, 2270), (2375, 2645), (2730, 3005))),
    "heart": (1940, 2220, ((1610, 1830), (2030, 2280), (2390, 2630), (2750, 2990))),
    "flame": (2310, 2560, ((1610, 1855), (2020, 2255), (2375, 2640), (2705, 2975))),
}

# Each trail is drawn as a run of separate marks — a dot, dashes, one long
# stroke — laid along the path a shooting star takes. Listed far end first, so
# the last one is the mark it arrives on, at the word.
TRAILS = (
    ((1356, 77), (1118, 168), (803, 392), (738, 909), (742, 1246)),
    ((1845, 423), (1586, 469), (1191, 617), (1008, 980), (963, 1232)),
    ((2007, 830), (1790, 859), (1458, 948), (1328, 1145), (1256, 1263)),
    ((2703, 1215), (2314, 1181), (1772, 1178), (1519, 1307), (1409, 1422)),
)

# A star's fall, cut out of its own drawing. The head runs from one end of the
# path to past the other; what is alight behind it is a fixed length of trail.
# Whole marks would only give five positions and the star would flicker rather
# than travel, so the cut is made along the path itself, through the strokes.
TRAIL_FRAMES = 14
TRAIL_TAIL = .42       # how much of the path burns behind the head
TRAIL_TEAR = .022      # the cut is torn, not sliced: a clean edge reads as paper

# --- on-stage sizes, in the 1920x1080 coordinate space ---------------------

MAGIC_HEIGHT = 223     # the hero of the & page, set inside the gap between the faces
SYMBOL_HEIGHT = 54     # across an eye, on the iris
SYMBOL_HALO = 4        # black separation, so the ink never merges with a sclera
TRAIL_HEIGHT = 400     # the steepest trail, stood up from its tip


def ink_of(source: Path) -> np.ndarray:
    """The pen, lifted off the paper.

    The and_text sheet is thin handwriting and takes a local threshold happily.
    These are fat marker strokes: a local threshold reads the middle of a stroke
    as its own background and hollows it out, which turned MAGIC into an outline.
    Dividing out a heavy blur removes the phone-photo lighting first, so a single
    global cut can then take the ink whole.
    """
    gray = cv2.imread(str(source), cv2.IMREAD_GRAYSCALE)
    if gray is None:
        raise FileNotFoundError(source)
    flat = gray.astype(np.float32) / np.maximum(cv2.GaussianBlur(gray.astype(np.float32), (0, 0), 60), 1)
    flat = np.clip(flat * 255, 0, 255).astype(np.uint8)
    _, ink = cv2.threshold(flat, 0, 255, cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(ink, 8)
    keep = np.zeros(count, dtype=np.uint8)
    keep[1:] = stats[1:, cv2.CC_STAT_AREA] >= SPECK
    return (keep[labels] * 255).astype(np.uint8)


def bounds(mask: np.ndarray) -> tuple[int, int, int, int]:
    ys, xs = np.nonzero(mask)
    if not len(xs):
        raise RuntimeError("no ink in crop")
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def crop(ink: np.ndarray, box: tuple[int, int, int, int]) -> np.ndarray:
    """The ink inside `box`, cut back to what it actually touches."""
    x0, y0, x1, y1 = box
    sub = ink[y0:y1, x0:x1]
    a, b, c, d = bounds(sub)
    return sub[b:d, a:c]


def place(frame: np.ndarray, size: tuple[int, int], scale: float) -> np.ndarray:
    """One drawing, scaled and centred on the shared canvas its siblings use, so
    the frames boil in place instead of drifting."""
    width = max(1, round(frame.shape[1] * scale))
    height = max(1, round(frame.shape[0] * scale))
    small = cv2.resize(frame, (width, height), interpolation=cv2.INTER_AREA)
    _, small = cv2.threshold(small, 96, 255, cv2.THRESH_BINARY)
    canvas = np.zeros((size[1], size[0]), dtype=np.uint8)
    left = (size[0] - width) // 2
    top = (size[1] - height) // 2
    canvas[top:top + height, left:left + width] = small
    return canvas


def write(name: str, ink: np.ndarray, halo: int = 0) -> None:
    """White ink on transparency, the shape of the ink — plus, when asked, an
    opaque black outline of it, so the drawing keeps its own ground."""
    alpha = ink
    if halo:
        k = 2 * halo + 1
        alpha = cv2.dilate(ink, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    rgba = np.dstack([ink, ink, ink, alpha])
    Image.fromarray(rgba).save(UI / f"{name}.png", optimize=True)


def build_word(ink: np.ndarray) -> None:
    frames = [crop(ink, box) for box in MAGIC]
    scale = MAGIC_HEIGHT / max(f.shape[0] for f in frames)
    size = (round(max(f.shape[1] for f in frames) * scale), MAGIC_HEIGHT)
    for number, frame in enumerate(frames):
        write(f"magic_{number}", place(frame, size, scale))
    print(f"magic: {size[0]}x{size[1]}")


def build_symbols(ink: np.ndarray) -> None:
    drawings = {
        name: [crop(ink, (x0, y0, x1, y1)) for y0, y1 in rows]
        for name, (x0, x1, rows) in SYMBOLS.items()
    }
    # one scale for all three, off the tallest drawing on the sheet, so a heart
    # stays a heart's size next to a star
    every = [f for group in drawings.values() for f in group]
    scale = SYMBOL_HEIGHT / max(f.shape[0] for f in every)
    side = max(round(max(f.shape[1] for f in every) * scale),
               round(max(f.shape[0] for f in every) * scale)) + 2 * SYMBOL_HALO
    size = (side, side)
    for name, group in drawings.items():
        for number, frame in enumerate(group):
            write(f"eye_{name}_{number}", place(frame, size, scale), halo=SYMBOL_HALO)
    print(f"eye symbols: {side}x{side}")


def build_trails(ink: np.ndarray) -> None:
    count, labels, stats, _ = cv2.connectedComponentsWithStats((ink > 0).astype(np.uint8), 8)
    corners = [(int(stats[i, 0]), int(stats[i, 1])) for i in range(1, count)]

    def mark_at(corner):
        x, y = corner
        gap, i = min((abs(cx - x) + abs(cy - y), i) for i, (cx, cy) in enumerate(corners, 1))
        if gap > CORNER_SLACK:
            raise RuntimeError(f"no mark at {corner} — the source sheet moved")
        return i

    # Every frame of every path is cut on one canvas, stacked on the point the
    # star arrives at, so the whole set is one box on the page and a frame is a
    # swap rather than a move.
    paths = []
    for marks in TRAILS:
        drawn = []
        for corner in marks:
            i = mark_at(corner)
            x, y, w, h, _ = stats[i]
            drawn.append(((x, y, x + w, y + h), (x + w / 2, y + h / 2), labels == i))
        paths.append(drawn)

    reach = [0, 0, 0, 0]   # left, top, right, bottom of the tip
    for drawn in paths:
        tx, ty = drawn[-1][1]
        for (x0, y0, x1, y1), _, _ in drawn:
            reach = [max(reach[0], tx - x0), max(reach[1], ty - y0),
                     max(reach[2], x1 - tx), max(reach[3], y1 - ty)]
    scale = TRAIL_HEIGHT / (reach[1] + reach[3])
    size = (round((reach[0] + reach[2]) * scale), TRAIL_HEIGHT)

    rng = np.random.default_rng(7)   # the tear is random, but the same every build
    for number, drawn in enumerate(paths):
        tx, ty = drawn[-1][1]
        hx, hy = drawn[0][1]
        ink_of_path = np.zeros(ink.shape, dtype=bool)
        for _, _, mark in drawn:
            ink_of_path |= mark
        ys, xs = np.nonzero(ink_of_path)

        # how far along the path each speck of ink sits. An arc bends less than
        # half a circle, so its own chord orders it from head to tip.
        ux, uy = tx - hx, ty - hy
        span = math.hypot(ux, uy)
        ux, uy = ux / span, uy / span
        along = ((xs - hx) * ux + (ys - hy) * uy)
        along = (along - along.min()) / (along.max() - along.min())
        along = along + rng.normal(0, TRAIL_TEAR, along.shape)

        x0 = int(tx - reach[0])
        y0 = int(ty - reach[1])
        cut_w = round(size[0] / scale)
        cut_h = round(TRAIL_HEIGHT / scale)
        for f in range(TRAIL_FRAMES):
            head = f / (TRAIL_FRAMES - 1) * (1 + TRAIL_TAIL)
            alight = (along <= head) & (along > head - TRAIL_TAIL)
            mask = np.zeros(ink.shape, dtype=np.uint8)
            mask[ys[alight], xs[alight]] = 255
            cut = mask[y0:y0 + cut_h, x0:x0 + cut_w]
            small = cv2.resize(cut, size, interpolation=cv2.INTER_AREA)
            _, small = cv2.threshold(small, 96, 255, cv2.THRESH_BINARY)
            write(f"trail_{number}_{f}", small)

    # What the page needs to aim a star: the box, the point in it the star
    # arrives at, and for each path the direction it travels in and how far it
    # reaches back from the tip. Paste into STREAK_ART / STREAK_PATHS in app.js.
    print(f"trails: {len(paths)} paths x {TRAIL_FRAMES} frames")
    print(f"const STREAK_ART = {{ w: {size[0]}, h: {size[1]}, "
          f"tipX: {round(reach[0] * scale, 1)}, tipY: {round(reach[1] * scale, 1)} }};")
    print("const STREAK_PATHS = [")
    for drawn in paths:
        hx, hy = drawn[0][1]
        tx, ty = drawn[-1][1]
        angle = math.degrees(math.atan2(ty - hy, tx - hx))
        chord = math.hypot(tx - hx, ty - hy) * scale
        print(f"  {{ angle: {angle:.1f}, chord: {chord:.0f} }},")
    print("];")


# the sky map: how coarsely the & page's plate is sampled for "dark enough that
# white ink reads here", and how much of a cell has to be dark to count
SKY_CELL = 32
SKY_DARK = 45
SKY_SOLID = .92


def build_sky() -> None:
    """Where a shooting star can cross the & page.

    A rectangle in the black between the two faces is the safe answer and a
    small sky. The plate is dark far past that — into the hair, the shadow down
    one cheek — and a white streak reads anywhere it is. So measure it: a coarse
    grid of the plate, one bit per cell, which the page walks each star's line
    against. Paste into STREAK_DARK in app.js.
    """
    plate = np.array(Image.open(UI.parent / "kf_amp_plate.png").convert("L")).astype(np.float32)
    dark = cv2.blur(plate, (25, 25)) < SKY_DARK
    rows = -(-dark.shape[0] // SKY_CELL)
    cols = -(-dark.shape[1] // SKY_CELL)
    bits = []
    for r in range(rows):
        for c in range(cols):
            cell = dark[r * SKY_CELL:(r + 1) * SKY_CELL, c * SKY_CELL:(c + 1) * SKY_CELL]
            bits.append(1 if cell.mean() >= SKY_SOLID else 0)
    packed = "".join(
        f"{sum(b << (3 - i) for i, b in enumerate(bits[k:k + 4])):x}"
        for k in range(0, len(bits), 4)
    )
    print(f"const STREAK_CELL = {SKY_CELL};")
    print(f"const STREAK_COLS = {cols};")
    print(f"const STREAK_DARK = '{packed}';   // {sum(bits)}/{len(bits)} cells")


def main() -> None:
    UI.mkdir(parents=True, exist_ok=True)
    ink = ink_of(SOURCE)
    build_word(ink)
    build_symbols(ink)
    build_trails(ink)
    build_sky()


if __name__ == "__main__":
    main()
