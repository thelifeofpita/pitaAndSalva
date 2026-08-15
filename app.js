/* PITA & SALVA — frame-sequence driven landing page.
   Every visual state is a pre-rendered 1-bit frame; JS only picks which frame
   is on screen and when. Timings are short and slightly irregular on purpose. */

const IMG = 'img/';

/* every sequence comes from img/frames.json, written by the build — so the page
   can never point at a frame that was renamed or dropped */
let SEQ = null;
let PAGES = null;

const LANDING = 'landing_plate';
const PAGE_DEFS = {
  pita:  { seq: 'pita',  key: 'kf_pita' },
  salva: { seq: 'salva', key: 'kf_salva' },
  and:   { seq: 'amp',   key: 'kf_amp_plate', backCentre: true, settleKey: true },
};

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
const src = (name) => `${IMG}${name}.png`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms, amt = 14) => ms + (Math.random() * 2 - 1) * amt;

function show(name) {
  plate.src = src(name);
}

/* Plays a list of frames. The choppiness is the point: a handful of frames,
   each held for a short, slightly uneven beat. `lastHold` lets a move settle on
   its final pose before whatever comes next. */
async function play(frames, hold = TIMING.trans, lastHold = null) {
  for (let i = 0; i < frames.length; i++) {
    show(frames[i]);
    const h = (i === frames.length - 1 && lastHold !== null) ? lastHold : hold;
    await wait(Math.max(40, jitter(h, h * 0.18)));
  }
}

function preload(names) {
  return Promise.all(names.map((n) => new Promise((res) => {
    const i = new Image();
    i.onload = i.onerror = () => res();
    i.src = src(n);
  })));
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
async function enterLanding({ dap = true } = {}) {
  current = null;
  page.classList.remove('on', 'extra', 'top-centre');
  ui.classList.add('hidden');
  if (dap) {
    await play(pickDap(), TIMING.dap, TIMING.dapLast);
  }
  show(LANDING);
  ui.classList.remove('hidden');
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
  await play(p.frames, TIMING.trans, TIMING.transLast);
  pageImg.src = src(p.key);
  page.classList.toggle('top-centre', !!p.backCentre);
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
  const targetY = 85 + h * targetScale / 2;
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
    page.classList.remove('on', 'extra', 'top-centre', 'page-and');
  }

  await Promise.all([titleMove.finished, worldMove.finished,
                     handsMove.finished]).catch(() => {});

  if (!reverse) {
    ui.classList.add('hidden');
    page.classList.remove('top-centre', 'page-and');
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
    campaignReturnOrigin = null;
    current = null;
    busy = false;
    return;
  }
  page.classList.remove('on', 'extra', 'top-centre', 'page-and');
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
  ui.classList.add('hidden');
  await play(pickDap(), TIMING.dap, TIMING.dapLast);
  show(LANDING);
  ui.classList.remove('hidden');
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
  await play([...rpsBridge].reverse(), TIMING.trans);
  await play(SEQ.rps.pump, TIMING.pump);

  // every combination has a filmed round: the throw is held, then the hands act
  // the result out — scissors snip at the palm, the fist closes over the
  // scissors, paper covers the fist, two papers shake on it
  const round = SEQ.rps.round[left + right];
  // Keep the thrown gesture moving. A near-one-second freeze here made the
  // game stop dead just as the result appeared. Two additional held beats on
  // the final throw pose now let the result register before the interaction,
  // without adding a new movement or changing the photographed outcome.
  await play(round.hold, TIMING.throw);
  await play([round.hold.at(-1), round.hold.at(-1)], TIMING.throw);
  await play(round.after, TIMING.after);
  await play(round.settle, TIMING.back);
  await play(rpsBridge, TIMING.back, TIMING.back + 60);
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
      backCentre: v.backCentre,
    }]));
  buildUI();
  const all = [LANDING, 'kf_pita', 'kf_salva', 'kf_amp_plate',
               ...SEQ.daps.flat(), ...SEQ.pita, ...SEQ.pita_settle,
               ...SEQ.salva, ...SEQ.amp,
               ...SEQ.rps.pump];
  for (const r of Object.values(SEQ.rps.round)) all.push(...r.hold, ...r.after, ...r.settle);
  await preload(all);
  document.body.classList.remove('booting');
  if (location.hash) { show(LANDING); route(); }
  else await enterLanding({ dap: true });
})();
