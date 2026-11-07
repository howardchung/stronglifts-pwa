import { Storage, fsSupported } from './storage.js';
import { RestTimer, fmt } from './timer.js';

// ============================================================
// Data model
// ============================================================
const uid = () =>
  crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36);

const tplEx = (name, sets, reps, increment, startWeight) => ({
  id: uid(), name, sets, reps, increment, startWeight,
});

const defaultData = () => ({
  version: 1,
  settings: { restSeconds: 90, onlyIncreaseOnSuccess: true, barWeight: 45 },
  templates: {
    A: [tplEx('Squat', 5, 5, 5, 45), tplEx('Bench Press', 5, 5, 5, 45), tplEx('Barbell Row', 5, 5, 5, 65)],
    B: [tplEx('Squat', 5, 5, 5, 45), tplEx('Overhead Press', 5, 5, 5, 45), tplEx('Deadlift', 1, 5, 5, 95)],
  },
  overrides: {}, // exerciseKey -> weight to use for the next workout
  workouts: [],  // { id, date, type, startedAt, finishedAt, exercises: [...] }
});

function normalize(d) {
  const def = defaultData();
  if (!d || typeof d !== 'object') return def;
  return {
    version: 1,
    settings: { ...def.settings, ...(d.settings || {}) },
    templates: {
      A: Array.isArray(d.templates?.A) ? d.templates.A : def.templates.A,
      B: Array.isArray(d.templates?.B) ? d.templates.B : def.templates.B,
    },
    overrides: d.overrides && typeof d.overrides === 'object' ? d.overrides : {},
    workouts: Array.isArray(d.workouts) ? d.workouts : [],
  };
}

const keyOf = (name) => name.trim().toLowerCase();
const pad = (n) => String(n).padStart(2, '0');
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const formatDate = (s) =>
  new Date(s + 'T12:00:00').toLocaleDateString([], {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  });
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const num = (v, fallback) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
};
const round = (n) => Math.round(n * 100) / 100;

// ============================================================
// State
// ============================================================
const store = new Storage();
let data = defaultData();
let tab = 'today';
let pendingType = null; // user-selected A/B override before starting

const $ = (sel) => document.querySelector(sel);
const view = $('#view');
const modal = $('#modal');

const timer = new RestTimer({
  onTick: (rem, dur, label) => renderTimer(rem, dur, label),
  onDone: () => {
    hideTimer();
    navigator.vibrate?.([300, 120, 300]);
    beep();
    toast('Rest over — time for your next set!');
  },
  onStop: () => hideTimer(),
});

// ============================================================
// Domain logic
// ============================================================
const sortedWorkouts = () =>
  [...data.workouts].sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));

const currentWorkout = () => data.workouts.find((w) => !w.finishedAt) || null;

function nextType() {
  const last = sortedWorkouts().find((w) => w.finishedAt);
  return last ? (last.type === 'A' ? 'B' : 'A') : 'A';
}

function lastPerformance(name) {
  const k = keyOf(name);
  for (const w of sortedWorkouts()) {
    if (!w.finishedAt) continue;
    const ex = w.exercises.find((e) => keyOf(e.name) === k);
    if (ex) return ex;
  }
  return null;
}

const isSuccess = (ex) => ex.results.every((r) => r !== null && r >= ex.reps);

/** Weight suggested by history alone (ignores manual overrides). */
function historyWeight(t) {
  const last = lastPerformance(t.name);
  if (!last) return t.startWeight;
  const inc = num(t.increment, 5);
  return isSuccess(last) || !data.settings.onlyIncreaseOnSuccess ? round(last.weight + inc) : last.weight;
}

function nextWeight(t) {
  const o = data.overrides[keyOf(t.name)];
  return o != null ? o : historyWeight(t);
}

function plates(weight) {
  const bar = num(data.settings.barWeight, 45);
  if (weight <= bar) return 'Empty bar';
  let side = (weight - bar) / 2;
  const out = [];
  for (const p of [45, 35, 25, 10, 5, 2.5]) {
    while (side >= p - 1e-9) {
      out.push(p);
      side -= p;
    }
  }
  return `Per side: ${out.join(', ')}${side > 0.01 ? ` (+${round(side)})` : ''}`;
}

