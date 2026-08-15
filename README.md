# pitalva — landing site

Everything on screen is a pre-rendered 1-bit frame in `img/`. The page is a fixed
1920×1080 stage scaled to the viewport, so every element sits at exactly the
coordinate it sits at in `keyframes/`.

## Run

```
python3 -m http.server 8777
open http://localhost:8777/
```

(Needs to be served over HTTP — `app.js` fetches `img/ui.json`.)

Live at <https://thelifeofpita.github.io/pitaAndSalva/>.

The source `.MOV` footage the build reads from is not in the repo — it is too
large for GitHub. Keep `videos/` alongside the checkout to re-run `tools/`.

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
| `img/ui.json` | position of every overlay element in 1920×1080 space |

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
- **Back** — the `<- BACK` control, or `Esc`.

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
