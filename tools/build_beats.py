#!/usr/bin/env python3
"""Render the four tracks of the Numpad Jam album for the project page.

The campaign's mechanic, from the mixThemUp mockup: YouTube's digit keys are a
decile seek, and each decile of that video is a 30s sample off a different
JPEGMAFIA record. So what the community submits is a key sequence — every press
restarts its own sample from that sample's top and holds until the next press.
That sequence is the bed of each track, cut exactly the way the keys would cut
it, and everything else here is the production on top of it: the sequence is
the idea, the track is that idea finished.

Each track is a full arrangement, not a loop with drums on it — an intro that
opens into the beat, a middle that changes, a turnaround, and an ending, with
its own kit, bass, keys and effects. All of it is synthesised in this file
(there is no numpy on this machine, so the voices are plain loops over short
hits) and locked to 120 BPM, which is the grid every key sequence already
lands on: a 0.5s hold is one beat, so the production locks to the chops by
construction rather than by nudging.

Three stems come out of each arrangement — kick, drums, music — because the
mixdown needs them apart: the kick is the sidechain key that makes everything
else breathe around it, and the three want different processing. The chops get
their own chain per track (filter opens, ducking, crush, dub echo) and then
the whole thing goes through one master chain.

The key strings printed by this script are the ones app.js shows on each card:
digits only, no separators, because a numpad has nothing else on it. Keep them
in step if a pattern changes here.

Source is the mixThemUp mockup's own asset folder (its ten sample files and ten
cover jpgs) — pass its path as argv[1], or set MIXTHEMUP.

  python3 tools/build_beats.py ~/path/to/mixThemUp
"""
import array
import json
import math
import os
import random
import subprocess
import sys
import tempfile
import wave

SRC = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("MIXTHEMUP", "../mixThemUp")
SRC = os.path.join(os.path.expanduser(SRC), "assets")
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                   "img", "projects", "numpad-jam", "beats")
# Scratch (normalised sources, chop and stem wavs) lives outside the repo: it is
# ~100MB of WAV and nothing in it ships. Kept between runs so re-rendering only
# pays for the loudnorm pass once.
TMP = os.path.join(tempfile.gettempdir(), "numpad-jam-beats")

# digit -> source stem. Digit 0 is decile 0, i.e. the first album, and so on up
# to 9 — the same mapping mixThemUp's own keydown handler uses.
STEMS = ["01_veteran", "02_blackbencarson", "03_cornballs", "04_ep", "05_ep2",
         "06_lp", "07_offline", "08_scaringthehoes", "09_ilaydownmylife",
         "10_experimentalrap"]

TARGET = 15.0   # the sample length each card advertises
FADE = 0.012    # fade in/out on every chop — kills the click at each key press
SR = 44100
BPM = 120.0
BEAT = 60.0 / BPM   # 0.5s — one hold in the shortest key sequences
BAR = 4 * BEAT      # 2s, so 15s is seven and a half bars

# Four tracks, four playing styles on the same ten keys. Each is a loop of
# (digit, hold seconds) repeated until it fills 15s.
BEATS = [
    # steady half-second loop with one double-tap stutter per bar
    dict(id="beat1", pattern=[(0, .5), (4, .5), (0, .5), (7, .5),
                              (0, .5), (4, .5), (7, .25), (7, .25)]),
    # fast finger-drumming, mostly quarter-second chops
    dict(id="beat2", pattern=[(1, .25), (1, .25), (5, .5), (8, .25), (8, .25),
                              (3, .5), (6, .75), (1, .25)]),
    # long holds — lets each sample actually sing before the cut
    dict(id="beat3", pattern=[(9, 1.5), (2, 1.0), (5, 1.5), (9, 1.0), (6, 1.5)]),
    # a build: the holds shrink each pass until the whole thing is stuttering
    dict(id="beat4", pattern=[(2, 1.0), (6, .75), (2, .5), (8, .5), (2, .375),
                              (6, .375), (8, .25), (2, .25), (8, .25), (6, .25)]),
]


def run(cmd):
    subprocess.run(cmd, check=True, capture_output=True)


# ------------------------------------------------------------------ chops

def normalize():
    """The ten samples sit ~12dB apart as ripped. A track cutting between them
    needs them at one level, or every press reads as a volume jump rather than
    as a new sample."""
    for s in STEMS:
        dst = os.path.join(TMP, s + ".wav")
        if os.path.exists(dst):
            continue
        run(["ffmpeg", "-v", "error", "-y", "-i", os.path.join(SRC, "audio", s + ".m4a"),
             "-af", "loudnorm=I=-15:TP=-1.5:LRA=11", "-ar", str(SR), "-ac", "2", dst])


