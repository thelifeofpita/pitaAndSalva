#!/usr/bin/env python3
"""Rock-paper-scissors frames: the shared count-in, plus a filmed round for each
of the nine combinations — the thrown gesture, the hands acting the result out,
and the settle. All whole frames: the resolutions have both hands touching, so
they cannot be composited from separate takes."""
import os, sys, numpy as np, cv2
from PIL import Image
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build import (prep, get_frame, lut, dither, save1bit, prefetch, IMG,
                   merge_manifest)

CROP = (2627, 1478, 878, 347)
TONE = dict(lo=110, T=184, S=22)
BG_REFERENCE_FRAME = 650

_bg_reference = None


def background_reference():
    """A separated pose with the middle of the wall and ledge exposed.

    The camera reframes slightly during the take, so this reference is aligned
    to each output frame before it is used.  The reference's own Vision mask
    prevents either person in that frame from ever becoming a background seed.
    """
    global _bg_reference
    if _bg_reference is None:
        img, mask = get_frame('RPS', BG_REFERENCE_FRAME)
        cw, ch, cx, cy = CROP
        rgb = cv2.resize(img[cy:cy + ch, cx:cx + cw], (1920, 1080),
                         interpolation=cv2.INTER_AREA)
        matte = cv2.resize(mask[cy:cy + ch, cx:cx + cw], (1920, 1080),
                           interpolation=cv2.INTER_AREA)
        sift = cv2.SIFT_create(nfeatures=5000)
        keys, desc = sift.detectAndCompute(
            cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY), None)
        _bg_reference = rgb, matte, sift, keys, desc
    return _bg_reference


def remove_aligned_background(rgb, vision_mask):
    """Refine bridged hand mattes using the actual, aligned set background.

    Vision sometimes treats two touching hands plus the space between them as
    one solid foreground instance.  Feature-aligning a clean pose makes the
    brick and ledge texture a high-confidence background seed. GrabCut then
    follows the real finger edges instead of the bridged instance outline.
    """
    ref, ref_mask, sift, ref_keys, ref_desc = background_reference()
    keys, desc = sift.detectAndCompute(
        cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY), None)
    if desc is None:
        return vision_mask
    pairs = cv2.BFMatcher().knnMatch(ref_desc, desc, k=2)
    good = [a for a, b in pairs if a.distance < .70 * b.distance]
    if len(good) < 30:
        return vision_mask
    p0 = np.float32([ref_keys[m.queryIdx].pt for m in good])
    p1 = np.float32([keys[m.trainIdx].pt for m in good])
    H, inliers = cv2.findHomography(p0, p1, cv2.RANSAC, 3)
    if H is None or inliers is None or int(inliers.sum()) < 20:
        return vision_mask

    size = (rgb.shape[1], rgb.shape[0])
    aligned = cv2.warpPerspective(ref, H, size)
    aligned_mask = cv2.warpPerspective(ref_mask, H, size)
    valid = cv2.warpPerspective(np.full(ref_mask.shape, 255, np.uint8), H,
                                size) > 250

    a = cv2.cvtColor(aligned, cv2.COLOR_RGB2GRAY).astype(np.float32)
    b = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY).astype(np.float32)
    kernel = (11, 11)
    ma = cv2.boxFilter(a, -1, kernel)
    mb = cv2.boxFilter(b, -1, kernel)
    sa = np.sqrt(np.maximum(cv2.boxFilter(a * a, -1, kernel) - ma * ma, 1))
    sb = np.sqrt(np.maximum(cv2.boxFilter(b * b, -1, kernel) - mb * mb, 1))
    corr = (cv2.boxFilter(a * b, -1, kernel) - ma * mb) / (sa * sb)
    wall = (corr > .82) & (sa > 4) & (aligned_mask < 24) & valid

    labels = np.full(vision_mask.shape, cv2.GC_BGD, np.uint8)
    labels[vision_mask > 50] = cv2.GC_PR_FGD
    labels[wall] = cv2.GC_BGD
    x = np.arange(rgb.shape[1])[None, :]
    core = cv2.erode((vision_mask > 180).astype(np.uint8),
                     np.ones((21, 21), np.uint8)) > 0
    # The arms entering from the two sides are indisputable foreground and
    # give GrabCut clean skin samples without seeding the bridged middle.
    labels[core & ((x < 600) | (x > 1320))] = cv2.GC_FGD
    bg_model = np.zeros((1, 65), np.float64)
    fg_model = np.zeros((1, 65), np.float64)
    cv2.grabCut(rgb, labels, None, bg_model, fg_model, 7,
                cv2.GC_INIT_WITH_MASK)
    keep = ((labels == cv2.GC_FGD) | (labels == cv2.GC_PR_FGD))
    return np.where(keep, vision_mask, 0).astype(np.uint8)

# Three complete count-in beats, including the real in-between positions. The
# old 12-frame stride jumped from the top to the bottom in one image and made
# the hands look as though they were striking down rather than counting in.
# 1836 is the real open-hands anticipation pose. It bridges the neutral landing
# into the first rising fists instead of making the count begin mid-motion.
# 1900 and 1904 restore the third rise before the hands reveal their throws.
PUMP = [1836, 1840, 1844, 1848, 1852, 1856, 1860, 1864, 1868,
        1872, 1876, 1880, 1884, 1888, 1892, 1896, 1900, 1904]
