/* PITA & SALVA — frame-sequence driven landing page.
   Every visual state is a pre-rendered 1-bit frame; JS only picks which frame
   is on screen and when. Timings are short and slightly irregular on purpose. */

const IMG = 'img/';
const PROJ_IMG = (slug) => `${IMG}projects/${slug}/`;

/* every sequence comes from img/frames.json, written by the build — so the page
   can never point at a frame that was renamed or dropped */
let SEQ = null;
let PAGES = null;

const LANDING = 'landing_plate';
/* `back` is the edge the landing lies behind, so leaving a page always reads as
   reversing the move that opened it. */
const PAGE_DEFS = {
  /* `*_plate`, not the raw keyframe: both of their keyframes mock a bio and CV
     in lorem, and that block is set as live type over the plate instead, so
     the plate has it erased — exactly what `kf_amp_plate` is to the & page. */
  /* Each member's framing is his own: in landscape it is the whole drawing,
     and on a portrait window the camera travels to his figure — see FRAMING. */
  pita:  { seq: 'pita',  key: 'kf_pita_plate',  back: 'left',  framing: 'pita' },
  salva: { seq: 'salva', key: 'kf_salva_plate', back: 'right', framing: 'salva' },
  and:   { seq: 'amp',   key: 'kf_amp_plate', back: 'bottom', settleKey: true,
           /* the two faces are at the edges of this frame; it is never cropped
              sideways, and on a portrait window it comes apart — both are the
              `and` framing, which the move that opens the page carries. */
           framing: 'and' },
};
const CAMPAIGN_BACK = 'top';   // campaign titles sit along the bottom of the landing
/* where the title comes to rest on a campaign page — must match
   `#page-extra .title { top }` in style.css, or the flown title jumps when the
   static one takes over */
const CAMPAIGN_TITLE_TOP = 175;
const BACK_SIDES = ['back-left', 'back-right', 'back-top', 'back-bottom'];
/* Which destination #page is showing, for the copy that belongs to only one of
   them: the & page's phrases, Pita's bio and CV. Campaign pages set none of
   these — they run on `extra` instead. */
const PAGE_KINDS = ['page-pita', 'page-salva', 'page-and'];

const BEATS = 'rps';          // rock / paper / scissors

/* per-frame hold, in ms. Stop-motion, not slideshow: slow enough to read each
   pose, fast enough to stay choppy. */
const TIMING = {
  dap: 132,        // the hands entering — the slowest beat, it has to land
  dapLast: 190,    // settle on the default pose before the page appears
  trans: 78,       // camera moves
  transLast: 150,
  pump: 92,        // same held stop-motion cadence as the rest of the site
  throw: 92,       // let the gesture read while flowing straight into reaction
  after: 112,      // the hands acting the result out
  back: 112,       // the aftermath: hands unclench and open back out
};

/* The beckon, as beats: which frame, and how long it is held.
   In, all the way in, back out, open — asked twice and then held. Coming and
   going on an even count reads as a hand grabbing at something; what reads as a
   summons is asking twice, quickly, and then waiting long enough that the next
   pair is a new sentence rather than more of the same one. */
const BECKON = [
  [1, 88], [2, 84], [1, 86], [0, 132],
  [1, 88], [2, 84], [1, 86], [0, 430],
];

const $ = (s) => document.querySelector(s);
const fitBox = $('#fit');
const stage = $('#stage');
const plate = $('#plate');
const ui = $('#ui');
const page = $('#page');
const pageImg = $('#page-img');
const pageExtra = $('#page-extra');
const hint = $('#hint');
const ghost = $('#ghost');
const ghostImg = ghost.querySelector('img');
const project = $('#project');
const projectScroll = $('#project-scroll');

let cfg = null;
let busy = false;
/* A tap on the way back that lands while a move is running. Dropping it is what
   makes the control feel broken: the site is mid-camera for the best part of a
   second either side of every page, and a press inside that window used to go
   nowhere at all — and worse, `goHome` had already cleared the address bar by
   then, so the URL and the screen disagreed. Held here instead and let through
   the moment the move ends. */
let pendingHome = false;
function idle() {
  busy = false;
  if (pendingHome) { pendingHome = false; goHome(); }
}
let current = null;          // null on landing, else a page id
let pendingCampaignOrigin = null;
let campaignReturnOrigin = null;
/* where the open project's title art actually sits, in stage coordinates —
   the flight aims at it on the way in and starts from it on the way out */
let campaignReturnTarget = null;

/* --------------------------------------------------------------- helpers */
function setBackSide(side) {
  page.classList.remove(...BACK_SIDES);
  if (side) page.classList.add('back-' + side);
  /* A page change under a resting pointer never fires pointerout, so a hand
     left mid-beckon would come back to the next page with its fingers still
     drawn in. The control opens on the same page every time. */
  stopBeckon(back);
}

function setPageKind(id) {
  page.classList.remove(...PAGE_KINDS);
  if (id) page.classList.add('page-' + id);
  layoutMemberCopy();
}

const src = (name) => `${IMG}${name}.png`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms, amt = 14) => ms + (Math.random() * 2 - 1) * amt;

/* ----------------------------------------------------------- frame store */
/* One entry per frame, kept for the life of the page. Holding the Image is the
   point: a released one is re-requested the next time it is shown, and online
   that request is what makes a dap drop frames. Every frame is fetched exactly
   once per visit. */
const store = new Map();

function entry(name) {
  let e = store.get(name);
  if (!e) {
    e = { img: null, ready: null };
    store.set(name, e);
  }
  return e;
}

/* A frame that fails to load must not resolve as if it had — the old preload
   swallowed errors, and the blank that followed read as a missing dap. */
function fetchFrame(name, tries = 3) {
  const e = entry(name);
  if (e.ready) return e.ready;
  const p = new Promise((res, rej) => {
    const attempt = (left) => {
      const i = new Image();
      i.decoding = 'async';
      i.onload = () => { e.img = i; res(i); };
      i.onerror = () => {
        if (left > 1) setTimeout(() => attempt(left - 1), (tries - left + 1) * 250);
        else rej(new Error('frame failed: ' + name));
      };
      i.src = src(name);
    };
    attempt(tries);
  });
  e.ready = p;
  /* Remember the frame, not the failure. Caching the rejected promise made one
     bad minute permanent: every later request for that frame got the old
     rejection back without touching the network, so the frame could never be
     drawn again for the rest of the visit — and if it was the landing plate,
     the page idled for good on whatever was painted before it. */
  p.catch(() => { if (e.ready === p) e.ready = null; });
  return p;
}

function load(names) {
  return Promise.all([...new Set(names)].map((n) => fetchFrame(n).catch(() => null)));
}

/* Loaded is not the same as paintable: the browser still has to turn the PNG
   into a bitmap, and left alone it does that at the moment of the draw, on the
   main thread, inside the hold. createImageBitmap does it in advance and off
   thread. (HTMLImageElement.decode() is the obvious tool here and cannot be
   used: on a detached image its promise can simply never settle.)

   A decoded 1920x1080 frame costs ~8MB, so they are kept in a small window
   around the playhead rather than all at once — 170 of them would be 1.4GB. */
const WINDOW = 12;
const BMP_CAP = 16;
const bmps = new Map();        // name -> ImageBitmap, in insertion order
let keep = new Set();          // frames the playhead still needs

function trim() {
  for (const [k, v] of bmps) {
    if (bmps.size <= BMP_CAP) break;
    if (keep.has(k)) continue;
    bmps.delete(k);
    v.close();
  }
}

async function decodeFrame(name) {
  if (bmps.has(name)) return bmps.get(name);
  const img = await fetchFrame(name);
  const bmp = await createImageBitmap(img);
  if (bmps.has(name)) { bmp.close(); return bmps.get(name); }
  bmps.set(name, bmp);
  trim();
  return bmp;
}

/* Load every frame of a sequence, decode the head of it. */
async function prime(frames) {
  const head = frames.slice(0, WINDOW);
  keep = new Set(head);
  load(frames);
  await Promise.all(head.map((n) => decodeFrame(n).catch(() => null)));
}

/* Warm frames we will want soon without blocking anything that is on screen.

   A few at a time, in order. Asking for all 190 at once buries the handful of
   frames the move currently playing is still waiting for — the browser opens
   its connections in request order, not in order of need — and a warm request
   that fails under that pile-up costs a frame nobody sees. */
const WARM_AT_ONCE = 6;

async function warm(names) {
  if (navigator.serviceWorker && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({
      type: 'warm',
      urls: names.map((n) => new URL(src(n), location.href).href),
    });
  }
  const queue = [...new Set(names)];
  for (let i = 0; i < queue.length; i += WARM_AT_ONCE) {
    await Promise.all(queue.slice(i, i + WARM_AT_ONCE)
      .map((n) => fetchFrame(n).catch(() => {})));
  }
}

/* ------------------------------------------------------------- rendering */
/* The plate is a canvas rather than an <img> because drawImage paints in the
   call itself. Assigning a src does not: the element keeps showing the previous
   frame until the new one is ready, so a slow frame is not a late frame, it is a
   frame nobody ever sees. */
const ctx = plate.getContext('2d', { alpha: false });
ctx.imageSmoothingEnabled = false;

/* The same drawing, as two half-width canvases. While the & is open these are
   what is on screen instead of the plate — one holding the left 960 units of
   every frame and one the right — which is what lets the frame come apart
   inside the move rather than after it. Each is only its own half, so painting
   both costs exactly what painting the plate costs. */
const halves = [...document.querySelectorAll('.af-plate')].map((c, i) => {
  const g = c.getContext('2d', { alpha: false });
  g.imageSmoothingEnabled = false;
  return { g, sx: i * 960 };
});
let andOpen = false;

let painted = null;

/* The overlay's artwork was erased out of the landing plate when it was built —
   the labels, the ampersand, the three throws and the campaign titles are all
   drawn on top of it instead — and the erase left a hairline of ink behind at
   every one of those places. It has never been visible, because each piece of
   overlay art has always sat exactly on top of its own ghost. It is visible the
   moment any of them moves, so the plate is cleaned rather than the layout kept
   still: these rectangles are black on the plate and black everywhere on this
   site, and the hands do not reach into any of them. */
let scrubs = null;
function scrubList() {
  if (scrubs || !cfg) return scrubs;
  const pad = 10;
  const box = (d) => [d.x - pad, d.y - pad, d.w + 2 * pad, d.h + 2 * pad];
  scrubs = Object.values(cfg.assets).map(box);
  const all = cfg.campaigns.concat(cfg.stars);
  const x = Math.min(...all.map((c) => c.x)), y = Math.min(...all.map((c) => c.y));
  scrubs.push([x - pad, y - pad,
               Math.max(...all.map((c) => c.x + c.w)) - x + 2 * pad,
               Math.max(...all.map((c) => c.y + c.h)) - y + 2 * pad]);
  return scrubs;
}

function draw(name) {
  const bmp = bmps.get(name);
  const e = bmp ? null : store.get(name);
  if (!bmp && (!e || !e.img || !e.img.complete)) return false;  // never blank the stage
  // Loaded but not decoded yet: drawing the element decodes it here and now,
  // which costs a few ms but always puts the right frame on screen.
  const img = bmp || e.img;
  const scrub = name === LANDING && scrubList();
  if (andOpen) {
    for (const h of halves) {
      h.g.drawImage(img, h.sx, 0, 960, 1080, 0, 0, 960, 1080);
      if (!scrub) continue;
      h.g.fillStyle = '#000';
      for (const r of scrubs) h.g.fillRect(r[0] - h.sx, r[1], r[2], r[3]);
    }
  } else {
    ctx.drawImage(img, 0, 0, 1920, 1080);
    if (scrub) {
      ctx.fillStyle = '#000';
      for (const r of scrubs) ctx.fillRect(r[0], r[1], r[2], r[3]);
    }
  }
  painted = name;
  return true;
}

/* Swapping which canvas is on screen, with the frame already on it. Both are
   painted before either is shown, so the change of surface is not a frame. */
function setAndOpen(on) {
  if (andOpen === on) return;
  andOpen = on;
  if (painted) { const was = painted; painted = null; draw(was); }
  stage.classList.toggle('and-open', on);
  if (!on) $('#and-faces').classList.remove('dressed');
}

/* The frame the page currently means to be showing. A frame that is not loaded
   yet is drawn when it arrives, and by then the sequence has usually moved on —
   without this guard that late draw paints an old frame over the new one, and
   whatever it lands on stays on screen. That is how the landing can end up
   idling on the first frame of the & move, or on a stray drawing from the middle
   of a dap: the frame was asked for during the move and arrived after it. */
let wanted = null;

/* Resolves true once `name` is actually on the canvas. Awaiting it matters at
   the end of a move — see enterLanding — and nowhere else: inside a sequence
   the next frame is already due. */
function show(name) {
  wanted = name;
  if (draw(name)) return Promise.resolve(true);
  return fetchFrame(name)
    .then(() => (wanted === name ? draw(name) : false))
    .catch(() => false);
}

/* Plays a list of frames. The choppiness is the point: a handful of frames,
   each held for a short, slightly uneven beat. `lastHold` lets a move settle on
   its final pose before whatever comes next.

   Driven off requestAnimationFrame so a hold ends on a paint rather than
   whenever a timer happens to fire — setTimeout drift accumulated across a
   twelve-frame dap is audible in the cadence. */
/* `framing` moves the camera across the move: where the landing is pointed and
   where the destination needs to be pointed are not the same place (see FRAMING
   in the fit section), and a move is the only place that change can be made
   without reading as a jump. It is stepped with the frames rather than tweened
   under them — this site cuts, it does not dissolve, and a camera travelling on
   the same beats as the poses is part of the same camera.

   `travel` is when in the move it goes. It matters because these sequences are
   themselves camera moves with a cut in them: the first frames of the way into
   a member's page are still the two hands, and the person only appears halfway
   through. Panning off the hands while they are still the picture is the jump,
   not the fix. So arriving, the camera holds and then travels with the subject
   it cuts to; leaving, it does the same thing in reverse and is home before the
   hands come back. The curve inside that span is the site's own `camPose`. */
const ARRIVE = [.45, 1], LEAVE = [0, .55];