def expand(pattern, total=TARGET):
    """Loop the pattern, trimming the last hold so the track lands exactly on 15s."""
    seq, t, i = [], 0.0, 0
    while t < total - 1e-6:
        d, hold = pattern[i % len(pattern)]
        hold = min(hold, total - t)
        seq.append((d, round(hold, 3)))
        t += hold
        i += 1
    return seq


def render_chops(name, seq):
    """The key sequence itself: each press cut from its sample's own top."""
    inputs, filters = [], []
    for i, (d, hold) in enumerate(seq):
        inputs += ["-i", os.path.join(TMP, STEMS[d] + ".wav")]
        filters.append(
            f"[{i}:a]atrim=0:{hold},asetpts=N/SR/TB,"
            f"afade=t=in:st=0:d={FADE},"
            f"afade=t=out:st={max(hold - FADE, 0):.3f}:d={FADE}[a{i}]")
    chain = "".join(f"[a{i}]" for i in range(len(seq)))
    graph = ";".join(filters) + f";{chain}concat=n={len(seq)}:v=0:a=1[out]"
    dst = os.path.join(TMP, name + "_chops.wav")
    run(["ffmpeg", "-v", "error", "-y", *inputs, "-filter_complex", graph,
         "-map", "[out]", "-ar", str(SR), "-ac", "2", dst])
    return dst


# ---------------------------------------------------------------- buffers

def buf(dur):
    return [0.0] * int(dur * SR)


def mix_in(dst, src, at, gain=1.0):
    i = int(at * SR)
    n = min(len(src), len(dst) - i)
    for k in range(max(0, -i), n):
        dst[i + k] += src[k] * gain


def hp(sig, a=0.92):
    """One-pole highpass. Cheap, and enough to turn white noise into a hat or
    to keep a noise bed out of the way of the bass."""
    out, prev_x, prev_y = [0.0] * len(sig), 0.0, 0.0
    for i, x in enumerate(sig):
        prev_y = a * (prev_y + x - prev_x)
        prev_x = x
        out[i] = prev_y
    return out


def lp(sig, a=0.25):
    """One-pole lowpass — takes the fizz off a saw so it sits under the mix."""
    out, y = [0.0] * len(sig), 0.0
    for i, x in enumerate(sig):
        y += a * (x - y)
        out[i] = y
    return out


def noise(dur, rng):
    return [rng.uniform(-1.0, 1.0) for _ in range(int(dur * SR))]


# ----------------------------------------------------------------- voices
# Each one is an envelope times an oscillator or noise. Short: a kick is 0.4s
# of samples, not 15s, and the arrangement adds it in at each of its offsets.

def kick(dur=0.42, f0=118.0, f1=44.0, drop=0.028, tail=0.10, click=0.35,
         drive=1.0, rng=None):
    """Pitch drops from f0 to f1 in `drop` seconds — that fall is the whole
    sound of a kick; the click on top is what makes it audible on a phone.
    `drive` runs it into tanh, which is where the crunch on these comes from."""
    n = int(dur * SR)
    out, phase = [0.0] * n, 0.0
    tick = noise(0.006, rng) if rng else []
    for i in range(n):
        t = i / SR
        f = f1 + (f0 - f1) * math.exp(-t / drop)
        phase += 2 * math.pi * f / SR
        out[i] = math.tanh(math.sin(phase) * drive) * math.exp(-t / tail)
    for i, v in enumerate(tick):
        out[i] += v * math.exp(-(i / SR) / 0.0015) * click
    return out


def snare(dur=0.26, tone=190.0, bright=0.9, drive=1.0, rng=None):
    n = int(dur * SR)
    ns = hp(noise(dur, rng), 0.90)
    out = [0.0] * n
    for i in range(n):
        t = i / SR
        body = (math.sin(2 * math.pi * tone * t) +
                0.6 * math.sin(2 * math.pi * tone * 1.78 * t)) * math.exp(-t / 0.045)
        out[i] = math.tanh((0.45 * body + bright * ns[i] * math.exp(-t / 0.075)) * drive)
    return out


def clap(rng, dur=0.34):
    """Four noise bursts a few milliseconds apart, then a tail — a clap is a
    room full of hands not quite together, and that stagger is the sound."""
    out = buf(dur)
    burst = hp(noise(0.02, rng), 0.86)
    for k, off in enumerate((0.0, 0.009, 0.019, 0.028)):
        shaped = [v * math.exp(-(i / SR) / 0.004) for i, v in enumerate(burst)]
        mix_in(out, shaped, off, 1.0 - 0.15 * k)
    tail = hp(noise(0.22, rng), 0.86)
    mix_in(out, [v * math.exp(-(i / SR) / 0.055) for i, v in enumerate(tail)], 0.028, 0.55)
    return out


def hat(rng, dur=0.05, decay=0.011):
    ns = hp(noise(dur, rng), 0.97)
    return [v * math.exp(-(i / SR) / decay) for i, v in enumerate(ns)]