# Real rounds: after a throw the hands act the result out — scissors snip at the
# palm, the fist closes over the scissors, the two scissors interlock, the fists
# bump. Both hands touch, so these can't be composited; they are whole frames
# from the take that actually played that combination. Key is (left, right).
ROUNDS = {
    # (left, right) -> the filmed round. Ranges given by Pita; frames picked on
    # the keyposes: the thrown gesture held, the beats of the resolution, then
    # the hands opening back out.
    'rr': dict(hold=[536, 544], after=[556, 564, 572, 580], settle=[588, 600]),
    'rp': dict(hold=[736, 744], after=[756, 764, 772, 780], settle=[792, 804]),
    'rs': dict(hold=[928, 940], after=[952, 960, 968, 980], settle=[996, 1008]),
    'pr': dict(hold=[1128, 1140], after=[1152, 1160, 1168, 1180], settle=[1192, 1204]),
    'pp': dict(hold=[1708, 1720], after=[1732, 1744, 1756, 1768], settle=[1784, 1796]),
    'ps': dict(hold=[1920, 1932], after=[1944, 1952, 1960, 1972], settle=[1988, 2000]),
    'sr': dict(hold=[2128, 2140], after=[2152, 2160, 2168, 2180], settle=[2196, 2212]),
    'sp': dict(hold=[2408, 2420], after=[2432, 2444, 2456, 2468], settle=[2484, 2496]),
    'ss': dict(hold=[2728, 2740], after=[2752, 2764, 2776, 2788], settle=[2808, 2830]),
}


def render(n, rng):
    g, m = prep('RPS', n, CROP)
    # Foreground-instance masks can bridge the negative space between touching
    # hands and retain the wall/stone texture inside that bridge. RPS contains
    # only bare arms and hands, so intersect the Vision matte with a deliberately
    # generous YCrCb skin range. This preserves both skin tones while removing
    # background caught between fingers and at overlapping silhouettes.
    img, _ = get_frame('RPS', n)
    cw, ch, cx, cy = CROP
    rgb = cv2.resize(img[cy:cy + ch, cx:cx + cw], (1920, 1080),
                     interpolation=cv2.INTER_AREA)
    # Only this touching paper/scissors pose contains the bridged wall patch.
    # Applying the edge refinement to clean, separated gestures can mistake a
    # finger for background and visibly amputate it, so every other frame keeps
    # its complete Vision silhouette plus the conservative skin intersection.
    if n == ROUNDS['ps']['hold'][0]:
        m = remove_aligned_background(rgb, m)
    Y, Cr, Cb = cv2.split(cv2.cvtColor(rgb, cv2.COLOR_RGB2YCrCb))
    skin = ((Cr >= 128) & (Cr <= 180) & (Cb >= 70) & (Cb <= 135) & (Y >= 75))
    skin = cv2.morphologyEx(skin.astype(np.uint8), cv2.MORPH_CLOSE,
                            np.ones((5, 5), np.uint8))
    m = m.copy()
    m[skin == 0] = 0
    return dither(g, m, lut(**TONE), rng), m


def side_mask(m, side):
    """Mask of the arm entering from `side` ('l' or 'r'), as whole connected
    components — so compositing never slices through a hand."""
    b = (m > 127).astype(np.uint8)
    num, lab, stats, cent = cv2.connectedComponentsWithStats(b, 8)
    out = np.zeros(b.shape, bool)
    for i in range(1, num):
        if stats[i, cv2.CC_STAT_AREA] < 4000:
            continue
        x0 = stats[i, cv2.CC_STAT_LEFT]
        x1 = x0 + stats[i, cv2.CC_STAT_WIDTH]
        touches = x0 <= 2 if side == 'l' else x1 >= b.shape[1] - 2
        if touches:
            out |= (lab == i)
    return out


def compose(cache, ln, rn):
    """Left arm from one take, right arm from another — whole connected
    components, so a hand is never sliced down the middle."""
    bl, ml = cache[ln]
    br, mr = cache[rn]
    return (bl & side_mask(ml, 'l')) | (br & side_mask(mr, 'r'))


def main():
    os.makedirs(IMG, exist_ok=True)
    frames = sorted(set(PUMP + [f for r in ROUNDS.values() for k in
                                ('hold', 'after', 'settle') for f in r[k]]))
    prefetch('RPS', frames + [BG_REFERENCE_FRAME])
    rng = np.random.default_rng(11)
    cache = {n: render(n, rng) for n in frames}

    out = {}
    for i, n in enumerate(PUMP):
        save1bit(cache[n][0], f'{IMG}/rpspump_{i:02d}.png')
    out['pump'] = [f'rpspump_{i:02d}' for i in range(len(PUMP))]

    out['round'] = {}
    for combo, r in ROUNDS.items():
        part = {}
        for k in ('hold', 'after', 'settle'):
            names = []
            for i, n in enumerate(r[k]):
                f = f'rpsr_{combo}_{k}{i}'
                save1bit(cache[n][0], f'{IMG}/{f}.png')
                names.append(f)
            part[k] = names
        out['round'][combo] = part
        print(f'  round {combo}: {r}')

    merge_manifest({'rps': out})
    print(out)


if __name__ == '__main__':
    main()
