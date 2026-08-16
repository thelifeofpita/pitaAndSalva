# pitalva — landing site

Everything on screen is a pre-rendered 1-bit frame in `img/`. The page is a fixed
1920×1080 stage scaled to the viewport, so every element sits at exactly the
coordinate it sits at in `keyframes/`.

## Run

```
cd site && python3 -m http.server 8777
open http://localhost:8777/
```

(Needs to be served over HTTP — `app.js` fetches `img/ui.json`.)

## What is where

| file | what |
| --- | --- |
| `img/landing_plate.png` | the landing hands, taken from `keyframes/landing.png` with the overlay artwork erased so the labels/icons/campaign names can be live elements |
| `img/dap{0..4}_*.png` | five different daps (`videos/daps.MOV`), 8 frames each; one plays at random on every load and on every return to the landing |
| `img/frames.json` | the frame manifest the page reads — written by the build, so the page can never reference a frame that was renamed or dropped |
| `img/pita_*.png`, `salva_*.png`, `amp_*.png` | the camera-move transitions |
| `img/kf_pita.png`, `kf_salva.png`, `kf_amp.png` | the destination states — the supplied keyframes, used as-is |
| `img/rpspump_*.png` | the shared rock-paper-scissors count-in |
| `img/rpshold_XY.png` | the 9 results; X = left hand, Y = right hand, each `r`/`p`/`s` |
| `img/rpsr_<combo>_*.png` | real rounds: the hold, the hands acting the result out, and the settle — whole frames from the take that actually played that combination |
| `img/rpsback_*.png` | fallback aftermath for combinations with no real round yet — hands unclench and open back out, composited per-arm |
| `img/ui/*` | the overlay artwork, sliced out of `assets/` |
| `img/ui/hand_*.png` | the BACK control — each landing hand cut out of `landing_plate.png` by `tools/build_hands.py`, baked at its on-screen size; `_v` is the same hand turned to point up |
| `img/ui.json` | position of every overlay element in 1920×1080 space |
| `sw.js` | the frame cache — see *Playing frames over a network* below |

## Playing frames over a network

A dap holds each drawing for ~132ms, so a frame that arrives late does not
arrive at all. Locally that is free. On GitHub Pages it is not: every file comes
back with `cache-control: max-age=600`, so ten minutes after a visit the browser
has to revalidate each of the 200 frames over the network before it can paint
it. That is what made playback stutter online and look perfect on localhost.

Three things keep the holds even, none of which change what is on screen:

- **`sw.js`** keeps the frames in Cache Storage, where `max-age` does not reach
  them. After the first visit a frame is a memory read, at any age, on any
  connection, including none. Bump `VERSION` in it after rebuilding frames to
  move every client onto the new art at once; without a bump the changes still
  land, one visit later.
- **The plate is a `<canvas>`.** `drawImage` paints inside the call. Assigning
  `img.src` does not — the element keeps showing the previous frame until the new
  one resolves, so a slow frame is not a late frame, it is a frame nobody sees.
- **Frames are decoded before they are due.** `createImageBitmap` runs off the
  main thread, on a sliding window of `WINDOW` frames around the playhead;
  `BMP_CAP` bounds how many stay decoded, because a decoded 1920×1080 frame
  costs ~8MB and all 170 at once would be 1.4GB. (`HTMLImageElement.decode()` is
  the obvious tool and cannot be used: on a detached image its promise can
  simply never settle.)

Boot waits for the landing plate and the one dap about to play — nine files, not
191. The rest is fetched behind the dap.

## Interactions

- **Load / return to landing** — a random dap plays, then the hands settle into
  the landing plate.
- **SALVA / PITA** — plays the camera pull-back from `videos/salva.MOV` /
  `videos/pita.MOV`, landing on the keyframe.
- **&** — plays the upward move from `videos/high_angle.MOV`. Its horizontal
  crop follows the midpoint between Pita and Salva, weighting both people
  equally rather than favoring whichever subject has more bright pixels. The
  vertical crop remains a clean camera rise, and the sequence settles on the
  destination plate itself so the final cut cannot jump.