def shaker(rng, dur=0.09):
    """Softer and longer than a hat, and it starts a hair late — a shaker is a
    handful of beads arriving, not a stick hitting metal."""
    ns = hp(noise(dur, rng), 0.955)
    return [v * (min(i / SR / 0.004, 1.0)) * math.exp(-(i / SR) / 0.022)
            for i, v in enumerate(ns)]


def rim(rng, dur=0.07):
    ns = hp(noise(dur, rng), 0.95)
    out = [0.0] * len(ns)
    for i in range(len(ns)):
        t = i / SR
        out[i] = (math.sin(2 * math.pi * 1750 * t) * 0.6 + ns[i] * 0.8) * math.exp(-t / 0.005)
    return out


def tom(freq=150.0, dur=0.3, rng=None):
    n = int(dur * SR)
    out, phase = [0.0] * n, 0.0
    for i in range(n):
        t = i / SR
        f = freq * (1 + 0.35 * math.exp(-t / 0.05))
        phase += 2 * math.pi * f / SR
        out[i] = math.sin(phase) * math.exp(-t / 0.09)
    return out


def sub(freq, dur, glide=0.045, sat=1.6):
    """An 808: a sine that slides into pitch and is driven hard enough to grow
    its own harmonics, which is what makes a 40Hz note audible on a laptop."""
    n = int(dur * SR)
    out, phase = [0.0] * n, 0.0
    for i in range(n):
        t = i / SR
        f = freq * (1.0 + 0.5 * math.exp(-t / glide))
        phase += 2 * math.pi * f / SR
        env = math.exp(-t / (dur * 0.42))
        out[i] = math.tanh(math.sin(phase) * sat) * env
    return out


def subdrop(freq=70.0, dur=1.6):
    """A sine falling off the bottom of the range — the sound an ending makes
    when the track doesn't so much stop as sink."""
    n = int(dur * SR)
    out, phase = [0.0] * n, 0.0
    for i in range(n):
        t = i / SR
        f = freq * (0.18 ** (t / dur))
        phase += 2 * math.pi * f / SR
        out[i] = math.tanh(math.sin(phase) * 1.4) * math.exp(-t / (dur * 0.7))
    return out


def pluck(freq, dur=0.3):
    """Two harmonics and a fast decay, lowpassed — a short upright-ish note to
    walk under a boom-bap loop."""
    n = int(dur * SR)
    raw = [0.0] * n
    for i in range(n):
        t = i / SR
        raw[i] = (math.sin(2 * math.pi * freq * t) +
                  0.35 * math.sin(2 * math.pi * freq * 2 * t) +
                  0.18 * math.sin(2 * math.pi * freq * 3 * t)) * math.exp(-t / (dur * 0.5))
    return lp(raw, 0.35)


def keys(freqs, dur=0.9, detune=0.006, bite=0.25):
    """A Rhodes-ish stab: each note two voices slightly apart, a fast attack and
    a long decay, lowpassed. Detuning is what stops a stack of sines reading as
    a test tone."""
    n = int(dur * SR)
    raw = [0.0] * n
    for f in freqs:
        for d in (1 - detune, 1 + detune):
            phase = 0.0
            for i in range(n):
                t = i / SR
                phase += 2 * math.pi * f * d / SR
                raw[i] += (math.sin(phase) + bite * math.sin(2 * phase)) * \
                    math.exp(-t / (dur * 0.42))
    scale = 1.0 / (2 * len(freqs))
    return lp([v * scale * min(i / SR / 0.006, 1.0) for i, v in enumerate(raw)], 0.5)


def bell(freq, dur=0.7):
    """Inharmonic partials over a fast decay — the plinky top line that carries
    a beat when there is no voice on it."""
    n = int(dur * SR)
    out = [0.0] * n
    for mult, amp, tau in ((1.0, 1.0, 0.30), (2.76, 0.42, 0.16), (5.4, 0.18, 0.08)):
        phase = 0.0
        for i in range(n):
            t = i / SR
            phase += 2 * math.pi * freq * mult / SR
            out[i] += math.sin(phase) * amp * math.exp(-t / (tau * dur / 0.7))
    return [v * 0.6 for v in out]


def pad(freqs, dur, detune=0.004):
    """A slow swell, two detuned voices per note. Sits far under everything —
    it is there to make the slow track feel like a room, not to be heard."""
    n = int(dur * SR)
    out = [0.0] * n
    for f in freqs:
        for d in (1 - detune, 1 + detune):
            phase = 0.0
            for i in range(n):
                phase += 2 * math.pi * f * d / SR
                out[i] += math.sin(phase)
    peak = 2 * len(freqs)
    for i in range(n):
        t = i / SR
        env = min(t / (dur * 0.45), 1.0) * min((dur - t) / (dur * 0.4), 1.0)
        out[i] = out[i] / peak * max(env, 0.0)
    return out


