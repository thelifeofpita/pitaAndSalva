#!/usr/bin/env python3
"""Calibrate (black-floor, T, sigma) fast, via a 256-entry LUT per parameter set."""
import sys, numpy as np, cv2
from PIL import Image
from math import erf
from calib import prep

DS = 4
LV = np.arange(256, dtype=np.float32)
_erf = np.vectorize(erf)


def lut(lo, T, S):
    p = 0.5 * (1 + _erf((LV - T) / (S * np.sqrt(2))))
    p[LV < lo] = 0.0
    return p.astype(np.float32)


def calibrate(kfpath, video, frame, crop, blur=1.5):
    g, m = prep(video, frame, crop)
    gi = np.clip(g, 0, 255).astype(np.uint8)
    k = (np.array(Image.open(kfpath).convert('L')) > 127).astype(np.float32)
    k = cv2.resize(k, (1920, 1080), interpolation=cv2.INTER_NEAREST)
    K = cv2.GaussianBlur(cv2.resize(k, (1920 // DS, 1080 // DS),
                                    interpolation=cv2.INTER_AREA), (0, 0), blur)
    mf = m.astype(np.float32) / 255.
    best = None
    for lo in [0, 60, 80, 95, 110, 120, 130, 140, 150, 160]:
        for T in range(120, 245, 2):
            for S in [4, 6, 8, 10, 12, 15, 18, 22, 26, 32]:
                p = lut(lo, T, S)[gi] * mf
                P = cv2.GaussianBlur(cv2.resize(p, (1920 // DS, 1080 // DS),
                                                interpolation=cv2.INTER_AREA), (0, 0), blur)
                e = float(np.abs(P - K).mean())
                if best is None or e < best[0]:
                    best = (e, lo, T, S)
    return best


if __name__ == '__main__':
    kf, video, frame = sys.argv[1], sys.argv[2], int(sys.argv[3])
    crop = tuple(int(x) for x in sys.argv[4].split(':'))
    e, lo, T, S = calibrate(kf, video, frame, crop)
    print(f'lo={lo} T={T} sigma={S}  blurdiff={e:.5f}')