async function play(frames, hold = TIMING.trans, lastHold = null,
                    framing = null, travel = ARRIVE) {
  if (!frames || !frames.length) return;
  await prime(frames);

  const from = cam;
  const to = framing ? camFor(framing) : from;
  const span = Math.max(1, frames.length - 1);
  const lerp = (a, b, p) => a + (b - a) * p;
  const pose = (i) => camPose(clamp01(
    (i / span - travel[0]) / Math.max(.001, travel[1] - travel[0])));

  const holds = frames.map((_, i) => {
    const h = (i === frames.length - 1 && lastHold !== null) ? lastHold : hold;
    return Math.max(40, jitter(h, h * 0.18));
  });

  return new Promise((resolve) => {
    let i = 0;
    let due = 0;
    const step = (now) => {
      if (!due) due = now;
      if (now >= due) {
        if (framing) {
          const p = pose(i);
          applyCam({ s: lerp(from.s, to.s, p), x: lerp(from.x, to.x, p),
                     y: lerp(from.y, to.y, p),
                     split: lerp(from.split || 0, to.split || 0, p) });
        }
        show(frames[i]);
        // A backgrounded tab stops raf; on return, run the rest from now rather
        // than flushing the whole backlog into one paint.
        due = (now - due > 900 ? now : due) + holds[i];
        i++;
        if (i >= frames.length) {
          keep = new Set();
          if (framing) { framed = framing; fit(); }
          setTimeout(resolve, Math.max(0, due - performance.now()));
          return;
        }
        // Pull the decode window along behind the playhead. There are whole
        // holds of runway here, so the decode never lands inside a beat.
        keep = new Set(frames.slice(i, i + WINDOW));
        const ahead = frames[i + WINDOW - 1];
        if (ahead) decodeFrame(ahead).catch(() => {});
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

/* ------------------------------------------------------------------- fit */
/* The stage is one fixed 1920x1080 drawing and a browser window is any shape at
   all. Fitting the drawing by `contain` — the whole frame, letterboxed — is
   what leaves a phone showing a 390x219 strip stranded in the middle of a black
   screen. So the drawing is not fitted to the window; a camera is pointed at it.

   A framing is that camera: a scale, and a point of the drawing to hold in the
   middle of the window. What each one is for:

     landing  two hands meeting dead centre, their arms already running off the
              frame, so cropping the arms is native to the image rather than
              something done to it. A window shaped like the drawing gets all of
              it; a portrait one closes in to the palms, on a straight ramp so
              dragging a window moves the frame rather than snapping it.
     wide     the whole drawing, uncropped sideways — what the & needs, since
              its subject is two faces held against opposite edges.
     pita     a member's own frame is his figure standing in one half of a 1.9:1
     salva    photograph, and a portrait window has no room for the half the
              copy was set into. So the camera goes to the figure and the copy
              takes the space under him. In landscape it is `wide`, unchanged.

   Moving between framings moves the camera, and that move is made inside the
   move that carries it — `play(..., framing)` steps it with the frames — so it
   reads as the camera travelling rather than as a cut that jumped. That is the
   whole reason a framing is a camera and not a number: a member's portrait
   framing is off to one side of the drawing, and without the pan the last frame
   of the move and the page it lands on are two different pictures. */
const CROP_H = 1010;          /* the drawing top to bottom, less its black rim */

/* every element the overlay clamps keeps this much clear screen edge */
const EDGE_PAD = 22;

/* Where the ink actually is in each member's plate — the box the portrait
   camera sizes itself to, measured off the drawing rather than guessed at.

   `cx` is a second measurement, and it is the one the camera actually holds in
   the middle: the centre of the head and shoulders, not of the whole silhouette.
   Pita stands square, so for him the two are the same point. Salva does not —
   his head and shoulders sit at x 517-731 while the arm throwing the horns
   trails down to 330 — so a frame centred on his ink box puts his face a
   hundred units right of the middle, which is exactly where it looked. A
   portrait is centred on the face; the arm is allowed to run wherever it runs. */
const FIGURE = {
  pita:  { x: 839, w: 935, y: 96,  h: 759, cx: 1306 },
  salva: { x: 334, w: 396, y: 200, h: 779, cx: 624 },
};
/* the share of the window a member's figure takes in portrait, and the air it
   keeps above him — the rest of the window is the column under him */
const FIG_W = .90, FIG_H = .40, FIG_TOP = .045;

const portrait = () => innerWidth / innerHeight < 1;

/* contain: the whole drawing, less the black rim off its top and bottom */
function wideCam() {
  return { s: Math.min(innerWidth / 1920, innerHeight / CROP_H),
           x: 960, y: 540, split: 0 };
}

const FRAMING = {
  /* `split` is how far the & frame has come apart — carried on the camera so
     the halves separate on the same curve, in the same beats, as the pull-back
     that opens the page. One move, not a move and then a move. */
  and() { return { ...wideCam(), split: portrait() ? 1 : 0 }; },
  landing() {
    const t = Math.min(1, Math.max(0, (1 - innerWidth / innerHeight) / .25));
    const w = 1920 + (780 - 1920) * t;
    return {
      s: Math.min(Math.max(innerWidth / 1920, innerHeight / 1080),
                  innerWidth / w, innerHeight / CROP_H),
      x: 960, y: 540, split: 0,
    };
  },
  wide: wideCam,
  pita:  () => memberCam('pita'),
  salva: () => memberCam('salva'),
};

/* The figure as large as the window will take him, held against the top so the
   copy has the rest. `y` is the point of the drawing the window centres on, so
   it is worked back from where his own centre has to land on the glass. */
function memberCam(id) {
  if (!portrait()) return wideCam();
  const f = FIGURE[id];
  const s = Math.min(innerWidth * FIG_W / f.w, innerHeight * FIG_H / f.h);
  const top = innerHeight * FIG_TOP;
  return {
    s,
    x: f.cx,
    y: f.y + f.h / 2 + (innerHeight / 2 - top - f.h * s / 2) / s,
    split: 0,
  };
}

let framed = 'landing';
let cam = { s: 1, x: 960, y: 540, split: 0 };

/* the window onto the stage, in stage units: what a clamped element has to stay
   inside of, and what a page's plate is fitted into */
let view = { s: 1, x: 0, y: 0, w: 1920, h: 1080, pad: EDGE_PAD };

const camFor = (name) => (FRAMING[name] || FRAMING.landing)();

function applyCam(c) {
  cam = c;
  andSplit = c.split || 0;
  /* the two fixed layers the site lives in, given exactly the size the layout
     was measured against — see the note on #fit in style.css */
  for (const el of [fitBox, project]) {
    el.style.width = innerWidth + 'px';
    el.style.height = innerHeight + 'px';
  }
  const s = c.s, w = innerWidth / s, h = innerHeight / s;
  view = { s, w, h, x: c.x - w / 2, y: c.y - h / 2, pad: EDGE_PAD / s };

  const css = document.documentElement.style;
  css.setProperty('--scale', s);
  /* the pan, applied after the scale so it is written in the drawing's own
     units: moving the stage by this much puts `c.x, c.y` in the middle */
  css.setProperty('--cam-x', (960 - c.x) + 'px');
  css.setProperty('--cam-y', (540 - c.y) + 'px');
  /* the inverse, so a box inside the scaled stage can be given a size in real
     screen pixels: `calc(17px * var(--inv))` is 17px on the glass */
  css.setProperty('--inv', 1 / s);
  css.setProperty('--view-x', view.x + 'px');
  css.setProperty('--view-y', view.y + 'px');
  css.setProperty('--view-w', view.w + 'px');
  css.setProperty('--view-h', view.h + 'px');
  /* the same window written from the other two sides, for anything held
     against them: `right: var(--view-r)` is the window's right edge */
  css.setProperty('--view-r', (1920 - view.x - view.w) + 'px');
  css.setProperty('--view-b', (1080 - view.y - view.h) + 'px');
  /* one size for the way back, everywhere it appears */
  css.setProperty('--back-hand', backHandPx() + 'px');

  /* A destination page's plate, whole, inside that window — the `contain` fit
     the whole stage used to get. Everything registered to the plate (the two
     eyes, MAGIC, a campaign's title) goes through the same three numbers, so it
     stays nailed to the drawing at every size. A camera pointed off centre is
     already framing its own subject, so there it is left alone. */
  const off = Math.abs(c.x - 960) > .5 || Math.abs(c.y - 540) > .5;
  const k = off ? 1 : Math.min(view.w / 1920, view.h / 1080);
  css.setProperty('--pg-k', k);
  css.setProperty('--pg-x', (960 - 960 * k) + 'px');
  css.setProperty('--pg-y', (540 - 540 * k) + 'px');

  /* Portrait: no frame here has negative space left to set a member's CV into
     beside him, so his page stacks instead. */
  document.body.classList.toggle('narrow', portrait());
  layoutUI();
}

function fit() { applyCam(camFor(framed)); }
addEventListener('resize', fit);

/* ------------------------------------------------------------ landing UI */
/* Every piece of the overlay keeps the rect it was drawn at in `ui.json` — its
   place in the 1920x1080 drawing — on the element itself, and `layoutUI()`
   below is the only thing that ever writes a position. The two are separate
   because the drawing's frame and the window's frame are no longer the same
   rectangle: the plate is cropped to fill the window (see `fit`), so an element
   drawn hard against the edge of the frame can be outside the window, and has
   to be brought back in without being redrawn. */
function buildUI() {
  const a = cfg.assets;
  const put = (el, d) => { el.design = { x: d.x, y: d.y, w: d.w, h: d.h }; };
  put($('#nav-salva'), a.salva);
  put($('#nav-pita'), a.pita);
  put($('#nav-amp'), a.amp);
  put($('#ico-rock'), a.rock);
  put($('#ico-paper'), a.paper);
  put($('#ico-scissors'), a.scissors);

  buildStreaks();

  const wrap = $('#campaigns');
  for (const s of cfg.stars) {
    const i = document.createElement('img');
    i.src = IMG + s.src;
    i.alt = '';
    i.style.position = 'absolute';
    i.design = { x: s.x, y: s.y, w: s.w, h: s.h };
    campStars.push(i);
    wrap.appendChild(i);
  }
  for (const c of cfg.campaigns) {
    const b = document.createElement('a');
    b.className = 'camp';
    b.href = '#' + c.slug;
    b.title = c.label;
    b.dataset.slug = c.slug;
    b.dataset.label = c.label;
    b.dataset.src = c.src;
    b.design = { x: c.x, y: c.y, w: c.w, h: c.h };
    campItems.push(b);
    const i = document.createElement('img');
    i.src = IMG + c.src;
    i.alt = c.label;
    i.style.cssText = 'width:100%;height:100%';
    b.appendChild(i);
    wrap.appendChild(b);
  }
  layoutUI();
}

const campItems = [];
const campStars = [];

/* --------------------------------------------------------------- layout */
/* Where an element goes once the window has cropped the drawing.

   Nothing here re-designs the landing: every element keeps the place it was
   drawn at for as long as that place is on screen, and is only pulled in — by
   the shortest distance that clears the edge — when it is not. That is the
   whole rule for the labels, the ampersand and the throw icons, and it is why
   a desktop window at the drawing's own ratio comes out pixel-identical to the
   keyframes while a phone still gets a label it can read.

   The campaign block is the one thing that cannot simply be nudged: it is a
   1772-unit line of hand-lettered titles, and a phone is not 1772 units wide at
   any scale that leaves the titles legible. So it is set, in order of how much
   it costs the design: at its drawn size if it fits, scaled down about its own
   centre if a modest reduction is enough, and only then re-broken into rows. */
function place(el, x, y, w, h) {
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  el.style.width = w + 'px';
  el.style.height = h + 'px';
}

/* the drawn position, moved the least distance that puts the whole box inside
   the window with `view.pad` to spare */
function clampX(x, w) {
  const lo = view.x + view.pad, hi = view.x + view.w - view.pad - w;
  return hi < lo ? view.x + (view.w - w) / 2 : Math.min(Math.max(x, lo), hi);
}
function clampY(y, h) {
  const lo = view.y + view.pad, hi = view.y + view.h - view.pad - h;
  return hi < lo ? view.y + (view.h - h) / 2 : Math.min(Math.max(y, lo), hi);
}

/* Where the two names go when the frame has closed in past them. They are drawn
   out at the wrists, in the black beyond the arms, and there is no black left
   there once the frame crops: pulling them straight in lays white lettering
   over a white hand. So they rise instead, to the line the ampersand's own
   letter sits on — still one to a side with their arrows pointing off the frame
   at the person they lead to, and now clear above the hands rather than beside
   them. */
const RAISED_LABEL_Y = 108;

function layoutUI() {
  if (!cfg) return;
  for (const id of ['#nav-amp', '#ico-rock', '#ico-paper', '#ico-scissors']) {
    const el = $(id), d = el.design;
    if (d) place(el, clampX(d.x, d.w), clampY(d.y, d.h), d.w, d.h);
  }
  const salva = $('#nav-salva'), pita = $('#nav-pita');
  /* a few units of travel is the label still standing in its own black; more
     than that and it has started climbing the arm */
  const raised = Math.abs(clampX(salva.design.x, salva.design.w) - salva.design.x) > 12 ||
                 Math.abs(clampX(pita.design.x, pita.design.w) - pita.design.x) > 12;
  for (const el of [salva, pita]) {
    const d = el.design;
    place(el, clampX(d.x, d.w), clampY(raised ? RAISED_LABEL_Y : d.y, d.h), d.w, d.h);
  }
  /* The ampersand points up out of the top of the frame and the throw icons sit
     just over the fingertips: on a window short enough to push the ampersand
     down onto them the two would collide, so it gives way rather than the
     icons, which are anchored to the hands. */
  const amp = $('#nav-amp'), rock = $('#ico-rock');
  if (amp.design && rock.design) {
    const ceiling = rock.offsetTop - amp.design.h - 16;
    if (amp.offsetTop > ceiling) amp.style.top = ceiling + 'px';
  }
  layoutCampaigns();
  layoutMemberCopy();
  layoutAndFaces();
}

/* Portrait: the figure across the top, the copy under it.
   In the frame each of them was shot in, the copy is set into the black his own
   body leaves; on a phone that black is a sliver, so the frame is reopened. The
   camera does the reframing (`memberCam` above) — by the time the move that
   opens the page has landed, the plate is already sitting where it will stay,
   which is what makes the page arrive rather than snap into place. All that is
   left for the layout is the column: it starts under his feet, not at some
   fixed share of the window, so Pita's copy does not open on a gap and Salva's
   does not open on his knees. */
function layoutMemberCopy() {
  const id = page.classList.contains('page-pita') ? 'pita'
           : page.classList.contains('page-salva') ? 'salva' : null;
  if (!id || !portrait()) return;
  const f = FIGURE[id];
  const top = f.y + f.h + 26 / view.s;
  const css = document.documentElement.style;
  css.setProperty('--copy-top', top + 'px');
  css.setProperty('--copy-h', (view.y + view.h - view.pad - top) + 'px');
}

/* ------------------------------------------------------------ the & page */
/* The frame, taken apart. Two faces held against opposite edges of a 1.9:1
   photograph is a composition with nothing in the middle, which is exactly what
   a portrait window has most of — so rather than shrink the whole picture to a
   band, the frame splits down the black gap between them and the two halves go
   to opposite corners, one high and one low, with MAGIC in the diagonal they
   leave. `andSplit` is how far through that they are, and it rides on the
   camera (see FRAMING.and), so the halves separate on the same curve and in the
   same held beats as the pull-back that opens the page.

   At 0 the two halves are the plate, exactly: edge to edge at their drawn size,
   filling the stage, which is what the moving frames need them to be and what a
   landscape window keeps. The seam falls in the black gap between the faces, so
   there is nothing there to give it away. */
let andSplit = 0;
/* the two halves where they currently are, in the drawing's units — the sky
   below is drawn around them once they have left the places the map knows */
let andRects = null;

/* The way back is one control, and it is one size wherever it is: the hand
   across the palm, in real screen pixels. The drawings differ — the pair that
   reach in from the side of a member's frame are cut lengthwise, the pair that
   hang into the & and into a project are cut the other way — so what is held
   equal is the palm, not the box, and each place multiplies out from here.
   Published as `--back-hand` for the stylesheet. */
const backHandPx = () => Math.min(74, Math.max(48, innerWidth * .09));

/* The strip of black at the bottom of the & that the picture does not get: it
   exists for that control, so it is measured from it rather than being a share
   of the window. A fraction cannot do this job — 20% of a 568-tall phone is
   114px and the control is 98 of them, which leaves it sixteen pixels off the
   bottom edge, exactly where a phone puts its own bar. Gap above, the control,
   and a clearance under it that nothing is allowed to eat. */
const BACK_GAP = 26;         /* between the picture and the hands */
const BACK_CLEAR = 40;       /* under them, at the least */
const andFootPx = () => Math.min(innerHeight * .3,
                                 BACK_GAP + backHandPx() * 150 / 96 + BACK_CLEAR);
/* MAGIC is measured down, not across: sized off the window's width it is a
   third of the height of a tablet held upright, and there is then no room left
   for the two faces it is supposed to be standing between. So the word takes a
   share of the height, capped so it cannot run the full width of a phone, and
   what is left over — less a little air on each side of it — is the two halves.
   The three of them are one measurement, which is why they are worked out
   together here rather than given separate constants. */
const WORD_H = .135;         /* of the height the picture is laid out in */
const WORD_MAX_W = .62;      /* of the window's width */
const WORD_AIR = .02;        /* above and below it, of that same height */

function layoutAndFaces() {
  const l = $('.af-l'), r = $('.af-r'), word = $('#and-word');
  if (!l) return;
  /* a landscape window is the frame whole; turning one back from portrait puts
     it together again rather than leaving the halves where they were */
  if (!portrait()) andSplit = 0;
  const t = andSplit;

  /* Open: laid out in the window less its foot, which is the black the hands
     waiting to take you back stand in — the one part of the window the picture
     does not get, so the control is never on a face and never under the bar a
     phone draws across the bottom of its own screen. */
  const areaPx = innerHeight - andFootPx();
  const wordPx = Math.min(areaPx * WORD_H, innerWidth * WORD_MAX_W * 223 / 521);
  const halfPx = Math.max(0, (areaPx - wordPx - 2 * areaPx * WORD_AIR) / 2);

  const area = areaPx / view.s;
  /* where the picture stops and the foot begins, for the control that stands in
     it — held against the bottom of the picture rather than the bottom of the
     window, which on a phone is under the browser's own bar */
  document.documentElement.style.setProperty('--and-foot', (view.y + area) + 'px');
  const k1 = halfPx / view.s / 1080;
  const lx1 = view.x, ly1 = view.y;
  const rx1 = view.x + view.w - 960 * k1;
  const ry1 = view.y + area - 1080 * k1;

  const mix = (a, b) => a + (b - a) * t;
  const k = mix(1, k1);
  const lx = mix(0, lx1), ly = mix(0, ly1);
  const rx = mix(960, rx1), ry = mix(0, ry1);
  l.style.transform = `translate(${lx}px, ${ly}px) scale(${k})`;
  r.style.transform = `translate(${rx}px, ${ry}px) scale(${k})`;
  /* what the sky has to keep out of, once the halves have moved */
  andRects = [{ x: lx, y: ly, w: 960 * k, h: 1080 * k },
              { x: rx, y: ry, w: 960 * k, h: 1080 * k }];
  openCellsFor = '';          /* the halves moved; the sky around them is new */

  /* MAGIC keeps the place it was drawn in while the frame is closed, and once
     the halves have gone it takes the middle of what they left. */
  const wk1 = wordPx / view.s / 223;
  const wx1 = 960 - 521 * wk1 / 2;
  const wy1 = (ly1 + 1080 * k1 + ry1) / 2 - 223 * wk1 / 2;
  const wx = mix(699, wx1), wy = mix(428, wy1), wk = mix(1, wk1);
  word.style.transform = `translate(${wx}px, ${wy}px) scale(${wk})`;
  /* the sky is a map of where the dark is, and the word is a hole in it. The
     word is a good deal larger once the frame has opened, so the hole is
     re-measured from where it actually is rather than left at the one place it
     was drawn. `bow` is the room an arc needs to swing clear of it. */
  const bow = 30;
  STREAK_WORD.x = wx - bow;
  STREAK_WORD.y = wy - bow;
  STREAK_WORD.w = 521 * wk + 2 * bow;
  STREAK_WORD.h = 223 * wk + 2 * bow;
}

/* The block as it was drawn, and what it costs to keep it. `MIN_SQUEEZE` is how
   far the drawn line may be scaled down before re-breaking it reads as less of
   a compromise than shrinking it further: under about two thirds the lettering
   stops being a title someone can read across a room. */
const MIN_SQUEEZE = .66;
const CAMP_ROW_GAP = 26;      /* between re-broken rows, in stage units */
const CAMP_STAR_GAP = 26;     /* around a star separator */

function layoutCampaigns() {
  if (!campItems.length) return;
  const design = campItems.concat(campStars).map((el) => el.design);
  const left = Math.min(...design.map((d) => d.x));
  const right = Math.max(...design.map((d) => d.x + d.w));
  const top = Math.min(...design.map((d) => d.y));
  const bottom = Math.max(...design.map((d) => d.y + d.h));
  /* a floor so an absurdly small window cannot drive the scale negative */
  const avail = Math.max(240, view.w - 2 * view.pad);
  const k = Math.min(1, avail / (right - left));

  if (k >= MIN_SQUEEZE) {
    /* drawn, or drawn and squeezed: the justified two-line block survives,
       scaled about its own centre so it stays centred under the hands */
    const cx = (left + right) / 2, cy = (top + bottom) / 2;
    const dy = clampY(cy + (top - cy) * k, (bottom - top) * k) - (cy + (top - cy) * k);
    for (const el of campItems.concat(campStars)) {
      const d = el.design;
      el.style.display = '';
      place(el, cx + (d.x - cx) * k, cy + (d.y - cy) * k + dy, d.w * k, d.h * k);
    }
    return;
  }
  /* re-broken, the block is shorter than the two drawn lines; it keeps the
     middle of the band those two lines occupied rather than their top edge, so
     it sits where the design put it rather than riding up under the hands */
  reflowCampaigns(avail, (top + bottom) / 2);
}

/* Re-broken into rows. Every title the drawn block sets is set again here,
   repeats included: the block is the site's list of campaigns and each one of
   them is a link, so dropping the second half of it to make the phone layout
   tidy takes three quarters of the list away from anyone holding a phone. There
   is room for all of them — the frame a portrait window crops to leaves more
   height under the hands than the drawn two lines need, not less. */
function reflowCampaigns(avail, middle) {
  const items = campItems;
  const star = campStars[0].design;
  const pairGap = star.w + 2 * CAMP_STAR_GAP;
  /* Scale so that the widest neighbouring pair still shares a row: two titles
     to a line is the shape of the drawn block, and keeping it is worth more
     than keeping the lettering at full size. */
  let pair = 0;
  for (let i = 1; i < items.length; i++) {
    pair = Math.max(pair, items[i - 1].design.w + pairGap + items[i].design.w);
  }
  const widest = Math.max(...items.map((el) => el.design.w));
  const k = Math.min(1, avail / (pair || widest));
  const limit = avail / k;

  const rows = [];
  let row = [];
  let width = 0;
  for (const el of items) {
    const w = el.design.w;
    const add = row.length ? pairGap + w : w;
    if (row.length && width + add > limit) { rows.push({ row, width }); row = []; width = 0; }
    width += row.length ? pairGap + w : w;
    row.push(el);
  }
  if (row.length) rows.push({ row, width });

  const rowH = Math.max(...items.map((el) => el.design.h)) * k;
  const gap = CAMP_ROW_GAP * k;
  const blockH = rows.length * rowH + (rows.length - 1) * gap;
  let y = clampY(middle - blockH / 2, blockH);

  for (const el of campItems) el.style.display = 'none';
  for (const el of campStars) el.style.display = 'none';

  let starAt = 0;
  for (const { row, width } of rows) {
    let x = 960 - width * k / 2;
    row.forEach((el, i) => {
      if (i) {
        const s = campStars[starAt++ % campStars.length];
        s.style.display = '';
        /* the star rides the middle of the gap, on the row's own baseline */
        place(s, x + CAMP_STAR_GAP * k, y + (rowH - star.h * k) / 2,
              star.w * k, star.h * k);
        x += pairGap * k;
      }
      el.style.display = '';
      place(el, x, y + (rowH - el.design.h * k) / 2, el.design.w * k, el.design.h * k);
      x += el.design.w * k;
    });
    y += rowH + gap;
  }
}

/* -------------------------------------------------------------- routing */
/* Every route back to the landing comes through here, so this is the one place
   that has to be sure of what it leaves on screen. The landing plate is the pose
   the whole overlay is positioned against — labels, icons, campaign names all
   sit where they sit in that one drawing — so resting on any other frame is not
   a dropped frame, it is a page whose buttons no longer line up with the hands
   under them. Wait for the plate rather than firing a show() at it and hoping. */
async function enterLanding({ dap = true, frames = null } = {}) {
  current = null;
  page.classList.remove('on', 'extra', ...PAGE_KINDS);
  setBackSide(null);
  ui.classList.add('hidden');
  if (dap) {
    await play(frames || pickDap(), TIMING.dap, TIMING.dapLast);
  }
  await settleOnLanding();
  ui.classList.remove('hidden');
  // every return to the landing is a return to the idle clock
  restartIdle();
}

/* The plate is loaded before the first dap ever plays, so this is normally a
   single synchronous draw. It only has anything to do when that load failed
   earlier in the visit, and then it keeps asking. */
async function settleOnLanding() {
  for (let tries = 0; tries < 3; tries++) {
    if (await show(LANDING)) return;
    if (wanted !== LANDING) return;   // a new move has taken the screen since
    await wait(400);
  }
}

let lastDap = -1;
function pickDap() {
  let i = Math.floor(Math.random() * SEQ.daps.length);
  if (SEQ.daps.length > 1 && i === lastDap) i = (i + 1) % SEQ.daps.length;
  lastDap = i;
  try { sessionStorage.setItem('lastDap', String(i)); } catch (e) { /* ignore */ }
  // Use each gesture's own photographed recovery poses backwards as its
  // anticipation, then the same poses forwards at the end. The fist-wiggle's
  // third-last drawing is still the wiggle itself, not recovery; including it
  // here performs a stray backwards wiggle before the opening palm hit.
  const action = SEQ.daps[i];
  const bridge = action.slice(i === 1 ? -2 : -3);
  return [
    ...[...bridge].reverse(),
    ...action,
    LANDING,
  ];
}

/* The sky over the & page. Four shooting stars were drawn; each is a run of
   separate marks laid along the path one takes, and a path's frames light those
   marks in turn — so the head runs the length of the path with the tail two
   marks behind it, and the streak comes up short, draws out long, then goes
   short again as it burns out.

   A star is thrown fresh every time it falls: somewhere in the black, at some
   size, travelling in some direction. The drawing is aimed by rotating it about
   the point it arrives at, which is why the whole set is cut on one canvas with
   that point in the same place in every frame. */
const STREAK_SLOTS = 28;     // stars that can be in the air at once

/* written by tools/build_magic.py — the box the drawings are cut on, the point
   in it a star arrives at, and each path's own direction of travel and reach */
const STREAK_ART = { w: 440, h: 400, tipX: 9.3, tipY: 388.7 };
const STREAK_PATHS = [
  { angle: 117.7, chord: 433 },
  { angle: 137.2, chord: 396 },
  { angle: 149.9, chord: 285 },
  { angle: 170.6, chord: 428 },
];
const STREAK_LENGTH = 14;    // frames in a fall

/* Where a star can cross. The plate is dark far past the gap between the two
   faces — into the hair, down the shadow on one cheek — and white ink reads
   anywhere it is, so the sky is measured off the plate rather than boxed: one
   bit per 32px cell, written by tools/build_magic.py. */
const STREAK_CELL = 32;
const STREAK_COLS = 60;
const STREAK_DARK = 'ffffffffff0f0003fffffffff0f800003fffffff0f800001fffffffd80000007ffffffe00000003ffffffe00000001ffffffe1c000001fffffffcc000001ffffffb0c000001ffffff9bc800001ffffff9fffc8001ffffff8ff3e8701ffffff8fe3f07e1ffffff9fc730481ffffff9fcc30001ffffffffcc30020ffffffffc670000fffffff7c7f0001ffffffffc020001ffffffffe000001ffffffffe000003fffffffff000007fffffffff00800ffffffffff80801ffffffffff80003ffffffffffc0003ffffffffff82007ffffffffff8000fffffffffff8008fffffffffff821ffffffffffff837ffffffffffff83fffffffffffff83fffffffffffff83';
/* what the sky is not: the word, the two eyes, and the hands waiting at the
   bottom edge — all drawn on top of the dark, so the map cannot see them */
let STREAK_WORD = { x: 669, y: 398, w: 582, h: 283 };
const STREAK_CLEAR = [
  STREAK_WORD,                           // the word, with room for an arc's bow
  { x: 210, y: 415, w: 115, h: 112 },    // his eye
  { x: 1716, y: 392, w: 115, h: 112 },   // his
  { x: 836, y: 916, w: 248, h: 164 },    // the hands
];
/* Enough that two stars do not read as one smudge, and no more: spaced any
   further they stop clustering, and evenly spread stars ring the word like an
   orbit instead of falling past it. */
const STREAK_APART = 90;
const STREAK_BOW = .14;      // how far an arc leans off its own chord

const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const chance = (p) => Math.random() < p;

const streakFrame = (path, f) => `ui/trail_${path}_${f}`;

/* Fifty-six drawings across four paths, and a star can be on any of them, so a
   slot carries one image and changes what it is showing. Every frame is fetched
   and decoded here, once, and held for the life of the page — the same reason
   the dap frames are held: a released one is re-requested, and a star that has
   to wait for the network is a star that never appears. */
function buildStreaks() {
  const sky = $('#streaks');
  for (let n = 0; n < STREAK_SLOTS; n++) {
    const slot = document.createElement('span');
    slot.className = 'streak';
    const i = document.createElement('img');
    i.alt = '';
    i.decoding = 'sync';
    slot.appendChild(i);
    sky.appendChild(slot);
  }
  const every = [];
  for (let path = 0; path < STREAK_PATHS.length; path++) {
    for (let f = 0; f < STREAK_LENGTH; f++) every.push(streakFrame(path, f));
  }
  load(every);
}

/* the cells the sky is made of, and a point in it */
const SKY_CELLS = (() => {
  const cells = [];
  for (let i = 0; i < STREAK_DARK.length * 4; i++) {
    if ((parseInt(STREAK_DARK[i >> 2], 16) >> (3 - (i & 3))) & 1) {
      cells.push({ x: (i % STREAK_COLS) * STREAK_CELL, y: Math.floor(i / STREAK_COLS) * STREAK_CELL });
    }
  }
  return cells;
})();

/* The drawn sky is a map of where the dark is in the 1.9:1 frame, and once the
   frame has come apart that map is describing a picture that is no longer on
   screen. So while the halves are open the sky is the window itself, less the
   two of them and less the word: the diagonal they leave between the corners,
   which is the biggest piece of black this page has ever had. */
const SKY_EDGE = 40;          /* how far a star stays off the window's own edge */
const skyOpen = () => andSplit > .5 && andRects;

function openSkyTakes(x, y) {
  if (x < view.x + SKY_EDGE || x > view.x + view.w - SKY_EDGE ||
      y < view.y + SKY_EDGE || y > view.y + view.h - SKY_EDGE) return false;
  for (const r of andRects) {
    if (x >= r.x - SKY_EDGE && x <= r.x + r.w + SKY_EDGE &&
        y >= r.y - SKY_EDGE && y <= r.y + r.h + SKY_EDGE) return false;
  }
  return !(x >= STREAK_WORD.x && x <= STREAK_WORD.x + STREAK_WORD.w &&
           y >= STREAK_WORD.y && y <= STREAK_WORD.y + STREAK_WORD.h);
}

/* Where a star may land: the drawn map's own lit cells, or — with the frame
   open — a grid over the window, which is rebuilt whenever the window is. */
let openCells = null, openCellsFor = '';
function skyCells() {
  if (!skyOpen()) return SKY_CELLS;
  const key = [view.x, view.y, view.w, view.h].map(Math.round).join(',');
  if (openCells && openCellsFor === key) return openCells;
  const cells = [];
  for (let y = view.y; y < view.y + view.h; y += STREAK_CELL) {
    for (let x = view.x; x < view.x + view.w; x += STREAK_CELL) {
      if (openSkyTakes(x + STREAK_CELL / 2, y + STREAK_CELL / 2)) cells.push({ x, y });
    }
  }
  openCells = cells.length ? cells : SKY_CELLS;
  openCellsFor = key;
  return openCells;
}

function skyTakes(x, y) {
  if (skyOpen()) return openSkyTakes(x, y);
  const col = Math.floor(x / STREAK_CELL);
  const row = Math.floor(y / STREAK_CELL);
  if (col < 0 || col >= STREAK_COLS || row < 0) return false;
  const i = row * STREAK_COLS + col;
  if (i >= STREAK_DARK.length * 4) return false;
  if (!((parseInt(STREAK_DARK[i >> 2], 16) >> (3 - (i & 3))) & 1)) return false;
  if (x >= STREAK_WORD.x && x <= STREAK_WORD.x + STREAK_WORD.w &&
      y >= STREAK_WORD.y && y <= STREAK_WORD.y + STREAK_WORD.h) return false;
  return !STREAK_CLEAR.some((c) => x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h);
}

/* Somewhere in the dark, pointing somewhere, clear of what is drawn on top of
   it and of the other stars in the air — or nowhere, if the sky is too full to
   take one. The whole of the star has to land in the dark, bow included: a
   streak that runs onto a lit cheek half disappears. */
function throwStreak(slot, taken) {
  for (let tries = 0; tries < 40; tries++) {
    const path = Math.floor(Math.random() * STREAK_PATHS.length);
    const scale = chance(.18) ? rand(.9, 1.5) : rand(.32, .8);
    const travel = rand(0, 360) * Math.PI / 180;
    const cells = skyCells();
    const cell = cells[Math.floor(Math.random() * cells.length)];
    const tip = { x: cell.x + rand(0, STREAK_CELL), y: cell.y + rand(0, STREAK_CELL) };
    const reach = STREAK_PATHS[path].chord * scale;
    const back = { x: -Math.cos(travel), y: -Math.sin(travel) };
    const side = { x: -back.y, y: back.x };

    // walk the star's own line, head to tip, and the two arcs it could bow into
    let fits = true;
    for (let k = 0; k <= 6 && fits; k++) {
      const t = k / 6;
      const bow = STREAK_BOW * reach * 4 * t * (1 - t);
      const x = tip.x + back.x * reach * t;
      const y = tip.y + back.y * reach * t;
      fits = skyTakes(x, y) &&
        skyTakes(x + side.x * bow, y + side.y * bow) &&
        skyTakes(x - side.x * bow, y - side.y * bow);
    }
    if (!fits) continue;
    if (taken.some((t) => Math.hypot(t.x - tip.x, t.y - tip.y) < STREAK_APART)) continue;

    const mirror = chance(.5);
    const degrees = travel * 180 / Math.PI;
    const base = mirror ? 180 - STREAK_PATHS[path].angle : STREAK_PATHS[path].angle;
    const w = STREAK_ART.w * scale;
    const h = STREAK_ART.h * scale;
    slot.style.cssText =
      `left:${(tip.x - STREAK_ART.tipX * scale).toFixed(1)}px;` +
      `top:${(tip.y - STREAK_ART.tipY * scale).toFixed(1)}px;` +
      `width:${w.toFixed(1)}px;height:${h.toFixed(1)}px;` +
      `transform:rotate(${(degrees - base).toFixed(1)}deg)${mirror ? ' scaleX(-1)' : ''}`;
    return { path, scale, tip };
  }
  return null;
}

async function fallStreak(slot, thrown, taken, alive) {
  const img = slot.firstElementChild;
  // a big one is close, and a close one goes past fast
  const hold = rand(-6, 6) + 74 - 24 * Math.min(thrown.scale, 1.2);
  // not every star burns the whole way down
  const last = chance(.16) ? Math.round(rand(6, 10)) : STREAK_LENGTH - 1;
  for (let f = 0; f <= last && alive(); f++) {
    img.src = src(streakFrame(thrown.path, f));
    // the bytes are already here; this is only to be sure the frame is ready to
    // paint before it is shown, so a swap can never flash the one before it
    await img.decode().catch(() => {});
    if (!alive()) break;
    slot.classList.add('on');
    await wait(jitter(hold, 6));
  }
  slot.classList.remove('on');
  const held = taken.indexOf(thrown.tip);
  if (held >= 0) taken.splice(held, 1);
}

/* One sky at a time: leaving the page ends the running one, but it only notices
   at its next held frame, so a quick return has to be able to start a new one
   and have the old one stand down when it wakes. */
let streakToken = 0;
async function streakLoop() {
  const mine = ++streakToken;
  const alive = () => current === 'and' && streakToken === mine;
  const slots = [...$('#streaks').children];
  const falling = new Set();
  const taken = [];
  while (alive()) {
    const free = slots.filter((s) => !falling.has(s));
    const slot = free.length ? free[Math.floor(Math.random() * free.length)] : null;
    const thrown = slot && throwStreak(slot, taken);
    if (thrown) {
      taken.push(thrown.tip);
      falling.add(slot);
      fallStreak(slot, thrown, taken, alive).then(() => falling.delete(slot));
      // mostly a shower, and now and then it thins out for a moment
      await wait(chance(.08) ? rand(300, 700) : rand(30, 80));
    } else {
      // the sky had no room for that one: try again rather than skip a turn
      await wait(12);
    }
  }
  for (const slot of slots) slot.classList.remove('on');
}

/* Star, heart or flame on each eye, a fresh pair every time the & is opened.
   The two eyes step through the three at different rates, so the pair is a
   different pair on each of the next two visits before it comes round again. */
const EYE_SYMBOLS = ['star', 'heart', 'flame'];
let eyeTurn = 0;
function dressEyes() {
  const eyes = $('#and-faces');
  eyes.dataset.l = EYE_SYMBOLS[eyeTurn % 3];
  eyes.dataset.r = EYE_SYMBOLS[(eyeTurn * 2 + 1) % 3];
  eyeTurn++;
}

async function goPage(id) {
  if (busy || current === id) return;
  busy = true;
  const p = PAGES[id];
  ui.classList.add('hidden');
  // Decode the destination alongside the move, so the last frame of the camera
  // pull-back cuts straight to it instead of flashing the empty page.
  const dest = load([p.key]);
  /* Hand the frames to the two halves before the move starts. They are the
     plate exactly until the camera begins to open them, so the change of
     surface is invisible — and it is what lets the frame come apart during the
     move instead of after it. */
  if (id === 'and') setAndOpen(true);
  await play(p.frames, TIMING.trans, TIMING.transLast, p.framing);
  await dest;
  pageImg.src = src(p.key);
  setBackSide(p.back);
  page.classList.remove('extra');
  setPageKind(id);
  if (id === 'and') dressEyes();
  page.classList.add('on');
  /* the eyes belong to the page, not to the move that opens it: they light on
     the two faces once the frame has finished coming apart */
  if (id === 'and') $('#and-faces').classList.add('dressed');
  current = id;
  idle();
  /* after `current`, which is the flag the loop runs on */
  if (id === 'and') streakLoop();
}

/* The one "camera" this site has: a held stop-motion pan/zoom sampled at
   these ten poses, never smoothly interpolated. `campaignDepthTransition`
   drives it toward a clicked title's on-screen position; the in-project
   prev/next nav below drives the exact same pose curve and threshold-to-
   black formula sideways instead, so a "camera move" only ever means one
   thing on this site. */
const CAM_STOPS = [0, .08, .17, .27, .38, .50, .63, .76, .88, 1];
const camPose = (t) => t * t * (3 - 2 * t);
const camStep = (frame) => ({ ...frame, easing: 'steps(1, end)' });
const CAM_DURATION = 470;

async function campaignDepthTransition(origin, reverse = false, target = null) {
  if (!origin) return;
  const image = origin.querySelector('img');
  if (!image) return;

  const x = origin.offsetLeft;
  const y = origin.offsetTop;
  const w = origin.offsetWidth;
  const h = origin.offsetHeight;
  // Where the flight ends is the page's business, not a constant: `target` is
  // the destination page's own title art, measured and handed over in stage
  // coordinates, so the camera's last held pose and the project's first frame
  // are the same picture. Only its width is used — the fly keeps the artwork's
  // ratio — which also means a target measured before the art has decoded
  // still lands right. Falls back to the fixed stage spot with no target.
  const targetScale = target ? target.w / w : 1.7;
  const targetX = target ? target.x + target.w / 2 : 960;
  const targetY = target ? target.y + h * targetScale / 2
                         : CAMPAIGN_TITLE_TOP + h * targetScale / 2;
  const dx = targetX - (x + w / 2);
  const dy = targetY - (y + h / 2);
  const focusX = x + w / 2;
  const focusY = y + h / 2;

  const flying = image.cloneNode(true);
  flying.className = 'campaign-fly-title';
  flying.style.left = x + 'px';
  flying.style.top = y + 'px';
  flying.style.width = w + 'px';
  flying.style.height = h + 'px';
  stage.appendChild(flying);
  origin.style.visibility = 'hidden';

  // The landing plate is black except for the hands. Screen blending lets the
  // hands pass in front of the travelling title without the plate's black
  // rectangle hiding it, which creates the foreground/depth read.
  plate.style.zIndex = '31';
  plate.style.mixBlendMode = 'screen';
  plate.style.transformOrigin = `${focusX}px ${focusY}px`;
  ui.style.transformOrigin = `${focusX}px ${focusY}px`;

  // One camera, sampled into held stop-motion poses. All three layers share
  // these exact offsets and the same pan. The hands only receive a deeper zoom,
  // so their sweep changes naturally with the position of the clicked title.
  const stops = CAM_STOPS;
  const pose = camPose;
  const stepped = camStep;
  const titleFrames = stops.map((offset) => {
    const p = pose(offset);
    const scale = 1 + (targetScale - 1) * p;
    return stepped({
      offset,
      transform: `translate3d(${dx * p}px,${dy * p}px,0) scale(${scale})`,
    });
  });
  const worldFrames = stops.map((offset) => {
    const p = pose(offset);
    const scale = 1 + (targetScale - 1) * p;
    const brightness = Math.max(0, 1 - 1.28 * p);
    return stepped({
      offset,
      transform: `translate3d(${dx * p}px,${dy * p}px,0) scale(${scale})`,
      filter: `contrast(${1 + 7 * p}) brightness(${brightness})`,
      opacity: Math.max(0, 1 - Math.pow(p, 1.7)),
    });
  });
  const handFrames = stops.map((offset) => {
    const p = pose(offset);
    const scale = 1 + 3.35 * p;
    const brightness = Math.max(0, 1 - Math.pow(p, 2.8));
    return stepped({
      offset,
      transform: `translate3d(${dx * p}px,${dy * p}px,0) scale(${scale})`,
      filter: `contrast(${1 + 7 * p}) brightness(${brightness})`,
      opacity: p < .88 ? 1 : Math.max(0, (1 - p) / .12),
    });
  });
  const timing = {
    duration: CAM_DURATION,
    easing: 'linear',
    fill: 'forwards',
    direction: reverse ? 'reverse' : 'normal',
  };
  const titleMove = flying.animate(titleFrames, timing);
  const worldMove = ui.animate(worldFrames, timing);
  const handsMove = plate.animate(handFrames, timing);

  if (reverse) {
    // The reverse animations begin on their final (black/close-camera) poses,
    // exactly underneath the project page. Removing the page now reveals the
    // first held pose without a flash of the normal landing state.
    show(LANDING);
    ui.classList.remove('hidden');
    page.classList.remove('on', 'extra', ...PAGE_KINDS);
    setBackSide(null);
  }

  await Promise.all([titleMove.finished, worldMove.finished,
                     handsMove.finished]).catch(() => {});

  if (!reverse) {
    ui.classList.add('hidden');
    setPageKind(null);
    setBackSide(CAMPAIGN_BACK);
    page.classList.add('on', 'extra');
    // #project opens right here, the same tick as the #page backdrop above,
    // not after goCampaign's later openProject() call — that extra await
    // was a second reveal step reverse never has (it shows the landing it's
    // returning to immediately, before the flight even starts), and the gap
    // between #page's own title stand-in and #project's real, precisely
    // measured one is exactly the jump this closes. openProject() still
    // runs afterward too; re-adding an already-set class is a no-op.
    project.classList.add('on');
    project.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => requestAnimationFrame(updateProject));
  }
  for (const animation of [titleMove, worldMove, handsMove]) animation.cancel();
  flying.remove();
  origin.style.visibility = '';
  plate.style.zIndex = '';
  plate.style.mixBlendMode = '';
  plate.style.transformOrigin = '';
  ui.style.transformOrigin = '';
}

/* --------------------------------------------------------------- project */
/* A project page is a normal scrolling document, not more frames of the
   stage — real footage and stills, not stop-motion. `.reveal` blocks open the
   same way the rest of the site does, though: noisy and dark, clearing to
   clean as they're scrolled to, the contrast/brightness move `campaign
   DepthTransition` already plays run continuously off scroll position instead
   of a fixed timeline. `.depth` blocks drift at their own rate under that,
   the same layered read as the title that flew in to open the page. */
const PROJECTS = {};

/* hand-drawn pen doodles: every arrow, circle and underline on a project page
   runs through the same turbulence filter, so a plain bezier reads as a loose
   pen stroke instead of vector-perfect line art. A feDisplacementMap bends the
   path off true — a real pen never tracks straight — and then `penInk` softens
   the edge and eats it back a little through an alpha gamma with a negative
   offset. Because the erosion is a pure function of edge alpha it is identical
   for every arrow, and because the displacement noise is isotropic and
   moderate-frequency its thick/thin averages out over any one stroke's run:
   the weight wanders ALONG each line the way a pen's does, without one arrow
   ever reading heavier than the next.
   Each doodle gets its own filter id — several of these sit in the DOM at
   once, and a shared id is a duplicate-id bug waiting to make one arrow's
   filter region silently apply to another's geometry. */
/* Every doodle below is drawn in ONE shared unit system: 1 SVG user unit = 1px
   at the 1920 layout width, and each is sized in CSS at exactly its viewBox
   size in vw. That is what keeps them consistent — the filter's noise
   frequency and displacement, and the pen's stroke-width, are all in user
   units, so a doodle drawn in a 60-unit box and one drawn in a 122-unit box
   come out of the same pen instead of the same pen scaled by two different
   amounts. Never size one of these to a width that doesn't match its
   viewBox's aspect: that rescales the stroke and breaks the set. */
/* userSpaceOnUse, not the default objectBoundingBox: a perfectly horizontal
   shaft has a zero-height bbox, and a percentage filter region off that is
   zero-height too — the stroke silently disappears. The fixed box below
   comfortably contains every viewBox on the page. */
/* `seed` only reshuffles the same noise, it doesn't change its character —
   it's there so two doodles that sit near each other on one page don't wear
   the identical wobble stroke for stroke. */
/* the weight/ink tail, shared by penFilter and the two bespoke filters below.
   It chains straight off whatever feDisplacementMap precedes it: a hair of
   blur, then an alpha gamma with a small negative offset that trims the
   softened edge — more where the wobble already pinched the line, so the
   stroke thins and nearly dries in places. Keep it gentle: it must never gap. */
const penInk = `<feGaussianBlur stdDeviation="0.5" result="b"/><feComponentTransfer in="b"><feFuncA type="gamma" amplitude="1.55" exponent="1.3" offset="-0.1"/></feComponentTransfer>`;
const penFilter = (id, seed = 7) => `<filter id="${id}" filterUnits="userSpaceOnUse" x="-20" y="-20" width="220" height="220">
  <feTurbulence type="fractalNoise" baseFrequency="0.045" numOctaves="2" seed="${seed}" result="n"/>
  <feDisplacementMap in="SourceGraphic" in2="n" scale="2.6"/>
  ${penInk}
</filter>`;
const PEN_W = 5.2;
const pen = (id) => `fill="none" stroke="currentColor" stroke-width="${PEN_W}" stroke-linecap="round" stroke-linejoin="round" filter="url(#${id})"`;

/* The one arrowhead every arrow on the page wears: a loose open V, ~32 units
   tall and ~26 deep, drawn as its own stroke that stops short of the shaft
   rather than joining it — exactly how they're drawn in layout.png. */
const headV = (id, vx, vy, ax, ay, bx, by) =>
  `<path d="M${ax} ${ay}L${vx} ${vy}L${bx} ${by}" ${pen(id)}/>`;

/* ---------------------------------------------------------- project nav */
/* Every project (built or not) sits on the same ring — the order campaign
   icons are laid out in on the landing. Prev/next walk this ring and wrap, so
   "move through all the projects" never dead-ends at an edge.

   The dedup below is now a guard rather than a filter: the second drawn line
   used to repeat three of the first line's campaigns, and it no longer does.
   It stays because the ring is built from ui.json, and a title set twice
   there — the landing is one drawing and a campaign could legitimately be
   lettered on both lines again — would otherwise put a campaign next to
   itself in the nav. */
function campaignRing() {
  const seen = new Set();
  const ring = [];
  for (const c of cfg.campaigns) {
    if (seen.has(c.slug)) continue;
    seen.add(c.slug);
    ring.push(c);
  }
  return ring;
}

function campaignNeighbors(slug) {
  const ring = campaignRing();
  const i = ring.findIndex((c) => c.slug === slug);
  if (i === -1) return { prev: null, next: null };
  return {
    prev: ring[(i - 1 + ring.length) % ring.length],
    next: ring[(i + 1) % ring.length],
  };
}

/* Nav arrows: same pen, same head, same 58x38 box, mirrored. `n` only exists
   to keep the filter ids unique — the nav renders twice on a page (top and
   bottom), and two <filter> elements sharing an id is a silent bug. */
const navChevron = (dir, n) => {
  const id = `navPen${dir < 0 ? 'L' : 'R'}${n}`;
  const head = dir < 0
    ? headV(id, 3, 17, 23, 3, 23, 31)
    : headV(id, 41, 17, 21, 3, 21, 31);
  const shaft = dir < 0
    ? `<path d="M14 17H40" ${pen(id)}/>`
    : `<path d="M4 17H30" ${pen(id)}/>`;
  return `<svg viewBox="0 0 44 34"><defs>${penFilter(id)}</defs>${shaft}${head}</svg>`;
};

/* The chrome every project page shares: prev/next into its neighbors on the
   ring, and — once, at the top — the close control built from the same
   reaching-hand cutouts `#back` uses everywhere else on the site. A project
   only ever supplies its own content; this is never redrawn per project. */
let navInstance = 0;
function renderProjectNav(slug, withHands) {
  const { prev, next } = campaignNeighbors(slug);
  const n = ++navInstance;
  const link = (c, dir, chevron, extraClass) => c ? `
      <button type="button" class="proj-nav-link${extraClass ? ' ' + extraClass : ''}" data-goto="${c.slug}" data-dir="${dir}">
        ${dir < 0 ? chevron : ''}<span>${c.label.toLowerCase()}</span>${dir > 0 ? chevron : ''}
      </button>` : '<span></span>';
  return `
    <div class="proj-nav">
      ${link(prev, -1, navChevron(-1, n))}
      ${withHands ? `<button type="button" class="proj-nav-hands" data-close aria-label="Close">
        <span class="back-in">
          <span class="hand h-salva-v"><img src="${IMG}ui/hand_salva_v_0.png" alt=""><img src="${IMG}ui/hand_salva_v_1.png" alt=""><img src="${IMG}ui/hand_salva_v_2.png" alt=""></span>
          <span class="hand h-pita-v"><img src="${IMG}ui/hand_pita_v_0.png" alt=""><img src="${IMG}ui/hand_pita_v_1.png" alt=""><img src="${IMG}ui/hand_pita_v_2.png" alt=""></span>
        </span>
      </button>` : ''}
      ${link(next, 1, navChevron(1, n), 'next')}
    </div>`;
}

PROJECTS['back-in-smoothly'] = function () {
  const p = PROJ_IMG('back-in-smoothly');
  const yt = 'ZOVg5GCUxqs';
  const GAME_URL = 'https://thelifeofpita.github.io/backingame/';
  const nav = (withHands) => renderProjectNav('back-in-smoothly', withHands);

  /* All five arrows below are traced off layout.png at 1920: same pen, same
     stroke, same open-V head (~32 tall, ~26 deep, always a separate stroke
     that stops short of the line it terminates, legs ~24 units long). Only the
     tail differs — straight for the nav-style pointers, a long left-hand hook
     for the two that drop from a caption into the artwork under it. Each
     viewBox is the traced ink box from layout.png, geometry inset by 3 (half
     the pen) so the stroke lands exactly on that box. */
  const descArrow = `<svg class="proj-arrow" viewBox="0 0 74 31"><defs>${penFilter('bisRough1')}</defs>
    <path d="M3 17C11 6 22 2 33 4C47 7 55 13 60 19" ${pen('bisRough1')}/>
    ${headV('bisRough1', 68, 27, 45, 22, 70, 3)}
  </svg>`;

  const printsArrow = `<svg class="proj-arrow" viewBox="0 0 79 117"><defs>${penFilter('bisRough2')}</defs>
    <path d="M75 3C58 1 22 6 8 34C1 52 12 82 30 98" ${pen('bisRough2')}/>
    ${headV('bisRough2', 45, 113, 22, 108, 47, 89)}
  </svg>`;

  const arrowLeft = `<svg class="proj-arrow" viewBox="0 0 94 33"><defs>${penFilter('bisRough3')}</defs>
    <path d="M24 16.5H91" ${pen('bisRough3')}/>
    ${headV('bisRough3', 3, 16.5, 23, 3, 23, 30)}
  </svg>`;
  const arrowRight = `<svg class="proj-arrow" viewBox="0 0 94 33"><defs>${penFilter('bisRough4')}</defs>
    <path d="M3 16.5H70" ${pen('bisRough4')}/>
    ${headV('bisRough4', 91, 16.5, 71, 3, 71, 30)}
  </svg>`;

  const tapArrow = `<svg class="bis-arrow-down proj-arrow" viewBox="0 0 54 91"><defs>${penFilter('bisRough5')}</defs>
    <path d="M51 3C34 1 12 12 7 38C4 55 12 74 23 80" ${pen('bisRough5')}/>
    ${headV('bisRough5', 35, 88, 12, 83, 37, 64)}
  </svg>`;

  const circleThis = `<svg viewBox="0 0 52 45"><defs>${penFilter('bisRough6')}</defs>
    <path d="M27 3C41 3 49 11 49 22C49 33 40 42 26 42C13 42 3 34 3 22C3 11 13 3 27 3Z" ${pen('bisRough6')}/>
  </svg>`;

  return `
    <div class="proj proj-bis">
      ${nav(true)}

      <div class="proj-head">
        <img class="proj-title-art" src="${IMG}ui/camp_l1_2.png" alt="Back in smoothly">
        <p class="bis-subtitle">use the rear view camera of cars to position PlatanoMelón’s relaxant lubricant as the smoooothest solution for your <small>tightest</small> maneuvers.</p>
      </div>

      <div class="proj-block bis-b-spot">
        <p class="bis-desc">
          tv and digital spot showcasing the struggle of backing in, unless you are using PlatanoMelón’s relaxant lubricant.
          ${descArrow}
        </p>
        <div class="proj-media bis-yt">
          <iframe src="https://www.youtube.com/embed/${yt}?rel=0" title="Back in smoothly" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen loading="lazy"></iframe>
        </div>
      </div>

      <div class="proj-block bis-b-duo">
        <div class="proj-duo">
          <div class="proj-media">
            <video autoplay muted loop playsinline poster="${p}gif1.jpg"><source src="${p}gif1.mp4" type="video/mp4"></video>
          </div>
          <div class="proj-media">
            <video autoplay muted loop playsinline poster="${p}gif2.jpg"><source src="${p}gif2.mp4" type="video/mp4"></video>
          </div>
        </div>
      </div>

      <div class="proj-block bis-b-cap">
        <p class="bis-caption">
          ${printsArrow}
          prints glued in hotel and motel parking spots, strategically placed to be seen while parking in reverse previous to having fun.
        </p>
      </div>

      <div class="proj-block bis-b-stick">
        <div class="bis-sticker-row">
          <img src="${p}stick1.webp" alt="Back in smoothly sticker — star">
          <img src="${p}stick2.webp" alt="Back in smoothly sticker — flower">
          <img src="${p}stick3.webp" alt="Back in smoothly sticker — burst">
        </div>
      </div>

      <div class="bis-park-row">
        <img src="${p}park1.webp" alt="Sticker on a parking garage rear-view screen — star">
        <img src="${p}park2.webp" alt="Sticker on a parking garage rear-view screen — flower">
        <img src="${p}park3.webp" alt="Sticker on a parking garage rear-view screen — burst">
      </div>

      <div class="proj-block bis-b-mobile">
        <div class="bis-mobile-row">
          <div class="proj-media">
            <video autoplay muted loop playsinline poster="${p}gif3.jpg"><source src="${p}gif3.mp4" type="video/mp4"></video>
          </div>
          <div class="bis-mobile-center">
            <div class="bis-interactive">
              ${arrowLeft}
              <p>interactive pop-up<br>game ad on mobile.</p>
              ${arrowRight}
            </div>
            <div class="bis-tap-wrap">
              <a class="bis-tap" href="${GAME_URL}" target="_blank" rel="noopener">
                <span>tap <span class="bis-circle">this${circleThis}</span> or scan</span>
                <span>here to play</span>
              </a>
              <div class="bis-qr-wrap">
                ${tapArrow}
                <a class="bis-qr" href="${GAME_URL}" target="_blank" rel="noopener">
                  <img src="${p}qr.svg" alt="Scan to play Back in smoothly on your phone">
                </a>
              </div>
            </div>
          </div>
          <div class="proj-media">
            <video autoplay muted loop playsinline poster="${p}gif4.jpg"><source src="${p}gif4.mp4" type="video/mp4"></video>
          </div>
        </div>
      </div>

      ${nav(false)}
    </div>`;
};

/* Same campaign-mockup system as Back in Smoothly (nav, title art, one bold
   idea line) — Numpad Jam has no build yet beyond its premise and a case
   study clip, so the page stops there instead of carrying content blocks
   the project doesn't have. */
PROJECTS['numpad-jam'] = function () {
  const p = PROJ_IMG('numpad-jam');
  const nav = (withHands) => renderProjectNav('numpad-jam', withHands);
  const yt = 'yY9nMKmyxvQ';

  /* same pen, same open-V head as every other doodle on a project page —
     traced at the descArrow's own viewBox so the two read as one family. */
  const caseArrow = `<svg class="proj-arrow" viewBox="0 0 74 31"><defs>${penFilter('npRough1')}</defs>
    <path d="M3 17C11 6 22 2 33 4C47 7 55 13 60 19" ${pen('npRough1')}/>
    ${headV('npRough1', 68, 27, 45, 22, 70, 3)}
  </svg>`;

  /* Same pen, same box and the same job as caseArrow above — text on the
     left, a doodle trailing it, both pointing down into the media the
     caption introduces — but drawn rather than reused: a second identical
     copy of that curve on one page reads as a pasted duplicate. This one
     bows the opposite way (sagging under its own start instead of arcing
     over it) and runs its own filter seed, so the roughness doesn't repeat
     stroke for stroke either. */
  const jamArrow = `<svg class="proj-arrow" viewBox="0 0 74 31"><defs>${penFilter('npRough3', 11)}</defs>
    <path d="M3 5C12 12 20 15 30 15C42 15 53 19 62 24" ${pen('npRough3')}/>
    ${headV('npRough3', 69, 30, 56, 28, 67, 17)}
  </svg>`;

  /* Points sideways, not down: the copy it trails sits to the left of the
     product rather than above it, so this one runs almost flat and lifts
     slightly into its head. Its own seed again, so three arrows in the same
     box on one page don't wear the same wobble. */
  const padArrow = `<svg class="proj-arrow" viewBox="0 0 74 31"><defs>${penFilter('npRough6', 23)}</defs>
    <path d="M3 23C14 20 26 16 38 13C46 11 55 9 62 8" ${pen('npRough6')}/>
    ${headV('npRough6', 71, 7, 59, 2, 59, 16)}
  </svg>`;

  /* The invitation, ringed by hand. Same pen as every arrow on the page, so
     it reads as the same marker — but a circle drawn in one stroke is never
     closed and never round: this one starts up the left side, comes round,
     and runs PAST its own start before it stops, which is what a real pen
     does when someone rings something on a page. The quarters are
     deliberately unequal (the top bulges right, the bottom sags left) for
     the same reason.

     It carries its own filter rather than penFilter(), for two reasons. The
     region: that helper's is a fixed x:-20..200, sized for the small arrow
     boxes, and this path runs out to x332, so the shared region would clip
     the right half of the ring clean off. And the roughness: penFilter's
     0.045/2.6 is 2.6 units of wobble across a 74-unit arrow, which is ~3.5%
     of the drawing. The same numbers on a box five times bigger come out
     five times smoother — a clean ellipse, not a pen. So the noise is
     scaled to the shape instead of copied from it: a lower frequency for a
     wave that runs the length of the curve rather than buzzing along it,
     and a displacement that keeps the same proportion of the box. */
  const tryFilter = `<filter id="npRough4" filterUnits="userSpaceOnUse" x="-30" y="-30" width="410" height="280">
    <feTurbulence type="fractalNoise" baseFrequency="0.013" numOctaves="3" seed="3" result="n"/>
    <feDisplacementMap in="SourceGraphic" in2="n" scale="9"/>
    ${penInk}
  </filter>`;
  const tryCircle = `<svg class="np-try-ring" viewBox="0 0 350 220"><defs>${tryFilter}</defs>
    <path d="M24 104C24 52 96 16 180 12C262 8 332 42 330 104C328 160 254 206 168 202C86 198 20 174 20 118C20 88 32 60 56 40" ${pen('npRough4')}/>
  </svg>`;

  /* The arrow that connects the two halves of the row: it comes off the
     bottom-right of the clip — the corner nearest the drawn keyboard in the
     footage — and climbs to the ring, stopping well short of both. Same pen
     and same 1-unit-≈-1px scale as the rest; its box is 150x90, so it is a
     mid-size doodle between the small caption arrows and the long shop one,
     and it keeps penFilter's own roughness since that region (x:-20..200)
     still covers a path this size. */
  const tryArrow = `<svg class="proj-arrow" viewBox="0 0 150 90"><defs>${penFilter('npRough5', 19)}</defs>
    <path d="M6 84C32 79 64 70 94 53C114 42 127 31 134 21" ${pen('npRough5')}/>
    ${headV('npRough5', 142, 10, 126, 13, 139, 27)}
  </svg>`;

  /* Purpose-drawn for this exact gap. Its box (.np-shop-arrow in the CSS)
     starts BELOW the caption's own text line, not level with it — an
     earlier version started at the text's own top and only stayed clear
     of the letters by x-position while the curve was still low enough to
     share the text's y-range, which meant the curve's sweep cut straight
     across the word "the". Starting the whole box past the text's bottom
     removes that risk structurally.

     This viewBox is sized to the real travel distance from the text to
     the hat card — 410x70, at the same "1 unit ≈ 1px at 1920 layout
     width" scale as every other doodle on the page (.np-shop-arrow's own
     width/height are viewBox-units/19.2, in vw, exactly like np-case's
     arrow). A cramped viewBox force-stretched across that whole distance
     tried once before and clipped its own arrowhead; the opposite mistake
     was tried after that — a viewBox close to square, stretched by
     preserveAspectRatio:none across a box roughly 10x wider than tall —
     which squashed the curve flat and warped the stroke width along the
     way. Matching the viewBox to the real box's own proportions is what
     actually avoids both: the SVG scales close to 1:1 in both axes, so
     PEN_W and the arrowhead render at their drawn size instead of being
     stretched or squeezed by the box around them.

     Can't use the shared penFilter() for it, though: that helper's filter
     region is a fixed x:-20..200, sized on the assumption every doodle's
     viewBox stays under ~180 units (true for the rest of the page, per
     its own comment). This path ranges over x0-410 and dips above y0, so
     the shared region would clip it — this is that same filter with its
     region widened to cover the whole path plus roughness margin. */
  const npFilterWide = `<filter id="npRough2" filterUnits="userSpaceOnUse" x="-30" y="-30" width="470" height="140">
    <feTurbulence type="fractalNoise" baseFrequency="0.045" numOctaves="2" seed="7" result="n"/>
    <feDisplacementMap in="SourceGraphic" in2="n" scale="2.6"/>
    ${penInk}
  </filter>`;
  /* The head's wings are rotated to the stem's own final tangent (the
     last segment dives toward 372,52, a 45° angle) instead of sitting
     vertically-symmetric under the vertex — a vertical V under a
     diagonal stem reads as pasted-on, not as the same stroke continuing
     into its own point. headV() is already its own stroke everywhere
     else on the page — "stops short of the shaft rather than joining
     it" — so the stem here has to stop short of the vertex (372,52) too,
     not run all the way into it: it now ends at 364,44, ~11 units back
     along that same 45° line, leaving the same open gap caseArrow's stem
     leaves before its own head. */
  const shopArrow = `<svg class="proj-arrow" viewBox="0 0 410 70"><defs>${npFilterWide}</defs>
    <path d="M15 20C130 2 230 -4 305 20C338 30 360 40 364 44" ${pen('npRough2')}/>
    ${headV('npRough2', 372, 52, 371, 39, 359, 51)}
  </svg>`;

  /* Cards traced 1:1 off shop.jpegmafia.net's own product tile — white
     square, soft drop shadow, grey Arial name, blue Arial price, square
     corners (no radius). Every name/price is confirmed off an actual video
     frame except "honor", which follows the same [motif] + garment +
     colorway pattern as the five that were. */
  const PRODUCTS = [
    { img: 'cowboy.jpg', name: 'Red Dot Tee Black', price: '€42.95' },
    { img: 'sunburst.jpg', name: 'MAFIA Intl. Crewneck Ash', price: '€63.95' },
    { img: 'cap.jpg', name: 'MAFIA International Hat Black', price: '€31.95' },
    { img: 'honor.jpg', name: 'Honor Power Blood Tee Black', price: '€42.95' },
    { img: 'goat.jpg', name: 'Mafia Goat Longsleeve Tee', price: '€58.95' },
  ];

  /* The album: 15s off each of four tracks. In mixThemUp the digit keys are
     YouTube's decile seek, and each decile of that video is a 30s sample off
     a different JPEGMAFIA record — so what the community submits is a key
     sequence, every press restarting its own sample from that sample's top
     and holding until the next press. That sequence is the bed of each
     track here, cut exactly the way the keys would cut it (see
     tools/build_beats.py), with drums, bass and effects written on top of
     it, different for each one: the community's sequence is the idea, and
     the record is that idea produced.

     A track is titled by the only name it has, the keys themselves — digits
     and nothing else, because a numpad has nothing else on it. Nobody names
     these; you play a sequence and the sequence is the track. They share one
     sleeve for the same reason: it is one album, and its cover is the
     instrument it was played on — the nine number keys, close up, nothing
     else in frame.

     Every one is credited to JPEGMAFIA, exactly like the track in the case
     video's own player: the community composed these by mixing his back
     catalogue with the number keys, but what comes out the other end is his
     album, released under his name. The listener's fingerprint is in the
     title, not in the byline. */
  const JAMS = [
    { id: 'beat1', keys: '04070477' },
    { id: 'beat2', keys: '11588361' },
    { id: 'beat3', keys: '92596' },
    { id: 'beat4', keys: '2628268286' },
  ];
  const ARTIST = 'JPEGMAFIA';

  /* Spotify's own mini player, same borrowed-UI move as the shop cards
     below: their card, their type, their green — a second real product
     surface the campaign's output shows up inside of. */
  const playIcon = `<svg class="np-jam-i-play" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 2.6 13 8l-8.5 5.4z"/></svg>`;
  const pauseIcon = `<svg class="np-jam-i-pause" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.2 2.5h2.6v11H4.2zm5 0h2.6v11H9.2z"/></svg>`;

  return `
    <div class="proj proj-numpad">
      ${nav(true)}

      <div class="proj-head">
        <img class="proj-title-art" src="${IMG}ui/camp_l1_3.png" alt="Numpad jam">
        <p class="numpad-idea">JPEGMAFIA releases a new album composed by his community through an obscure YouTube feature.</p>
      </div>

      <div class="proj-block np-b-case">
        <p class="np-case">
          case study
          ${caseArrow}
        </p>
        <div class="proj-media np-yt">
          <iframe src="https://www.youtube.com/embed/${yt}?rel=0" title="Numpad Jam" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen loading="lazy"></iframe>
        </div>
      </div>

      <!-- Real footage cut straight from the case-study video itself, not
           recreated — the mockup already shows the tool doing its thing at
           the right speed, so there was nothing to rebuild. This is the
           fast, varied keyboard-jump section (mixThemUp's number keys
           landing on different album samples), cut before the camera pushes
           in on it later in the source. It runs at its own full width here,
           uncropped: showing all ten timeline covers is the point of the
           shot. Beside it, the invitation — the clip shows somebody doing
           it, and the circle is where you go to do it yourself. -->
      <div class="proj-block np-b-duo">
        <div class="np-duo">
          <div class="proj-media np-duo-clip">
            <video autoplay muted loop playsinline poster="${p}gif2.jpg"><source src="${p}gif2.mp4" type="video/mp4"></video>
          </div>
          <!-- the arrow lives outside the <a>, not in it: it points AT the
               link, so it shouldn't be part of the link's hit area or shake
               with it on hover -->
          <div class="np-duo-try">
            <div class="np-try-arrow">${tryArrow}</div>
            <a class="np-try" href="https://www.youtube.com/watch?v=HlXeVnXsTjc" target="_blank" rel="noopener">
              ${tryCircle}
              <span class="np-try-label">click to mix with your keyboard</span>
            </a>
          </div>
        </div>
      </div>

      <div class="proj-block np-b-jams">
        <p class="np-case np-jams-caption">
          the comments composed the album, hear it for yourself
          ${jamArrow}
        </p>
        <div class="np-jams">
          ${JAMS.map((j) => `
            <div class="np-jam">
              <div class="np-jam-top">
                <div class="np-jam-art"><img src="${p}beats/cover.jpg" alt=""></div>
                <div class="np-jam-body">
                  <div class="np-jam-name">${j.keys}</div>
                  <div class="np-jam-by">${ARTIST}</div>
                </div>
                <button class="np-jam-play" type="button" data-jam-play aria-label="Play ${j.keys} by ${ARTIST}">${playIcon}${pauseIcon}</button>
              </div>
              <div class="np-jam-row">
                <div class="np-jam-time" data-jam-now>0:00</div>
                <!-- the bar is the click target for scrubbing, so it carries
                     the padding that makes a 4px line hittable rather than
                     being a 4px line you have to hit exactly -->
                <div class="np-jam-bar" data-jam-seek><div class="np-jam-track"><div class="np-jam-fill"></div><div class="np-jam-knob"></div></div></div>
                <div class="np-jam-time">0:15</div>
              </div>
              <audio preload="none" src="${p}beats/${j.id}.mp3"></audio>
            </div>`).join('')}
        </div>
      </div>

      <div class="proj-block np-b-shop">
        <p class="np-shop-caption">the shop filled up with numbers too</p>
        <div class="np-shop-arrow">${shopArrow}</div>
        <div class="np-shop">
          ${PRODUCTS.map((item) => `
            <div class="np-shop-card">
              <div class="np-shop-tile"><img src="${p}products/${item.img}" alt="${item.name}"></div>
              <div class="np-shop-name">${item.name}</div>
              <div class="np-shop-price">${item.price}</div>
            </div>`).join('')}
        </div>
      </div>

      <!-- The product itself, last: one continuous turn on black. The take it
           was cut from doesn't loop — it eases up, turns, and stops on a
           different pose — so tools/build_pad_loop.py stabilises it, retimes
           it to one steady rate and closes the seam. Copy on the left with an
           arrow off the end of it, because the pad is the thing being pointed
           at here, not something the copy introduces. -->
      <div class="proj-block np-b-pad">
        <div class="np-pad">
          <p class="np-pad-copy">numpad? samplepad? both.</p>
          <div class="np-pad-arrow">${padArrow}</div>
          <div class="proj-media np-pad-clip">
            <video autoplay muted loop playsinline poster="${p}pad.jpg"><source src="${p}pad.mp4" type="video/mp4"></video>
          </div>
        </div>
      </div>

      ${nav(false)}
    </div>`;
};

/* Same campaign-mockup system as the other two project pages (nav, title art,
   one bold idea line, then the work) — its own block rather than a shared one
   so each page can drift from the others' numbers.

   The work here is nine photographs and nothing else, so the page is the
   contact sheet itself: a 3x3 of squares, all cropped to the same size so no
   one shot outranks another. The layout is the argument — the four corners
   are the four garments hung in the street as ads, the four sides are the
   patched-on lettering those ads are made of, and the middle is the pile they
   all came out of. Full scene, detail, full scene, detail, round the ring,
   with the source at the centre of it. */
PROJECTS['ads-from-trash'] = function () {
  const p = PROJ_IMG('ads-from-trash');
  const nav = (withHands) => renderProjectNav('ads-from-trash', withHands);

  /* Reading order IS the ring: corners are the four hung garments, the four
     edges between them are the close-ups of their lettering, and the pile
     sits in the middle. Cropped square off the originals at the point of
     interest (tools/crop_aft.py), so the grid is nine equal squares and
     nothing is letterboxed into one.

     `m` is the same nine in the order a phone reads them, since one column
     cannot be a ring: each garment hung, then the stitching on it read close,
     then the next — and the pile, which is all four of them at once, last.
     The grid keeps the DOM in ring order and re-orders with CSS, so the
     reading order on a wide screen is the one written here. */
  const CELLS = [
    { m: 1, img: 'full-tshirt.webp',    alt: 'Worn-out t-shirt hung on a wall: "We tried to make the most of it, and the most turned out to be an ad."' },
    { m: 2, img: 'close-tshirt.webp',   alt: 'Close-up of the patched letters "WE TR" stitched onto the t-shirt' },
    { m: 3, img: 'full-dress.webp',     alt: 'Sequin dress hung on a wall: "We did our best, and it turned out to be this ugly ad."' },
    { m: 4, img: 'close-dress.webp',    alt: 'Close-up of the patched letters "D I" stitched onto the sequin dress' },
    { m: 9, img: 'pile.webp',           alt: 'The four garments in a pile on the floor in window light' },
    { m: 6, img: 'close-hoodie.webp',   alt: 'Close-up of the patched letters "AR" stitched onto the hoodie' },
    { m: 5, img: 'full-hoodie.webp',    alt: 'Blue hoodie hung on a wall: "The best clothes end up in our stores. The most worn-out ones are our ads."' },
    { m: 8, img: 'close-overalls.webp', alt: 'Close-up of the patched letters "NO" stitched onto the overalls' },
    { m: 7, img: 'full-overalls.webp',  alt: 'Grease-stained overalls hung on a wall: "We had no choice but to recycle these worn-out overalls into a worn-out ad."' },
  ];


  return `
    <div class="proj proj-aft">
      ${nav(true)}

      <div class="proj-head">
        <img class="proj-title-art" src="${IMG}ui/camp_l1_1.png" alt="Ads from trash">
        <p class="aft-idea">giving a use to the 8% of unrecyclable donated clothes that Humana eliminates, as ads.</p>
      </div>

      <div class="proj-block aft-b-grid">
        <div class="aft-grid">
          ${CELLS.map((c) => `
            <figure class="aft-cell" style="--m:${c.m}">
              <img src="${p}${c.img}" alt="${c.alt}" loading="lazy">
            </figure>`).join('')}
        </div>
      </div>

      ${nav(false)}
    </div>`;
};

/* Built to update/surf_the_spike/layout.pdf, which is drawn at the same 1920
   the project pages are laid out in — so every number in .proj-sts's CSS is
   read straight off it (155-unit margins, a 1610-wide column, the gaps between
   the blocks) rather than invented. Four blocks, each one caption and one piece
   of media the caption's arrow points into, and last the placements as a flush
   2x2 with a caption over it and a caption under it. */
PROJECTS['surf-the-spike'] = function () {
  const p = PROJ_IMG('surf-the-spike');
  const nav = (withHands) => renderProjectNav('surf-the-spike', withHands);
  const yt = 'nf5xLDfsp5k';

  /* Seven doodles, traced off the layout at its own scale: 1 SVG user unit =
     1px at 1920, each sized in CSS at exactly its viewBox size in vw, same pen
     and same open-V head as every other project page. Each carries its own
     filter id — several sit in the DOM at once and a shared id silently
     applies one arrow's filter region to another's geometry — and its own
     seed, so seven arrows on one page don't wear one wobble seven times. */
  const caseArrow = `<svg class="proj-arrow" viewBox="0 0 74 31"><defs>${penFilter('stsRough1')}</defs>
    <path d="M3 17C11 6 22 2 33 4C47 7 55 13 60 19" ${pen('stsRough1')}/>
    ${headV('stsRough1', 68, 27, 45, 22, 70, 3)}
  </svg>`;

  /* The long one: it leaves the caption at the top right, runs back across the
     black and drops onto the third phone. Its filter needs a region of its own
     — penFilter's is fixed at x:-20..200, which is sized for the small arrow
     boxes and would clip nothing here, but the height matters: this box is 88
     tall against their 31, and the shared region's 220 covers it. Kept on
     penFilter for exactly that reason. */
  const scanArrow = `<svg class="proj-arrow" viewBox="0 0 168 88"><defs>${penFilter('stsRough2', 13)}</defs>
    <path d="M162 6C104 7 46 17 25 55" ${pen('stsRough2')}/>
    ${headV('stsRough2', 24, 82, 6, 60, 42, 62)}
  </svg>`;

  const uiArrow = `<svg class="proj-arrow" viewBox="0 0 128 58"><defs>${penFilter('stsRough3', 23)}</defs>
    <path d="M12 14C46 8 88 14 108 36" ${pen('stsRough3')}/>
    ${headV('stsRough3', 117, 50, 94, 39, 122, 28)}
  </svg>`;

  /* The pair over the shops: one arrow off each end of the caption, dropping
     into the photograph under it. Mirrored, not one drawing flipped — a flip
     would repeat the same wobble backwards, which reads as a copy. */
  const shopLeft = `<svg class="proj-arrow" viewBox="0 0 112 46"><defs>${penFilter('stsRough4', 31)}</defs>
    <path d="M104 12C76 12 50 18 33 30" ${pen('stsRough4')}/>
    ${headV('stsRough4', 14, 37, 27, 17, 40, 37)}
  </svg>`;
  const shopRight = `<svg class="proj-arrow" viewBox="0 0 126 48"><defs>${penFilter('stsRough5', 37)}</defs>
    <path d="M8 12C44 13 82 20 105 33" ${pen('stsRough5')}/>
    ${headV('stsRough5', 116, 42, 93, 36, 111, 21)}
  </svg>`;

  /* And the pair under the vending machines, which point back UP into them:
     short hooks rather than long sweeps, because the caption sits right on the
     edge of the photographs instead of a block away from them. */
  const vendLeft = `<svg class="proj-arrow" viewBox="0 0 62 44"><defs>${penFilter('stsRough6', 43)}</defs>
    <path d="M56 37C40 35 24 33 14 24" ${pen('stsRough6')}/>
    ${headV('stsRough6', 12, 9, 12, 31, 26, 20)}
  </svg>`;
  const vendRight = `<svg class="proj-arrow" viewBox="0 0 46 44"><defs>${penFilter('stsRough7', 47)}</defs>
    <path d="M8 37C20 35 28 28 33 17" ${pen('stsRough7')}/>
    ${headV('stsRough7', 35, 9, 23, 16, 40, 26)}
  </svg>`;

  /* The four placements, in the order the layout hangs them: the two shops on
     the top row, the two machines under them, flush — no gutter, because the
     grid is one wall of places the message was put rather than four pictures
     with space to breathe. */
  const PLACES = [
    { img: 'shop1.webp', alt: 'Gas station shop front, the campaign running on a screen in the window: "Sleep like a baby, tomorrow."' },
    { img: 'shop2.webp', alt: 'Behind a shop counter, the same campaign on a screen over the drinks fridge: "Sleep like a log, tomorrow."' },
    { img: 'vend1.webp', alt: 'Campus vending machine wrapped with "Get tonight’s energy spike."' },
    { img: 'vend2.webp', alt: 'A row of campus machines carrying the same wrap' },
  ];

  return `
    <div class="proj proj-sts">
      ${nav(true)}

      <div class="proj-head">
        <img class="proj-title-art" src="${IMG}ui/camp_l2_0.png" alt="Surf the spike">
        <p class="sts-idea">a solution for college students to take full advantage of their late-night caffeine-filled study sessions.</p>
      </div>

      <div class="proj-block sts-b-case">
        <p class="sts-cap sts-cap-case">
          <span>video case</span>
          ${caseArrow}
        </p>
        <div class="proj-media sts-yt">
          <iframe src="https://www.youtube.com/embed/${yt}?rel=0" title="Surf the spike" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen loading="lazy"></iframe>
        </div>
      </div>

      <!-- The one caption set to the right of the column: its arrow has to
           leave the words travelling left to land on the third phone, so the
           words have to be over on that side to leave it the run. -->
      <div class="proj-block sts-b-scan">
        <div class="sts-scan">
          <p class="sts-cap sts-cap-scan">
            ${scanArrow}
            <span>scan your caffeine intake</span>
          </p>
          <img src="${p}scan.webp" alt="Three phones scanning a coffee, a tea and an energy shot, each labelled with the caffeine it holds" loading="lazy">
        </div>
      </div>

      <div class="proj-block sts-b-ui">
        <p class="sts-cap sts-cap-ui">
          <span>get your specific energy curve tracked and a study plan that benefits from it</span>
          ${uiArrow}
        </p>
        <div class="proj-media sts-clip">
          <video autoplay muted loop playsinline poster="${p}ui.jpg"><source src="${p}ui.mp4" type="video/mp4"></video>
        </div>
      </div>

      <div class="proj-block sts-b-out">
        <p class="sts-cap sts-cap-shops">
          ${shopLeft}
          <span>reached students in gas stations near residences</span>
          ${shopRight}
        </p>
        <div class="sts-grid">
          ${PLACES.map((c) => `<figure class="sts-cell"><img src="${p}${c.img}" alt="${c.alt}" loading="lazy"></figure>`).join('')}
        </div>
        <p class="sts-cap sts-cap-vend">
          ${vendLeft}
          <span>and in vending machines inside campus</span>
          ${vendRight}
        </p>
      </div>

      ${nav(false)}
    </div>`;
};

/* Built to update/tracking_life/layout.pdf, the same way Surf the Spike is
   built to its own: that file is drawn at 1920, which is the width these pages
   are laid out against, so its measurements go straight into .proj-tl's CSS.
   Three blocks — the film, the phone's own back lighting up beside the life it
   is reading, and the recap it hands back. */
PROJECTS['tracking-life'] = function () {
  const p = PROJ_IMG('tracking-life');
  const nav = (withHands) => renderProjectNav('tracking-life', withHands);
  const yt = 'JPgC5tQR8n4';

  /* Four doodles traced off the layout at its own scale: 1 unit = 1px at 1920,
     each sized in CSS at exactly its viewBox size in vw, same pen and same
     open-V head as the rest of the site. Own filter id each — several sit in
     the DOM at once and a shared id silently applies one arrow's filter region
     to another's geometry — and own seed, so no two wear the same wobble. */
  const caseArrow = `<svg class="proj-arrow" viewBox="0 0 66 34"><defs>${penFilter('tlRough1', 5)}</defs>
    <path d="M4 11C18 8 34 12 45 23" ${pen('tlRough1')}/>
    ${headV('tlRough1', 57, 30, 39, 27, 55, 8)}
  </svg>`;

  /* The pair over the two clips: this one leaves the left of the line and
     drops into the phone, so it runs down-left and stands its head on end. */
  const lightLeft = `<svg class="proj-arrow" viewBox="0 0 122 52"><defs>${penFilter('tlRough2', 11)}</defs>
    <path d="M118 6C88 11 56 21 34 36" ${pen('tlRough2')}/>
    ${headV('tlRough2', 10, 46, 15, 11, 58, 44)}
  </svg>`;

  /* And this one comes out from UNDER the words rather than after them — it
     starts below the middle of the line and sweeps out to the right clip, which
     is why the CSS pulls it back over the text instead of setting it beside. */
  const lightRight = `<svg class="proj-arrow" viewBox="0 0 108 32"><defs>${penFilter('tlRough3', 19)}</defs>
    <path d="M5 4C22 16 42 8 60 14C74 19 84 22 92 26" ${pen('tlRough3')}/>
    ${headV('tlRough3', 101 , 29, 78, 25, 99, 7)}
  </svg>`;

  const recapArrow = `<svg class="proj-arrow" viewBox="0 0 76 42"><defs>${penFilter('tlRough4', 29)}</defs>
    <path d="M72 5C52 9 32 17 21 28" ${pen('tlRough4')}/>
    ${headV('tlRough4', 8, 37, 12, 9, 44, 35)}
  </svg>`;

  return `
    <div class="proj proj-tl">
      ${nav(true)}

      <div class="proj-head">
        <img class="proj-title-art" src="${IMG}ui/camp_l2_2.png" alt="Tracking life">
        <p class="tl-idea">a vitality sensor indicated through the Nothing Phone (3)’s glyph.</p>
      </div>

      <div class="proj-block tl-b-case">
        <p class="tl-cap tl-cap-case">
          <span>video case</span>
          ${caseArrow}
        </p>
        <div class="proj-media tl-yt">
          <iframe src="https://www.youtube.com/embed/${yt}?rel=0" title="Tracking life" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen loading="lazy"></iframe>
        </div>
      </div>

      <!-- The two of them read as one line: the glyph on the back of the phone
           and the living it is reading off, side by side, one caption over the
           pair with an arrow into each. -->
      <div class="proj-block tl-b-light">
        <p class="tl-cap tl-cap-light">
          ${lightLeft}
          <span>light up when vitality is high</span>
          ${lightRight}
        </p>
        <div class="tl-duo">
          <div class="proj-media tl-clip">
            <video autoplay muted loop playsinline poster="${p}light-up.jpg"><source src="${p}light-up.mp4" type="video/mp4"></video>
          </div>
          <div class="proj-media tl-clip">
            <video autoplay muted loop playsinline poster="${p}life.jpg"><source src="${p}life.mp4" type="video/mp4"></video>
          </div>
        </div>
      </div>

      <div class="proj-block tl-b-recap">
        <p class="tl-cap tl-cap-recap">
          ${recapArrow}
          <span>and get a recap</span>
        </p>
        <div class="proj-media tl-clip">
          <video autoplay muted loop playsinline poster="${p}recap.jpg"><source src="${p}recap.mp4" type="video/mp4"></video>
        </div>
      </div>

      ${nav(false)}
    </div>`;
};

/* Built to update/pick_a_side/layout.pdf (drawn at 1920, 1 unit = 1px, the
   same as Surf the Spike and Tracking Life). The work is four animations off
   the source render (McDonald's turned its side menu into a midterm ballot):
   the order kiosk folding its menu blocks into a ballot, the checkout screen
   resolving into a ballot box, the fries carton turning to show an "I PICKED
   MY SIDE" sticker, and the app running the election live. The renders keep
   their alpha, so they play as animated WebP in <img> — the one transparent
   animation format every current browser renders (this repo's ffmpeg cannot
   make VP9-alpha WebM). tools/build_pas.sh cuts them; order/checkout/reminder
   bounce (ping-pong), app plays straight. */
PROJECTS['pick-a-side'] = function () {
  const p = PROJ_IMG('pick-a-side');
  const nav = (withHands) => renderProjectNav('pick-a-side', withHands);
  const yt = 'C9xKzRLujqs';

  /* Five doodles traced off the layout, same pen and open-V head as every
     other project page — own filter id and seed each, and .proj-arrow so they
     drop on a phone with the rest. */
  const caseArrow = `<svg class="proj-arrow" viewBox="0 0 80 48"><defs>${penFilter('pasRough1', 3)}</defs>
    <path d="M4 12C24 7 46 10 58 20C62 24 63 30 63 34" ${pen('pasRough1')}/>
    ${headV('pasRough1', 63, 44, 52, 28, 74, 32)}
  </svg>`;

  /* A C-hook off the near side of each kiosk caption, curling down the edge of
     the words and standing its head on end into the screen below — the left
     one down the left side, the right one down the right. */
  const orderArrow = `<svg class="proj-arrow" viewBox="0 0 56 80"><defs>${penFilter('pasRough2', 11)}</defs>
    <path d="M42 4C18 7 5 24 8 42C9 54 10 60 11 66" ${pen('pasRough2')}/>
    ${headV('pasRough2', 11, 78, 0, 61, 24, 64)}
  </svg>`;
  const checkoutArrow = `<svg class="proj-arrow" viewBox="0 0 56 80"><defs>${penFilter('pasRough3', 17)}</defs>
    <path d="M14 4C38 7 51 24 48 42C47 54 46 60 45 66" ${pen('pasRough3')}/>
    ${headV('pasRough3', 45, 78, 32, 64, 56, 61)}
  </svg>`;

  /* Off the end of the reminder line, curving down into the carton under it. */
  const reminderArrow = `<svg class="proj-arrow" viewBox="0 0 92 68"><defs>${penFilter('pasRough4', 23)}</defs>
    <path d="M4 8C30 3 56 12 74 32C78 36 80 42 81 46" ${pen('pasRough4')}/>
    ${headV('pasRough4', 82, 58, 62, 50, 88, 36)}
  </svg>`;

  /* Straight across from the words to the phone beside them. */
  const appArrow = `<svg class="proj-arrow" viewBox="0 0 140 40"><defs>${penFilter('pasRough5', 29)}</defs>
    <path d="M4 22C42 14 90 14 120 21" ${pen('pasRough5')}/>
    ${headV('pasRough5', 138, 24, 117, 8, 125, 33)}
  </svg>`;

  const loop = (name, alt) => `<div class="proj-media pas-anim pas-anim-${name}">
        <img src="${p}${name}.webp" alt="${alt}" loading="lazy">
      </div>`;

  return `
    <div class="proj proj-pas">
      ${nav(true)}

      <div class="proj-head">
        <img class="proj-title-art" src="${IMG}ui/camp_l1_0.png" alt="Pick a side">
        <p class="pas-idea">for the midterm elections in the United States, McDonald’s turned its side menu into a ballot.</p>
      </div>

      <div class="proj-block pas-b-case">
        <p class="pas-cap pas-cap-case">
          <span>video case</span>
          ${caseArrow}
        </p>
        <div class="proj-media pas-yt">
          <iframe src="https://www.youtube.com/embed/${yt}?rel=0" title="Pick a side" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen loading="lazy"></iframe>
        </div>
      </div>

      <!-- The two kiosk screens are one act: the menu blocks fold into a
           ballot, and that ballot is what you check out with. A caption over
           each with an arrow onto its screen. -->
      <div class="proj-block pas-b-kiosk">
        <div class="pas-duo">
          <div class="pas-col pas-col-order">
            <p class="pas-cap pas-cap-order">
              ${orderArrow}
              <span>ordering is like filling up a ballot</span>
            </p>
            ${loop('order', 'A McDonald’s order kiosk: the Pick a Side menu blocks folding down into a ballot')}
          </div>
          <div class="pas-col pas-col-checkout">
            <p class="pas-cap pas-cap-checkout">
              <span>checkout with your “ballot”</span>
              ${checkoutArrow}
            </p>
            ${loop('checkout', 'The kiosk order summary resolving into a red ballot box')}
          </div>
        </div>
      </div>

      <!-- The takeaway and the follow-up: a sticker on the carton so you
           remember you voted, and the election running live in the app. -->
      <!-- Placed, not gridded: in the layout the carton hangs lower-left and
           the phone stands upper-right, its caption tucked in at the phone's
           lower-left corner. .pas-b-after is a relative box and each piece is
           set in vw off the 1920 drawing; the phone @media flattens it. -->
      <div class="proj-block pas-b-after">
        <p class="pas-cap pas-cap-reminder">
          <span>get a cute reminder</span>
          ${reminderArrow}
        </p>
        ${loop('reminder', 'A McDonald’s fries carton turning to show an “I PICKED MY SIDE” sticker')}
        ${loop('app', 'The McDonald’s app: a Pick a Side section running the election live, state by state')}
        <p class="pas-cap pas-cap-app">
          <span>follow the elections in the app</span>
          ${appArrow}
        </p>
      </div>

      ${nav(false)}
    </div>`;
};

function clamp01(n) { return n < 0 ? 0 : n > 1 ? 1 : n; }

/* Chrome's autoplay heuristics sometimes leave an off-screen `autoplay` video
   paused rather than actually playing it, so a clip below the fold can sit on
   its poster frame forever. Driving play/pause off intersection instead of
   trusting the attribute fixes that and, as a side effect, stops paying for
   decode on clips that have scrolled away. */
let projectVideoObserver = null;
function watchProjectVideos() {
  if (projectVideoObserver) projectVideoObserver.disconnect();
  projectVideoObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) e.target.play().catch(() => {});
      else e.target.pause();
    }
  }, { rootMargin: '200px 0px' });
  for (const v of projectScroll.querySelectorAll('video')) projectVideoObserver.observe(v);
}

