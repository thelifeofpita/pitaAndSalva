#!/usr/bin/env python3
"""Build every frame sequence for the pitalva site.

Art direction: subject cutout (macOS Vision) -> grayscale -> black floor ->
gaussian-noise threshold dither -> 1-bit white-on-black PNG at 1920x1080.
"""
import os, subprocess, tempfile, sys, json
import numpy as np, cv2
from PIL import Image
from math import erf

W = '/private/tmp/claude-501/-Users-pita-Desktop-pitalva-3/58707d15-4626-4f5f-b1f9-294474df67fc/scratchpad'
VID = '/Users/pita/Desktop/pitalva_3/videos'
SITE = '/Users/pita/Desktop/pitalva_3/site'
IMG = f'{SITE}/img'
FCACHE = f'{W}/fcache'
ERODE = 3          # px to pull the matte in, to kill the mask's white fringe
MAX_FIT = 1.30     # how far a dap's framing may widen before the hands read as lost
LV = np.arange(256, dtype=np.float32)
_erf = np.vectorize(erf)


def lut(lo, T, S):
    p = 0.5 * (1 + _erf((LV - T) / (S * np.sqrt(2)))).astype(np.float32)
    p[LV < lo] = 0.0
    return p.astype(np.float32)


def prefetch(video, frames):
    """Extract a set of exact frame numbers in a single decode pass."""
    d = f'{FCACHE}/{video}'
    os.makedirs(d, exist_ok=True)
    todo = sorted({n for n in frames if not os.path.exists(f'{d}/{n:06d}.jpg')})
    if not todo:
        return
    tmp = tempfile.mkdtemp()
    sel = '+'.join(f'eq(n\\,{n})' for n in todo)
    subprocess.run(['ffmpeg', '-v', 'error', '-i', f'{VID}/{video}.MOV',
                    '-vf', f"select='{sel}'", '-vsync', '0', '-q:v', '1',
                    '-y', f'{tmp}/%05d.jpg'], check=True)
    got = sorted(os.listdir(tmp))
    assert len(got) == len(todo), (video, len(got), len(todo))
    for fn, n in zip(got, todo):
        os.replace(f'{tmp}/{fn}', f'{d}/{n:06d}.jpg')
    subprocess.run(['rm', '-rf', tmp])


def get_frame(video, n):
    """Return (rgb, mask) at native resolution, cached on disk."""
    d = f'{FCACHE}/{video}'
    p, mp = f'{d}/{n:06d}.jpg', f'{d}/{n:06d}_m.png'
    if not os.path.exists(p):
        prefetch(video, [n])
    if not os.path.exists(mp):
        subprocess.run([f'{W}/venv/bin/python', f'{W}/seg.py', p, mp],
                       capture_output=True)
    img = np.array(Image.open(p).convert('RGB'))
    if os.path.exists(mp):
        m = np.array(Image.open(mp).convert('L'))
        if m.shape != img.shape[:2]:
            m = cv2.resize(m, (img.shape[1], img.shape[0]))
    else:
        m = np.zeros(img.shape[:2], np.uint8)
    return img, m


def prep(video, n, crop):
    img, m = get_frame(video, n)
    cw, ch, cx, cy = [int(round(v)) for v in crop]
    H, Wd = img.shape[:2]
    cx = max(0, min(cx, Wd - 1)); cy = max(0, min(cy, H - 1))
    cw = min(cw, Wd - cx); ch = min(ch, H - cy)
    sub = img[cy:cy + ch, cx:cx + cw]
    ms = m[cy:cy + ch, cx:cx + cw]
    it = cv2.INTER_AREA if cw > 1920 else cv2.INTER_CUBIC
    sub = cv2.resize(sub, (1920, 1080), interpolation=it)
    ms = cv2.resize(ms, (1920, 1080), interpolation=it)
    # Vision's mask sits a couple of pixels outside the subject, so the bright
    # wall just past the edge survives the threshold and draws a white outline
    # around everything. Pull the matte in before it is used.
    if ERODE:
        ms = cv2.erode(ms, np.ones((ERODE * 2 + 1,) * 2, np.uint8))
    if video == 'daps':
        # These takes contain only bare hands/arms against black shirts. Vision
        # correctly finds the people but can leave a bright shirt seam or a
        # sliver of wall inside its soft edge. Keep skin only *inside* the
        # already-eroded subject matte: this removes those outlines without
        # letting the skin-coloured brick background become foreground.
        Y, Cr, Cb = cv2.split(cv2.cvtColor(sub, cv2.COLOR_RGB2YCrCb))
        skin = ((Cr >= 128) & (Cr <= 180) &
                (Cb >= 70) & (Cb <= 135) & (Y >= 65) &
                (Cr.astype(np.int16) - Cb.astype(np.int16) >= 8))
        skin = cv2.morphologyEx(skin.astype(np.uint8), cv2.MORPH_CLOSE,
                                np.ones((5, 5), np.uint8))
        ms[skin == 0] = 0
        # A face glint or a few wall pixels can still satisfy both masks. Arms
        # are always large connected regions in this fixed crop, so discard
        # only isolated remnants; never erode the retained hand components.
        count, labels, stats, _ = cv2.connectedComponentsWithStats(
            (ms > 127).astype(np.uint8), 8)
        keep = np.zeros(ms.shape, bool)
        for i in range(1, count):
            if stats[i, cv2.CC_STAT_AREA] >= 8000:
                keep |= labels == i
        ms[~keep] = 0
    g = cv2.cvtColor(sub, cv2.COLOR_RGB2GRAY)
    return g, ms


