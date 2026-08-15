#!/usr/bin/env python3
"""NCC search of a keyframe against pre-decoded 240x135 gray raw videos."""
import sys, numpy as np
from PIL import Image
import cv2

W = '/private/tmp/claude-501/-Users-pita-Desktop-pitalva-3/58707d15-4626-4f5f-b1f9-294474df67fc/scratchpad'
SW, SH = 240, 135


def load(name):
    a = np.fromfile(f'{W}/raw/{name}.gray', dtype=np.uint8)
    return a.reshape(-1, SH, SW)


def norm(g, sigma=2.0):
    g = cv2.GaussianBlur(g.astype(np.float32), (0, 0), sigma)
    return (g - g.mean()) / (g.std() + 1e-6)


def run(kfpath, vids, topn=12, sigma=2.0):
    k = np.array(Image.open(kfpath).convert('L').resize((SW, SH), Image.BOX))
    k = norm(k, sigma)
    out = []
    for v in vids:
        arr = load(v)
        for n in range(arr.shape[0]):
            g = norm(arr[n], sigma)
            out.append((float((k * g).mean()), v, n))
    out.sort(reverse=True)
    return out[:topn]


if __name__ == '__main__':
    kf = sys.argv[1]
    vids = sys.argv[2].split(',')
    for s, v, n in run(kf, vids, int(sys.argv[3]) if len(sys.argv) > 3 else 12):
        print(f'{v:12s} {n:6d}  {s:.4f}')
