#!/usr/bin/env python3
"""Silhouette-IoU search: background-subtraction foreground vs keyframe silhouette."""
import sys, numpy as np, cv2
from PIL import Image

W = '/private/tmp/claude-501/-Users-pita-Desktop-pitalva-3/58707d15-4626-4f5f-b1f9-294474df67fc/scratchpad'
SW, SH = 240, 135


def load(name):
    return np.fromfile(f'{W}/raw/{name}.gray', dtype=np.uint8).reshape(-1, SH, SW)


def kf_sil(path, thr=0.22, sigma=3.0):
    k = np.array(Image.open(path).convert('L').resize((SW, SH), Image.BOX), np.float32) / 255.
    k = cv2.GaussianBlur(k, (0, 0), sigma)
    return (k > thr)


def run(kfpath, vid, x0=0.12, x1=0.88, y0=0.0, y1=1.0, topn=15, diffthr=18):
    arr = load(vid).astype(np.float32)
    bg = np.median(arr[::7], axis=0)
    S = kf_sil(kfpath)
    m = np.zeros((SH, SW), bool)
    m[int(y0 * SH):int(y1 * SH), int(x0 * SW):int(x1 * SW)] = True
    S = S & m
    out = []
    for n in range(arr.shape[0]):
        F = (np.abs(arr[n] - bg) > diffthr)
        F = cv2.morphologyEx(F.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8)).astype(bool) & m
        inter = np.count_nonzero(S & F)
        union = np.count_nonzero(S | F)
        out.append((inter / max(union, 1), n))
    out.sort(reverse=True)
    return out[:topn]


if __name__ == '__main__':
    kf, vid = sys.argv[1], sys.argv[2]
    for s, n in run(kf, vid):
        print(f'{n:6d}  {s:.4f}')