def dither(g, m, L, rng):
    p = L[g] * (m.astype(np.float32) / 255.)
    return (rng.random(g.shape, dtype=np.float32) < p)


def save1bit(arr_bool, path):
    if not np.any(arr_bool):
        raise ValueError(f'refusing to write an empty animation frame: {path}')
    Image.fromarray((arr_bool * 255).astype(np.uint8)).convert('1').save(
        path, optimize=True, bits=1)


def ease(t):
    return t * t * (3 - 2 * t)


def interp_crops(c0, c1, n, easing=True):
    """Interpolate crop rectangles by centre + width."""
    out = []
    x0c, y0c = c0[2] + c0[0] / 2, c0[3] + c0[1] / 2
    x1c, y1c = c1[2] + c1[0] / 2, c1[3] + c1[1] / 2
    for i in range(n):
        t = i / (n - 1) if n > 1 else 1.0
        te = ease(t) if easing else t
        cw = c0[0] * (1 - te) + c1[0] * te
        ch = cw * 1080 / 1920
        xc = x0c * (1 - te) + x1c * te
        yc = y0c * (1 - te) + y1c * te
        out.append((cw, ch, xc - cw / 2, yc - ch / 2))
    return out


def centroid(video, n, thr=150):
    """Centre of the *visible* content: inside the subject mask and bright
    enough to survive the threshold (black clothing renders as nothing)."""
    img, m = get_frame(video, n)
    g = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
    vis = (m > 127) & (g > thr)
    vis = cv2.morphologyEx(vis.astype(np.uint8), cv2.MORPH_OPEN,
                           np.ones((15, 15), np.uint8))
    ys, xs = np.nonzero(vis)
    if len(xs) < 500:
        ys, xs = np.nonzero(m > 127)
    if len(xs) == 0:
        h, w = m.shape
        return w / 2, h / 2
    lo_x, hi_x = np.percentile(xs, [2, 98])
    lo_y, hi_y = np.percentile(ys, [2, 98])
    return float((lo_x + hi_x) / 2), float((lo_y + hi_y) / 2)


def content_box(video, n, thr=150):
    """Bounding box of the renderable subject, in source pixels."""
    img, m = get_frame(video, n)
    g = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
    vis = (m > 127) & (g > thr)
    vis = cv2.morphologyEx(vis.astype(np.uint8), cv2.MORPH_OPEN,
                           np.ones((15, 15), np.uint8))
    ys, xs = np.nonzero(vis)
    if len(xs) < 500:
        return None
    return xs.min(), ys.min(), xs.max(), ys.max()


