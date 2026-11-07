// Service worker: offline app shell + persistent rest-timer notification.
const CACHE = 'sl55-v3';
const ASSETS = [
  './',
  'index.html',
  'styles.css',
  'js/app.js',
  'js/storage.js',
  'js/timer.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/badge-96.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Stale-while-revalidate for same-origin GET requests.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const key = req.mode === 'navigate' ? 'index.html' : req;
      const cached = await cache.match(key, { ignoreSearch: true });
      const network = fetch(req)
        .then((res) => {
          if (res.ok) cache.put(key, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});

// ============================================================
// Persistent rest-timer notification
// ============================================================
// The page sends {type:'timer-set', endAt, duration, label} / {type:'timer-clear'}.
// While a timer is active the service worker updates the notification every
// second (kept alive with event.waitUntil), so the countdown keeps running
// when the app is in the background. If the user swipes the notification
// away while the timer is active, it is shown again.

const TIMER_TAG = 'rest-timer';
const DONE_TAG = 'rest-done';
const MAX_EVENT_MS = 4.5 * 60 * 1000; // stay under Chrome's 5-minute per-event limit

let timer = null;      // { endAt, duration, label }
let loop = null;       // Promise for the running update loop
let wake = null;       // wakes the loop early after a state change
let notifQueue = Promise.resolve();

const fmt = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const clock = (ts) =>
  new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });

/** Serialize notification operations so a stale update can never land after a close. */
const enqueue = (fn) => (notifQueue = notifQueue.then(fn).catch(() => {}));

const closeTag = (tag) =>
  enqueue(async () => (await self.registration.getNotifications({ tag })).forEach((n) => n.close()));

const showProgress = () =>
  enqueue(async () => {
    if (!timer) return;
    const rem = timer.endAt - Date.now();
    if (rem <= 0) return;
    await self.registration.showNotification(`Rest: ${fmt(rem)} remaining`, {
      tag: TIMER_TAG,
      body: `${timer.label ? timer.label + '\n' : ''}Ends at ${clock(timer.endAt)}`,
      icon: 'icons/icon-192.png',
      badge: 'icons/badge-96.png',
      silent: true,
      renotify: false,
      requireInteraction: true,
      timestamp: timer.endAt,
      actions: [
        { action: 'add30', title: '+30 sec' },
        { action: 'skip', title: 'Skip rest' },
      ],
      data: { kind: 'timer' },
    });
  });

const showDone = (label) =>
  enqueue(() =>
    self.registration.showNotification('Rest over — time to lift! 🏋️', {
      tag: DONE_TAG,
      body: label || 'Start your next set.',
      icon: 'icons/icon-192.png',
      badge: 'icons/badge-96.png',
      renotify: true,
      silent: false,
      vibrate: [300, 120, 300, 120, 300],
      data: { kind: 'done' },
    })
  );

async function broadcast(msg) {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  clients.forEach((c) => c.postMessage(msg));
}

const sleep = (ms) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    wake = () => {
      clearTimeout(t);
      resolve();
    };
  });

async function runLoop() {
  while (timer) {
    const rem = timer.endAt - Date.now();
    if (rem <= 0) {
      const { label } = timer;
      timer = null;
      closeTag(TIMER_TAG);
      showDone(label);
      await notifQueue;
      await broadcast({ type: 'timer-sync', state: null, done: true });
      break;
    }
    showProgress();
    await notifQueue;
    // Wake up right when the displayed second changes.
    await sleep(Math.max(50, ((timer?.endAt ?? 0) - Date.now()) % 1000 || 1000));
  }
  loop = null;
  wake = null;
}

/** Start (or nudge) the update loop and keep the worker alive for it. */
function ensureLoop(event) {
  if (loop) wake?.();
  else loop = runLoop();
  // Each event may only extend the worker's life ~5 min; later events take over.
  event.waitUntil(Promise.race([loop, new Promise((r) => setTimeout(r, MAX_EVENT_MS))]));
}

function setTimer(state, event) {
  if (state && state.endAt > Date.now()) {
    timer = { endAt: state.endAt, duration: state.duration, label: state.label || '' };
    closeTag(DONE_TAG);
    ensureLoop(event);
  } else {
    timer = null;
    wake?.();
    event.waitUntil(closeTag(TIMER_TAG));
  }
}

self.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (msg.type === 'timer-set') setTimer(msg, event);
  else if (msg.type === 'timer-clear') setTimer(null, event);
});

// Keep the notification persistent: re-show it if dismissed while the timer is active.
self.addEventListener('notificationclose', (event) => {
  if (event.notification.tag === TIMER_TAG && timer && timer.endAt > Date.now()) ensureLoop(event);
});

self.addEventListener('notificationclick', (event) => {
  const { action } = event;
  const isTimer = event.notification.data?.kind === 'timer';

  if (isTimer && action === 'add30' && timer) {
    timer = { ...timer, endAt: timer.endAt + 30000, duration: timer.duration + 30000 };
    ensureLoop(event);
    event.waitUntil(broadcast({ type: 'timer-sync', state: timer }));
    return;
  }
  if (isTimer && action === 'skip') {
    setTimer(null, event);
    event.waitUntil(broadcast({ type: 'timer-sync', state: null }));
    return;
  }

  // Tap on the notification body: bring the app to the front (timer notification stays).
  if (!isTimer) event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const client = clients.find((c) => 'focus' in c);
      return client ? client.focus() : self.clients.openWindow('./');
    })
  );
});
