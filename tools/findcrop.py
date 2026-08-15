#!/usr/bin/env python3
"""Find (frame, crop-width, x, y) mapping a keyframe onto a source video frame,
using Vision foreground masks (works with a moving camera)."""
import sys, os, subprocess, tempfile, numpy as np, cv2
from PIL import Image

W = '/private/tmp/claude-501/-Users-pita-Desktop-pitalva-3/58707d15-4626-4f5f-b1f9-294474df67fc/scratchpad'
VID = '/Users/pita/Desktop/pitalva_3/videos'


def cache_frames(video, frames, cdir, f=4):
    os.makedirs(cdir, exist_ok=True)
    todo = [n for n in frames if not os.path.exists(f'{cdir}/{n:06d}.npz')]
    for chunk in [todo[i:i + 60] for i in range(0, len(todo), 60)]:
        if not chunk:
            continue
        tmp = tempfile.mkdtemp()
        sel = '+'.join(f'eq(n\\,{n})' for n in chunk)
        subprocess.run(['ffmpeg', '-v', 'error', '-i', f'{VID}/{video}.MOV',
                        '-vf', f"select='{sel}'", '-vsync', '0', '-y',
                        f'{tmp}/%04d.png'], check=True)
        files = sorted(os.listdir(tmp))
        assert len(files) == len(chunk), (len(files), len(chunk))
        for fn, n in zip(files, chunk):
            p = f'{tmp}/{fn}'; mp = p[:-4] + '_m.png'
            subprocess.run([f'{W}/venv/bin/python', f'{W}/seg.py', p, mp],
                           capture_output=True)
            img = np.array(Image.open(p).convert('RGB'))
            m = (np.array(Image.open(mp).convert('L')) if os.path.exists(mp)
                 else np.zeros(img.shape[:2], np.uint8))
            if m.shape != img.shape[:2]:
                m = cv2.resize(m, (img.shape[1], img.shape[0]))
            g = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
            H, Wd = g.shape
            g = cv2.resize(g, (Wd // f, H // f), interpolation=cv2.INTER_AREA)
            m = cv2.resize(m, (Wd // f, H // f), interpolation=cv2.INTER_AREA)
            np.savez_compressed(f'{cdir}/{n:06d}.npz', g=g, m=m)
            os.remove(p); os.remove(mp) if os.path.exists(mp) else None
        subprocess.run(['rm', '-rf', tmp])


def run(kfpath, video, frames, cdir, widths, f=4, blur=4.0, topn=12):
    cache_frames(video, frames, cdir, f)
    kb = (np.array(Image.open(kfpath).convert('L')) > 127).astype(np.float32)
    KH, KW = kb.shape
    out = []
    for n in frames:
        d = np.load(f'{cdir}/{n:06d}.npz')
        g = d['g'].astype(np.float32); m = d['m'].astype(np.float32) / 255.
        D = cv2.GaussianBlur(g * m, (0, 0), blur)
        for cw in widths:
            ch = int(round(cw * KH / KW))
            tw, th = cw // f, ch // f
            if tw > D.shape[1] or th > D.shape[0]:
                continue
            T = cv2.resize(kb, (tw, th), interpolation=cv2.INTER_AREA)
            T = cv2.GaussianBlur(T, (0, 0), blur * tw / KW * f)
            r = cv2.matchTemplate(D, T, cv2.TM_CCOEFF_NORMED)
            _, mx, _, loc = cv2.minMaxLoc(r)
            out.append((float(mx), n, cw, loc[0] * f, loc[1] * f))
    out.sort(reverse=True)
    return out[:topn]


if __name__ == '__main__':
    kf, video = sys.argv[1], sys.argv[2]
    a, b, st = [int(x) for x in sys.argv[3].split(',')]
    cdir = sys.argv[4]
    widths = [int(x) for x in sys.argv[5].split(',')] if len(sys.argv) > 5 else \
        list(range(1920, 3841, 120))
    for s, n, cw, x, y in run(kf, video, list(range(a, b, st)), cdir, widths):
        print(f'frame {n:6d} score {s:.4f} crop {cw}x{int(round(cw*9/16))}+{x}+{y}')