function startWorkout(type) {
  const consumed = {};
  const exercises = data.templates[type].map((t) => {
    const k = keyOf(t.name);
    if (data.overrides[k] != null) consumed[k] = data.overrides[k];
    return {
      name: t.name,
      sets: t.sets,
      reps: t.reps,
      increment: num(t.increment, 5),
      weight: nextWeight(t),
      results: Array(t.sets).fill(null),
    };
  });
  Object.keys(consumed).forEach((k) => delete data.overrides[k]);
  data.workouts.push({
    id: uid(),
    date: todayStr(),
    type,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    consumedOverrides: consumed,
    exercises,
  });
  pendingType = null;
  persist();
  render();
}

function nextPendingSet(w) {
  for (const ex of w.exercises) {
    const j = ex.results.findIndex((r) => r === null);
    if (j !== -1) return `Next: ${ex.name} — set ${j + 1}/${ex.sets} @ ${ex.weight} lb`;
  }
  return '';
}

function tapSet(exIdx, setIdx) {
  const w = currentWorkout();
  if (!w) return;
  const ex = w.exercises[exIdx];
  const r = ex.results[setIdx];
  // Cycle: empty -> target reps (done) -> reps-1 ... -> 0 -> empty
  const next = r === null ? ex.reps : r > 0 ? r - 1 : null;
  ex.results[setIdx] = next;
  persist();

  if (next !== null) {
    const allDone = w.exercises.every((e) => e.results.every((x) => x !== null));
    if (allDone) timer.stop();
    else timer.start(num(data.settings.restSeconds, 90), nextPendingSet(w));
  }
  render();
}

function finishWorkout() {
  const w = currentWorkout();
  if (!w) return;
  const missing = w.exercises.reduce((n, e) => n + e.results.filter((r) => r === null).length, 0);
  if (missing && !confirm(`${missing} set(s) not logged. Finish anyway? Unlogged sets count as missed.`)) return;
  w.finishedAt = new Date().toISOString();
  delete w.consumedOverrides;
  timer.stop();
  persist();
  render();
  toast('Workout saved 💪');
}

function discardWorkout() {
  const w = currentWorkout();
  if (!w || !confirm('Discard this workout? Logged sets will be lost.')) return;
  Object.assign(data.overrides, w.consumedOverrides || {});
  data.workouts = data.workouts.filter((x) => x !== w);
  timer.stop();
  persist();
  render();
}

// ============================================================
// Persistence
// ============================================================
async function persist() {
  try {
    await store.save(data);
    renderStorageIndicator();
  } catch (err) {
    console.error(err);
    renderStorageIndicator();
    showBanner(
      store.status === 'needs-permission'
        ? 'Lost access to your data file. Changes are cached locally.'
        : `Could not save to file: ${err.message}`,
      store.status === 'needs-permission' ? { label: 'Reconnect', action: 'storage-resave' } : null
    );
  }
}

// ============================================================
// Rendering
// ============================================================
function render() {
  document.querySelectorAll('.tabs button').forEach((b) =>
    b.classList.toggle('active', b.dataset.tab === tab)
  );
  $('#title').textContent = { today: 'Today', history: 'History', settings: 'Settings' }[tab];
  view.innerHTML =
    tab === 'today' ? renderToday() : tab === 'history' ? renderHistory() : renderSettings();
  renderStorageIndicator();
}

function renderToday() {
  const w = currentWorkout();
  if (w) return renderWorkout(w);

  const rotation = nextType();
  const type = pendingType ?? rotation;
  const exs = data.templates[type];
  const doneToday = data.workouts.filter((x) => x.finishedAt && x.date === todayStr());

  const rows = exs
    .map((t) => {
      const wgt = nextWeight(t);
      const last = lastPerformance(t.name);
      let hint = '';
      if (data.overrides[keyOf(t.name)] != null) hint = '<span class="tag">custom</span>';
      else if (last && wgt > last.weight) hint = `<span class="tag up">+${round(wgt - last.weight)}</span>`;
      else if (last && wgt === last.weight) hint = '<span class="tag">repeat</span>';
      return `<li><span>${esc(t.name)}</span><span class="muted">${t.sets}×${t.reps}</span><span class="w">${wgt} lb ${hint}</span></li>`;
    })
    .join('');

  return `
    ${doneToday.length ? `<div class="card success">✓ Workout ${doneToday.map((x) => x.type).join(' & ')} completed today. Nice work!</div>` : ''}
    <section class="card">
      <div class="row between">
        <h2>Workout ${type}</h2>
        <div class="seg" role="group" aria-label="Workout type">
          ${['A', 'B'].map((t) => `<button class="${t === type ? 'on' : ''}" data-action="pick-type" data-type="${t}">${t}</button>`).join('')}
        </div>
      </div>
      <p class="muted small">${formatDate(todayStr())}${type !== rotation ? ` · Rotation says Workout ${rotation}` : ' · Next in rotation'}</p>
      ${exs.length
        ? `<ul class="preview">${rows}</ul>
           <button class="btn primary block" data-action="start-workout" data-type="${type}">Start Workout ${type}</button>`
        : `<p class="empty">No exercises in Workout ${type}. Add some in <a href="#" data-action="goto" data-tab="settings">Settings</a>.</p>`}
    </section>`;
}

