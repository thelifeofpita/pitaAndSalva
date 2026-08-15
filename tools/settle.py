#!/usr/bin/env python3
"""Find, for a given dap, the frame that best matches the idle pose.

The last frame of a dap has to land on the idle hands or the cut to the landing
plate reads as the dap getting chopped. This scores candidate frames by IoU of
the rendered silhouette against the landing plate itself.
"""
import os, sys, numpy as np, cv2
from PIL import Image

W = '/private/tmp/claude-501/-Users-pita-Desktop-pitalva-3/58707d15-4626-4f5f-b1f9-294474df67fc/scratchpad'
SITE = '/Users/pita/Desktop/pitalva_3/site'
STEP = 6
CX, CY, CW, CH = 450, 360, 960, 540           # landing crop at the 1080p scan size
SW, SH = 96, 54


def plate():
    p = np.array(Image.open(f'{SITE}/img/landing_plate.png').convert('L')) > 127
    return cv2.resize(p.astype(np.uint8), (SW, SH), interpolation=cv2.INTER_AREA) > 0.4


def shapes():
    """Crop-space silhouettes for every scanned frame (cached by pickdaps)."""
    c = f'{W}/dapshapes.npy'
    if os.path.exists(c):
        return np.load(c)
    import pickdaps
    return pickdaps.shapes()


def iou(a, b):
    u = np.count_nonzero(a | b)
    return np.count_nonzero(a & b) / u if u else 0.0


def best_settle(after_frame, span=260, topn=6):
    """Best idle-matching frames in the window following `after_frame`."""
    sh = shapes(); P = plate()
    lo, hi = after_frame // STEP, min(len(sh) - 1, (after_frame + span) // STEP)
    out = [(iou(sh[i], P), i * STEP) for i in range(lo, hi + 1)]
    out.sort(reverse=True)
    return out[:topn]


if __name__ == '__main__':
    for f in [int(x) for x in sys.argv[1:]]:
        print(f'after {f}:', [(round(s, 3), n) for s, n in best_settle(f)])