def crash(rng, dur=1.8):
    ns = hp(noise(dur, rng), 0.965)
    return [v * math.exp(-(i / SR) / 0.55) for i, v in enumerate(ns)]


def rev_crash(rng, dur=1.4):
    """A crash played backwards: the standard way to walk a listener into a
    downbeat, because the swell ends exactly where the next thing starts."""
    return crash(rng, dur)[::-1]


def impact(rng, dur=1.2):
    """The hit on a drop: a low boom, a noise slam and a short tail."""
    out = buf(dur)
    boom = kick(dur=1.0, f0=180, f1=32, drop=0.06, tail=0.32, click=0.0, drive=1.6, rng=rng)
    mix_in(out, boom, 0, 1.0)
    slam = hp(noise(0.5, rng), 0.80)
    mix_in(out, [v * math.exp(-(i / SR) / 0.10) for i, v in enumerate(slam)], 0, 0.55)
    return out


def riser(rng, dur):
    """Noise that opens up plus a sine climbing two octaves — the two together
    are what makes a build feel like it is going somewhere."""
    n = int(dur * SR)
    ns = hp(noise(dur, rng), 0.93)
    out, phase = [0.0] * n, 0.0
    for i in range(n):
        t = i / SR
        p = t / dur
        phase += 2 * math.pi * (240 * (2 ** (2 * p))) / SR
        out[i] = ns[i] * (p ** 2.4) * 0.8 + math.sin(phase) * (p ** 4) * 0.25
    return out


def downlifter(rng, dur=1.0):
    """The opposite gesture, for the bar after a drop."""
    n = int(dur * SR)
    ns = hp(noise(dur, rng), 0.90)
    out, phase = [0.0] * n, 0.0
    for i in range(n):
        t = i / SR
        p = 1.0 - t / dur
        phase += 2 * math.pi * (180 * (2 ** (2.2 * p))) / SR
        out[i] = ns[i] * (p ** 2) * 0.35 + math.sin(phase) * (p ** 2) * 0.4
    return out


def crackle(rng, dur, density=520):
    """Vinyl: sparse clicks, not a hiss. Clicks at this rate read as a record
    rather than as tape noise."""
    out = buf(dur)
    for _ in range(int(dur * density)):
        at = rng.uniform(0, dur - 0.01)
        amp = rng.uniform(0.05, 0.5) ** 2
        click = [rng.uniform(-1, 1) * math.exp(-(i / SR) / 0.0009) for i in range(60)]
        mix_in(out, click, at, amp)
    return out


# --------------------------------------------------------------- send fx
# Reverb and delay run here rather than in ffmpeg because they are part of how
# a voice sounds, not part of the mixdown: a snare with its own tail is one
# sound the arrangement can place, and the tail has to be there before the
# stems are summed and ducked.

COMBS = ((1116, 0.86), (1188, 0.85), (1277, 0.84), (1356, 0.83))
ALLPASS = (556, 441)


def reverb(sig, wet=0.3, size=1.0, damp=0.36):
    """Schroeder: four damped comb filters into two allpasses. Not a concert
    hall — a plate, which is what these drums want."""
    n = len(sig)
    wetsig = [0.0] * n
    for delay, fb in COMBS:
        d = max(1, int(delay * size))
        line, store, idx = [0.0] * d, 0.0, 0
        for i in range(n):
            y = line[idx]
            wetsig[i] += y
            store = y * (1 - damp) + store * damp
            line[idx] = sig[i] + store * fb
            idx = idx + 1 if idx + 1 < d else 0
    wetsig = [v * 0.25 for v in wetsig]
    for delay in ALLPASS:
        d = max(1, int(delay * size))
        line, idx = [0.0] * d, 0
        for i in range(n):
            y = line[idx]
            out = y - wetsig[i]
            line[idx] = wetsig[i] + y * 0.5
            wetsig[i] = out
            idx = idx + 1 if idx + 1 < d else 0
    return [sig[i] * (1 - wet * 0.4) + wetsig[i] * wet for i in range(n)]


def delay(sig, time, fb=0.42, wet=0.35, damp=0.4):
    """Feedback delay with each repeat duller than the last — a bright echo
    repeating forever sounds like a bug, a dull one sounds like a dub plate."""
    n, d = len(sig), max(1, int(time * SR))
    out = list(sig)
    line, store, idx = [0.0] * d, 0.0, 0
    for i in range(n):
        y = line[idx]
        out[i] += y * wet
        store = y * (1 - damp) + store * damp
        line[idx] = sig[i] + store * fb
        idx = idx + 1 if idx + 1 < d else 0
    return out


# --------------------------------------------------------- arrangements
# One writer per track, each returning three stems (kick / drums / music) the
# length of the track. Positions are in beats, so everything lands on the grid
# the key sequences already sit on. These are deliberately four different
# records: a boom-bap loop, a trap beat, a dub, and a build with a beat switch.