function renderWorkout(w) {
  const total = w.exercises.reduce((n, e) => n + e.sets, 0);
  const done = w.exercises.reduce((n, e) => n + e.results.filter((r) => r !== null).length, 0);
  const exHtml = w.exercises
    .map(
      (ex, i) => `
      <section class="card exercise">
        <div class="row between">
          <h3>${esc(ex.name)}</h3>
          <button class="weight-btn" data-action="edit-weight" data-ex="${i}" aria-label="Edit weight">${ex.weight} lb <span aria-hidden="true">✎</span></button>
        </div>
        <p class="muted small">${ex.sets}×${ex.reps} · ${plates(ex.weight)}</p>
        <div class="sets">
          ${ex.results
            .map((r, j) => {
              const cls = r === null ? 'pending' : r >= ex.reps ? 'done' : 'fail';
              return `<button class="set ${cls}" data-action="set-tap" data-ex="${i}" data-set="${j}" aria-label="Set ${j + 1}: ${r === null ? 'not done' : r + ' reps'}">${r === null ? ex.reps : r}</button>`;
            })
            .join('')}
        </div>
      </section>`
    )
    .join('');

  return `
    <section class="card row between">
      <div>
        <h2>Workout ${w.type}</h2>
        <p class="muted small">${formatDate(w.date)}${w.date !== todayStr() ? ' · unfinished from a previous day' : ''}</p>
      </div>
      <span class="pill">${done}/${total} sets</span>
    </section>
    <p class="hint">Tap a set when complete. Tap again to lower reps if you missed.</p>
    ${exHtml}
    <div class="actions">
      <button class="btn primary block" data-action="finish-workout">Finish Workout</button>
      <button class="btn ghost danger block" data-action="discard-workout">Discard</button>
    </div>`;
}

function renderHistory() {
  const list = sortedWorkouts();
  if (!list.length) return `<p class="empty">No workouts recorded yet.<br>Start one from the Today tab.</p>`;
  const finished = list.filter((w) => w.finishedAt).length;
  return `
    <p class="muted small center">${finished} workout${finished === 1 ? '' : 's'} completed</p>
    ${list
      .map(
        (w) => `
      <article class="card hist">
        <div class="row between">
          <div class="row gap"><span class="badge">${w.type}</span><b>${formatDate(w.date)}</b>${w.finishedAt ? '' : '<span class="tag">in progress</span>'}</div>
          <button class="icon-btn" data-action="delete-workout" data-id="${w.id}" aria-label="Delete workout">🗑</button>
        </div>
        <ul>
          ${w.exercises
            .map(
              (e) => `<li>
                <span>${esc(e.name)}</span>
                <span class="muted">${e.weight} lb</span>
                <span class="reps ${w.finishedAt ? (isSuccess(e) ? 'ok' : 'miss') : ''}">${e.results.map((r) => (r === null ? '–' : r)).join(' ')}</span>
              </li>`
            )
            .join('')}
        </ul>
      </article>`
      )
      .join('')}`;
}

