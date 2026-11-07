// Storage layer.
//
// Primary backend: a user-chosen JSON file via the File System Access API
// (Chrome on Android 132+, desktop Chrome/Edge). The FileSystemFileHandle is
// persisted in IndexedDB so the same file is reused on every launch.
//
// Fallback backend: localStorage (browsers without the picker APIs, or when
// the user opts out). localStorage is also always kept as a cache/mirror.

const DB_NAME = 'sl55';
const DB_STORE = 'kv';
const HANDLE_KEY = 'dataFileHandle';
const MODE_KEY = 'sl55-storage-mode'; // 'file' | 'local'
const CACHE_KEY = 'sl55-data';

export const fsSupported =
  typeof window !== 'undefined' &&
  'showSaveFilePicker' in window &&
  'showOpenFilePicker' in window;

// ---------- tiny IndexedDB key/value helpers ----------
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idb(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, mode);
    const req = fn(tx.objectStore(DB_STORE));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
  });
}
const idbGet = (k) => idb('readonly', (s) => s.get(k));
const idbSet = (k, v) => idb('readwrite', (s) => s.put(v, k));
const idbDel = (k) => idb('readwrite', (s) => s.delete(k));

// ---------- Storage ----------
export class Storage {
  constructor() {
    this.mode = null;     // 'file' | 'local' | null
    this.handle = null;   // FileSystemFileHandle
    this.status = 'unconfigured'; // 'ok' | 'needs-permission' | 'unconfigured'
    this._queue = Promise.resolve();
  }

  get fileName() {
    return this.handle?.name ?? null;
  }

  async init() {
    const mode = localStorage.getItem(MODE_KEY);
    if (mode === 'file' && fsSupported) {
      try {
        this.handle = (await idbGet(HANDLE_KEY)) ?? null;
      } catch {
        this.handle = null;
      }
      if (!this.handle) {
        this.status = 'unconfigured';
        return;
      }
      this.mode = 'file';
      const perm = await this.handle.queryPermission({ mode: 'readwrite' });
      this.status = perm === 'granted' ? 'ok' : 'needs-permission';
    } else if (mode === 'local') {
      this.mode = 'local';
      this.status = 'ok';
    } else {
      this.status = 'unconfigured';
    }
  }

  /** Must be called from a user gesture. Lets the user pick where to create the file. */
  async createFile() {
    const handle = await window.showSaveFilePicker({
      suggestedName: 'stronglifts-data.json',
      types: [{ description: 'Stronglifts data (JSON)', accept: { 'application/json': ['.json'] } }],
    });
    await this._useHandle(handle);
  }

  /** Must be called from a user gesture. Lets the user pick an existing data file. */
  async openFile() {
    // No `types` filter: Android's document picker can grey out .json files
    // when the MIME mapping is unknown.
    const [handle] = await window.showOpenFilePicker({ multiple: false });
    await this._useHandle(handle);
  }

  async _useHandle(handle) {
    const perm = await handle.requestPermission({ mode: 'readwrite' });
    if (perm !== 'granted') throw new Error('Write permission was not granted for that file.');
    this.handle = handle;
    this.mode = 'file';
    this.status = 'ok';
    await idbSet(HANDLE_KEY, handle);
    localStorage.setItem(MODE_KEY, 'file');
  }

  /** Must be called from a user gesture. Re-grants access to the remembered file. */
  async reconnect() {
    if (!this.handle) throw new Error('No data file remembered.');
    const perm = await this.handle.requestPermission({ mode: 'readwrite' });
    if (perm !== 'granted') throw new Error('Permission denied.');
    this.status = 'ok';
  }

  async useBrowserStorage() {
    this.mode = 'local';
    this.status = 'ok';
    this.handle = null;
    localStorage.setItem(MODE_KEY, 'local');
    try { await idbDel(HANDLE_KEY); } catch { /* ignore */ }
    try { await navigator.storage?.persist?.(); } catch { /* ignore */ }
  }

  /** Last known data from the local mirror (may be null). */
  loadCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  /**
   * Load data from the active backend.
   * Returns null when the file is empty (new file). Throws on invalid JSON.
   */
  async load() {
    if (this.mode === 'file') {
      const file = await this.handle.getFile();
      const text = (await file.text()).trim();
      if (!text) return null;
      const data = JSON.parse(text);
      localStorage.setItem(CACHE_KEY, JSON.stringify(data));
      return data;
    }
    return this.loadCache();
  }

  /** Save data. Writes are serialized so they never interleave. */
  save(data) {
    const json = JSON.stringify(data, null, 2);
    localStorage.setItem(CACHE_KEY, json);
    if (this.mode !== 'file' || !this.handle) return Promise.resolve();
    this._queue = this._queue
      .catch(() => {})
      .then(async () => {
        try {
          const w = await this.handle.createWritable();
          await w.write(json);
          await w.close();
        } catch (err) {
          if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError') {
            this.status = 'needs-permission';
          }
          throw err;
        }
      });
    return this._queue;
  }
}
