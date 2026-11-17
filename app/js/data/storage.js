/**
 * storage.js — Où l'app garde ses données SUR LE TÉLÉPHONE : une copie des fichiers du dépôt
 * (pour fonctionner hors ligne), la file des modifications pas encore envoyées, et quelques réglages.
 *
 * Deux implémentations avec la même interface :
 *   - IndexedDB dans le navigateur (persistant, plusieurs Mo sans souci) ;
 *   - en mémoire pour les tests automatisés.
 *
 * La source de vérité reste le dépôt GitHub : effacer ces données locales ne fait perdre que
 * les modifications pas encore envoyées.
 */

export function memoryStorage(initial = {}) {
  const files = new Map((initial.files || []).map((f) => [f.path, { ...f }]));
  const ops = new Map((initial.ops || []).map((o) => [o.seq, { ...o }]));
  const meta = new Map(Object.entries(initial.meta || {}));
  const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
  return {
    async loadAll() {
      return {
        files: [...files.values()].map(clone),
        ops: [...ops.values()].map(clone).sort((a, b) => a.seq - b.seq),
        meta: Object.fromEntries([...meta].map(([k, v]) => [k, clone(v)])),
      };
    },
    async putFile(entry) { files.set(entry.path, clone(entry)); },
    async deleteFile(path) { files.delete(path); },
    async putOp(op) { ops.set(op.seq, clone(op)); },
    async deleteOp(seq) { ops.delete(seq); },
    async putMeta(key, value) { meta.set(key, clone(value)); },
    async deleteMeta(key) { meta.delete(key); },
    async clear() { files.clear(); ops.clear(); meta.clear(); },
    /** Tests : simule un redémarrage de l'app en relisant le même stockage. */
    _dump() { return { files: [...files.values()], ops: [...ops.values()], meta: Object.fromEntries(meta) }; },
  };
}

/** IndexedDB, enveloppé dans des promesses. Trois « tables » : files, ops, meta. */
export function idbStorage(name = 'marginalia') {
  let dbPromise = null;
  const open = () => {
    dbPromise ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(name, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'path' });
        if (!db.objectStoreNames.contains('ops')) db.createObjectStore('ops', { keyPath: 'seq' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  };
  const tx = async (stores, mode, fn) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(stores, mode);
      const result = fn(t);
      t.oncomplete = () => resolve(result?.result ?? result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  };
  const getAll = (t, store) => {
    const req = t.objectStore(store).getAll();
    return req;
  };
  return {
    async loadAll() {
      const db = await open();
      return new Promise((resolve, reject) => {
        const t = db.transaction(['files', 'ops', 'meta'], 'readonly');
        const files = getAll(t, 'files');
        const ops = getAll(t, 'ops');
        const metaStore = t.objectStore('meta');
        const keys = metaStore.getAllKeys();
        const values = metaStore.getAll();
        t.oncomplete = () => {
          const meta = {};
          keys.result.forEach((k, i) => { meta[k] = values.result[i]; });
          resolve({ files: files.result, ops: ops.result.sort((a, b) => a.seq - b.seq), meta });
        };
        t.onerror = () => reject(t.error);
      });
    },
    putFile: (entry) => tx(['files'], 'readwrite', (t) => t.objectStore('files').put(entry)),
    deleteFile: (path) => tx(['files'], 'readwrite', (t) => t.objectStore('files').delete(path)),
    putOp: (op) => tx(['ops'], 'readwrite', (t) => t.objectStore('ops').put(op)),
    deleteOp: (seq) => tx(['ops'], 'readwrite', (t) => t.objectStore('ops').delete(seq)),
    putMeta: (key, value) => tx(['meta'], 'readwrite', (t) => t.objectStore('meta').put(value, key)),
    deleteMeta: (key) => tx(['meta'], 'readwrite', (t) => t.objectStore('meta').delete(key)),
    clear: () => tx(['files', 'ops', 'meta'], 'readwrite', (t) => {
      t.objectStore('files').clear();
      t.objectStore('ops').clear();
      t.objectStore('meta').clear();
    }),
  };
}