function renderTemplate(type) {
  const list = data.templates[type];
  return `
    <section class="card">
      <h2>Workout ${type}</h2>
      <ul class="tpl">
        ${list
          .map(
            (t, i) => `<li>
              <button class="tpl-main" data-action="tpl-edit" data-type="${type}" data-idx="${i}">
                <b>${esc(t.name)}</b>
                <span class="muted small">${t.sets}×${t.reps} · next ${nextWeight(t)} lb · +${num(t.increment, 5)}/workout</span>
              </button>
              <div class="tpl-ctl">
                <button class="icon-btn" data-action="tpl-move" data-type="${type}" data-idx="${i}" data-dir="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move up">▲</button>
                <button class="icon-btn" data-action="tpl-move" data-type="${type}" data-idx="${i}" data-dir="1" ${i === list.length - 1 ? 'disabled' : ''} aria-label="Move down">▼</button>
                <button class="icon-btn" data-action="tpl-del" data-type="${type}" data-idx="${i}" aria-label="Remove">✕</button>
              </div>
            </li>`
          )
          .join('') || '<li class="muted small">No exercises</li>'}
      </ul>
      <button class="btn ghost block" data-action="tpl-add" data-type="${type}">+ Add exercise</button>
    </section>`;
}

function renderSettings() {
  const s = data.settings;
  const notif = 'Notification' in window ? Notification.permission : 'unsupported';
  const storageDesc =
    store.mode === 'file'
      ? `Data file: <b>${esc(store.fileName || 'unknown')}</b>${store.status !== 'ok' ? ' <span class="tag warn">needs permission</span>' : ''}`
      : store.mode === 'local'
        ? 'Browser storage (on this device only)'
        : 'Not configured';

  return `
    ${renderTemplate('A')}
    ${renderTemplate('B')}
    <section class="card">
      <h2>Training</h2>
      <label class="field"><span>Rest timer (seconds)</span>
        <input type="number" inputmode="numeric" min="10" max="900" step="5" data-setting="restSeconds" value="${s.restSeconds}"></label>
      <label class="field"><span>Bar weight (lb)</span>
        <input type="number" inputmode="decimal" min="0" step="2.5" data-setting="barWeight" value="${s.barWeight}"></label>
      <label class="field toggle"><span>Only add weight when all sets &amp; reps were completed</span>
        <input type="checkbox" data-setting="onlyIncreaseOnSuccess" ${s.onlyIncreaseOnSuccess ? 'checked' : ''}></label>
    </section>
    <section class="card">
      <h2>Notifications</h2>
      <p class="small">${
        notif === 'granted' ? 'Enabled — the rest timer shows a notification with time remaining.'
        : notif === 'denied' ? 'Blocked. Enable notifications for this site in your browser settings.'
        : notif === 'unsupported' ? 'Not supported in this browser.'
        : 'Allow notifications to see the rest timer outside the app.'}</p>
      ${notif === 'default' ? '<button class="btn ghost block" data-action="notif-enable">Enable notifications</button>' : ''}
    </section>
    <section class="card">
      <h2>Storage</h2>
      <p class="small">${storageDesc}</p>
      ${fsSupported
        ? `<button class="btn ghost block" data-action="storage-new">Save to a new file…</button>
           <button class="btn ghost block" data-action="storage-open">Open an existing data file…</button>
           ${store.mode === 'file' && store.status !== 'ok' ? '<button class="btn ghost block" data-action="storage-resave">Reconnect file</button>' : ''}
           ${store.mode !== 'local' ? '<button class="btn ghost block" data-action="storage-local">Use browser storage instead</button>' : ''}`
        : '<p class="muted small">This browser cannot access the file system directly. Use Export/Import to back up your data.</p>'}
      <div class="row gap">
        <button class="btn ghost grow" data-action="export">Export JSON</button>
        <button class="btn ghost grow" data-action="import">Import JSON</button>
      </div>
    </section>
    <p class="muted small center">Stronglifts 5×5 tracker · data never leaves your device</p>`;
}

function renderStorageIndicator() {
  const el = $('#storage-indicator');
  if (store.mode === 'file') {
    el.textContent = store.status === 'ok' ? `📄 ${store.fileName}` : '⚠️ File disconnected';
    el.classList.toggle('warn', store.status !== 'ok');
  } else {
    el.textContent = store.mode === 'local' ? '📱 Browser' : '⚠️ No storage';
    el.classList.toggle('warn', !store.mode);
  }
}

// ---------- Timer bar ----------
function renderTimer(rem, dur, label) {
  const bar = $('#timer');
  bar.hidden = false;
  document.body.classList.add('timer-on');
  $('#timer-time').textContent = fmt(rem);
  $('#timer-label').textContent = label || 'Rest';
  $('#timer-progress').style.transform = `scaleX(${dur ? rem / dur : 0})`;
}
function hideTimer() {
  $('#timer').hidden = true;
  document.body.classList.remove('timer-on');
}