def arrange_beat1(dur, rng):
    """04070477 — boom bap. The chop loop is steady half-second presses, so the
    production stays out of its way and gives it a room: a backbeat, swung
    eighths, a shaker, and an Am7/Fmaj7/G7 turnaround on Rhodes that gives the
    loop a chord to repeat over instead of repeating alone. Bar 0 is drums
    only, bar 6 drops the hats out for a bar so the last two land harder."""
    K, D, M = buf(dur), buf(dur), buf(dur)
    k = kick(rng=rng, drive=1.35)
    s = reverb(snare(rng=rng, drive=1.2), wet=0.26, size=0.9)
    h, ho, sh = hat(rng), hat(rng, 0.22, 0.06), shaker(rng)
    bars = int(dur / BAR) + 1
    chords = ([220.0, 261.6, 329.6, 392.0],    # Am7
              [174.6, 220.0, 261.6, 329.6],    # Fmaj7
              [196.0, 246.9, 293.7, 349.2])    # G7
    for b in range(bars):
        t0 = b * BAR
        intro, breakdown = b == 0, b == 6
        for at in (0, 1.5, 2.5):                       # kick: 1, & of 2, 3
            if intro and at != 0:
                continue
            mix_in(K, k, t0 + at * BEAT, 0.95)
        if not intro:
            for at in (1, 3):
                mix_in(D, s, t0 + at * BEAT, 0.6)
        for e in range(8):                             # swung eighths
            at = t0 + e * 0.5 * BEAT + (0.055 * BEAT if e % 2 else 0.0)
            if not breakdown:
                mix_in(D, ho if e == 7 and not intro else h, at,
                       (0.3 if e % 2 else 0.42) * (0.6 if intro else 1.0))
            mix_in(D, sh, at + 0.25 * BEAT, 0.16)
        if intro:
            continue
        ch = chords[(b - 1) % 3]
        mix_in(M, keys(ch, 1.1), t0, 0.5)              # chord on 1
        mix_in(M, keys(ch, 0.5), t0 + 2.5 * BEAT, 0.3)  # push on the & of 3
        for j, f in enumerate((55.0, 55.0, 43.65, 49.0) if (b - 1) % 3 != 1
                              else (43.65, 43.65, 49.0, 49.0)):
            mix_in(M, pluck(f, 0.55), t0 + j * BEAT, 0.55)
        if b == 5:                                      # fill into the break
            for j in range(4):
                mix_in(D, s, t0 + 3 * BEAT + j * 0.25 * BEAT, 0.3 + 0.1 * j)
        if b == 6:
            mix_in(D, rev_crash(rng, 1.2), t0 + 2 * BEAT, 0.3)
        if b == 7 or (b == bars - 1):
            mix_in(D, crash(rng), t0, 0.34)
    mix_in(M, crackle(rng, dur, 300), 0, 0.18)
    return K, D, M


def arrange_beat2(dur, rng):
    """11588361 — trap. The chops are already machine-gun fast, so the kit
    answers them instead of doubling them: 808s with glide, hats that break
    into triplet rolls, claps on the backbeat. It opens on a bell figure with
    a reversed cymbal under it, cuts everything but the chops for half a bar at
    12s, and comes back for the last two bars."""
    K, D, M = buf(dur), buf(dur), buf(dur)
    k = kick(dur=0.3, f0=140, f1=52, tail=0.06, drive=1.5, rng=rng)
    c = reverb(clap(rng), wet=0.3, size=0.8)
    h = hat(rng, 0.04, 0.008)
    ho = hat(rng, 0.26, 0.075)
    bars = int(dur / BAR) + 1
    notes = [(0.0, 41.2, 1.5), (1.5, 55.0, 0.75), (2.5, 36.7, 1.5)]     # E1 A1 D1
    top = [(0.0, 659.3), (0.75, 784.0), (1.5, 587.3), (2.75, 493.9)]    # E5 G5 D5 B4
    mix_in(M, rev_crash(rng, 2.0), 0, 0.3)
    for b in range(bars):
        t0 = b * BAR
        intro, cut = b == 0, b == 6
        if not intro and not cut:
            for at in (0, 2.5):
                mix_in(K, k, t0 + at * BEAT, 0.88)
            for at in (1, 3):
                mix_in(D, c, t0 + at * BEAT, 0.5)
            for nb, f, ln in notes:
                mix_in(M, sub(f, ln * BEAT, sat=2.0), t0 + nb * BEAT, 0.85)
            e = 0.0
            while e < 4:
                step = 1 / 3 if (b % 2 == 1 and e >= 3.0) else 0.25
                mix_in(D, h, t0 + e * BEAT, 0.34 if (e % 1) else 0.52)
                e += step
            if b % 4 == 3:
                mix_in(D, ho, t0 + 3.5 * BEAT, 0.3)
        if b == 3:                                      # tom fill into the half
            for j, f in enumerate((190, 150, 120, 95)):
                mix_in(D, tom(f, 0.28, rng), t0 + 3 * BEAT + j * 0.25 * BEAT, 0.5)
        if cut:                                         # the drop-out
            mix_in(M, downlifter(rng, 1.0), t0, 0.3)
            mix_in(M, rev_crash(rng, 1.0), t0 + 2 * BEAT, 0.32)
        # the bell figure runs the whole way, delayed and panned by the mix
        for nb, f in top:
            amp = 0.3 if not intro else 0.42
            mix_in(M, bell(f * (0.5 if b % 4 == 2 else 1.0), 0.8), t0 + nb * BEAT, amp)
        if b == bars - 1:
            mix_in(D, crash(rng), t0, 0.4)
            mix_in(M, sub(41.2, 2.0 * BEAT, sat=2.2), t0, 0.8)
    M[:] = delay(M, 0.75 * BEAT, fb=0.34, wet=0.3)
    return K, D, M