def fit_crops(video, frames, base, pad=40, settle=2):
    """Crop path for a dap: wide enough to hold the whole move, easing back to
    the landing framing so the last frame still cuts cleanly to the idle plate.

    A dap like the hand-fist-wiggle happens above the landing crop, so framing
    every frame like the landing chops the top off the movement.
    """
    bw, bh, bx, by = base
    boxes = [content_box(video, n) for n in frames]
    boxes = [b for b in boxes[:max(1, len(frames) - settle)] if b]
    x0, y0 = bx, by
    x1, y1 = bx + bw, by + bh
    for b in boxes:
        x0 = min(x0, b[0] - pad); y0 = min(y0, b[1] - pad)
        x1 = max(x1, b[2] + pad); y1 = max(y1, b[3] + pad)
    # grow to 16:9 around that union, never smaller than the landing crop
    cw = max(bw, x1 - x0, (y1 - y0) * 16 / 9)
    cw = min(cw, bw * MAX_FIT)
    ch = cw * 9 / 16
    cx = (x0 + x1) / 2 - cw / 2
    cy = (y0 + y1) / 2 - ch / 2
    img, _ = get_frame(video, frames[0])
    H, Wd = img.shape[:2]
    cw = min(cw, Wd); ch = cw * 9 / 16
    cx = max(0, min(Wd - cw, cx)); cy = max(0, min(H - ch, cy))
    action = (cw, ch, cx, cy)
    n = len(frames)
    out = []
    for i in range(n):
        # hold the wide framing through the move, then ease home over the tail
        t = 0.0 if i < n - 1 - settle else \
            ease((i - (n - 1 - settle)) / max(1, settle))
        out.append(tuple(a * (1 - t) + b * t for a, b in zip(action, base)))
    return out


def pan_crops(video, frames, base, settle=2, pad=30, smooth=2):
    """Constant-size crop that pans only as far as it must to keep the move in
    frame, then eases back onto the landing framing for the settle.

    Widening the crop instead (see fit_crops) keeps everything visible but
    shrinks the hands — on the up-and-down dap that read as the second hand
    disappearing. Panning holds the hands at the size they are in the idle
    plate, which is what the cut back to it needs.
    """
    bw, bh, bx, by = base
    img, _ = get_frame(video, frames[0])
    H, Wd = img.shape[:2]
    pos = []
    for n in frames:
        b = content_box(video, n)
        x, y = bx, by
        if b:
            if b[0] - pad < x:            x = b[0] - pad
            elif b[2] + pad > x + bw:     x = b[2] + pad - bw
            if b[1] - pad < y:            y = b[1] - pad
            elif b[3] + pad > y + bh:     y = b[3] + pad - bh
        pos.append([max(0, min(Wd - bw, x)), max(0, min(H - bh, y))])
    # take the sharpness out of the pan
    for _ in range(smooth):
        pos = [[(pos[max(0, i - 1)][k] + 2 * pos[i][k] + pos[min(len(pos) - 1, i + 1)][k]) / 4
                for k in (0, 1)] for i in range(len(pos))]
    out = []
    n = len(frames)
    for i, (x, y) in enumerate(pos):
        t = 0.0 if i < n - 1 - settle else ease((i - (n - 1 - settle)) / max(1, settle))
        out.append((bw, bh, x * (1 - t) + bx * t, y * (1 - t) + by * t))
    return out


def updown_crops(frames, base):
    """Framing for the complete two-hit up/down take.

    Its first hand rises near the top while the receiving hand waits near the
    bottom. The generic subject fit follows the upper body and clips that low
    hand. Hold a deliberately taller, lower action crop through both hits,
    then ease the camera back to the exact idle framing after the second hit.
    """
    # Nearly the full source height is necessary here: at each wind-up one
    # palm is high while the other waits below the opposite person's waist.
    action = (2880, 1620, 480, 400)
    settle_from = len(frames) - 3
    out = []
    for i in range(len(frames)):
        t = 0 if i <= settle_from else ease((i - settle_from) /
                                             (len(frames) - 1 - settle_from))
        out.append(tuple(a * (1 - t) + b * t
                         for a, b in zip(action, base)))
    return out


def snap_to_idle(video, frames, crops, tone, plate_path, tail=3, span=90, step=6):
    """Nudge the tail of a dap so its hands land on the idle pose.

    The take never returns to *exactly* the keyframe pose, so the cut to the
    landing plate jumps. Shifting the last few crops by the offset that best
    matches the plate closes that gap without touching the performance.
    """
    P = np.array(Image.open(plate_path).convert('L')) > 127
    Ps = cv2.resize(P.astype(np.uint8), (240, 135), interpolation=cv2.INTER_AREA) > .35
    L = lut(**tone)
    best = (None, -1)
    cw, ch, cx, cy = crops[-1]
    for dy in range(-span, span + 1, step):
        for dx in range(-span, span + 1, step):
            g, m = prep(video, frames[-1], (cw, ch, cx + dx, cy + dy))
            v = (m > 127) & (L[g] > .35)
            vs = cv2.resize(v.astype(np.uint8), (240, 135), interpolation=cv2.INTER_AREA) > .35
            u = np.count_nonzero(vs | Ps)
            sc = np.count_nonzero(vs & Ps) / u if u else 0
            if sc > best[1]:
                best = ((dx, dy), sc)
    (dx, dy), sc = best
    return apply_tail_offset(crops, (dx, dy), tail), (dx, dy), sc