// ---------- Banner / toast ----------
function showBanner(msg, btn) {
  const el = $('#banner');
  el.innerHTML = `<span>${esc(msg)}</span>${btn ? `<button class="btn small" data-action="${btn.action}">${esc(btn.label)}</button>` : ''}<button class="icon-btn" data-action="banner-close" aria-label="Dismiss">✕</button>`;
  el.hidden = false;
}
const hideBanner = () => ($('#banner').hidden = true);

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.25, 0.5].forEach((t) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.25, ctx.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.2);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + t);
      o.stop(ctx.currentTime + t + 0.2);
    });
  } catch { /* ignore */ }
}

// ============================================================
// Modals
// ============================================================
function openModal(html, { locked = false } = {}) {
  modal.innerHTML = html;
  modal.dataset.locked = locked ? '1' : '';
  if (!modal.open) modal.showModal();
}
function closeModal() {
  modal.dataset.locked = '';
  if (modal.open) modal.close();
}
modal.addEventListener('cancel', (e) => {
  if (modal.dataset.locked) e.preventDefault();
});
modal.addEventListener('click', (e) => {
  // tap on backdrop closes (when not locked)
  if (e.target === modal && !modal.dataset.locked) closeModal();
});

function weightModal(exIdx) {
  const w = currentWorkout();
  const ex = w.exercises[exIdx];
  const inc = num(ex.increment, 5);
  openModal(`
    <form class="sheet" id="weight-form">
      <h2>${esc(ex.name)}</h2>
      <div class="stepper">
        <button type="button" class="btn round" data-step="-${inc}">−${inc}</button>
        <input id="weight-input" type="number" inputmode="decimal" step="any" min="0" value="${ex.weight}" aria-label="Weight in lb">
        <button type="button" class="btn round" data-step="${inc}">+${inc}</button>
      </div>
      <p class="muted small center" id="plate-info">${plates(ex.weight)}</p>
      <div class="row gap">
        <button type="button" class="btn ghost grow" data-action="modal-close">Cancel</button>
        <button type="submit" class="btn primary grow">Save</button>
      </div>
    </form>`);
  const input = $('#weight-input');
  const update = () => ($('#plate-info').textContent = plates(num(input.value, 0)));
  input.addEventListener('input', update);
  modal.querySelectorAll('[data-step]').forEach((b) =>
    b.addEventListener('click', () => {
      input.value = Math.max(0, round(num(input.value, 0) + num(b.dataset.step, 0)));
      update();
    })
  );
  $('#weight-form').onsubmit = (e) => {
    e.preventDefault();
    ex.weight = Math.max(0, round(num(input.value, ex.weight)));
    closeModal();
    persist();
    render();
  };
}

function templateModal(type, idx) {
  const editing = idx != null;
  const t = editing ? data.templates[type][idx] : { name: '', sets: 5, reps: 5, increment: 5, startWeight: 45 };
  const allNames = [...new Set([...data.templates.A, ...data.templates.B].map((x) => x.name))];
  openModal(`
    <form class="sheet" id="tpl-form">
      <h2>${editing ? 'Edit' : 'Add'} exercise · Workout ${type}</h2>
      <label class="field"><span>Name</span>
        <input name="name" required maxlength="40" list="ex-names" value="${esc(t.name)}" placeholder="e.g. Chin-ups"></label>
      <datalist id="ex-names">${allNames.map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
      <div class="grid2">
        <label class="field"><span>Sets</span><input name="sets" type="number" inputmode="numeric" min="1" max="20" required value="${t.sets}"></label>
        <label class="field"><span>Reps</span><input name="reps" type="number" inputmode="numeric" min="1" max="50" required value="${t.reps}"></label>
        <label class="field"><span>Next weight (lb)</span><input name="weight" type="number" inputmode="decimal" step="any" min="0" required value="${editing ? nextWeight(t) : t.startWeight}"></label>
        <label class="field"><span>Increase / workout</span><input name="increment" type="number" inputmode="decimal" step="any" min="0" required value="${num(t.increment, 5)}"></label>
      </div>
      <div class="row gap">
        <button type="button" class="btn ghost grow" data-action="modal-close">Cancel</button>
        <button type="submit" class="btn primary grow">Save</button>
      </div>
    </form>`);
  $('#tpl-form').onsubmit = (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const name = String(f.get('name')).trim();
    if (!name) return;
    const next = {
      ...(editing ? t : { id: uid() }),
      name,
      sets: Math.max(1, Math.round(num(f.get('sets'), 5))),
      reps: Math.max(1, Math.round(num(f.get('reps'), 5))),
      increment: Math.max(0, num(f.get('increment'), 5)),
    };
    const weight = Math.max(0, round(num(f.get('weight'), 45)));
    const k = keyOf(name);
    if (editing && keyOf(t.name) !== k) delete data.overrides[keyOf(t.name)];
    if (!lastPerformance(name)) {
      next.startWeight = weight;
      delete data.overrides[k];
    } else {
      next.startWeight = next.startWeight ?? weight;
      if (weight === historyWeight(next)) delete data.overrides[k];
      else data.overrides[k] = weight;
    }
    if (editing) data.templates[type][idx] = next;
    else data.templates[type].push(next);
    closeModal();
    persist();
    render();
  };
}