def arrange_beat3(dur, rng):
    """92596 — dub. The chops get 1.5s at a time here and the whole point is
    that you hear them, so the production is space rather than material: one
    kick a bar, a side-stick in a long echo, a sine bass on whole notes, a Dm9
    pad swelling through the middle, vinyl underneath. Everything is wet."""
    K, D, M = buf(dur), buf(dur), buf(dur)
    k = kick(dur=0.6, f0=95, f1=38, drop=0.04, tail=0.16, click=0.15, rng=rng)
    r = delay(reverb(rim(rng), wet=0.5, size=1.2), 0.75 * BEAT, fb=0.5, wet=0.5)
    sh = reverb(shaker(rng, 0.2), wet=0.4)
    bars = int(dur / BAR) + 1
    for b in range(bars):
        t0 = b * BAR
        mix_in(K, k, t0, 1.0)
        if b >= 2:
            mix_in(K, k, t0 + 2.5 * BEAT, 0.5)
        mix_in(D, r, t0 + 2 * BEAT, 0.45)
        if b >= 3:
            for e in (1.5, 3.5):
                mix_in(D, sh, t0 + e * BEAT, 0.22)
        mix_in(M, sub(36.7 if b % 2 else 49.0, 2.2 * BEAT, glide=0.12, sat=1.1), t0, 0.7)
        if b in (2, 5):
            mix_in(M, delay(reverb(bell(587.3, 1.2), wet=0.55), 1.5 * BEAT,
                            fb=0.45, wet=0.45), t0 + 1.5 * BEAT, 0.26)
    mix_in(M, crackle(rng, dur), 0, 0.28)
    mix_in(M, pad([146.8, 174.6, 220.0, 329.6], dur * 0.62), dur * 0.3, 0.2)
    mix_in(D, rev_crash(rng, 2.0), dur * 0.42, 0.22)
    return K, D, M


def arrange_beat4(dur, rng):
    """2628268286 — the build, and then the switch. The chop pattern's holds
    keep halving, so the track is written as tension and release: seven seconds
    of riser and an accelerating snare roll, an impact and four-on-the-floor at
    the drop, then at 11.5s it halves into a distorted half-time outro with the
    sub falling off the bottom — the beat switch the album keeps doing."""
    K, D, M = buf(dur), buf(dur), buf(dur)
    k = kick(dur=0.34, f0=150, f1=48, tail=0.07, drive=1.8, rng=rng)
    kh = kick(dur=0.6, f0=170, f1=42, drop=0.05, tail=0.20, drive=2.2, rng=rng)
    s = snare(dur=0.2, tone=210, bright=0.75, drive=1.3, rng=rng)
    sbig = reverb(snare(dur=0.4, tone=180, bright=1.0, drive=1.6, rng=rng),
                  wet=0.4, size=1.1)
    h = hat(rng, 0.04, 0.01)
    drop_at, switch_at = 3 * BAR + 2 * BEAT, 5 * BAR + 3 * BEAT
    bars = int(dur / BAR) + 1
    for b in range(bars):
        t0 = b * BAR
        for e in range(8):
            at = t0 + e * 0.5 * BEAT
            if at >= switch_at:
                break
            if at >= drop_at:
                mix_in(K, k, at, 0.92 if e % 2 == 0 else 0.0)
                mix_in(D, h, at + 0.25 * BEAT, 0.3)
            elif e % 2 == 0 and b >= 1:
                mix_in(K, k, at, 0.6)
        # the roll: eighths, then sixteenths, then thirty-seconds
        if t0 < drop_at:
            step = (0.5, 0.5, 0.25, 0.125)[min(b, 3)]
            e = 0.0
            while e < 4 and t0 + e * BEAT < drop_at:
                mix_in(D, s, t0 + e * BEAT,
                       0.14 + 0.4 * (e / 4) * ((b + 1) / 4))
                e += step
        elif t0 >= switch_at:
            pass
        else:
            for at in (1, 3):
                mix_in(D, sbig, t0 + at * BEAT, 0.5)
    mix_in(M, riser(rng, drop_at), 0, 0.24)
    mix_in(D, impact(rng), drop_at, 0.7)
    mix_in(D, crash(rng), drop_at, 0.45)
    for j, f in enumerate((41.2, 41.2, 55.0, 36.7)):
        mix_in(M, sub(f, 1.5 * BEAT, sat=2.2), drop_at + j * BEAT, 0.8)
    # the switch: half time, one heavy kick and snare per bar, then the sink
    mix_in(D, downlifter(rng, 1.2), switch_at, 0.4)
    for j in range(3):
        mix_in(K, kh, switch_at + j * 2 * BEAT, 1.0)
        mix_in(D, sbig, switch_at + j * 2 * BEAT + BEAT, 0.55)
    mix_in(M, subdrop(70.0, 2.0), switch_at + 1.2, 0.75)
    mix_in(D, crash(rng), switch_at, 0.4)
    return K, D, M