- **Rock / paper / scissors** — hovering shows *drag to hand*; dragging an icon
  onto either hand starts a round. That hand plays the gesture you dragged, the
  other plays at random — biased toward a throw the footage has a real
  resolution for. Where a real round exists the hands act the result out
  (scissors snip at the palm, the fist closes over the scissors, the two
  scissors interlock, the fists bump); otherwise they just open back out.

  Real rounds found so far, as (left, right) with their source frames:

  | combo | resolution | frames |
  | --- | --- | --- |
  | paper / scissors | scissors cut paper | 1928–2036 |
  | scissors / rock | rock crushes scissors | 2148–2240 |
  | scissors / scissors | scissors interlock | 2420–2500 |
  | rock / rock | fists bump | 515–620 |

  Still missing a real round: `rock/paper`, `rock/scissors`, `paper/rock`,
  `paper/paper`, `scissors/paper`. Add them to `ROUNDS` in `build_rps.py`.
- **Campaign names** — each is its own hit area and links to a placeholder page.
- **Back** — a hand reaching in from the edge the landing is behind, or `Esc`.
  The edge is the one the page was opened through, so leaving reads as reversing
  that move: left on Pita, right on Salva, bottom centre on the &, top centre on
  a campaign. It is a `back-*` class on `#page`, set from `back` in `PAGE_DEFS`.

  The hand is the *other* person's, held out for the dap that takes you home —
  Salva's on Pita's page, Pita's on Salva's, both of them on the & and on a
  campaign, turned to stand on the edge they come in from. All four are in the
  markup and the `back-*` class picks which are shown, so the control never
  waits on an image swap. Hovering rocks each hand about its own wrist, the two
  of them at different speeds.

## Timing

All per-frame holds live in `TIMING` at the top of `app.js`, in ms. Stop-motion,
not slideshow — each pose has to be readable before the next one lands:

| | |
| --- | --- |
| `dap` / `dapLast` | 132 / 190 — the hands entering, the slowest beat |
| `trans` / `transLast` | 78 / 150 — camera moves |
| `pump` | 74 — the rock-paper-scissors count-in |
| `result` | 950 — how long the thrown hands are held before they react |
| `after` | 112 — the hands acting the result out |
| `back` | 138 — the aftermath, hands opening back out |

Each hold is jittered ±18% so the cadence never locks to a metronome.

## Rebuilding the frames

The build scripts live in `tools/` (`build.py`, `build_rps.py`, `seg.py`,
`dapscan.py`, `pickdaps.py` and helpers). The pipeline for every frame is:

1. pull the exact frame from the source `.MOV`,
2. cut the subject out with the macOS Vision framework
   (`VNGenerateForegroundInstanceMaskRequest`, via a pyobjc venv),
3. crop to the framing that matches the keyframe (found by template-matching the
   keyframe against the footage), scale to 1920×1080,
4. dither: white with probability `Φ((grey − T) / σ)` inside the cutout, clamped
   to 0 below a black floor — the noise-plus-threshold look, with `T`, `σ` and
   the floor fitted per shot against the corresponding keyframe.

Transitions interpolate both the crop (anchored to the subject, exact at both
ends) and the tone, so frame 0 matches the landing grade and the last frame
matches the destination keyframe.

### The back hands

`tools/build_hands.py` cuts them straight out of `site/img/landing_plate.png`,
so they are the landing's own hands rather than a new drawing. It reads the
plate's dither as tone (a wide blur), keeps the largest shape in each crop —
which drops the lettering that shares it, and is why the blur has to be wide
enough to bridge the gap between Salva's thumb and his fingers — then bakes each
hand at its on-screen size and re-dithers it there. Sizes are `WIDE` and `TALL`
at the top of the file; the vertical one has to stay clear of the campaign
title, which sits at `CAMPAIGN_TITLE_TOP` in `app.js`.

### Picking daps

`tools/dapscan.py` sweeps `daps.MOV` and records, per frame, how much of the
landing crop is *renderable* subject — inside the cutout **and** above the black
floor. This is the measurement that matters: plain background subtraction reads
a torso moving off bright wall as motion even though nothing renders, which is
how hands ended up out of frame. `tools/pickdaps.py` then reads that curve and
picks sequences that stay readable throughout and settle on the default pose.
The chosen frame numbers are pasted into `DAP_FRAMES` in `build.py`.

Note: frame previews must be extracted with `select='eq(n,N)'` from the start of
the file. `ffmpeg -ss` seeking is not frame-exact on this footage and silently
shifts the numbering.