/** First-run / reconnect storage chooser. */
function storageModal(reason) {
  const reconnect = reason === 'reconnect';
  openModal(
    `<div class="sheet">
      <h2>${reconnect ? 'Reconnect your data file' : 'Where should your workouts be saved?'}</h2>
      ${reconnect
        ? `<p class="small">Allow access to <b>${esc(store.fileName || 'your data file')}</b> to continue.</p>
           <button class="btn primary block" data-action="storage-reconnect">Allow access</button>
           <button class="btn ghost block" data-action="storage-open">Choose a different file…</button>`
        : fsSupported
          ? `<p class="small">Pick a location on your phone (e.g. Documents or Downloads, or a synced folder) for your workout data file. You can change this later in Settings.</p>
             <button class="btn primary block" data-action="storage-new">Create new data file…</button>
             <button class="btn ghost block" data-action="storage-open">Open existing data file…</button>`
          : `<p class="small">This browser doesn't support saving to the file system (requires Chrome on Android 132+ or desktop Chrome/Edge). Your data will be kept in browser storage — use Export in Settings to back it up.</p>`}
      <button class="btn ghost block" data-action="storage-local">${fsSupported ? 'Use browser storage instead' : 'Continue'}</button>
      <p class="error small" id="storage-error" hidden></p>
    </div>`,
    { locked: true }
  );
}

function storageError(err) {
  if (err?.name === 'AbortError') return; // user cancelled picker
  console.error(err);
  const el = $('#storage-error');
  const msg = `Couldn't use that file: ${err.message || err}`;
  if (el && modal.open) {
    el.textContent = msg;
    el.hidden = false;
  } else showBanner(msg);
}

// ============================================================
// Actions
// ============================================================
async function ensureNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    try { await Notification.requestPermission(); } catch { /* ignore */ }
  }
}

