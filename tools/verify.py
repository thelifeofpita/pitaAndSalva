#!/usr/bin/env python3
"""Render one (video, frame, crop) with the art-direction pipeline and build a
side-by-side + overlay comparison against a keyframe."""
import sys, subprocess, numpy as np, cv2
from PIL import Image
from math import erf

W = '/private/tmp/claude-501/-Users-pita-Desktop-pitalva-3/58707d15-4626-4f5f-b1f9-294474df67fc/scratchpad'
VID = '/Users/pita/Desktop/pitalva_3/videos'
_erf = np.vectorize(erf)


def phi(z):
    return 0.5 * (1 + _erf(z / np.sqrt(2)))


def render(video, frame, crop, T=196, S=12, out=None, seed=7):
    p = f'{W}/_v.png'
    subprocess.run(['ffmpeg', '-v', 'error', '-i', f'{VID}/{video}.MOV',
                    '-vf', f"select='eq(n\\,{frame})'", '-frames:v', '1', '-y', p],
                   check=True)
    subprocess.run([f'{W}/venv/bin/python', f'{W}/seg.py', p, f'{W}/_v_m.png'],
                   check=True)
    img = np.array(Image.open(p).convert('RGB'))
    m = np.array(Image.open(f'{W}/_v_m.png').convert('L'))
    if m.shape != img.shape[:2]:
        m = cv2.resize(m, (img.shape[1], img.shape[0]))
    cw, ch, cx, cy = crop
    img = img[cy:cy + ch, cx:cx + cw]
    m = m[cy:cy + ch, cx:cx + cw]
    img = cv2.resize(img, (1920, 1080), interpolation=cv2.INTER_AREA if cw > 1920 else cv2.INTER_CUBIC)
    m = cv2.resize(m, (1920, 1080), interpolation=cv2.INTER_AREA if cw > 1920 else cv2.INTER_CUBIC)
    g = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY).astype(np.float32)
    rng = np.random.default_rng(seed)
    pr = phi((g - T) / S) * (m.astype(np.float32) / 255.)
    white = (rng.random(g.shape, dtype=np.float32) < pr)
    o = (white * 255).astype(np.uint8)
    if out:
        Image.fromarray(o).save(out)
    return o


if __name__ == '__main__':
    kf, video, frame = sys.argv[1], sys.argv[2], int(sys.argv[3])
    crop = tuple(int(x) for x in sys.argv[4].split(':'))
    T = float(sys.argv[5]) if len(sys.argv) > 5 else 196
    S = float(sys.argv[6]) if len(sys.argv) > 6 else 12
    o = render(video, frame, crop, T, S)
    k = np.array(Image.open(kf).convert('L').resize((1920, 1080)))
    kb = (k > 127).astype(np.float32)
    ob = (o > 127).astype(np.float32)
    d = cv2.GaussianBlur(kb, (0, 0), 6) - cv2.GaussianBlur(ob, (0, 0), 6)
    print('white frac kf %.4f render %.4f  blurdiff %.4f' %
          (kb.mean(), ob.mean(), np.abs(d).mean()))
    sbs = Image.new('L', (1920, 2160))
    sbs.paste(Image.fromarray((kb * 255).astype(np.uint8)), (0, 0))
    sbs.paste(Image.fromarray(o), (0, 1080))
    sbs.resize((960, 1080)).save(f'{W}/_v_sbs.png')
    ov = np.dstack([(kb * 255).astype(np.uint8), o, np.zeros_like(o)])
    Image.fromarray(ov).resize((1280, 720)).save(f'{W}/_v_ov.png')
