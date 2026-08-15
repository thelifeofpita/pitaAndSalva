#!/usr/bin/env python3
"""Multi-scale template search: keyframe silhouette vs bg-subtracted foreground.

Finds (frame, scale, x, y) of the 4K-crop region that produced a keyframe.
Coordinates reported in *source video* pixel space (3840x2160 or native).
"""
import sys, numpy as np, cv2
from PIL import Image

W = '/private/tmp/claude-501/-Users-pita-Desktop-pitalva-3/58707d15-4626-4f5f-b1f9-294474df67fc/scratchpad'
SW, SH = 240, 135


def load(name):
    return np.fromfile(f'{W}/raw/{name}.gray', dtype=np.uint8).reshape(-1, SH, SW)


def run(kfpath, vid, scales, step=1, diffthr=18, topn=10, sigma=3.0, kthr=0.22):
    arr = load(vid).astype(np.float32)
    bg = np.median(arr[::7], axis=0)
    k = np.array(Image.open(kfpath).convert('L').resize((SW, SH), Image.BOX), np.float32) / 255.
    k = cv2.GaussianBlur(k, (0, 0), sigma)
    K0 = (k > kthr).astype(np.float32)
    tmpls = []
    for s in scales:
        w = int(round(SW * s)); h = int(round(SH * s))
        tmpls.append((s, cv2.resize(K0, (w, h), interpolation=cv2.INTER_AREA)))
    out = []
    for n in range(0, arr.shape[0], step):
        F = (np.abs(arr[n] - bg) > diffthr).astype(np.uint8)
        F = cv2.morphologyEx(F, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8)).astype(np.float32)
        for s, T in tmpls:
            r = cv2.matchTemplate(F, T, cv2.TM_CCOEFF_NORMED)
            _, mx, _, loc = cv2.minMaxLoc(r)
            out.append((float(mx), n, s, loc[0], loc[1]))
    out.sort(reverse=True)
    return out[:topn]


if __name__ == '__main__':
    kf, vid = sys.argv[1], sys.argv[2]
    step = int(sys.argv[3]) if len(sys.argv) > 3 else 2
    scales = [round(x, 3) for x in np.arange(0.40, 0.86, 0.05)]
    if len(sys.argv) > 4:
        scales = [float(x) for x in sys.argv[4].split(',')]
    for sc, n, s, x, y in run(kf, vid, scales, step):
        print(f'frame {n:6d} score {sc:.4f} scale {s:.3f} crop@small ({x},{y})')
