/* PITA & SALVA — frame-sequence driven landing page.
   Every visual state is a pre-rendered 1-bit frame; JS only picks which frame
   is on screen and when. Timings are short and slightly irregular on purpose. */

const IMG = 'img/';

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

let cfg = null;
let busy = false;
let current = null;          // null on landing, else a page id
let pendingCampaignOrigin = null;
let campaignReturnOrigin = null;

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

async function campaignDepthTransition(origin, reverse = false) {
  if (!origin) return;
  const image = origin.querySelector('img');
  if (!image) return;

  const x = origin.offsetLeft;
  const y = origin.offsetTop;
  const w = origin.offsetWidth;
  const h = origin.offsetHeight;
  const targetScale = 1.7;
  const targetX = 960;
  const targetY = CAMPAIGN_TITLE_TOP + h * targetScale / 2;
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
  const stops = [0, .08, .17, .27, .38, .50, .63, .76, .88, 1];
  const pose = (t) => t * t * (3 - 2 * t);
  const stepped = (frame) => ({ ...frame, easing: 'steps(1, end)' });
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
    duration: 470,
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
  }
  for (const animation of [titleMove, worldMove, handsMove]) animation.cancel();
  flying.remove();
  origin.style.visibility = '';
  plate.style.zIndex = '';
  plate.style.mixBlendMode = '';
  plate.style.transformOrigin = '';
  ui.style.transformOrigin = '';
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
  pageExtra.innerHTML =
    `<div class="title"><img src="${IMG}${c.src}" alt="${c.label}"></div>` +
    '<div class="soon">COMING SOON</div>';
  await campaignDepthTransition(origin);
  current = 'c/' + slug;
  busy = false;
}

async function goBack() {
  if (busy || current === null) return;
  busy = true;
  const id = current;
  if (id.startsWith('c/')) {
    const slug = id.slice(2);
    const origin = campaignReturnOrigin ||
      document.querySelector(`.camp[data-slug="${slug}"]`);
    await campaignDepthTransition(origin, true);
    await settleOnLanding();
    campaignReturnOrigin = null;
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