/* ------------------------------------------- numpad jam mini players */
/* One jam at a time, like a real player: starting a second card stops the
   first rather than stacking two beats on top of each other. The page's
   own clips are muted, so the jams are the only sound the site ever makes
   and nothing can start one but a click. */
let jamCurrent = null;   // the <audio> that is currently sounding, if any
let jamRaf = null;

function jamClock(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/* timeupdate only fires ~4x a second, which reads as a bar that steps
   rather than one that moves, so the fill is driven off rAF while a jam
   plays and left alone the rest of the time. The loop runs on jamCurrent
   being set, not on the element being unpaused: play() resolves a beat
   later than it's called, so a paused check here would see the audio still
   stopped on the first frame and end the loop before it ever started.
   stopJams() is the only thing that ends it. */
function jamFrame() {
  jamRaf = null;
  if (!jamCurrent) return;
  jamPaint(jamCurrent);
  jamRaf = requestAnimationFrame(jamFrame);
}

function jamPaint(audio) {
  const card = audio.closest('.np-jam');
  if (!card) return;
  // duration is NaN until metadata lands; the beats are all 15s by
  // construction, so the bar can be honest from the first frame.
  const total = Number.isFinite(audio.duration) ? audio.duration : 15;
  card.style.setProperty('--jam-p', clamp01((audio.currentTime || 0) / total));
  card.querySelector('[data-jam-now]').textContent = jamClock(audio.currentTime);
}

function stopJams() {
  if (jamRaf) { cancelAnimationFrame(jamRaf); jamRaf = null; }
  jamCurrent = null;
  for (const a of projectScroll.querySelectorAll('audio')) {
    a.pause();
    try { a.currentTime = 0; } catch (e) { /* not seekable yet: nothing to reset */ }
  }
  for (const c of projectScroll.querySelectorAll('.np-jam')) c.classList.remove('on');
}

projectScroll.addEventListener('click', (ev) => {
  const card = ev.target.closest('.np-jam');
  if (!card) return;
  const audio = card.querySelector('audio');

  const seek = ev.target.closest('[data-jam-seek]');
  if (seek) {
    const r = seek.getBoundingClientRect();
    const total = Number.isFinite(audio.duration) ? audio.duration : 15;
    try { audio.currentTime = clamp01((ev.clientX - r.left) / r.width) * total; } catch (e) {}
    jamPaint(audio);
    return;
  }

  if (!ev.target.closest('[data-jam-play]')) return;
  const wasPlaying = audio === jamCurrent && !audio.paused;
  stopJams();
  if (wasPlaying) { jamPaint(audio); return; }
  jamCurrent = audio;
  card.classList.add('on');
  audio.play().catch(() => { stopJams(); });
  jamFrame();
});

/* A jam that runs out goes back to its own start rather than sitting spent
   at the end: 15s is a loop someone played, and the card should be ready to
   play it again the next time it's clicked. */
projectScroll.addEventListener('ended', (ev) => {
  if (ev.target.tagName !== 'AUDIO') return;
  stopJams();
  jamPaint(ev.target);
}, true);

/* Every campaign opens into #project, whether or not it has a build yet —
   one destination per slug, reached the same way whether you clicked its
   icon on the landing or arrived via prev/next from a neighbor. A campaign
   without a project gets the shared COMING SOON stub instead of a project
   page, but it's still #project that opens, with the same nav around it. */
function buildProject(slug) {
  // before the innerHTML below detaches them — a detached <audio> keeps
  // sounding, so the page it belongs to has to silence it on its way out
  stopJams();
  const build = PROJECTS[slug];
  if (build) {
    projectScroll.innerHTML = build();
  } else {
    const c = cfg.campaigns.find((x) => x.slug === slug);
    projectScroll.innerHTML = `<div class="proj proj-soon">
      ${renderProjectNav(slug, true)}
      <div class="proj-soon-body">
        <img src="${IMG}${c.src}" alt="${c.label}">
        <div class="soon">COMING SOON</div>
      </div>
      ${renderProjectNav(slug, false)}
    </div>`;
  }
  projectScroll.scrollTop = 0;
  watchProjectVideos();
  return true;
}

/* The title the transition flies is the same artwork the project page opens
   with, so the two have to agree on where that is. #project is display:none
   until it opens; `probing` lays it out without showing it, long enough to
   read the real rect. Returned in the stage's own 1920x1080 coordinates,
   because that is the space the flying clone animates in. */
function projectTitleRect() {
  const wasOn = project.classList.contains('on');
  if (!wasOn) project.classList.add('probing');
  const art = projectScroll.querySelector('.proj-title-art, .proj-soon-body img');
  const rect = art && art.getBoundingClientRect();
  if (!wasOn) project.classList.remove('probing');
  if (!rect || !rect.width) return null;
  const stageRect = stage.getBoundingClientRect();
  const s = stageRect.width / 1920;
  return {
    x: (rect.left - stageRect.left) / s,
    y: (rect.top - stageRect.top) / s,
    w: rect.width / s,
  };
}

/* Scroll-scrubbed, not a one-shot entrance: a block starts resolving as its
   top clears 92% of viewport height and reads clean by 45%, so the noise
   dissolves at the pace of the scroll itself rather than on a timer. */
let projectRaf = null;
function updateProject() {
  projectRaf = null;
  const vh = innerHeight;
  for (const el of projectScroll.querySelectorAll('.reveal')) {
    const top = el.getBoundingClientRect().top;
    const p = clamp01((vh * .92 - top) / (vh * .47));
    el.style.setProperty('--p', p.toFixed(3));
  }
  for (const el of projectScroll.querySelectorAll('.depth')) {
    const r = el.getBoundingClientRect();
    const depth = parseFloat(el.dataset.depth || '0');
    const y = (vh / 2 - (r.top + r.height / 2)) * depth;
    el.style.setProperty('--y', y.toFixed(1) + 'px');
  }
}
function scheduleProjectUpdate() {
  if (projectRaf) return;
  projectRaf = requestAnimationFrame(updateProject);
}
projectScroll.addEventListener('scroll', scheduleProjectUpdate, { passive: true });
addEventListener('resize', scheduleProjectUpdate);

function openProject(slug, prebuilt = false) {
  if (!prebuilt && !buildProject(slug)) return false;
  project.classList.add('on');
  project.setAttribute('aria-hidden', 'false');
  // two frames: one for the new layout to land, one for the first paint at
  // the correct scroll-driven --p/--y instead of the CSS-default noisy state.
  requestAnimationFrame(() => requestAnimationFrame(updateProject));
  return true;
}

function closeProject() {
  if (!project.classList.contains('on')) return;
  project.classList.remove('on');
  project.setAttribute('aria-hidden', 'true');
  if (projectVideoObserver) { projectVideoObserver.disconnect(); projectVideoObserver = null; }
  for (const v of projectScroll.querySelectorAll('video')) v.pause();
  stopJams();
  projectScroll.innerHTML = '';
}

$('#project-close').addEventListener('click', goHome);

/* project-page chrome that isn't part of the .reveal/.depth scroll system:
   a project's own prev/next campaign nav, and a close control built from
   the same reaching-hand artwork the rest of the site uses for "back". */
projectScroll.addEventListener('click', (ev) => {
  if (ev.target.closest('[data-close]')) { goHome(); return; }
  const nav = ev.target.closest('[data-goto]');
  if (nav) {
    ev.preventDefault();
    projectTransitionTo(nav.dataset.goto, Number(nav.dataset.dir));
  }
});

/* Prev/next never leaves #project or touches the landing/hands stage, but it
   is the same camera move as clicking a title, not a different effect: one
   held stop-motion pan (CAM_STOPS/camPose/camStep, the exact curve and
   contrast/brightness-to-black formula `campaignDepthTransition` uses for
   its `worldFrames`), aimed sideways at "the next place" instead of at an
   icon's position. The outgoing project plays it forward — the disappear
   read the rest of the site uses — and, once swapped, the incoming one
   plays the identical keyframes in reverse: the appear read is the disappear
   read undone, never a separate animation. */
function cameraPanFrames(pan) {
  return CAM_STOPS.map((offset) => {
    const p = camPose(offset);
    const brightness = Math.max(0, 1 - 1.28 * p);
    return camStep({
      offset,
      transform: `translate3d(${pan * p}px,0,0)`,
      filter: `contrast(${1 + 7 * p}) brightness(${brightness})`,
      opacity: Math.max(0, 1 - Math.pow(p, 1.7)),
    });
  });
}

async function projectTransitionTo(slug, dir) {
  if (busy || !projectScroll.querySelector('.proj')) return;
  busy = true;
  const distance = Math.max(140, innerWidth * .22);
  const timing = { duration: CAM_DURATION, easing: 'linear', fill: 'forwards' };

  // A logical pan, not a mirror: "next" (dir 1) pans the camera rightward,
  // so the outgoing project — behind the camera now — exits left, and the
  // incoming one arrives from the right it just panned toward. "prev" is
  // the same read flipped. Two different offsets, not one played backwards.
  const outFrames = cameraPanFrames(-dir * distance);
  const inFrames = cameraPanFrames(dir * distance);

  const out = projectScroll.animate(outFrames, timing);
  await out.finished.catch(() => {});

  if (projectVideoObserver) { projectVideoObserver.disconnect(); projectVideoObserver = null; }
  for (const v of projectScroll.querySelectorAll('video')) v.pause();
  stopJams();
  buildProject(slug);
  /* `c/` here is the internal key only — it is what tells goBack a campaign is
     open rather than a member page. The address itself is the bare slug. */
  current = 'c/' + slug;
  /* The address follows the page. Replaced rather than pushed, and replaced
     rather than assigned: `location.hash = ...` would fire hashchange, and
     `route()` would answer it by opening this same project all over again —
     from the landing, with the depth transition, on top of the pan that is
     still running. The ring is a lateral move inside one project view, so it
     leaves the history where entering it put it: Back is still the way out to
     the landing, and a copied link is still the project on screen. */
  history.replaceState(null, '', '#' + slug);
  campaignReturnOrigin = document.querySelector(`.camp[data-slug="${slug}"]`) || campaignReturnOrigin;

  // `out` ends at opacity 0 and `in`'s reverse start (its own p:1) is also
  // opacity 0 — both offsets are invisible, so the swap above never flashes
  // even though the two poses sit on opposite sides.
  const inAnim = projectScroll.animate(inFrames, { ...timing, direction: 'reverse' });
  out.cancel();
  await inAnim.finished.catch(() => {});
  inAnim.cancel();
  // measured only now the pan is off the element — mid-animation the scroller
  // still carries the camera's transform, and the title would read as being
  // wherever that pose left it rather than where the page puts it
  campaignReturnTarget = projectTitleRect();
  idle();
}

async function goCampaign(slug, origin = null) {
  if (busy) return;
  const c = cfg.campaigns.find((x) => x.slug === slug &&
    (!origin || x.src === origin.dataset.src)) ||
    cfg.campaigns.find((x) => x.slug === slug);
  /* A campaign the landing does not letter does not exist: the block IS the
     list, and everything downstream — the flying title, the project's own
     prev/next — is built out of that entry. A hash for one that was taken off
     the block (PASTA FOR PASTA, until it has a project) or was never on it
     goes home rather than opening a page with no title to fly. */
  if (!c) { goHome(); return; }   // goHome clears the address itself
  /* and whatever spelling got us here, the address ends up the short one —
     which is what upgrades a `#c/<slug>` link from the few hours the site
     shipped with that prefix */
  if (location.hash.slice(1) !== slug) history.replaceState(null, '', '#' + slug);
  busy = true;
  origin = origin || document.querySelector(`.camp[data-slug="${slug}"]`);
  campaignReturnOrigin = origin;
  pageImg.removeAttribute('src');
  // just the landing target for the flying title — #project opens on top of
  // it either way, so this never needs its own COMING SOON copy any more.
  pageExtra.innerHTML = `<div class="title"><img src="${IMG}${c.src}" alt="${c.label}"></div>`;
  // built before the flight, not after: the camera needs somewhere real to
  // aim, and the page it aims at is this one. Kept for the way out too, since
  // by then the page is gone and cannot be measured again.
  buildProject(slug);
  campaignReturnTarget = projectTitleRect();
  await campaignDepthTransition(origin, false, campaignReturnTarget);
  openProject(slug, true);
  current = 'c/' + slug;
  idle();
}

async function goBack() {
  if (busy || current === null) return;
  busy = true;
  const id = current;
  if (id.startsWith('c/')) {
    const slug = id.slice(2);
    // read while the page is still standing, so a resize since it opened is
    // accounted for — but only from the top, where the title is the thing the
    // camera is actually looking at. Scrolled away, the pose it landed on is
    // still the truer place to start the flight back from.
    const target = (projectScroll.scrollTop < 2 && projectTitleRect())
      || campaignReturnTarget;
    closeProject();
    const origin = campaignReturnOrigin ||
      document.querySelector(`.camp[data-slug="${slug}"]`);
    await campaignDepthTransition(origin, true, target);
    await settleOnLanding();
    campaignReturnOrigin = null;
    campaignReturnTarget = null;
    current = null;
    idle();
    return;
  }
  page.classList.remove('on', 'extra', ...PAGE_KINDS);
  setBackSide(null);
  /* the eyes belong to the & page, not to the move that leaves it — the same
     as on the way in, where they only light once the frame has come apart. So
     drop them the instant the frame starts coming back together, not when the
     move finishes (which is all setAndOpen(false) below would do). */
  if (id === 'and') $('#and-faces').classList.remove('dressed');
  if (PAGES[id]) {
    await play([...PAGES[id].frames].reverse(), TIMING.trans, TIMING.transLast,
               'landing', LEAVE);
  }
  /* by now the halves are closed again, so the plate can take the frames back */
  setAndOpen(false);
  await enterLanding({ dap: false });
  idle();
}

/* leaving a page always comes back through here, so the hash is cleared once
   and goBack() can never be kicked off twice */
function goHome() {
  /* queued, not dropped — and the address is only cleared once the move it asks
     for is actually going to happen */
  if (busy) { pendingHome = true; return; }
  if (location.hash) history.replaceState(null, '', location.pathname);
  goBack();
}

/* One flat namespace: `#and`, `#pita`, `#salva` are the three drawn pages and
   everything else is a campaign slug — `#numpad-jam`, not `#c/numpad-jam`. The
   member pages are matched first, so a campaign may not be called `pita`,
   `salva` or `and`; nothing else is reserved, and an unknown slug goes home
   through goCampaign.

   `c/` is still accepted and answered on the clean address: the site shipped
   with that prefix for a few hours, and openProject rewrites whatever came in
   to the short form, so an old link upgrades itself rather than 404ing into
   the landing. */
function route() {
  let h = location.hash.replace(/^#/, '');
  if (!h) { if (current !== null) goHome(); return; }
  if (PAGES[h]) { goPage(h); return; }
  if (h.startsWith('c/')) h = h.slice(2);
  const origin = pendingCampaignOrigin;
  pendingCampaignOrigin = null;
  goCampaign(h, origin);
}
addEventListener('hashchange', route);

/* ------------------------------------------------------- rock/paper/scissors */
const DROPS = {
  l: $('#drop-l'),
  r: $('#drop-r'),
};

function stagePoint(ev) {
  const r = stage.getBoundingClientRect();
  const s = r.width / 1920;
  return { x: (ev.clientX - r.left) / s, y: (ev.clientY - r.top) / s };
}

function zoneAt(p) {
  for (const k of ['l', 'r']) {
    const d = DROPS[k];
    const x = d.offsetLeft, y = d.offsetTop;
    if (p.x >= x && p.x <= x + d.offsetWidth && p.y >= y && p.y <= y + d.offsetHeight) return k;
  }
  return null;
}

let drag = null;
let suppressStageClickUntil = 0;

function startDrag(ev, el) {
  if (busy || current !== null) return;
  ev.preventDefault();
  const g = el.dataset.g;
  const p = stagePoint(ev);
  drag = { el, g, dx: p.x - el.offsetLeft, dy: p.y - el.offsetTop, zone: null };
  ghostImg.src = el.querySelector('img').src;
  ghost.style.width = el.offsetWidth + 'px';
  ghost.style.height = el.offsetHeight + 'px';
  ghost.classList.add('on');
  el.classList.add('grabbed');
  stage.classList.add('dragging');
  moveDrag(ev);
}

function moveDrag(ev) {
  if (!drag) return;
  const p = stagePoint(ev);
  ghost.style.transform = `translate(${p.x - drag.dx}px, ${p.y - drag.dy}px)`;
  const z = zoneAt(p);
  if (z !== drag.zone) {
    Object.values(DROPS).forEach((d) => d.classList.remove('over'));
    if (z) DROPS[z].classList.add('over');
    drag.zone = z;
  }
}

function endDrag(ev) {
  if (!drag) return;
  const d = drag;
  // read the zone from the release point itself: a fast drag can end without
  // ever emitting a move event
  if (ev && ev.clientX !== undefined) d.zone = zoneAt(stagePoint(ev));
  else d.zone = null;
  drag = null;
  // Browsers dispatch a synthetic click after pointerup. By then `drag` is
  // null, so without this guard a cancelled icon drag landing over a hand is
  // misread as a request for a dap.
  suppressStageClickUntil = performance.now() + 300;
  ghost.classList.remove('on');
  d.el.classList.remove('grabbed');
  stage.classList.remove('dragging');
  Object.values(DROPS).forEach((x) => x.classList.remove('over'));
  hint.classList.remove('on');
  if (d.zone) playRPS(d.zone, d.g[0]);
}

for (const id of ['#ico-rock', '#ico-paper', '#ico-scissors']) {
  const el = $(id);
  el.addEventListener('pointerdown', (e) => startDrag(e, el));
  el.addEventListener('mouseenter', () => { if (!drag && current === null) hint.classList.add('on'); });
  el.addEventListener('mouseleave', () => { if (!drag) hint.classList.remove('on'); });
}
// listen on the window so the drag survives leaving the icon, with or without
// pointer capture
addEventListener('pointermove', moveDrag);
addEventListener('pointerup', endDrag);
addEventListener('pointercancel', endDrag);

/* Anywhere on the landing asks for a dap — the hands, the arms, the black
   around them, the letterbox outside the drawing. It used to be two hand-shaped
   regions, which meant the answer to "what happens if I click this?" was
   sometimes nothing, and nothing is the one answer a page like this should
   never give. The exclusions are what already do something of their own: the
   three navigation words and the campaign titles (`a, button`), and an icon
   just put down, which `suppressStageClickUntil` covers. */
$('#fit').addEventListener('click', async (ev) => {
  if (busy || current !== null || drag || performance.now() < suppressStageClickUntil ||
      ev.target.closest('a, button')) return;
  busy = true;
  // the same return the rest of the site uses, so it settles the same way
  await enterLanding({ dap: true });
  idle();
});

/* ------------------------------------------------------------- idle dap */
/* Left alone, the two of them dap on their own. A minute is long enough that it
   never interrupts someone reading the campaign titles, and short enough that a
   tab left open keeps moving. It is the same dap a click asks for — the whole
   point is that the page is doing what you would have done — and after it the
   clock starts again, so an untouched landing keeps daps coming.

   Any pointer, key or wheel resets the clock, so this only ever plays into an
   empty room. It does not run on a page, under an open project, on a hidden
   tab, or for a viewer who has asked for reduced motion: a dap the visitor did
   not ask for is exactly the motion that preference is about. */
const IDLE_DAP = 60000;
const prefersStillness = matchMedia('(prefers-reduced-motion: reduce)');
let idleTimer = null;

function restartIdle() {
  clearTimeout(idleTimer);
  idleTimer = null;
  if (current !== null || document.hidden || prefersStillness.matches) return;
  idleTimer = setTimeout(idleDap, IDLE_DAP);
}

async function idleDap() {
  idleTimer = null;
  // mid-move, mid-drag or under a project: let whatever is happening finish and
  // ask again a minute after it does
  if (busy || current !== null || drag || document.hidden ||
      project.classList.contains('on')) { restartIdle(); return; }
  busy = true;
  await enterLanding({ dap: true });
  idle();
}

for (const e of ['pointerdown', 'pointermove', 'wheel', 'keydown', 'touchstart']) {
  addEventListener(e, restartIdle, { passive: true });
}
// a backgrounded tab is not an idle visitor, it is no visitor at all
addEventListener('visibilitychange', restartIdle);

async function playRPS(zone, gesture) {
  if (busy) return;
  busy = true;
  ui.classList.add('hidden');
  // the other hand throws at random — a real one in three, every time. Biasing
  // this toward the combinations that have a filmed resolution made the game
  // deterministic, which is worse than sometimes missing the resolution.
  const other = BEATS[Math.floor(Math.random() * 3)];
  const left = zone === 'l' ? gesture : other;
  const right = zone === 'r' ? gesture : other;

  // Omit the widest neutral frame. Landing -> tight -> medium -> RPS crop is a
  // single monotonic pull-back; the same exact bridge runs forwards on return.
  const rpsBridge = SEQ.pita_settle.slice(1);

  // every combination has a filmed round: the throw is held, then the hands act
  // the result out — scissors snip at the palm, the fist closes over the
  // scissors, paper covers the fist, two papers shake on it
  const round = SEQ.rps.round[left + right];
  // The whole round is one continuous move through four sequences. Decoding it
  // now means the count-in cannot stall on the way into the throw.
  const whole = load([...rpsBridge, ...SEQ.rps.pump,
                      ...round.hold, ...round.after, ...round.settle]);

  await play([...rpsBridge].reverse(), TIMING.trans);
  await whole;
  await play(SEQ.rps.pump, TIMING.pump);
  // Keep the thrown gesture moving. A near-one-second freeze here made the
  // game stop dead just as the result appeared. Two additional held beats on
  // the final throw pose now let the result register before the interaction,
  // without adding a new movement or changing the photographed outcome.
  await play(round.hold, TIMING.throw);
  await play([round.hold.at(-1), round.hold.at(-1)], TIMING.throw);
  await play(round.after, TIMING.after);
  await play(round.settle, TIMING.back);
  await play(rpsBridge, TIMING.back, TIMING.back + 60);
  // the bridge ends on the plate; make sure it is the plate that is on screen
  await settleOnLanding();
  ui.classList.remove('hidden');
  idle();
}

/* ----------------------------------------------------------------- wiring */
const back = $('#back');
back.addEventListener('click', goHome);
addEventListener('keydown', (e) => { if (e.key === 'Escape') goHome(); });

/* The hand beckons while it is pointed at — two photographed poses held in
   turn, on the same jittered stop-motion cadence as the frames on the plate,
   rather than a CSS rotation of one drawing.
   Delegated, because the project pages build their own copy of this control
   every time one opens, and a listener bound to the element would go with it.
   The run number is what stops a loop: a pointer that leaves mid-hold bumps it,
   and the loop it belonged to falls out on its next line instead of fighting
   the one that starts on the way back in. */
const BECKONS = '#back, .proj-nav-hands';
let beckonRun = 0;

async function beckon(el) {
  const me = ++beckonRun;
  for (let i = 0; me === beckonRun; i = (i + 1) % BECKON.length) {
    const [frame, hold] = BECKON[i];
    el.dataset.beckon = frame;
    await wait(jitter(hold));
  }
}

function stopBeckon(el) {
  beckonRun++;
  el.dataset.beckon = '0';
}

/* pointerover/out rather than enter/leave: these bubble, which is what makes
   one listener enough. The relatedTarget check drops the crossings between the
   control's own children, which are not entering or leaving anything. */
document.addEventListener('pointerover', (e) => {
  const el = e.target.closest(BECKONS);
  if (el && !el.contains(e.relatedTarget)) beckon(el);
});
document.addEventListener('pointerout', (e) => {
  const el = e.target.closest(BECKONS);
  if (el && !el.contains(e.relatedTarget)) stopBeckon(el);
});
/* it is a button: reaching it by keyboard should wave too */
document.addEventListener('focusin', (e) => {
  const el = e.target.closest(BECKONS);
  if (el) beckon(el);
});
document.addEventListener('focusout', (e) => {
  const el = e.target.closest(BECKONS);
  if (el) stopBeckon(el);
});

document.addEventListener('click', (e) => {
  const a = e.target.closest('a.nav, a.camp');
  if (!a) return;
  e.preventDefault();
  if (a.classList.contains('camp')) pendingCampaignOrigin = a;
  const h = a.getAttribute('href').slice(1);
  if (location.hash.slice(1) === h) route(); else location.hash = h;
});

/* ------------------------------------------------------------------- boot */
(async function boot() {
  fit();
  const [ui_, frames] = await Promise.all([
    fetch('img/ui.json').then((r) => r.json()),
    fetch('img/frames.json').then((r) => r.json()),
  ]);
  cfg = ui_;
  SEQ = frames;
  PAGES = Object.fromEntries(Object.entries(PAGE_DEFS).map(
    ([k, v]) => [k, {
      frames: v.settleKey ? [...SEQ[v.seq], v.key] : SEQ[v.seq],
      key: v.key,
      back: v.back,
      framing: v.framing || 'landing',
    }]));
  buildUI();

  /* Wait for the landing and the one dap that is about to play — around a dozen
     frames — instead of all two hundred. Everything else is fetched behind the
     dap, so the page opens at the speed of what it is actually showing. */
  const first = pickDap();
  await load([LANDING, ...first]);
  await decodeFrame(LANDING).catch(() => {});
  document.body.classList.remove('booting');

  const rest = [LANDING, 'kf_pita_plate', 'kf_salva_plate', 'kf_amp_plate',
                ...SEQ.daps.flat(), ...SEQ.pita, ...SEQ.pita_settle,
                ...SEQ.salva, ...SEQ.amp,
                ...SEQ.rps.pump];
  for (const r of Object.values(SEQ.rps.round)) rest.push(...r.hold, ...r.after, ...r.settle);

  if (location.hash) { show(LANDING); warm(rest); route(); restartIdle(); }
  else {
    const playing = enterLanding({ dap: true, frames: first });
    warm(rest);
    await playing;
  }
})();