ARRANGE = {"beat1": arrange_beat1, "beat2": arrange_beat2,
           "beat3": arrange_beat3, "beat4": arrange_beat4}


def write_wav(path, mono, headroom=0.89):
    peak = max(1e-9, max(abs(v) for v in mono))
    scale = headroom / peak if peak > headroom else 1.0
    data = array.array("h", (int(max(-1.0, min(1.0, v * scale)) * 32767) for v in mono))
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(data.tobytes())


def render_stems(name, dur):
    rng = random.Random(sum(ord(c) for c in name) * 7919)
    paths = []
    for tag, sig in zip(("kick", "drums", "music"), ARRANGE[name](dur, rng)):
        p = os.path.join(TMP, f"{name}_{tag}.wav")
        write_wav(p, sig)
        paths.append(p)
    return paths


# ------------------------------------------------------------------ mixdown
# Per-track recipes. `chops` is what happens to the key sequence itself before
# it meets the kit, `stems` the level and colour of each of the three stems.
# The chops chain always ends ducked against the kick — that pumping is most of
# why a loop and a kit sound like one record instead of two files.

MIX = {
    "beat1": dict(
        # a bar of muffled loop before the beat lands, then it opens up
        chops="[0:a]asplit=2[ci][cr];"
              "[ci]atrim=0:2,asetpts=N/SR/TB,lowpass=f=520,volume=0.9[cii];"
              "[cr]atrim=2,asetpts=N/SR/TB[crr];[cii][crr]concat=n=2:v=0:a=1,"
              "equalizer=f=2600:t=q:w=1.1:g=2,asoftclip=type=tanh:param=0.55",
        duck="threshold=0.055:ratio=6:attack=6:release=190",
        chop_gain=0.80, kick_gain=1.00, drums_gain=0.72, music_gain=0.66,
        drums_fx="equalizer=f=180:t=q:w=1:g=-2,aexciter=amount=1.4",
        music_fx="extrastereo=m=1.4,lowpass=f=9000"),
    "beat2": dict(
        # crushed and high-passed: the 808s own everything under 120Hz
        chops="[0:a]highpass=f=125,acrusher=bits=9:mode=log:mix=0.35,"
              "equalizer=f=3400:t=q:w=1.2:g=2.5",
        duck="threshold=0.04:ratio=9:attack=3:release=150",
        chop_gain=0.74, kick_gain=0.95, drums_gain=0.80, music_gain=0.82,
        drums_fx="aexciter=amount=2,equalizer=f=8000:t=q:w=1:g=2",
        music_fx="extrastereo=m=1.2,asoftclip=type=atan:param=0.6"),
    "beat3": dict(
        # dub: darker, wider, and echoing a dotted eighth behind itself
        chops="[0:a]lowpass=f=6500,aecho=0.9:0.75:375|750:0.35|0.18,"
              "equalizer=f=300:t=q:w=1.2:g=1.5",
        duck="threshold=0.09:ratio=4:attack=12:release=320",
        chop_gain=0.86, kick_gain=0.92, drums_gain=0.60, music_gain=0.62,
        drums_fx="lowpass=f=7000",
        music_fx="extrastereo=m=1.6,lowpass=f=7500"),
    "beat4": dict(
        # filtered flat through the build, wide open on the drop, crushed after
        # the switch — the chops move with the arrangement instead of sitting
        # at one setting under it
        chops="[0:a]asplit=3[cb][cd][cs];"
              "[cb]atrim=0:7,asetpts=N/SR/TB,lowpass=f=900,volume=0.85[cbb];"
              "[cd]atrim=7:11.5,asetpts=N/SR/TB,equalizer=f=3000:t=q:w=1:g=2[cdd];"
              "[cs]atrim=11.5,asetpts=N/SR/TB,acrusher=bits=8:mode=log:mix=0.5[css];"
              "[cbb][cdd][css]concat=n=3:v=0:a=1,asoftclip=type=tanh:param=0.6",
        duck="threshold=0.05:ratio=8:attack=4:release=160",
        chop_gain=0.72, kick_gain=1.00, drums_gain=0.86, music_gain=0.80,
        drums_fx="aexciter=amount=1.8",
        music_fx="extrastereo=m=1.3"),
}

