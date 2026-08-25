/* PITA & SALVA — offline frame cache.

   The whole site is a frame sequence: a dap holds each drawing for ~132ms, so a
   frame that arrives late does not arrive at all. GitHub Pages serves every file
   with `cache-control: max-age=600`, which means that ten minutes after a visit
   the browser has to revalidate each of the 200 frames over the network before
   it can paint it. That is what makes playback stutter online and fine locally.

   This worker takes the frames out of the HTTP cache and into Cache Storage,
   where `max-age` does not apply. After the first visit a frame is a memory
   read, at any age, on any connection, including none.

   Bump VERSION after rebuilding frames to force every client onto the new art in
   one step. Without a bump the stale-while-revalidate path below still picks up
   changes, just one visit later. */
const VERSION = 'pitalva-v50';
const CACHE = VERSION;

/* Enough to boot and play the first dap. The rest of the frames land in the
   cache as the page asks for them. */
const CORE = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './img/ui.json',
  './img/frames.json',
  './img/landing_plate.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // Individually, so one missing file cannot fail the whole install.
    await Promise.all(CORE.map((u) => c.add(new Request(u, { cache: 'reload' }))
      .catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

/* Cache first, then refresh in the background.

   Playback never waits on the network: a cached frame is returned immediately
   and the copy on disk is updated behind it for next time. Only a frame that has
   never been seen goes to the network on the critical path. */
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: false });

    // `reload` bypasses the browser's own HTTP cache, not just this worker's
    // Cache Storage — without it a revalidation here can silently hand back
    // the browser's own stale copy of a URL whose bytes changed, and Cache
    // Storage happily overwrites itself with that same stale response.
    const fresh = fetch(req, { cache: 'reload' }).then((res) => {
      // Opaque and error responses would poison the cache for a frame that is
      // currently playing fine from it.
      if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
      return res;
    }).catch(() => null);

    if (hit) {
      e.waitUntil(fresh);
      return hit;
    }

    const res = await fresh;
    if (res) return res;

    // Offline and never cached. For a navigation, the shell is better than the
    // browser's error page — every frame it needs may well be in the cache.
    if (req.mode === 'navigate') {
      const shell = await cache.match('./index.html');
      if (shell) return shell;
    }
    return new Response('', { status: 504, statusText: 'offline' });
  })());
});

/* The page asks for the rest of the frames once it is interactive, so warming
   the cache never competes with the first dap for bandwidth. */
self.addEventListener('message', (e) => {
  const data = e.data;
  if (!data || data.type !== 'warm' || !Array.isArray(data.urls)) return;
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    for (const u of data.urls) {
      try {
        if (await cache.match(u)) continue;
        const res = await fetch(u, { cache: 'reload' });
        if (res && res.ok && res.type === 'basic') await cache.put(u, res.clone());
      } catch (err) { /* a frame that fails here is retried by the page */ }
    }
  })());
});