const actions = {
  goto: (el) => { tab = el.dataset.tab; render(); },
  'pick-type': (el) => { pendingType = el.dataset.type; render(); },
  'start-workout': (el) => { ensureNotificationPermission(); startWorkout(el.dataset.type); },
  'set-tap': (el) => tapSet(+el.dataset.ex, +el.dataset.set),
  'edit-weight': (el) => weightModal(+el.dataset.ex),
  'finish-workout': finishWorkout,
  'discard-workout': discardWorkout,
  'delete-workout': (el) => {
    const w = data.workouts.find((x) => x.id === el.dataset.id);
    if (!w || !confirm(`Delete Workout ${w.type} from ${formatDate(w.date)}?`)) return;
    if (!w.finishedAt) timer.stop();
    data.workouts = data.workouts.filter((x) => x !== w);
    persist();
    render();
  },
  'tpl-add': (el) => templateModal(el.dataset.type, null),
  'tpl-edit': (el) => templateModal(el.dataset.type, +el.dataset.idx),
  'tpl-del': (el) => {
    const list = data.templates[el.dataset.type];
    const i = +el.dataset.idx;
    if (!confirm(`Remove ${list[i].name} from Workout ${el.dataset.type}?`)) return;
    list.splice(i, 1);
    persist();
    render();
  },
  'tpl-move': (el) => {
    const list = data.templates[el.dataset.type];
    const i = +el.dataset.idx;
    const j = i + +el.dataset.dir;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    persist();
    render();
  },
  'notif-enable': async () => { await ensureNotificationPermission(); render(); },
  'modal-close': closeModal,
  'banner-close': hideBanner,
  'timer-add': () => timer.add(30),
  'timer-skip': () => timer.stop(),

  // ---- storage ----
  'storage-new': async () => {
    try {
      await store.createFile();
      await store.save(data); // write current data into the new file
      closeModal();
      hideBanner();
      toast(`Saving to ${store.fileName}`);
      render();
    } catch (err) { storageError(err); }
  },
  'storage-open': async () => {
    try {
      await store.openFile();
      const loaded = await store.load();
      if (loaded) data = normalize(loaded);
      else await store.save(data); // empty file: initialize with current data
      closeModal();
      hideBanner();
      toast(`Loaded ${store.fileName}`);
      render();
    } catch (err) { storageError(err); }
  },
  'storage-reconnect': async () => {
    try {
      await store.reconnect();
      const loaded = await store.load();
      data = normalize(loaded ?? store.loadCache());
      closeModal();
      hideBanner();
      render();
    } catch (err) { storageError(err); }
  },
  // Reconnect after a failed write: push the cached (latest) data to the file.
  'storage-resave': async () => {
    try {
      await store.reconnect();
      await store.save(data);
      hideBanner();
      toast('Data file reconnected');
      render();
    } catch (err) { storageError(err); }
  },
  'storage-local': async () => {
    await store.useBrowserStorage();
    await store.save(data);
    closeModal();
    hideBanner();
    render();
  },

  // ---- import / export ----
  export: () => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `stronglifts-${todayStr()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  },
  import: () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const parsed = JSON.parse(await file.text());
        if (!Array.isArray(parsed.workouts)) throw new Error('Not a Stronglifts data file');
        if (!confirm(`Replace current data with ${parsed.workouts.length} workout(s) from ${file.name}?`)) return;
        data = normalize(parsed);
        timer.stop();
        await persist();
        render();
        toast('Data imported');
      } catch (err) {
        alert(`Import failed: ${err.message}`);
      }
    };
    input.click();
  },
};

document.addEventListener('click', (e) => {
  const tabBtn = e.target.closest('.tabs button');
  if (tabBtn) {
    tab = tabBtn.dataset.tab;
    render();
    window.scrollTo(0, 0);
    return;
  }
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.action];
  if (fn) {
    e.preventDefault();
    fn(el);
  }
});

view.addEventListener('change', (e) => {
  const key = e.target.dataset.setting;
  if (!key) return;
  if (e.target.type === 'checkbox') data.settings[key] = e.target.checked;
  else data.settings[key] = Math.max(0, num(e.target.value, data.settings[key]));
  persist();
});

$('#storage-indicator').addEventListener('click', () => {
  if (store.status === 'needs-permission') return storageModal('reconnect');
  if (!store.mode) return storageModal('setup');
  tab = 'settings';
  render();
});

// The service worker owns the timer notification; when the user presses +30s /
// Skip on it (or it expires) the new state is synced back to the page.
navigator.serviceWorker?.addEventListener('message', (e) => {
  if (e.data?.type !== 'timer-sync') return;
  timer.applyRemote(e.data.state, { done: !!e.data.done });
});

// When an updated service worker takes over, reload so page and worker match.
// (Workout and timer state are persisted, so nothing is lost.)
if (navigator.serviceWorker?.controller) {
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    timer.refresh();
    if (tab === 'today') render(); // date may have rolled over
  }
});

// ============================================================
// Boot
// ============================================================
async function boot() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('SW registration failed', err));
  }

  await store.init();

  if (store.status === 'ok') {
    try {
      const loaded = await store.load();
      data = normalize(loaded ?? store.loadCache());
      if (!loaded) persist();
    } catch (err) {
      console.error(err);
      data = normalize(store.loadCache());
      showBanner(`Couldn't read data file (${err.message}). Showing cached data.`);
    }
    render();
  } else {
    data = normalize(store.loadCache());
    render();
    storageModal(store.status === 'needs-permission' ? 'reconnect' : 'setup');
  }

  timer.restore();
}

boot();