# One master chain for all four so the album sounds like one record: gentle
# glue compression, a little weight and air, and tanh instead of a hard
# ceiling. Deliberately light — an earlier version ran a heavier compressor
# into loudnorm's own dynamic pass and came out at under 1 LU of range, which
# is a track with no drums left in it: the transients that make a kit sound
# like a kit are exactly what that squashes.
MASTER = ("acompressor=threshold=0.26:ratio=2:attack=20:release=260:makeup=1.1,"
          "equalizer=f=120:t=q:w=1:g=1.2,equalizer=f=9000:t=q:w=1:g=1.5,"
          "asoftclip=type=tanh:param=0.85")

TARGET_LUFS = -14.0


def measure_lufs(path):
    out = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", path,
                          "-af", "ebur128=framelog=quiet", "-f", "null", "-"],
                         capture_output=True, text=True).stderr
    for line in out.splitlines():
        if "I:" in line and "LUFS" in line:
            return float(line.split("I:")[1].split("LUFS")[0])
    return TARGET_LUFS


def mixdown(name, chops, stems):
    """Two passes: build the mix, measure it, then trim it to the album's level
    with one static gain. A static gain is the point — loudnorm would hit the
    same number by riding the volume, and riding the volume is what flattened
    these the first time round."""
    m = MIX[name]
    graph = (
        f"{m['chops']}[cf];"
        f"[1:a]aformat=channel_layouts=stereo,volume={m['kick_gain']}[k];"
        f"[2:a]aformat=channel_layouts=stereo,{m['drums_fx']},volume={m['drums_gain']}[d];"
        f"[3:a]aformat=channel_layouts=stereo,{m['music_fx']},volume={m['music_gain']}[mu];"
        # the kick keys the duck, and is also heard: asplit so one copy does each
        f"[k]asplit=2[kmix][kkey];"
        f"[cf][kkey]sidechaincompress={m['duck']}[cd];"
        f"[cd]volume={m['chop_gain']}[cv];"
        f"[cv][kmix][d][mu]amix=inputs=4:normalize=0:dropout_transition=0[mix];"
        f"[mix]{MASTER}[out]")
    rough = os.path.join(TMP, name + "_mix.wav")
    run(["ffmpeg", "-v", "error", "-y", "-i", chops, *sum((["-i", s] for s in stems), []),
         "-filter_complex", graph, "-map", "[out]", "-ar", str(SR), "-ac", "2", rough])
    gain = TARGET_LUFS - measure_lufs(rough)
    run(["ffmpeg", "-v", "error", "-y", "-i", rough,
         "-af", f"volume={gain:.2f}dB,"
                "alimiter=level_in=1:limit=0.97:attack=5:release=80",
         "-c:a", "libmp3lame", "-b:a", "160k", "-ar", str(SR),
         os.path.join(OUT, name + ".mp3")])


# The album's sleeve, shared by every track on it: a close-up of the numpad the
# whole campaign runs on, cropped to the nine number keys and nothing else —
# the instrument, framed the way a record frames whatever it was played on.
# Centre and half-size are in the source photo's own pixels; the crop is square
# so the card can scale it without deciding anything.
COVER_SRC = os.path.join(os.path.dirname(OUT), "numpad.jpg")
COVER_CENTRE = (527, 382)
COVER_HALF = 140   # tight enough that the nine keys fill the frame edge to edge
COVER_PX = 320      # the card draws it at ~70px, so this covers 4x displays


def render_cover():
    from PIL import Image
    im = Image.open(COVER_SRC).convert("RGB")
    cx, cy = COVER_CENTRE
    crop = im.crop((cx - COVER_HALF, cy - COVER_HALF, cx + COVER_HALF, cy + COVER_HALF))
    crop.resize((COVER_PX, COVER_PX), Image.LANCZOS).save(
        os.path.join(OUT, "cover.jpg"), quality=88, optimize=True)


os.makedirs(OUT, exist_ok=True)
os.makedirs(TMP, exist_ok=True)
normalize()
render_cover()
titles = {}
for b in BEATS:
    seq = expand(b["pattern"])
    mixdown(b["id"], render_chops(b["id"], seq), render_stems(b["id"], TARGET))
    titles[b["id"]] = "".join(str(d) for d, _ in b["pattern"])
    print(b["id"], titles[b["id"]], "|", len(seq), "presses |",
          os.path.getsize(os.path.join(OUT, b["id"] + ".mp3")) // 1024, "KB")
print(json.dumps(titles))
