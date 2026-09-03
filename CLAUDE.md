# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A static, dependency-free site (`index.html` + `app.js` + `style.css`) for the
pitalva duo, deployed to GitHub Pages from the repo root. There is no build step
for the site itself, no package.json, no tests. Everything on the landing stage
is a pre-rendered 1-bit PNG frame in `img/`; JS only decides which frame is on
screen and when. The Python in `tools/` produced those frames offline — it is
not part of running the site.

## Run

```
python3 -m http.server 8777        # from the repo root
open http://localhost:8777/
```

Must be served over HTTP: `app.js` fetches `img/ui.json` and `img/frames.json`,
and `sw.js` needs a real origin. (README.md says `cd site` first — stale; the
repo root *is* the site. `tools/*.py` still write to `.../pitalva_3/site/img`,
which is now just `img/`.)

After changing frames, bump `VERSION` in `sw.js` (`pitalva-vNN`) or returning
visitors keep the old art for one more visit — the worker caches frames in Cache
Storage precisely so the host's `max-age=600` cannot make a frame arrive late.

## Architecture

**One fixed 1920×1080 coordinate space.** `#fit`/`#stage` are scaled to the
viewport; every position in `img/ui.json`, in `style.css`, and in the keyframes
is in those coordinates. Never introduce a viewport-relative position on the
stage — project pages (`#project`) are the deliberate exception, a normal
scrolling document layered over the stage.

**The window is a camera pointed at that space, not a letterbox of it.**
`fit()` in `app.js` applies a `FRAMING`: a scale and the point of the drawing to
hold in the middle of the window. `landing` closes in to the two palms on a
portrait window (the arms already run off frame, so cropping them is native to
the image) and keeps the full width on any window shaped like the drawing;
`wide` is the whole drawing, which is what the & needs; `pita`/`salva` travel
the camera to that member's figure on a portrait window and are `wide` in
landscape.