def apply_tail_offset(crops, offset, tail=3):
    """Ease a reviewed alignment offset into the final photographed poses."""
    dx, dy = offset
    out = list(crops)
    for i in range(len(crops)):
        k = i - (len(crops) - 1 - tail)
        if k <= 0:
            continue
        t = ease(min(1.0, k / tail))
        w_, h_, x_, y_ = crops[i]
        out[i] = (w_, h_, x_ + dx * t, y_ + dy * t)
    return out


def tracked_crops(video, frames, c0, c1, easing=True):
    """Crop path anchored to the subject centroid, with exact endpoints."""
    cents = [centroid(video, n) for n in frames]
    off0 = (c0[2] + c0[0] / 2 - cents[0][0], c0[3] + c0[1] / 2 - cents[0][1])
    off1 = (c1[2] + c1[0] / 2 - cents[-1][0], c1[3] + c1[1] / 2 - cents[-1][1])
    out = []
    nn = len(frames)
    for i, (n, (px, py)) in enumerate(zip(frames, cents)):
        t = i / (nn - 1) if nn > 1 else 1.0
        te = ease(t) if easing else t
        cw = c0[0] * (1 - te) + c1[0] * te
        ch = cw * 1080 / 1920
        ox = off0[0] * (1 - te) + off1[0] * te
        oy = off0[1] * (1 - te) + off1[1] * te
        out.append((cw, ch, px + ox - cw / 2, py + oy - ch / 2))
    return out


def balanced_pair_crops(video, frames, c0, c1, smoothing=2):
    """Track the horizontal midpoint between two people with equal weight.

    A centroid of the whole foreground favors whichever person has more bright
    skin or clothing in a frame. For the high-angle two-shot, use the bounding
    centres of the two largest foreground components instead, average those
    centres equally, and smooth the path. Vertical motion remains the clean
    camera-rise interpolation so changing poses cannot make the crop bob.
    """
    base = interp_crops(c0, c1, len(frames))
    pair_x = []
    for n, crop in zip(frames, base):
        _, m = get_frame(video, n)
        count, _, stats, _ = cv2.connectedComponentsWithStats(
            (m > 127).astype(np.uint8), 8)
        parts = sorted(
            (stats[i] for i in range(1, count)
             if stats[i, cv2.CC_STAT_AREA] > 5000),
            key=lambda s: s[cv2.CC_STAT_AREA], reverse=True)[:2]
        if len(parts) == 2:
            centres = [p[cv2.CC_STAT_LEFT] + p[cv2.CC_STAT_WIDTH] / 2
                       for p in parts]
            pair_x.append(sum(centres) / 2)
        else:
            pair_x.append(crop[2] + crop[0] / 2)

    # Remove frame-to-frame mask noise without moving either exact endpoint.
    for _ in range(smoothing):
        pair_x = [pair_x[0]] + [
            (pair_x[i - 1] + 2 * pair_x[i] + pair_x[i + 1]) / 4
            for i in range(1, len(pair_x) - 1)] + [pair_x[-1]]

    start_centre = c0[2] + c0[0] / 2
    end_centre = c1[2] + c1[0] / 2
    offset0 = start_centre - pair_x[0]
    offset1 = end_centre - pair_x[-1]
    out = []
    for i, ((cw, ch, _, y), anchor) in enumerate(zip(base, pair_x)):
        t = i / (len(frames) - 1) if len(frames) > 1 else 1.0
        te = ease(t)
        offset = offset0 * (1 - te) + offset1 * te
        out.append((cw, ch, anchor + offset - cw / 2, y))
    return out


def interp_tone(t0, t1, n):
    out = []
    for i in range(n):
        t = ease(i / (n - 1)) if n > 1 else 1.0
        out.append(dict(lo=t0['lo'] * (1 - t) + t1['lo'] * t,
                        T=t0['T'] * (1 - t) + t1['T'] * t,
                        S=t0['S'] * (1 - t) + t1['S'] * t))
    return out


