// Rest timer (page side).
//
// The timer is based on an absolute end timestamp, so it stays accurate even
// if the page is throttled while in the background. State is mirrored to
// localStorage so a reload resumes a running timer.
//
// The persistent system notification is owned by the service worker (see
// sw.js): this module only tells it when the timer starts/changes/stops, and
// the service worker keeps the notification counting down even when Android
// backgrounds or freezes the page. Notification actions (+30s / Skip) are
// applied by the service worker and synced back here via `applyRemote`.

const STATE_KEY = 'sl55-timer';

export const fmt = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

async function postToServiceWorker(msg) {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    (reg.active || navigator.serviceWorker.controller)?.postMessage(msg);
  } catch { /* ignore */ }
}

export class RestTimer {
  constructor({ onTick, onDone, onStop }) {
    this.onTick = onTick;
    this.onDone = onDone;
    this.onStop = onStop;
    this.endAt = null;
    this.duration = 0;
    this.label = '';
    this._interval = null;
  }

  get running() {
    return this.endAt !== null;
  }

  remaining() {
    return this.endAt ? Math.max(0, this.endAt - Date.now()) : 0;
  }

  start(seconds, label = '') {
    this.duration = seconds * 1000;
    this.endAt = Date.now() + this.duration;
    this.label = label;
    this._persist();
    this._sync();
    this._loop();
  }

  add(seconds) {
    if (!this.running) return;
    this.endAt += seconds * 1000;
    this.duration += seconds * 1000;
    this._persist();
    this._sync();
    this._tick();
  }

  stop() {
    const wasRunning = this.running;
    this._clear();
    postToServiceWorker({ type: 'timer-clear' });
    if (wasRunning) this.onStop?.();
  }

  /** Resume a timer saved before a reload (and re-sync the notification). */
  restore() {
    try {
      const s = JSON.parse(localStorage.getItem(STATE_KEY) || 'null');
      if (s && s.endAt > Date.now()) {
        Object.assign(this, { endAt: s.endAt, duration: s.duration, label: s.label });
        this._sync();
        this._loop();
        return;
      }
    } catch { /* ignore */ }
    localStorage.removeItem(STATE_KEY);
    postToServiceWorker({ type: 'timer-clear' }); // remove any stale notification
  }

  /** Refresh UI and re-send state to the service worker (e.g. page became visible). */
  refresh() {
    if (!this.running) return;
    this._sync();
    this._tick();
  }

  /** Apply a state change made by the service worker (notification actions / expiry). */
  applyRemote(state, { done = false } = {}) {
    if (state && state.endAt > Date.now()) {
      Object.assign(this, { endAt: state.endAt, duration: state.duration, label: state.label });
      this._persist();
      this._loop();
    } else if (this.running) {
      if (done) this._finish();
      else {
        this._clear();
        this.onStop?.();
      }
    }
  }

  // ---------- internals ----------
  _sync() {
    postToServiceWorker({
      type: 'timer-set',
      endAt: this.endAt,
      duration: this.duration,
      label: this.label,
    });
  }

  _persist() {
    localStorage.setItem(
      STATE_KEY,
      JSON.stringify({ endAt: this.endAt, duration: this.duration, label: this.label })
    );
  }

  _clear() {
    clearInterval(this._interval);
    this._interval = null;
    this.endAt = null;
    localStorage.removeItem(STATE_KEY);
  }

  _loop() {
    clearInterval(this._interval);
    this._interval = setInterval(() => this._tick(), 250);
    this._tick();
  }

  _finish() {
    const label = this.label;
    this._clear();
    this.onDone?.(label);
  }

  _tick() {
    if (!this.running) return;
    const rem = this.remaining();
    if (rem <= 0) this._finish(); // the service worker shows the "rest over" notification
    else this.onTick?.(rem, this.duration, this.label);
  }
}