Moving between framings moves the camera, and that move is stepped across the
frames of the move that carries it — `play(frames, hold, lastHold, framing,
travel)`. `travel` matters: these sequences have a cut in them (the first frames
of the way into a member's page are still the two hands), so arriving the camera
holds and then travels with the subject it cuts to, and leaving it does the same
in reverse. Without the pan the last frame of the move and the page it lands on
are two different pictures, which is exactly what a snap is.

`applyCam` also gives `#fit` and `#project` their size in real pixels. Both are
fixed layers, and a fixed box pinned with `inset: 0` is the *layout* viewport
while every number here comes from `innerHeight`, the *visual* one — on a phone
whose browser bar overlays the page those are different heights, so the whole
composition ends up centred on a taller box than it was measured for and a
control held against an edge lands somewhere other than where it looks like it
is. Sizing the layers from the same numbers the layout uses makes them one
rectangle. `#project-scroll` also carries the safe-area insets, since the close
control is the first thing inside it.

The way back is one control at one size wherever it appears: `--back-hand` is
its palm width in real pixels, and each place multiplies out from it — the pair
cut lengthwise for a member's frame, the pair cut across for the & and for a
project's own copy. Do not give any of them a size of its own.

`fit()` publishes what the rest of the site positions against, all in stage
units: `--view-x/y/w/h` plus `--view-r/b` (the window), `--cam-x/y` (the pan
the stage's own transform applies), `--pg-x/y/k` (a destination page's plate
fitted whole inside it — anything registered to a plate goes through those three,
which is how MAGIC, the eye symbols and a member's copy stay nailed to the
photograph), and `--inv`, the scale inverted, so `calc(15px * var(--inv))` inside
the scaled stage is 15 real pixels on the glass. `body.narrow` is set on a
portrait window.

**The landing overlay is placed by script, not by CSS.** `buildUI()` stores each
element's drawn rect from `ui.json` on the element; `layoutUI()` is the only
thing that writes a position. Everything keeps its drawn place while that place
is on screen and is pulled in by the shortest distance that clears the edge when
it is not. Two exceptions carry the portrait design: the two name labels rise to
the ampersand's line rather than climb the arms they would otherwise cover, and
the campaign block is squeezed about its centre or, past `MIN_SQUEEZE`, re-broken
into rows. All seven titles are set in either case — each one is a link, and the
block is the site's list of campaigns. The overlay's artwork was
erased out of `landing_plate` when it was built and left a hairline ghost at
every one of those places, so `draw()` blacks those rectangles out — without it,
moving a piece of overlay reveals the ghost it used to cover.

**A member's page stacks in portrait.** There is no negative space left beside
the figure on a phone, so `memberCam` points the camera at his figure (measured
constants in `FIGURE`) and `layoutMemberCopy()` starts the bio and CV under his
feet, as a column that scrolls. `FIGURE` carries two measurements, and the
difference matters: the box sizes the frame, but `cx` — the centre of the head
and shoulders — is the point the camera holds. Pita stands square so his are the
same point; Salva's arm trails a hundred units left of his face, and centring on
his ink box put his head visibly right of the middle. The camera gets there inside the
move that opens the page, so nothing snaps on arrival. In landscape the drawn
side-by-side layout stands, with a floor on the type size in real pixels so a
small window does not set a CV at eleven pixels.

**The & page comes apart in portrait.** Two faces held against opposite edges of
a 1.9:1 frame is a composition with nothing in the middle, which is most of what
a portrait window has. So the frame splits down the black gap between them:
`#and-faces` is the drawing as two half-width canvases, and it sits in `#stage`
beside `#plate`, not inside `#page`, because the halves carry the *moving frames*
too — `setAndOpen(true)` hands them the frames before the & move starts and
`draw()` paints each its own half from then on. That is what lets the separation
happen inside the camera move rather than after it: `andSplit` rides on the
camera (`FRAMING.and`), so the halves travel to opposite corners on the same
curve and in the same held beats as the pull-back, and the reverse closes them on
the way out. At `andSplit = 0` the two halves are the plate exactly, which is
what the frames need and what landscape keeps — the seam falls in the black gap
between the faces. `#page.page-and` is given no background, or its own black
would cover them.

`layoutAndFaces` sizes the halves and MAGIC as one measurement (the word takes a
share of the height, the halves take what is left) and keeps `AND_FOOT` of the
window clear at the bottom, which is where the way back stands: centred, on
black, above the bar a phone draws across its own screen. The shooting-star sky
follows the halves — `STREAK_DARK` maps the dark of the closed frame, and once
they are open `openSkyTakes` uses the window less the two of them and less the
word.

**Frames are data, not code.** `img/frames.json` is the manifest (`pita`,
`salva`, `amp`, `rps`, `daps`, `pita_settle`); `img/ui.json` holds the overlay
assets and the campaign list (label + slug + rect). `app.js` reads both at boot
into `SEQ` and `cfg` and never hardcodes a frame filename — so the page can't
point at a frame the build renamed or dropped. Adding a campaign or moving an
overlay element means editing `img/ui.json`, not the markup.

**The plate is a `<canvas>`, not an `<img>`.** `drawImage` paints inside the
call; an `img.src` assignment does not, so a slow frame would silently be a
frame nobody sees. Frames are also decoded ahead of the playhead with
`createImageBitmap` over a sliding `WINDOW`, capped by `BMP_CAP` (a decoded
1920×1080 frame is ~8MB). `HTMLImageElement.decode()` is not usable here — on a
detached image its promise can never settle. Boot awaits only the landing plate
plus the one dap about to play; `warm()` fetches the rest behind it.

**Timing lives in one place**: `TIMING` at the top of `app.js`, per-frame holds
in ms, jittered so the cadence never locks to a metronome. Stop-motion, not
slideshow.

**Routing** is the URL hash. `PAGE_DEFS` maps `pita`/`salva`/`and` to a
sequence, a destination plate, and `back` — the edge the landing lies behind, so
leaving reverses the move that opened the page. Campaign pages route through
`goCampaign` → `campaignDepthTransition` → `openProject`. Escape or `#back`
goes home.

**Preloaded, never swapped.** Several controls exist in the markup in all their
variants (all four back hands, both eyes' three symbols, every star frame slot)
with CSS picking which is shown — an image swap at interaction time would stall.
Keep that pattern when adding one.

## Project pages

`PROJECTS[slug] = () => html` in `app.js` registers a built project (currently
`back-in-smoothly`, `numpad-jam`, `ads-from-trash`); any campaign slug without
an entry renders the shared COMING SOON page. Every project supplies only its
own content — `renderProjectNav()` adds prev/next around the campaign ring and
the close control. Media lives in `img/projects/<slug>/`.

Project pages are pure `vw` designs pinned to a 1920 layout. Below 1000px they
switch to the fixed-pixel phone layout in each page's `@media (max-width: 1000px)`
block; above it a few mock-UI labels (`.np-jam-name` and its siblings) carry a
`max(…, Npx)` floor so they never fall under the smallest size that UI is ever
really set at.

`.proj-nav` is `1fr auto 1fr`, not a flex row spread apart: with `space-between`
the close control lands wherever the two campaign labels leave it. Below 1000px
it stacks — hands centred on their own row, the two titles on one line under
them — and that block is written last, through `.proj-nav`, so it outranks the
three built pages' own nav sizing and the shared COMING SOON page gets the same
control as everyone else.

Ads from Trash is the one page whose layout changes shape on a phone. Its 3x3 is
a ring (corners hung, edges close, pile centre) and only reads as one while it
stays 3x3, so it holds down to 720px, where a cell is still 200px and the
headline printed on the garment can still be read. Below that the ring unwinds
into one full-bleed column in each cell's `--m` order — each garment, then its
stitching close, then the next, and the pile last — with the DOM left in ring
order so nothing about the wide layout moves.

Hand-drawn doodles (arrows, circles, underlines) are inline SVG through the
shared `penFilter`/`pen`/`headV` helpers. Two invariants: **each doodle needs a
unique filter id** (duplicates silently cross-apply), and **each is sized in CSS
at exactly its viewBox size in vw** — 1 user unit = 1px at 1920 layout width, so
stroke weight and noise frequency stay consistent across the set. The filter is
`userSpaceOnUse`; an objectBoundingBox region collapses to zero height on a
horizontal shaft and the stroke disappears.

## Rebuilding frames (`tools/`)

Effectively macOS-only and currently not runnable here: the scripts hardcode
`/Users/pita/...` paths, need the source `.MOV` footage (gitignored, too large
for GitHub) and a pyobjc venv for the macOS Vision segmentation step
(`tools/seg.py`). Treat them as a record of how `img/` was produced. The
pipeline and the individual scripts (`build.py`, `build_rps.py`, `dapscan.py`,
`pickdaps.py`, `build_hands.py`, `build_and_text.py`) are documented in
README.md.

Two gotchas from that work that still apply: extract frames with
`select='eq(n,N)'` from the start of the file — `ffmpeg -ss` is not frame-exact
on this footage and silently shifts numbering; and Vision's matte sits a couple
of pixels outside the subject, so it must be eroded before thresholding or every
shape gets a white outline.

## Style

`app.js` and `style.css` are heavily commented, and the comments explain *why* a
non-obvious choice was made (canvas vs img, preloaded variants, filter ids,
measurements taken off a mockup). Match that: when changing one of these
decisions, update the comment that justifies it rather than leaving it stale.
Copy on the member pages is real content — check with the user before rewording
a bio, CV line, or campaign label.