def build_seq(name, video, frames, crops, lo=None, T=None, S=None, tones=None,
              seed=None, outdir=None):
    outdir = outdir or IMG
    os.makedirs(outdir, exist_ok=True)
    prefetch(video, frames)
    if tones is None:
        tones = [dict(lo=lo, T=T, S=S)] * len(frames)
    rng = np.random.default_rng(seed if seed is not None else abs(hash(name)) % 10 ** 6)
    paths = []
    for i, (n, c) in enumerate(zip(frames, crops)):
        g, m = prep(video, n, c)
        b = dither(g, m, lut(**tones[i]), rng)
        p = f'{outdir}/{name}_{i:02d}.png'
        save1bit(b, p)
        paths.append(os.path.basename(p))
        print(f'  {name}_{i:02d}  frame {n}  crop {tuple(int(v) for v in c)}')
    return paths


# ---------------------------------------------------------------- sequences
# Explicit frame lists, chosen by tools/pickdaps.py: each dap starts with the
# hands already reading in the crop, works through the move, and settles on the
# default pose. Frame-exact; do not re-derive them from seek-based previews.
# The six daps, with frames picked at the extremes of each move — the hits and
# the furthest-apart points. Even spacing aliases an oscillation into stillness,
# which is why the wiggle and the wave read as nothing when sampled evenly.
DAP_FRAMES = [
    # handshake: reach, clasp, shake, release, settle
    [1734, 1752, 1764, 1776, 1788, 1806, 1848, 1896],
    # hand-fist-wiggle: open-hand hit, separate into fists, fist bump, finger
    # wiggle, then recover. Keep the whole edit inside this continuous take:
    # 2664/2700 belong to a later handshake and make the motion jump backwards.
    [2124, 2136, 2144, 2154, 2160, 2168, 2180, 2184, 2190, 2208],
    # snapping: thumb-hook grip, then the fingers slide and snap apart
    [4220, 4228, 4236, 4252, 4276, 4292, 4300, 4308, 4312],
    # waving: both palms up, apart, swaying at each other. Frame 4700 briefly
    # turns Salva's palm horizontal between vertical poses, so omit that hitch.
    [4706, 4712, 4718, 4726, 4734, 4742, 4750, 4758],
    # palm-and-back: two hits, with the hand flipping between them
    [5232, 5244, 5256, 5272, 5292, 5304, 5320, 5340],
    # up and down: a second take (6624-6788). The 5448-6072 one has the hands
    # far apart and one arm alone for most of it; here both stay in frame and
    # both hits land — up, down onto the hand, up again, second hit, settle
    [6637, 6640, 6652, 6660, 6662, 6680, 6687, 6696, 6708, 6712,
     6736, 6788],
]
DAP_CROP = (1920, 1080, 900, 720)
HANDS = dict(lo=140, T=196, S=14)
# Reviewed against the landing plate. Keeping these frame-exact offsets avoids
# re-running a thousand-crop search when only an earlier action pose changes.
DAP_IDLE_OFFSETS = [(42, -72), (-12, -292), (-48, 24),
                    (-18, -54), (-18, 0), (90, 90)]
RPS_CROP = (2680, 1508, 700, 390)
RPS_TONE = dict(lo=140, T=200, S=12)


def dap_frames(a, b, n=6):
    return [int(round(a + (b - a) * i / (n - 1))) for i in range(n)]


TRANS = {
    'pita': dict(video='pita', tone0=dict(lo=140, T=208, S=8),
                 tone1=dict(lo=80, T=162, S=22),
                 frames=[1272, 1288, 1310, 1372, 1404, 1440],
                 # Match the landing plate's hand scale and horizon before the
                 # camera pulls out. The old crop sat high and far right, so
                 # the reverse move ended on a visibly different pose.
                 c0=(2033, 1144, 366, 419), c1=(3240, 1822, 32, 44)),
    'salva': dict(video='salva', tone0=dict(lo=140, T=202, S=8),
                  tone1=dict(lo=80, T=162, S=22),
                  frames=[30, 100, 134, 165, 196, 250],
                  c0=(1860, 1046, 1100, 652), c1=(2760, 1552, 748, 24)),
    # the & move is a straight camera rise. Anchoring the crop to the subject
    # makes it chase whatever is brightest — a hand, then a face — so this one
    # interpolates the crop directly and lets the footage do the movement.
    'amp': dict(video='high_angle', balance_pair=True,
                tone0=dict(lo=140, T=194, S=14),
                tone1=dict(lo=0, T=182, S=22),
                frames=[18, 74, 118, 140, 160, 176, 190, 204, 216],
                c0=(1480, 832, 204, 212), c1=(560, 315, 675, 306)),
}


