#!/usr/bin/env python3
"""Calibrate (T, sigma) for a keyframe by matching the local white-density
distribution of the render to the keyframe's, inside the subject mask."""
import sys, subprocess, numpy as np, cv2
from PIL import Image
from math import erf

W = '/private/tmp/claude-501/-Users-pita-Desktop-pitalva-3/58707d15-4626-4f5f-b1f9-294474df67fc/scratchpad'
VID = '/Users/pita/Desktop/pitalva_3/videos'
_erf = np.vectorize(erf)


def phi(z):
    return 0.5 * (1 + _erf(z / np.sqrt(2)))


def prep(video, frame, crop):
    p = f'{W}/_c.png'
    subprocess.run(['ffmpeg', '-v', 'error', '-i', f'{VID}/{video}.MOV',
                    '-vf', f"select='eq(n\\,{frame})'", '-frames:v', '1', '-y', p],
                   check=True)
    subprocess.run([f'{W}/venv/bin/python', f'{W}/seg.py', p, f'{W}/_c_m.png'],
                   check=True)
    img = np.array(Image.open(p).convert('RGB'))
    m = np.array(Image.open(f'{W}/_c_m.png').convert('L'))
    if m.shape != img.shape[:2]:
        m = cv2.resize(m, (img.shape[1], img.shape[0]))
    cw, ch, cx, cy = crop
    img = img[cy:cy + ch, cx:cx + cw]; m = m[cy:cy + ch, cx:cx + cw]
    it = cv2.INTER_AREA if cw > 1920 else cv2.INTER_CUBIC
    img = cv2.resize(img, (1920, 1080), interpolation=it)
    m = cv2.resize(m, (1920, 1080), interpolation=it)
    return cv2.cvtColor(img, cv2.COLOR_RGB2GRAY).astype(np.float32), m


def calibrate(kfpath, video, frame, crop, blur=3.0):
    g, m = prep(video, frame, crop)
    k = (np.array(Image.open(kfpath).convert('L')) > 127).astype(np.float32)
    k = cv2.resize(k, (1920, 1080), interpolation=cv2.INTER_NEAREST)
    mb = (m > 127)
    inner = cv2.erode(mb.astype(np.uint8), np.ones((15, 15), np.uint8)).astype(bool)
    if inner.sum() < 5000:
        inner = mb
    Dk = cv2.GaussianBlur(k, (0, 0), blur)
    hk, _ = np.histogram(Dk[inner], bins=20, range=(0, 1), density=True)
    ck = np.cumsum(hk)
    best = None
    mf = m.astype(np.float32) / 255.
    for T in range(120, 241, 2):
        for S in [4, 6, 8, 10, 12, 14, 17, 20, 24, 28, 34]:
            p = phi((g - T) / S) * mf
            D = cv2.GaussianBlur(p, (0, 0), blur)
            hp, _ = np.histogram(D[inner], bins=20, range=(0, 1), density=True)
            e = float(np.abs(ck - np.cumsum(hp)).sum())
            if best is None or e < best[0]:
                best = (e, T, S)
    return best


if __name__ == '__main__':
    kf, video, frame = sys.argv[1], sys.argv[2], int(sys.argv[3])
    crop = tuple(int(x) for x in sys.argv[4].split(':'))
    e, T, S = calibrate(kf, video, frame, crop)
    print(f'T={T} sigma={S}  err={e:.3f}')
