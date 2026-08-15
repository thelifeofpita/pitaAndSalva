#!/usr/bin/env python3
"""Choose the dap frame sequences from the cutout scan produced by dapscan.py.

Two measurements, both taken from the real Vision cutout (background
subtraction is not usable: a torso moving off bright wall reads as motion even
though nothing renders, which is how hands ended up out of frame):

  coverage  — how much of the landing crop is renderable subject. Guards against
              frames where the hands are outside the crop.
  change    — how much the visible silhouette differs between consecutive picks.
              Ranks daps by how much actually happens in them.
"""
import os, sys, numpy as np, cv2
from PIL import Image

W = '/private/tmp/claude-501/-Users-pita-Desktop-pitalva-3/58707d15-4626-4f5f-b1f9-294474df67fc/scratchpad'
TMP = f'{W}/dapscan_tmp'
STEP = 6
NF = 8
CX, CY, CW, CH = 450, 360, 960, 540          # landing crop, at the 1080p scan size
SHAPE_CACHE = f'{W}/dapshapes.npy'


def shapes():
    """Small binary stack of the visible subject, one per scanned frame."""
    if os.path.exists(SHAPE_CACHE):
        return np.load(SHAPE_CACHE)
    files = sorted(f for f in os.listdir(TMP) if f.endswith('.jpg'))
    out = np.zeros((len(files), 54, 96), bool)
    for i, f in enumerate(files):
        p = f'{TMP}/{f}'; mp = p[:-4] + '_m.png'
        g = np.array(Image.open(p).convert('L'))[CY:CY + CH, CX:CX + CW]
        if os.path.exists(mp):
            m = np.array(Image.open(mp).convert('L'))
            if m.shape != (1080, 1920):
                m = cv2.resize(m, (1920, 1080))
            m = m[CY:CY + CH, CX:CX + CW]
        else:
            m = np.zeros_like(g)
        v = ((m > 127) & (g > 140)).astype(np.uint8)
        out[i] = cv2.resize(v, (96, 54), interpolation=cv2.INTER_AREA) > 0.4
    np.save(SHAPE_CACHE, out)
    return out


def pick(n_daps=5, min_span=8, max_span=26):
    cov = np.load(f'{W}/dapscan.npy')
    sh = shapes()
    N = len(cov)
    P = float(np.percentile(cov, 80))
    rest = cov >= 0.90 * P
    live = cov >= 0.62 * P                    # hands clearly readable in frame

    settles = []
    i = 0
    while i < N:
        if rest[i]:
            j = i
            while j + 1 < N and rest[j + 1]:
                j += 1
            if j - i >= 2:
                settles.append((i, j))
            i = j + 1
        else:
            i += 1

    cands = []
    for si, sj in settles:
        end = min(N - 1, si + 2)
        start = end
        while start > 0 and live[start - 1] and end - start < max_span:
            start -= 1
        if end - start < min_span:
            continue
        idx = [int(round(start + (end - start) * k / (NF - 1))) for k in range(NF)]
        idx = sorted(set(idx))
        if len(idx) < NF:
            continue
        change = float(np.mean([np.mean(sh[a] ^ sh[b])
                                for a, b in zip(idx, idx[1:])]))
        dip = float(cov[idx].min() / P)
        # both hands have to be on screen in every frame we keep — a dap where
        # one arm swings out of the crop reads as broken, not as style
        half = sh.shape[2] // 2
        lr = min(min(sh[i][:, :half].mean(), sh[i][:, half:].mean()) for i in idx)
        cands.append(dict(idx=idx, change=change, dip=dip, lr=float(lr), end=end))

    cands = [c for c in cands if c['dip'] >= 0.62 and c['lr'] >= 0.12]
    cands.sort(key=lambda c: -c['change'])
    picked = []
    for c in cands:
        if any(abs(c['end'] - p['end']) < 30 for p in picked):
            continue
        picked.append(c)
        if len(picked) == n_daps:
            break
    return P, picked


if __name__ == '__main__':
    P, picked = pick(int(sys.argv[1]) if len(sys.argv) > 1 else 5)
    print(f'resting coverage P={P:.3f}')
    for c in picked:
        print(f"  change={c['change']:.3f} dip={c['dip']:.2f} lr={c['lr']:.2f} "
              f"frames={[i * STEP for i in c['idx']]}")
    print('\nDAP_FRAMES = [')
    for c in picked:
        print('    %s,' % [i * STEP for i in c['idx']])
    print(']')
