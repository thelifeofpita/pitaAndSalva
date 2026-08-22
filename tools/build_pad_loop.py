#!/usr/bin/env python3
"""Turn the product turntable clip into a loop for the Numpad Jam page.

The source is an 8s take of the pad spinning on black. None of them loop as
shot — each eases up from a standstill and none runs at one rate — but some of
them do come all the way back round, and whether a take does is the single fact
this script has to establish first, because everything downstream depends on
it:

  0. CLOSE? One frame partway through is compared against the first. If the two
     sit closer together than two ordinary neighbours do, the take has returned
     to its own starting pose and owns a whole revolution; everything after
     that frame is the generator filling out its running time and is dropped.
     If nothing matches that well, the take fell short of a full turn and the
     loop will have to hide the missing arc.

  1. STABILISE. The pad wanders across frame as it turns, so each frame is
     shifted to put the pad's bounding-box centre on the same point. Measured
     off a box-averaged mask, because the ground has specks on it and one speck
     at the edge of frame moves a bounding box by hundreds of pixels.

  2. RETIME. The take does not turn at one rate — it crawls for its first few
     frames and runs in the middle — so the frames are resampled at evenly
     spaced ANGLES rather than played in order. Angle comes from two signals,
     each used only where it is trustworthy: the silhouette's width gives the
     four quarter turns exactly (see `quarter_turns`), and how much the picture
     changes between frames distributes the angle inside each quarter (see
     `angle_curve`). Neither is any good at the other's job.

     Output frames are then the nearest source frame to each wanted angle —
     nearest, never blended. Mixing the two frames either side seems smoother
     and is not: it puts the pad ghosted over itself two degrees away on every
     single frame. The output rate is set low enough (see FPS) that "nearest"
     almost always means a frame of its own.

  3. FIX WHAT IS BROKEN, AND ONLY THAT. A take that closes needs nothing else:
     its size and look already match across the seam, and correcting them
     against a model of a turntable — which this footage only approximately is
     — would push two frames that already agree apart. A take that fell short
     gets the rest: its drift divided out, its best wrap point found, its
     residual size unwound over the whole loop, and a short dissolve across
     what is still missing.

  python3 tools/build_pad_loop.py ~/path/to/turntable.mp4
"""
import glob
import math
import os
import shutil
import subprocess
import sys
import tempfile

from PIL import Image, ImageChops

SRC = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("PAD_CLIP", "")
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                   "img", "projects", "numpad-jam")
TMP = os.path.join(tempfile.gettempdir(), "numpad-pad-loop")

# 12fps, not 24. Every output frame here is a source frame — no blending, no
# invention — so asking for more of them than the take has only means showing
# some of them twice. The take spends 184 frames on a revolution but spreads
# them unevenly: its thinnest quarter has 37. At 12fps a 12s turn needs 144,
# which is 36 a quarter, so even that quarter has a frame of its own to show
# for every one of them.
FPS = 12
SECONDS = 12.0            # a full turn in 12s — the source does it in 8
OUT_FRAMES = int(FPS * SECONDS)
FADE_FRAMES = 3           # ~0.12s: the seam dissolve, see (3) above
CROP = (960, 700)         # around the pad at its widest pose, with margin
SIZE = (768, 560)         # what ships; the card draws it at ~576px wide
# The generator stamps a "Veo" watermark into the bottom-right corner. It is
# masked out of every measurement here and cropped out of the render.
WATERMARK = (1180, 650)
INK = 30                  # luma above this is the pad, below it is the ground
# The take's "black" is not black — it sits around 2-11, which on a page whose
# own background is #000 draws the clip's rectangle as a grey panel behind the
# pad. Everything at or under this level is pulled to true black and the rest
# is stretched back up, so the pad floats on the page instead of sitting in a
# box on it.
BLACK_POINT = 12
LIFT = bytes([0 if v <= BLACK_POINT else
              min(255, round((v - BLACK_POINT) * 255 / (255 - BLACK_POINT)))
              for v in range(256)]) * 3


def run(cmd):
    subprocess.run(cmd, check=True, capture_output=True)


