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
  pita:  { seq: 'pita',  key: 'kf_pita',  back: 'left' },
  salva: { seq: 'salva', key: 'kf_salva', back: 'right' },
  and:   { seq: 'amp',   key: 'kf_amp_plate', back: 'bottom', settleKey: true },
};
const CAMPAIGN_BACK = 'top';   // campaign titles sit along the bottom of the landing
/* where the title comes to rest on a campaign page — must match
   `#page-extra .title { top }` in style.css, or the flown title jumps when the
   static one takes over */
const CAMPAIGN_TITLE_TOP = 175;
const BACK_SIDES = ['back-left', 'back-right', 'back-top', 'back-bottom'];

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

const $ = (s) => document.querySelector(s);
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

let painted = null;

function draw(name) {
  const bmp = bmps.get(name);
  if (bmp) { ctx.drawImage(bmp, 0, 0, 1920, 1080); painted = name; return true; }
  const e = store.get(name);
  if (!e || !e.img || !e.img.complete) return false;  // never blank the stage
  // Loaded but not decoded yet: drawing the element decodes it here and now,
  // which costs a few ms but always puts the right frame on screen.
  ctx.drawImage(e.img, 0, 0, 1920, 1080);
  painted = name;
  return true;
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
async function play(frames, hold = TIMING.trans, lastHold = null) {
  if (!frames || !frames.length) return;
  await prime(frames);

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
        show(frames[i]);
        // A backgrounded tab stops raf; on return, run the rest from now rather
        // than flushing the whole backlog into one paint.
        due = (now - due > 900 ? now : due) + holds[i];
        i++;
        if (i >= frames.length) {
          keep = new Set();
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

function fit() {
  const s = Math.min(innerWidth / 1920, innerHeight / 1080);
  document.documentElement.style.setProperty('--scale', s);
}
addEventListener('resize', fit);

/* ------------------------------------------------------------ landing UI */
function buildUI() {
  const a = cfg.assets;
  const put = (el, d) => {
    el.style.left = d.x + 'px';
    el.style.top = d.y + 'px';
    el.style.width = d.w + 'px';
    el.style.height = d.h + 'px';
  };
  put($('#nav-salva'), a.salva);
  put($('#nav-pita'), a.pita);
  put($('#nav-amp'), a.amp);
  put($('#ico-rock'), a.rock);
  put($('#ico-paper'), a.paper);
  put($('#ico-scissors'), a.scissors);

  const wrap = $('#campaigns');
  for (const s of cfg.stars) {
    const i = document.createElement('img');
    i.src = IMG + s.src;
    i.alt = '';
    i.style.cssText = `position:absolute;left:${s.x}px;top:${s.y}px;width:${s.w}px;height:${s.h}px`;
    wrap.appendChild(i);
  }
  for (const c of cfg.campaigns) {
    const b = document.createElement('a');
    b.className = 'camp';
    b.href = '#c/' + c.slug;
    b.title = c.label;
    b.dataset.slug = c.slug;
    b.dataset.label = c.label;
    b.dataset.src = c.src;
    b.style.cssText = `left:${c.x}px;top:${c.y}px;width:${c.w}px;height:${c.h}px`;
    const i = document.createElement('img');
    i.src = IMG + c.src;
    i.alt = c.label;
    i.style.cssText = 'width:100%;height:100%';
    b.appendChild(i);
    wrap.appendChild(b);
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
  page.classList.remove('on', 'extra', 'page-and');
  setBackSide(null);
  ui.classList.add('hidden');
  if (dap) {
    await play(frames || pickDap(), TIMING.dap, TIMING.dapLast);
  }
  await settleOnLanding();
  ui.classList.remove('hidden');
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

async function goPage(id) {
  if (busy || current === id) return;
  busy = true;
  const p = PAGES[id];
  ui.classList.add('hidden');
  // Decode the destination alongside the move, so the last frame of the camera
  // pull-back cuts straight to it instead of flashing the empty page.
  const dest = load([p.key]);
  await play(p.frames, TIMING.trans, TIMING.transLast);
  await dest;
  pageImg.src = src(p.key);
  setBackSide(p.back);
  page.classList.remove('extra', 'page-and');
  page.classList.toggle('page-and', id === 'and');
  page.classList.add('on');
  current = id;
  busy = false;
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
    page.classList.remove('on', 'extra', 'page-and');
    setBackSide(null);
  }

  await Promise.all([titleMove.finished, worldMove.finished,
                     handsMove.finished]).catch(() => {});

  if (!reverse) {
    ui.classList.add('hidden');
    page.classList.remove('page-and');
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
   runs through the same feTurbulence/feDisplacementMap filter, so a plain
   bezier reads as a loose pen stroke instead of vector-perfect line art.
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
const penFilter = (id, seed = 7) => `<filter id="${id}" filterUnits="userSpaceOnUse" x="-20" y="-20" width="220" height="220">
  <feTurbulence type="fractalNoise" baseFrequency="0.045" numOctaves="2" seed="${seed}" result="n"/>
  <feDisplacementMap in="SourceGraphic" in2="n" scale="2.6"/>
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
   icons are laid out in on the landing, deduplicated (the landing repeats
   some campaigns across its two star layers). Prev/next walk this ring and
   wrap, so "move through all the projects" never dead-ends at an edge. */
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
          <img class="hand h-salva-v" src="${IMG}ui/hand_salva_v.png" alt="">
          <img class="hand h-pita-v" src="${IMG}ui/hand_pita_v.png" alt="">
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
  const descArrow = `<svg viewBox="0 0 74 31"><defs>${penFilter('bisRough1')}</defs>
    <path d="M3 17C11 6 22 2 33 4C47 7 55 13 60 19" ${pen('bisRough1')}/>
    ${headV('bisRough1', 68, 27, 45, 22, 70, 3)}
  </svg>`;

  const printsArrow = `<svg viewBox="0 0 79 117"><defs>${penFilter('bisRough2')}</defs>
    <path d="M75 3C58 1 22 6 8 34C1 52 12 82 30 98" ${pen('bisRough2')}/>
    ${headV('bisRough2', 45, 113, 22, 108, 47, 89)}
  </svg>`;

  const arrowLeft = `<svg viewBox="0 0 94 33"><defs>${penFilter('bisRough3')}</defs>
    <path d="M24 16.5H91" ${pen('bisRough3')}/>
    ${headV('bisRough3', 3, 16.5, 23, 3, 23, 30)}
  </svg>`;
  const arrowRight = `<svg viewBox="0 0 94 33"><defs>${penFilter('bisRough4')}</defs>
    <path d="M3 16.5H70" ${pen('bisRough4')}/>
    ${headV('bisRough4', 91, 16.5, 71, 3, 71, 30)}
  </svg>`;

  const tapArrow = `<svg class="bis-arrow-down" viewBox="0 0 54 91"><defs>${penFilter('bisRough5')}</defs>
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
  const caseArrow = `<svg viewBox="0 0 74 31"><defs>${penFilter('npRough1')}</defs>
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
  const jamArrow = `<svg viewBox="0 0 74 31"><defs>${penFilter('npRough3', 11)}</defs>
    <path d="M3 5C12 12 20 15 30 15C42 15 53 19 62 24" ${pen('npRough3')}/>
    ${headV('npRough3', 69, 30, 56, 28, 67, 17)}
  </svg>`;

  /* Points sideways, not down: the copy it trails sits to the left of the
     product rather than above it, so this one runs almost flat and lifts
     slightly into its head. Its own seed again, so three arrows in the same
     box on one page don't wear the same wobble. */
  const padArrow = `<svg viewBox="0 0 74 31"><defs>${penFilter('npRough6', 23)}</defs>
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
  const tryArrow = `<svg viewBox="0 0 150 90"><defs>${penFilter('npRough5', 19)}</defs>
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
  const shopArrow = `<svg viewBox="0 0 410 70"><defs>${npFilterWide}</defs>
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
  current = 'c/' + slug;
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
  busy = false;
}

async function goCampaign(slug, origin = null) {
  if (busy) return;
  busy = true;
  const c = cfg.campaigns.find((x) => x.slug === slug &&
    (!origin || x.src === origin.dataset.src)) ||
    cfg.campaigns.find((x) => x.slug === slug);
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
  busy = false;
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
    busy = false;
    return;
  }
  page.classList.remove('on', 'extra', 'page-and');
  setBackSide(null);
  if (PAGES[id]) {
    await play([...PAGES[id].frames].reverse(), TIMING.trans, TIMING.transLast);
  }
  await enterLanding({ dap: false });
  busy = false;
}

/* leaving a page always comes back through here, so the hash is cleared once
   and goBack() can never be kicked off twice */
function goHome() {
  if (location.hash) history.replaceState(null, '', location.pathname);
  goBack();
}

function route() {
  const h = location.hash.replace(/^#/, '');
  if (!h) { if (current !== null) goHome(); return; }
  if (PAGES[h]) { goPage(h); return; }
  if (h.startsWith('c/')) {
    const origin = pendingCampaignOrigin;
    pendingCampaignOrigin = null;
    goCampaign(h.slice(2), origin);
  }
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

function landingHandAt(p) {
  // Hand-shaped hit regions, deliberately stopping before the navigation and
  // campaign artwork. The arms alone and the black centre gap do not trigger.
  const left = p.x >= 315 && p.x <= 935 && p.y >= 250 && p.y <= 725;
  const right = p.x >= 975 && p.x <= 1650 && p.y >= 205 && p.y <= 745;
  return left || right;
}

stage.addEventListener('click', async (ev) => {
  if (busy || current !== null || drag || performance.now() < suppressStageClickUntil ||
      ev.target.closest('a, button')) return;
  if (!landingHandAt(stagePoint(ev))) return;
  busy = true;
  // the same return the rest of the site uses, so it settles the same way
  await enterLanding({ dap: true });
  busy = false;
});

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
  busy = false;
}

/* ----------------------------------------------------------------- wiring */
$('#back').addEventListener('click', goHome);
addEventListener('keydown', (e) => { if (e.key === 'Escape') goHome(); });

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
    }]));
  buildUI();

  /* Wait for the landing and the one dap that is about to play — around a dozen
     frames — instead of all two hundred. Everything else is fetched behind the
     dap, so the page opens at the speed of what it is actually showing. */
  const first = pickDap();
  await load([LANDING, ...first]);
  await decodeFrame(LANDING).catch(() => {});
  document.body.classList.remove('booting');

  const rest = [LANDING, 'kf_pita', 'kf_salva', 'kf_amp_plate',
                ...SEQ.daps.flat(), ...SEQ.pita, ...SEQ.pita_settle,
                ...SEQ.salva, ...SEQ.amp,
                ...SEQ.rps.pump];
  for (const r of Object.values(SEQ.rps.round)) rest.push(...r.hold, ...r.after, ...r.settle);

  if (location.hash) { show(LANDING); warm(rest); route(); }
  else {
    const playing = enterLanding({ dap: true, frames: first });
    warm(rest);
    await playing;
  }
})();
