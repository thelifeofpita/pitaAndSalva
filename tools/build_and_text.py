#!/usr/bin/env python3
"""Build the eight live About/ampersand copy cutouts from the source photo."""

from pathlib import Path

import cv2
import numpy as np


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets" / "and_text_2.jpeg"
OUT = ROOT / "site" / "img" / "and_text"

# The blocks in the source, in reading order. The generous vertical bounds keep
# punctuation and the natural tilt of the handwriting while excluding the next
# phrase. Target widths are the actual on-stage sizes in the 1920 x 1080 layout.
PHRASES = (
    (80, 325, 460),
    (340, 980, 545),
    (1050, 1400, 550),
    (1450, 1790, 520),
    (1810, 2150, 600),
    (2170, 2325, 525),
    (2350, 3200, 570),
    (3260, 3435, 555),
)


def remove_specks(mask: np.ndarray, minimum_area: int = 20) -> np.ndarray:
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
    keep = np.zeros(count, dtype=np.uint8)
    keep[1:] = stats[1:, cv2.CC_STAT_AREA] >= minimum_area
    return keep[labels] * 255


def tight_crop(mask: np.ndarray, padding: int = 10) -> np.ndarray:
    ys, xs = np.nonzero(mask)
    if not len(xs):
        raise RuntimeError("No handwriting found in phrase crop")
    x0 = max(0, int(xs.min()) - padding)
    x1 = min(mask.shape[1], int(xs.max()) + padding + 1)
    y0 = max(0, int(ys.min()) - padding)
    y1 = min(mask.shape[0], int(ys.max()) + padding + 1)
    return mask[y0:y1, x0:x1]


def join_words(*groups: np.ndarray, gap: int = 65) -> np.ndarray:
    """Join photographed word groups on a shared handwritten baseline."""
    height = max(group.shape[0] for group in groups)
    width = sum(group.shape[1] for group in groups) + gap * (len(groups) - 1)
    line = np.zeros((height, width), dtype=np.uint8)
    left = 0
    for group in groups:
        top = height - group.shape[0]
        line[top:, left:left + group.shape[1]] = group
        left += group.shape[1] + gap
    return line


def recompose_fantasy_paragraph(mask: np.ndarray) -> np.ndarray:
    """Reflow the long sentence into four similarly weighted handwritten lines."""
    group = lambda y0, y1, x0, x1: tight_crop(
        mask[y0:y1, x0:x1], padding=2
    ).copy()

    lines = (
        group(20, 170, 60, 2120),
        join_words(
            group(180, 350, 60, 2010),       # fantasy ideas … budgets
            group(350, 530, 50, 275),        # for
        ),
        join_words(
            group(350, 530, 285, 2030),      # fantasy people … the
            group(530, 710, 45, 500),        # fantasy
        ),
        join_words(
            group(530, 710, 520, 1950),      # minds … so-called
            group(710, 840, 45, 680),        # creatives.
        ),
    )

    line_gap = 48
    width = max(line.shape[1] for line in lines)
    height = sum(line.shape[0] for line in lines) + line_gap * (len(lines) - 1)
    result = np.zeros((height, width), dtype=np.uint8)
    top = 0
    for line in lines:
        result[top:top + line.shape[0], :line.shape[1]] = line
        top += line.shape[0] + line_gap
    return result


def main() -> None:
    gray = cv2.imread(str(SOURCE), cv2.IMREAD_GRAYSCALE)
    if gray is None:
        raise FileNotFoundError(SOURCE)

    # Local thresholding removes the paper and the phone-photo lighting without
    # flattening the lighter pen strokes. The site uses true 1-bit artwork, so
    # the result is deliberately hard white ink on hard black, not antialiased.
    ink = cv2.adaptiveThreshold(
        gray,
        255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY_INV,
        61,
        12,
    )
    ink = remove_specks(ink)

    OUT.mkdir(parents=True, exist_ok=True)
    for number, (top, bottom, target_width) in enumerate(PHRASES, 1):
        phrase = ink[top:bottom]
        if number == 7:
            phrase = recompose_fantasy_paragraph(phrase)
        phrase = tight_crop(phrase)
        target_height = round(phrase.shape[0] * target_width / phrase.shape[1])
        phrase = cv2.resize(
            phrase, (target_width, target_height), interpolation=cv2.INTER_AREA
        )
        _, phrase = cv2.threshold(phrase, 96, 255, cv2.THRESH_BINARY)
        cv2.imwrite(str(OUT / f"phrase_{number:02}.png"), phrase)


if __name__ == "__main__":
    main()
