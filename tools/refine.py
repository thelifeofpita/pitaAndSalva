#!/usr/bin/env python3
"""Fine local search over (crop width, x, y) for one video frame vs a keyframe."""
import sys, subprocess, numpy as np, cv2
from PIL import Image

W = '/private/tmp/claude-501/-Users-pita-Desktop-pitalva-3/58707d15-4626-4f5f-b1f9-294474df67fc/scratchpad'
VID = '/Users/pita/Desktop/pitalva_3/videos'


def frame_data(video, frame):
    p = f'{W}/_r.png'
    subprocess.run(['ffmpeg', '-v', 'error', '-i', f'{VID}/{video}.MOV',
                    '-vf', f"select='eq(n\\,{frame})'", '-frames:v', '1', '-y', p],
                   check=True)
    subprocess.run([f'{W}/venv/bin/python', f'{W}/seg.py', p, f'{W}/_r_m.png'],
                   check=True)
    img = np.array(Image.open(p).convert('RGB'))
    m = np.array(Image.open(f'{W}/_r_m.png').convert('L'))
    if m.shape != img.shape[:2]:
        m = cv2.resize(m, (img.shape[1], img.shape[0]))
    g = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY).astype(np.float32)
    return g * (m.astype(np.float32) / 255.)


def score(D, kfB, cw, cx, cy, ow=480, blur=3.0):
    ch = int(round(cw * 1080 / 1920))
    H, Wd = D.shape
    if cx < 0 or cy < 0 or cx + cw > Wd or cy + ch > H:
        return -1
    sub = cv2.resize(D[cy:cy + ch, cx:cx + cw], (ow, int(ow * 1080 / 1920)),
                     interpolation=cv2.INTER_AREA)
    sub = cv2.GaussianBlur(sub, (0, 0), blur)
    a = sub - sub.mean(); b = kfB - kfB.mean()
    return float((a * b).sum() / (np.sqrt((a * a).sum() * (b * b).sum()) + 1e-9))


def refine(kfpath, video, frame, cw0, cx0, cy0, span=None, ow=480):
    D = frame_data(video, frame)
    k = (np.array(Image.open(kfpath).convert('L')) > 127).astype(np.float32)
    kfB = cv2.GaussianBlur(cv2.resize(k, (ow, int(ow * 1080 / 1920)),
                                      interpolation=cv2.INTER_AREA), (0, 0), 3.0)
    step = max(2, cw0 // 240)
    best = (score(D, kfB, cw0, cx0, cy0, ow), cw0, cx0, cy0)
    for it in range(6):
        improved = False
        for dw in (-step * 2, -step, 0, step, step * 2):
            for dx in (-step * 2, -step, 0, step, step * 2):
                for dy in (-step * 2, -step, 0, step, step * 2):
                    cw, cx, cy = best[1] + dw, best[2] + dx, best[3] + dy
                    if cw < 200:
                        continue
                    s = score(D, kfB, cw, cx, cy, ow)
                    if s > best[0]:
                        best = (s, cw, cx, cy); improved = True
        if not improved:
            if step == 1:
                break
            step = max(1, step // 2)
    return best


if __name__ == '__main__':
    kf, video, frame = sys.argv[1], sys.argv[2], int(sys.argv[3])
    cw, cx, cy = [int(x) for x in sys.argv[4].split(':')]
    s, cw, cx, cy = refine(kf, video, frame, cw, cx, cy)
    print(f'score {s:.4f}  crop {cw}x{int(round(cw*1080/1920))}+{cx}+{cy}')
