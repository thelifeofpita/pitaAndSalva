#!/usr/bin/env python3
"""Cuts the BACK control's hands, as a beckon, out of the rock-paper-scissors take.

`build_hands.py` cuts one still hand out of the landing plate and the site
jiggles it in CSS. A jiggle is invented motion, and on a site where nothing
moves that was not photographed moving, it shows. The count-in at the head of a
rock-paper-scissors round is these same two hands doing the real thing — the
palm open, then the fingers drawn in over it — so the beckon is cut from there
instead, and hovering plays photographed frames like everything else.

Registration is the whole job. The count-in is a pump: the forearms travel
through it, so the same window taken from two frames would read as a hand
crossing the screen rather than fingers closing. The fix is to register on the
forearm, which is the part of the arm the gesture does not reach — a strip of it
well behind the wrist is matched between frames, and the window for each frame
is slid by whatever shift lines that strip up. What is left moving is the
fingers. The match is reported as an overlap when the tool runs: if it drops off
1.0 the two frames are no longer the same arm in the same place, and the beckon
will swim.

The rest of the treatment is `build_hands.py`'s, for the reason it gives: the
art is baked at its on-screen size and re-dithered there, because scaling a
1-bit dither in the browser averages the noise into grey and the crunch is gone.

    python3 tools/build_beckon.py

Writes img/ui/hand_{pita,salva}_{0..n}.png (fingers pointing in from the side)
and hand_{pita,salva}_v_{0..n}.png (the same hand turned to point up, for the &
and the campaign pages). Frame 0 is the pose the control rests in.
"""

import random
from pathlib import Path

from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
IMG = ROOT / 'img'
OUT = IMG / 'ui'

# The poses that make the gesture, per hand, in the order they are played
# through. `rpspump_00` is the hand held open at the head of a round and
# `rpspump_01` is its fingers drawn in over the palm; everything later in the
# count-in is the pump itself — the closed hand travelling — which is a move,
# not a gesture.
#
# Three poses each, because two read as a hand grabbing at something: between
# open and shut there is nothing but the cut, and the cut is the grab. The
# middle one is what turns it into a curl.
#
# Pita's middle pose is photographed — `dap4_06`, from the dap take, catches his
# fingers mid-bend. Salva has none. The count-in shuts his hand between one
# frame and the next, and every other frame in the footage was searched for one
# that registers on his arm and catches his fingers partway: there is nothing
# between his fingers extended and his fingers in. So his is built, by the
# `squash` below — the only frame on this site that was not photographed. The
# two hands have to keep the same time, and an invented middle frame is a
# smaller lie than a hand that grabs.

# `win` is the window on the first frame, in its own coordinates; every later
# frame gets the same window slid by the shift that lines its arm up with this
# one's. `arm` is the strip that shift is measured on, and where it sits is the
# one judgement call in here. Far down the forearm, the forearm holds still and
# the whole hand tips instead — which reads as a wrist flick, not a beckon. So
# it is taken just behind the knuckles, where the hand itself is: the back of
# the hand holds, the fingers curl into it, and what gives is the arm, which
# runs off the frame edge where a few pixels of travel do not show.
# Salva's middle pose, built out of his open hand. A finger bending, seen from
# the back of the hand, mostly does two things to its own shape: it gets shorter,
# because what the camera sees is the finger foreshortened, and its tip rides up.
# So everything past the knuckles is squashed towards them and lifted, and the
# hand behind the knuckles is left exactly as it was shot.
#
# The numbers are read off his two real poses in the registered window: his
# fingertips reach x747 open and x621 in, and the knuckles sit at x600 — so the
# fingers are 147 long open and 21 long in, and halfway is 84, which is 0.57 of
# open. `lift` is the tips' rise over that half, matched by eye against the pose
# they are heading for.
SQUASH = {'from': 'rpspump_00', 'knuckles': 600, 'keep': .57, 'lift': 30}

HANDS = {
    'salva': {'win': (40, 390, 820, 890), 'arm': (420, 560),
              'frames': ['rpspump_00', SQUASH, 'rpspump_01']},
    'pita':  {'win': (860, 300, 1640, 800), 'arm': (1380, 1620),
              'frames': ['rpspump_00', 'dap4_06', 'rpspump_01']},
}

WIDE = 150   # on-screen width of the hand on Pita's and Salva's pages
INK = 30     # tone above which a blurred frame pixel counts as subject
BRIDGE = 8   # blur radius used to read that tone
REACH = 150  # how far the registration search looks, in px


def solid(grey):
    """A filled mask of where the subject is, as a 0/255 image.

    The frame is dither, so the hand is not one connected run of white pixels.
    Blurring first turns local dither density back into tone, which is.
    """
    return grey.filter(ImageFilter.GaussianBlur(BRIDGE)).point(
        lambda v: 255 if v > INK else 0)