def explode():
    frames = os.path.join(TMP, "src")
    if os.path.isdir(frames) and glob.glob(os.path.join(frames, "*.png")):
        return sorted(glob.glob(os.path.join(frames, "*.png")))
    os.makedirs(frames, exist_ok=True)
    run(["ffmpeg", "-v", "error", "-y", "-i", SRC, "-vsync", "0",
         os.path.join(frames, "%03d.png")])
    return sorted(glob.glob(os.path.join(frames, "*.png")))


def silhouette(path):
    """Bounding box of the pad, watermark excluded.

    Measured on a box-averaged copy rather than the frame itself. The ground is
    not clean — there are faint specks and compression noise scattered over it,
    a few of them above the ink threshold — and a bounding box is decided by
    its most extreme pixel, so one speck at the edge of frame moves it by
    hundreds of pixels. (It did: on one take the box ran out to x=19 for a pad
    that starts at x=291, which threw the centring and the quarter-turn
    landmarks off with it.) Averaging 4x4 blocks first sinks anything smaller
    than a block below the threshold and leaves the pad, which is solid,
    exactly where it was."""
    im = Image.open(path).convert("L")
    small = im.resize((im.width // 4, im.height // 4), Image.BOX)
    mask = small.point(lambda v: 255 if v > INK else 0)
    mask.paste(0, (WATERMARK[0] // 4, WATERMARK[1] // 4, mask.width, mask.height))
    b = mask.getbbox()
    return tuple(v * 4 for v in b) if b else (0, 0, im.width, im.height)


def smooth(values, window=9, circular=False):
    """Moving average. `circular` for a take that closes: its last frame is its
    first, so the window has to run round the join rather than stop at it —
    otherwise the two ends get smoothed against different neighbours and a
    perfectly matched pair of frames comes out shifted apart by a few pixels."""
    half, out, n = window // 2, [], len(values)
    for i in range(n):
        if circular:
            out.append(sum(values[(i + k) % n] for k in range(-half, half + 1))
                       / window)
        else:
            lo, hi = max(0, i - half), min(n, i + half + 1)
            out.append(sum(values[lo:hi]) / (hi - lo))
    return out


def extrema(widths, lo, hi, want_min):
    """The frame in [lo,hi] where the silhouette is narrowest or widest —
    edge-on or face-on, i.e. a quarter turn."""
    rng = range(lo, hi + 1)
    return min(rng, key=lambda i: widths[i]) if want_min else \
        max(rng, key=lambda i: widths[i])


def motion(frames, centres):
    """Cumulative frame-to-frame difference on stabilised thumbnails: a proxy
    for how far the pad has turned, which frame number is not while the take is
    still speeding up or slowing down."""
    thumbs = []
    for path, (cx, cy) in zip(frames, centres):
        im = Image.open(path).convert("L")
        thumbs.append(im.crop((int(cx) - 480, int(cy) - 350,
                               int(cx) + 480, int(cy) + 350)).resize((160, 117)))
    cum = [0.0]
    for a, b in zip(thumbs, thumbs[1:]):
        h = ImageChops.difference(a, b).histogram()
        cum.append(cum[-1] + sum(i * h[i] for i in range(256)) / sum(h))
    return cum


def find_repeat(frames):
    """Look for the frame that brings the pad back to where it started.

    Compared raw, not stabilised: if the take really does close, the frame is
    a repeat in the footage itself and needs no help to match. The test is
    against the take's own neighbour-to-neighbour difference — a pair that
    matches better than two consecutive frames do is the same pose twice, and
    anything looser is just the nearest miss. Returns (closed, last)."""
    thumbs = [Image.open(f).convert("L").resize((96, 54)) for f in frames]

    def d(a, b):
        h = ImageChops.difference(thumbs[a], thumbs[b]).histogram()
        return sum(i * h[i] for i in range(256)) / sum(h)

    mid = len(thumbs) // 2
    baseline = sum(d(i, i + 1) for i in range(mid - 5, mid + 5)) / 10
    # half a turn is the least that could be called coming back round
    best, at = min((d(0, j), j) for j in range(len(thumbs) // 2, len(thumbs)))
    print(f"closest return to frame 0: frame {at} at {best:.2f} "
          f"(neighbours differ by {baseline:.2f})")
    return (best < baseline, at) if best < baseline else (False, at)


def quarter_turns(widths, last):
    """The four frames whose angle is known exactly, read off the silhouette.

    W(θ) = width·|cos θ| + depth·|sin θ|, so the two NARROWEST frames of the
    take are exactly edge-on: 90 and 270, where the cos term is gone and only
    the pad's depth is left. The half turn is the dip between the two widest
    frames either side of it — because the widest frames are not flat-on, as an
    earlier version of this assumed. dW/dθ at θ=0 is +depth, so the silhouette
    keeps widening past the flat pose and peaks about 16 degrees beyond it;
    calling that peak the half turn puts the mark 16 degrees late and makes the
    retiming speed up and slow down four times a revolution chasing it.

    Only these four, and not an angle for every frame. Inverting the width
    frame by frame is exact where the width is moving and worthless where it
    isn't: flat-on it sits at an extremum, ten frames here reading 708, 708,
    709, 710, 710, and the inverse of a width that isn't moving is noise —
    taken literally it stalls the angle and then lurches it. The four landmarks
    are the part of the geometry that is unambiguous, and it is enough.

    Returns None if the take's shape doesn't read as a turntable at all."""
    w = smooth(widths[:last + 1], 5)

    def arg(lo, hi, want_min):
        lo, hi = max(1, lo), min(last - 1, hi)
        return extrema(w, lo, hi, want_min) if hi > lo else lo

    quarter = last // 4
    m1 = arg(quarter // 2, last // 2, True)                 # edge-on, 90
    m2 = arg(last // 2, last - quarter // 2, True)          # edge-on, 270
    mid = (m1 + m2) // 2
    p1, p2 = arg(m1 + 1, mid, False), arg(mid, m2 - 1, False)
    half = arg(p1 + 1, p2 - 1, True)                        # the half turn, 180
    if not 0 < m1 < half < m2 < last:
        return None
    print(f"quarter turns at frames {[0, m1, half, m2, last]} "
          f"({m1}, {half - m1}, {m2 - half}, {last - m2} frames each)")
    return [(0, 0.0), (m1, 90.0), (half, 180.0), (m2, 270.0), (last, 360.0)]


def angle_curve(marks, cum):
    """Angle per frame: the landmarks are geometry, and inside each quarter the
    angle advances with how much the picture actually changed.

    Motion is a poor guide to angle across a whole turn — it depends on what is
    facing the camera, and it is about twice as sensitive over the quarters
    showing this pad's keypad as over the ones showing its blank back, which is
    a 2:1 error if it is trusted end to end. Inside ONE quarter the camera sees
    the same faces throughout, so the bias is near enough constant and what is
    left is a good account of where the take sped up and where it crawled. The
    landmarks stop that error from ever accumulating past a quarter."""
    theta = [0.0] * (marks[-1][0] + 1)
    for (i0, a0), (i1, a1) in zip(marks, marks[1:]):
        span = cum[i1] - cum[i0]
        for i in range(i0, i1 + 1):
            t = (cum[i] - cum[i0]) / span if span else 0.0
            theta[i] = a0 + (a1 - a0) * t
    return theta


def drift_ratio(measured, theta, last, basis, label):
    """How much bigger the pad is than it ought to be, frame by frame.

    Size can't be read off the silhouette directly, because a box on a
    turntable legitimately changes silhouette as it turns: it is widest
    face-on and narrowest edge-on, and — because this one sits tilted rather
    than square to the axis — it also stands tallest when it is edge-on. Both
    are known shapes of θ, so `basis` gives the two terms of one, they are
    fitted over the whole take by least squares, and the fit says what each
    frame's own angle SHOULD measure. Whatever is left over is the take's
    drift, which is what gets divided out. Smoothed, because the measurement
    is a bounding box and a bounding box is noisy."""
    f11 = f22 = f12 = m1 = m2 = 0.0
    for i in range(last + 1):
        u, v = basis(theta[i])
        f11 += u * u
        f22 += v * v
        f12 += u * v
        m1 += measured[i] * u
        m2 += measured[i] * v
    det = f11 * f22 - f12 * f12
    a = (m1 * f22 - m2 * f12) / det
    b = (m2 * f11 - m1 * f12) / det
    ratio = []
    for i in range(len(measured)):
        u, v = basis(theta[min(i, last)])
        model = a * u + b * v
        ratio.append(measured[i] / model if model > 1 else 1.0)
    print(f"{label}: fit {a:.0f}/{b:.0f}, drift {min(ratio):.3f}-{max(ratio):.3f}")
    return smooth(ratio, 15)


# W(θ) = width·|cos θ| + depth·|sin θ| — a box seen from the side.
# H(θ) = height + lean·|sin θ| — the same box, tilted back off its axis.
def width_basis(t):
    return abs(math.cos(math.radians(t))), abs(math.sin(math.radians(t)))


def height_basis(t):
    return 1.0, abs(math.sin(math.radians(t)))


def source_at(theta, angle, last):
    """Fractional source index for a wanted angle."""
    if angle <= theta[0]:
        return 0.0
    for i in range(last):
        if theta[i] <= angle <= theta[i + 1]:
            gap = theta[i + 1] - theta[i]
            return i + ((angle - theta[i]) / gap if gap else 0.0)
    return float(last)


def sample(frames, centres, drift, x):
    """One output frame: the source frame nearest the wanted angle, stabilised
    in position and size, and cropped.

    NEAREST, not blended. Mixing the two frames either side of the wanted angle
    seems like the smoother choice and is not: a turntable frame blended with
    the next one is the pad ghosted over itself two degrees away, and doing it
    on every output frame puts a soft double image on the whole clip. Better to
    show a real frame, slightly early or slightly late, than a real frame
    crossed with another. The output rate is set to the source's own angular
    resolution (see FPS) so the rounding is rarely more than half a frame."""
    idx = min(max(int(round(x)), 0), len(frames) - 1)

    def one(idx):
        im = Image.open(frames[idx]).convert("RGB")
        cx, cy = centres[idx]
        # a frame whose pad grew by s is cropped s times bigger and scaled
        # back down, which is the same thing as shrinking the pad by s. The two
        # axes drift by different amounts here, so they are corrected apart.
        sw, sh = drift[0][idx], drift[1][idx]
        w, h = CROP[0] * sw, CROP[1] * sh
        left, top = int(round(cx - w / 2)), int(round(cy - h / 2))
        # pad rather than clamp: clamping would slide the pad off centre again
        box = Image.new("RGB", (int(round(w)), int(round(h))), (0, 0, 0))
        box.paste(im.crop((left, top, left + box.width, top + box.height)), (0, 0))
        return box.resize(CROP, Image.LANCZOS)

    return one(idx)


def thumbs_of(frames):
    return [Image.open(f).convert("L").resize((96, 54)) for f in frames]


def picture_step(a, b):
    h = ImageChops.difference(a, b).histogram()
    return sum(i * h[i] for i in range(256)) / sum(h)


def source_fps(path, count):
    """The clip's own rate. Asked of the container rather than assumed, and
    worked out from the duration because a GIF's nominal rate and the rate its
    frame delays actually add up to are not always the same number."""
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries",
                          "format=duration", "-of", "csv=p=0", path],
                         capture_output=True, text=True).stdout.strip()
    try:
        return count / float(out)
    except (ValueError, ZeroDivisionError):
        return float(FPS)


def trim_stalls(frames):
    """Drop frames off either end that aren't moving.

    A clip that has been cut by hand often starts or ends on a couple of near
    identical frames — the pad sitting still for a beat before it goes. Played
    once that reads as a considered opening; played on a loop it is a hitch
    every time round, and it is usually the ONLY thing standing between a hand
    cut clip and a seamless one. A frame counts as stalled when it moves less
    than a third of what the clip typically moves between frames."""
    th = thumbs_of(frames)
    steps = [picture_step(a, b) for a, b in zip(th, th[1:])]
    typical = sorted(steps)[len(steps) // 2]
    head = 0
    while head < len(steps) - 2 and steps[head] < typical * 0.3:
        head += 1
    tail = 0
    while tail < len(steps) - head - 2 and steps[-1 - tail] < typical * 0.3:
        tail += 1
    kept = frames[head:len(frames) - tail]
    wrap = picture_step(th[len(frames) - tail - 1], th[head])
    print(f"trimmed {head} stalled frames off the head and {tail} off the tail; "
          f"wrap now {wrap:.2f} against a typical {typical:.2f}")
    # a wrap no worse than an ordinary step means it is already a loop
    return kept, wrap <= typical * 1.6


def write_out(rendered, fps):
    """Frames to mp4, plus the poster the page shows before it plays."""
    out_dir = os.path.join(TMP, "out")
    shutil.rmtree(out_dir, ignore_errors=True)
    os.makedirs(out_dir)
    for k, im in enumerate(rendered):
        im.resize(SIZE, Image.LANCZOS).point(LIFT).save(
            os.path.join(out_dir, f"{k:04d}.png"))
    mp4 = os.path.join(OUT, "pad.mp4")
    run(["ffmpeg", "-v", "error", "-y", "-framerate", f"{fps:.4f}",
         "-i", os.path.join(out_dir, "%04d.png"),
         "-an", "-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p",
         "-crf", "24", "-preset", "slow", "-movflags", "+faststart", mp4])
    rendered[0].resize(SIZE, Image.LANCZOS).point(LIFT).save(
        os.path.join(OUT, "pad.jpg"), quality=86, optimize=True)
    print(f"pad.mp4 {os.path.getsize(mp4) // 1024} KB / "
          f"{len(rendered) / fps:.2f}s at {fps:.2f}fps")


def main():
    if not SRC or not os.path.exists(SRC):
        sys.exit("pass the turntable clip as argv[1] (or set PAD_CLIP)")
    os.makedirs(TMP, exist_ok=True)
    frames = explode()

    # Is it a loop already? An edit that has been cut by hand needs nothing
    # done to it but its stalled ends taken off — retiming, drift correction
    # and seam-hiding all exist to rescue a raw take, and running them over a
    # clip that already works can only move it away from where it was put.
    fps_in = source_fps(SRC, len(frames))   # before trimming: the clip's own rate
    frames, loops = trim_stalls(frames)
    if loops:
        print("already a loop — keeping its own frames and its own timing")
        boxes = [silhouette(f) for f in frames]
        cx = smooth([(b[0] + b[2]) / 2 for b in boxes], circular=True)
        cy = smooth([(b[1] + b[3]) / 2 for b in boxes], circular=True)
        centres = list(zip(cx, cy))
        flat = ([1.0] * len(frames), [1.0] * len(frames))
        write_out([sample(frames, centres, flat, i) for i in range(len(frames))],
                  fps_in)
        return

    # Does the take come back round? Some of them do: the pad returns to its
    # exact starting pose partway through and the generator then does something
    # else with the frames it has left. That repeat is worth finding, because a
    # take that owns one whole revolution can be cut into a loop with nothing
    # hidden at the seam at all — no dissolve, no missing arc.
    #
    # It is a repeat rather than a near-miss when the two frames sit CLOSER
    # together than two ordinary neighbours do: that is the only threshold that
    # means anything here, since how much a frame differs from the next one is
    # exactly the resolution this footage can distinguish poses at.
    closed, last = find_repeat(frames)
    if closed:
        # everything past the repeat is the generator filling time after the
        # turn was over — it is not part of the revolution and would drag the
        # measurements around if it were left in
        frames = frames[:last + 1]
        print(f"take closes: frame {last} repeats frame 0 — one whole turn, "
              f"{len(frames) - 1} frames of it")

    boxes = [silhouette(f) for f in frames]
    widths = [b[2] - b[0] for b in boxes]
    heights = [b[3] - b[1] for b in boxes]
    cx = smooth([(b[0] + b[2]) / 2 for b in boxes], circular=closed)
    cy = smooth([(b[1] + b[3]) / 2 for b in boxes], circular=closed)
    centres = list(zip(cx, cy))

    cum = motion(frames, centres)
    if not closed:
        # it never comes back round, so the turn is whatever ran before the
        # take decelerated to its stop; that frozen tail is not part of it
        steps = [cum[i + 1] - cum[i] for i in range(len(cum) - 1)]
        moving = max(steps)
        last = len(frames) - 1
        while last > 1 and steps[last - 1] < moving * 0.06:
            last -= 1
        print(f"take does not close: turning through frame {last}")

    marks = quarter_turns(widths, last)
    if marks is None:
        # nothing recognisable to anchor to: the ends are all that is left
        print("shape unreadable — anchoring on the ends alone")
        marks = [(0, 0.0), (last, 360.0)]
    theta = angle_curve(marks, cum)
    if closed:
        # Nothing to correct, and correcting anyway would do harm: the pad
        # measures the same at both ends of a take that closes, so any residual
        # the model reports is the model's error, not the footage's — and
        # applying it would push two frames that already match apart.
        drift = ([1.0] * len(frames), [1.0] * len(frames))
    else:
        drift = (drift_ratio(widths, theta, last, width_basis, "width"),
                 drift_ratio(heights, theta, last, height_basis, "height"))

    rendered = []
    for k in range(OUT_FRAMES):
        x = source_at(theta, 360.0 * k / OUT_FRAMES, last)
        rendered.append(sample(frames, centres, drift, x))

    # Where the pose actually comes back round. The take stops a little short
    # of a full turn, so cutting at the nominal 360 leaves the pad visibly
    # further along than it started and the dissolve has to ghost that gap
    # away. Comparing the rendered frames against their own first frame finds
    # the real wrap point instead, and the loop is trimmed to it: a couple of
    # tenths shorter than nominal, and matched at the seam.
    # A take that closes needs none of what follows: its own last frame is its
    # first frame, so the loop is already the whole turn and cutting it is
    # enough. Only a take that fell short has to be trimmed to its best wrap
    # and dissolved across what is missing.
    # Compared as silhouettes, not as pictures. The take's lighting and colour
    # drift as it goes, and against a raw-luma metric that drift swamps
    # everything: every late frame scores about the same, so the search can't
    # see which one is actually back at the starting pose. A binary mask throws
    # the look away and leaves the outline, which is the thing that has to line
    # up for a cut to be invisible.
    def key(im):
        return im.convert("L").resize((160, 117)).point(
            lambda v: 255 if v > INK else 0)

    head = key(rendered[0])

    def gap(im):
        h = ImageChops.difference(head, key(im)).histogram()
        return sum(i * h[i] for i in range(256)) / sum(h)

    if closed:
        print(f"seam {gap(rendered[-1]):.1f} — nothing trimmed, nothing hidden")
    else:
        window = range(OUT_FRAMES - 72, OUT_FRAMES)
        wrap = min(window, key=lambda k: gap(rendered[k]))
        print(f"wrap at {wrap}/{OUT_FRAMES} frames ({wrap / FPS:.2f}s), "
              f"seam {gap(rendered[wrap]):.1f} vs nominal {gap(rendered[-1]):.1f}")
        rendered = rendered[:wrap]

    # Unwind whatever size difference is left across the seam. Correcting the
    # source against a model of its own silhouette (above) gets most of the
    # drift, but not all of it — the model is a box on a turntable and this
    # footage only approximately is one. So the last frame is measured against
    # the first and the difference is spread over the whole loop as a smooth
    # ramp: about a percent a second, which nobody can see going round, and a
    # seam that matches in size at the end of it.
    def extent(im):
        m = im.convert("L").point(lambda v: 255 if v > INK else 0)
        b = m.getbbox()
        return (b[2] - b[0], b[3] - b[1])

    if closed:
        print("no residual to unwind: the take closes on itself")
        fw = fh = lw = lh = 1
    else:
        fw, fh = extent(rendered[0])
        lw, lh = extent(rendered[-1])
    rw, rh = lw / fw, lh / fh
    if not closed:
        print(f"residual size at seam: {rw:.3f} x {rh:.3f} — unwinding")
    n = len(rendered) - 1
    for k in range(1, len(rendered)):
        sw, sh = rw ** (k / n), rh ** (k / n)
        im = rendered[k]
        w, h = int(round(im.width / sw)), int(round(im.height / sh))
        # resize about the centre, then re-crop to the frame it came from
        big = im.resize((w, h), Image.LANCZOS)
        left, top = (w - im.width) // 2, (h - im.height) // 2
        rendered[k] = big.crop((left, top, left + im.width, top + im.height))

    # what is left at the seam is the look drifting, not the pose: a short
    # dissolve of the tail into the head covers it
    for j in range(0 if closed else FADE_FRAMES):
        w = (j + 1) / (FADE_FRAMES + 1)
        rendered[len(rendered) - FADE_FRAMES + j] = Image.blend(
            rendered[len(rendered) - FADE_FRAMES + j], rendered[j], w)

    write_out(rendered, FPS)


main()