MANIFEST = f'{IMG}/frames.json'


def merge_manifest(part):
    """One manifest for the whole site, merged from the separate build steps —
    so the page can never reference a frame that is no longer built."""
    cur = {}
    if os.path.exists(MANIFEST):
        with open(MANIFEST) as f:
            cur = json.load(f)
    cur.update(part)
    with open(MANIFEST, 'w') as f:
        json.dump(cur, f, indent=1)
    return cur


def main(which=None):
    os.makedirs(IMG, exist_ok=True)
    manifest = {}
    if which and which.startswith('dap') and which[3:].isdigit():
        i = int(which[3:])
        if not 0 <= i < len(DAP_FRAMES):
            raise ValueError(f'unknown dap index: {i}')
        fr = DAP_FRAMES[i]
        # `fit_crops` inspects every source pose. Decode missing frames in one
        # forward pass first; seeking from frame zero once per anticipation
        # pose is both needlessly slow and vulnerable to an interrupted build.
        prefetch('daps', fr)
        cs = updown_crops(fr, DAP_CROP) if i == 5 else \
            fit_crops('daps', fr, DAP_CROP)
        off = DAP_IDLE_OFFSETS[i]
        cs = apply_tail_offset(cs, off)
        print(f'  dap{i}: reviewed idle offset {off}')
        names = [n[:-4] for n in build_seq(
            f'dap{i}', 'daps', fr, cs, **HANDS)]
        with open(MANIFEST) as f:
            current_manifest = json.load(f)
        current_manifest['daps'][i] = names
        with open(MANIFEST, 'w') as f:
            json.dump(current_manifest, f, indent=1)
        print(json.dumps({f'dap{i}': names}, indent=1))
        return
    if which in (None, 'daps'):
        manifest['daps'] = []
        # Decode all six takes in one forward pass. Doing this inside the loop
        # makes ffmpeg traverse the same 4K/60 movie once per dap.
        prefetch('daps', [n for fr in DAP_FRAMES for n in fr])
        for i, fr in enumerate(DAP_FRAMES):
            cs = updown_crops(fr, DAP_CROP) if i == 5 else \
                fit_crops('daps', fr, DAP_CROP)
            off = DAP_IDLE_OFFSETS[i]
            cs = apply_tail_offset(cs, off)
            print(f'  dap{i}: reviewed idle offset {off}')
            manifest['daps'].append(
                build_seq(f'dap{i}', 'daps', fr, cs, **HANDS))
    if which in (None, 'trans') or which in TRANS:
        transitions = TRANS.items() if which in (None, 'trans') else [(which, TRANS[which])]
        for k, v in transitions:
            fr = v['frames']
            prefetch(v['video'], fr)
            if v.get('balance_pair'):
                cs = balanced_pair_crops(v['video'], fr, v['c0'], v['c1'])
            elif v.get('track', True):
                cs = tracked_crops(v['video'], fr, v['c0'], v['c1'])
            else:
                cs = interp_crops(v['c0'], v['c1'], len(fr))
            tn = interp_tone(v['tone0'], v['tone1'], len(fr))
            manifest[k] = build_seq(k, v['video'], fr, cs, tones=tn)
            if k == 'pita':
                # Finish on real photographed poses from the idle end of the
                # complete up/down take. Their progressively tighter crops
                # continue the camera movement into the landing framing; no
                # opacity blend is used anywhere in the sequence.
                settle_frames = [6712, 6736, 6788]
                settle_crops = [(2880, 1620, 503, 423),
                                (2400, 1350, 756, 626),
                                # fitted against the two landing silhouettes;
                                # this removes the last scale/position jump
                                (2185, 1229, 882, 829)]
                settle = build_seq('pita_settle', 'daps', settle_frames,
                                   settle_crops, **HANDS)
                # End on the actual plate, making the following landing state
                # the same pixels instead of a cut between near-matches.
                manifest['pita_settle'] = settle + ['landing_plate.png']
    # strip the .png so the manifest holds frame *names*, as the page uses them
    manifest = {k: ([[n[:-4] for n in s] for s in v] if k == 'daps'
                    else [n[:-4] for n in v]) for k, v in manifest.items()}
    merge_manifest(manifest)
    print(json.dumps(manifest, indent=1))


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else None)