def overlap(a, b):
    """How much of two masks coincide, 0 to 1."""
    inter = union = 0
    for x, y in zip(a.get_flattened_data(), b.get_flattened_data()):
        if x and y:
            inter += 1
        if x or y:
            union += 1
    return inter / union if union else 0


def register(ref, mask, strip):
    """The shift that puts `mask`'s forearm where `ref`'s forearm is.

    Coarse then fine, because the search is quadratic and the travel is large:
    a pass at 8px steps on quarter-scale masks, then a pass at 1px around what
    it found.
    """
    x0, x1 = strip
    def crop(m, dx, dy, s):
        return m.crop((x0 + dx, dy, x1 + dx, ref.height + dy)).resize(
            ((x1 - x0) // s, ref.height // s))

    best = (0, 0, 0)
    for step, span, scale in ((8, REACH, 4), (1, 8, 2)):
        base = (best[1], best[2])
        a = crop(ref, 0, 0, scale)
        for dy in range(base[1] - span, base[1] + span + 1, step):
            for dx in range(base[0] - span, base[0] + span + 1, step):
                got = overlap(a, crop(mask, dx, dy, scale))
                if got > best[0]:
                    best = (got, dx, dy)
    return best


def squash(grey, spec):
    """Everything past the knuckles, shortened towards them and lifted.

    A mesh rather than a resize, because the hand behind the knuckles must come
    through untouched: the warp is one quad, and the source it samples is a
    sheared box whose far edge is raised, which is what tilts the fingers up as
    they shorten.
    """
    w, h = grey.size
    xk = spec['knuckles']
    lift = spec['lift']
    out = Image.new('L', (w, h))
    out.paste(grey.crop((0, 0, xk, h)), (0, 0))
    fingers = int((w - xk) * spec['keep'])
    quad = (xk, 0, xk, h, w, h + lift, w, lift)
    out.paste(grey.transform((fingers, h), Image.MESH,
                             [((0, 0, fingers, h), quad)], Image.BILINEAR), (xk, 0))
    return out


def bake(grey, width, rng):
    """Area-downsample to `width`, then re-dither at that size."""
    h = max(1, round(grey.height * width / grey.width))
    small = grey.resize((width, h), Image.BOX)
    # The dither the frames themselves use, read backwards: the tone of a patch
    # is how much of it is white, so tone is the probability a pixel is white.
    alpha = Image.new('L', small.size)
    alpha.putdata([255 if rng.random() * 255 < v else 0
                   for v in small.get_flattened_data()])
    out = Image.new('RGBA', small.size, (255, 255, 255, 0))
    out.putalpha(alpha)
    return out


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    rng = random.Random(7)                     # reproducible builds
    cache = {}

    def read(name):
        if name not in cache:
            frame = Image.open(IMG / f'{name}.png').convert('L')
            cache[name] = (frame, solid(frame))
        return cache[name]

    for who, cfg in HANDS.items():
        x0, y0, x1, y1 = cfg['win']
        ref = read(cfg['frames'][0])[1]
        for i, spec in enumerate(cfg['frames']):
            built = isinstance(spec, dict)
            name = spec['from'] if built else spec
            frame, mask = read(name)
            if i == 0:
                dx = dy = 0
            else:
                got, dx, dy = register(ref, mask, cfg['arm'])
                print(f'  {who} {name}: arm {got:.2f} at {dx:+d},{dy:+d}')
            box = (x0 + dx, y0 + dy, x1 + dx, y1 + dy)
            grey = frame.crop(box)
            # Anything outside the subject is background dither, not hand.
            grey.paste(0, (0, 0, grey.width, grey.height),
                       Image.eval(mask.crop(box), lambda v: 255 - v))
            if built:
                grey = squash(grey, spec)
                print(f'  {who} built: {name} squashed to {spec["keep"]}')

            bake(grey, WIDE, rng).save(OUT / f'hand_{who}_{i}.png')
            # Turned so the fingers point up, arm hanging off the bottom.
            # Salva's hand comes in from the left, so it turns anticlockwise;
            # Pita's, from the right, turns the other way. Both then face the
            # way they face each other on the landing.
            turn = Image.ROTATE_90 if who == 'salva' else Image.ROTATE_270
            bake(grey, WIDE, rng).transpose(turn).save(
                OUT / f'hand_{who}_v_{i}.png')

        im = Image.open(OUT / f'hand_{who}_0.png')
        n = len(cfg['frames']) - 1
        print(f'hand_{who}_[0-{n}].png  {im.width}x{im.height}')


if __name__ == '__main__':
    main()
