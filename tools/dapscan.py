#!/usr/bin/env python3
"""Sweep daps.MOV and measure, per frame, how much of the landing crop is
actually *renderable* subject (inside the Vision cutout AND bright enough to
survive the black floor). Background-subtraction can't tell hands from wall
revealed by a moving torso, so this uses the real mask."""
import os, subprocess, tempfile, numpy as np, cv2
from PIL import Image

W = '/private/tmp/claude-501/-Users-pita-Desktop-pitalva-3/58707d15-4626-4f5f-b1f9-294474df67fc/scratchpad'
VID = '/Users/pita/Desktop/pitalva_3/videos/daps.MOV'
STEP = 6
N = 6883
# landing crop 1920x1080 @ (900,720) in 4K -> half that at 1920x1080 decode
CX, CY, CW, CH = 450, 360, 960, 540
OUT = f'{W}/dapscan.npy'

tmp = f'{W}/dapscan_tmp'
os.makedirs(tmp, exist_ok=True)
if not os.listdir(tmp):
    subprocess.run(['ffmpeg', '-v', 'error', '-i', VID, '-vf',
                    f"select='not(mod(n\\,{STEP}))',scale=1920:1080", '-vsync', '0',
                    '-q:v', '4', '-y', f'{tmp}/%05d.jpg'], check=True)
files = sorted(f for f in os.listdir(tmp) if f.endswith('.jpg'))
print('frames', len(files), flush=True)

cov = np.zeros(len(files), np.float32)
band = slice(int(0.18 * CW), int(0.82 * CW))
for i, f in enumerate(files):
    p = f'{tmp}/{f}'; mp = p[:-4] + '_m.png'
    if not os.path.exists(mp):
        subprocess.run([f'{W}/venv/bin/python', f'{W}/seg.py', p, mp],
                       capture_output=True)
    g = np.array(Image.open(p).convert('L'))[CY:CY + CH, CX:CX + CW]
    if os.path.exists(mp):
        m = np.array(Image.open(mp).convert('L'))
        if m.shape != (1080, 1920):
            m = cv2.resize(m, (1920, 1080))
        m = m[CY:CY + CH, CX:CX + CW]
    else:
        m = np.zeros_like(g)
    cov[i] = ((m > 127) & (g > 140))[:, band].mean()
    if i % 100 == 0:
        print(i, round(float(cov[i]), 3), flush=True)
np.save(OUT, cov)
print('saved', OUT)
