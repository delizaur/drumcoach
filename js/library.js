// Keeps loaded beatmaps in IndexedDB so they don't have to be dropped again on every visit.

const DB_NAME = 'drumcoach';
const STORE = 'songs';
let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function run(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const library = {
  /** @returns {Promise<Array<{id, title, artist, creator, files: File[], usedAt: number}>>} */
  async list() {
    try {
      const all = (await run('readonly', s => s.getAll())) || [];
      return all.sort((a, b) => b.usedAt - a.usedAt);
    } catch (err) {
      console.warn('Song library unavailable', err);
      return [];
    }
  },
  async put(record) {
    try { await run('readwrite', s => s.put(record)); } catch (err) { console.warn('Could not save song', err); }
  },
  async touch(id) {
    try {
      const rec = await run('readonly', s => s.get(id));
      if (rec) await run('readwrite', s => s.put({ ...rec, usedAt: Date.now() }));
    } catch { /* ignore */ }
  },
  async remove(id) {
    try { await run('readwrite', s => s.delete(id)); } catch (err) { console.warn('Could not delete song', err); }
  },
};
