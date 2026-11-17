/**
 * repo.js — La copie de travail du dépôt de données, sur le téléphone, et sa synchronisation avec GitHub.
 *
 * Trois idées :
 *  1. « base » = la dernière version connue de chaque fichier sur GitHub (avec son sha).
 *  2. « opérations en attente » = ce que tu as fait depuis, pas encore envoyé (note ajoutée, action cochée…).
 *     Elles sont enregistrées sur le téléphone AVANT d'être envoyées : rien ne se perd hors ligne.
 *  3. Ce que l'app affiche = base + opérations en attente. Tu vois donc tout de suite le résultat
 *     de ce que tu fais, réseau ou pas.
 *
 * Synchroniser = envoyer les opérations (un commit par fichier modifié), puis récupérer ce qui a changé
 * ailleurs (ton PC, Obsidian, le raccourci iPhone). Si un fichier a bougé sur GitHub entre-temps,
 * GitHub refuse l'écriture (409) : on relit la nouvelle version et on y réapplique les opérations.
 */
import { applyOps, OP_KINDS } from '../core/ops.js';

const STALE_WINDOW_MS = 120000; // juste après une écriture, GitHub peut encore servir l'ancienne arborescence
const MAX_STALE_SHAS = 8;
const MAX_CONFLICT_RETRIES = 3;
const FETCH_CONCURRENCY = 4;

/** Les fichiers du dépôt que l'app suit (le reste — images, autres notes — est ignoré). */
export function isTracked(path) {
  return (path.startsWith('fiches/') && path.endsWith('.md'))
    || /^\.marginalia\/journal\/[^/]+\.jsonl$/.test(path)
    || path === '.marginalia/livres.json'
    || path === '.marginalia/reglages.json'
    || /^boite\/[^/]+\.(md|txt)$/i.test(path)
    || path === 'README.md';
}

/** Exécute fn sur chaque élément, `limit` à la fois. */
async function pool(items, limit, fn) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  });
  await Promise.all(workers);
}

export function createRepo({ storage, now = () => new Date(), clockMs = () => Date.now() }) {
  const base = new Map(); // chemin → { path, sha, content }
  let ops = []; // [{ seq, path, kind, args, at, label, failures?, error? }]
  let meta = {};
  const view = new Map(); // chemin → contenu affiché (base + opérations), calculé à la demande
  const inFlight = new Set(); // opérations en cours d'envoi : elles ne peuvent plus être annulées
  const recentWrites = new Map(); // chemin → instant de notre dernière écriture
  const listeners = new Set();
  let github = null;
  let version = 0;
  let syncing = null;
  let again = false;
  let hooks = { afterPull: null };
  let status = { state: 'disconnected', error: null, lastSync: null };

  const emit = (type, detail = {}) => { for (const fn of listeners) fn({ type, ...detail }); };

  function changed(paths) {
    for (const path of paths) view.delete(path);
    version += 1;
    emit('change', { paths });
  }

  function setStatus(next) {
    status = { ...status, ...next, pending: ops.length };
    emit('status', { status: getStatus() });
  }

  const getStatus = () => ({ ...status, pending: ops.length, failed: ops.filter((o) => o.error).length });

  async function setMeta(key, value) {
    if (value === undefined) {
      delete meta[key];
      await storage.deleteMeta(key);
    } else {
      meta[key] = value;
      await storage.putMeta(key, value);
    }
  }

  /* ------------------------------ Lecture ------------------------------ */

  function read(path) {
    if (view.has(path)) return view.get(path);
    const pending = ops.filter((o) => o.path === path);
    const content = pending.length ? applyOps(base.get(path)?.content ?? null, pending).content : (base.get(path)?.content ?? null);
    view.set(path, content);
    return content;
  }

  function paths(prefix = '') {
    const all = new Set([...base.keys(), ...ops.map((o) => o.path)]);
    return [...all].filter((p) => p.startsWith(prefix) && read(p) !== null).sort();
  }

  /* ------------------------------ Écriture ------------------------------ */

  /**
   * Met une opération dans la file. Elle est d'abord appliquée à la vue actuelle : si elle n'a pas de sens
   * (note introuvable…), l'erreur remonte tout de suite à l'interface et rien n'est enregistré.
   * @returns { op } — op = null si l'opération ne change rien (déjà faite)
   */
  async function enqueue({ path, kind, args = {}, label = '' }) {
    if (!OP_KINDS.has(kind)) throw new Error(`Opération inconnue : ${kind}`);
    if (!path || typeof path !== 'string' || path.includes('..') || path.startsWith('/')) throw new Error('Chemin invalide');
    const seq = (meta.lastSeq ?? 0) + 1;
    const op = { seq, path, kind, args, at: now().toISOString(), label: String(label).slice(0, 140) };
    const before = read(path);
    const { content: after, rejected } = applyOps(before, [op]);
    if (rejected.length) throw rejected[0].error;
    if (after === before) return { op: null };
    // La vue est mise à jour AVANT d'attendre le stockage : une seconde opération lancée pendant
    // l'enregistrement de celle-ci s'appliquera bien par-dessus.
    meta.lastSeq = seq;
    ops.push(op);
    view.set(path, after);
    version += 1;
    try {
      await storage.putMeta('lastSeq', seq);
      await storage.putOp(op);
    } catch (err) {
      ops = ops.filter((o) => o !== op);
      changed([path]);
      throw err;
    }
    emit('change', { paths: [path], local: true });
    setStatus({});
    return { op };
  }

  /** Annule une opération pas encore envoyée (le « Annuler » juste après avoir noté). */
  async function cancel(seq) {
    const op = ops.find((o) => o.seq === seq);
    if (!op || inFlight.has(seq)) return false;
    ops = ops.filter((o) => o.seq !== seq);
    await storage.deleteOp(seq);
    changed([op.path]);
    setStatus({});
    return true;
  }

  async function dropOps(list) {
    const seqs = new Set(list.map((o) => o.seq));
    ops = ops.filter((o) => !seqs.has(o.seq));
    for (const seq of seqs) await storage.deleteOp(seq);
  }

  async function setBase(path, entry) {
    if (entry) {
      base.set(path, entry);
      await storage.putFile(entry);
    } else {
      base.delete(path);
      await storage.deleteFile(path);
    }
  }

  /**
   * Les versions d'un fichier que nous venons de remplacer : si GitHub nous les ressert dans les minutes
   * qui suivent (cache pas encore à jour), on les ignore. Passé ce délai, on refait confiance à GitHub :
   * un fichier peut très bien revenir à un contenu antérieur (une note annulée sur un autre appareil).
   */
  function staleShas(path) {
    const fresh = clockMs() - STALE_WINDOW_MS;
    return (meta.stale?.[path] ?? []).filter((s) => s.at > fresh).map((s) => s.sha);
  }
  async function rememberStale(path, sha) {
    if (!sha) return;
    const fresh = clockMs() - STALE_WINDOW_MS;
    const stale = {};
    for (const [p, list] of Object.entries(meta.stale ?? {})) {
      const kept = list.filter((s) => s.at > fresh && !(p === path && s.sha === sha));
      if (kept.length) stale[p] = kept;
    }
    stale[path] = [{ sha, at: clockMs() }, ...(stale[path] ?? [])].slice(0, MAX_STALE_SHAS);
    await setMeta('stale', stale);
  }

  /* ------------------------------ Envoi ------------------------------ */

  /** Regroupe les opérations par fichier, dans l'ordre de la première opération de chaque fichier. */
  function groups() {
    const byPath = new Map();
    for (const op of [...ops].sort((a, b) => a.seq - b.seq)) {
      if (!byPath.has(op.path)) byPath.set(op.path, []);
      byPath.get(op.path).push(op);
    }
    return [...byPath].map(([path, list]) => ({ path, ops: list }));
  }

  function commitMessage(list) {
    const labels = [...new Set(list.map((o) => o.label).filter(Boolean))];
    const head = labels[0] || 'mise à jour';
    return `Marginalia : ${head}${labels.length > 1 ? ` (+${labels.length - 1})` : ''}`;
  }

  async function pushGroup({ path, ops: list }) {
    for (const op of list) inFlight.add(op.seq);
    try {
      for (let attempt = 0; ; attempt += 1) {
        const current = base.get(path) ?? null;
        const before = current?.content ?? null;
        const { content: next, rejected } = applyOps(before, list);
        if (rejected.length) {
          // Exemple : l'action a été supprimée de la fiche sur le PC avant que ce changement arrive.
          emit('rejected', { items: rejected.map(({ op, error }) => ({ label: op.label, message: error.message })) });
        }
        const accepted = list.filter((op) => !rejected.some((r) => r.op === op));
        if (next === before) {
          await dropOps(list);
          changed([path]);
          return;
        }
        try {
          if (next === null) {
            await github.deleteFile(path, { sha: current.sha, message: commitMessage(accepted) });
            await rememberStale(path, current.sha);
            await setBase(path, null);
          } else {
            const { sha } = await github.putFile(path, next, { sha: current?.sha, message: commitMessage(accepted) });
            if (current) await rememberStale(path, current.sha);
            await setBase(path, { path, sha, content: next });
          }
          recentWrites.set(path, clockMs());
          await dropOps(list);
          changed([path]);
          return;
        } catch (err) {
          if (err.kind !== 'conflict' || attempt >= MAX_CONFLICT_RETRIES) throw err;
          // Le fichier a changé sur GitHub : on relit sa version actuelle et on recommence.
          const fresh = await github.getFile(path, meta.branch);
          await setBase(path, fresh ? { path, sha: fresh.sha, content: fresh.content } : null);
          changed([path]);
        }
      }
    } finally {
      for (const op of list) inFlight.delete(op.seq);
    }
  }

  async function push() {
    for (const group of groups()) {
      try {
        await pushGroup(group);
      } catch (err) {
        // Réseau coupé, jeton refusé, GitHub en panne : on s'arrête, tout reste dans la file.
        if (['network', 'auth', 'forbidden', 'rate', 'server', 'notfound'].includes(err.kind)) throw err;
        // Erreur propre à ce fichier : on la note et on passe aux autres (on réessaiera au prochain envoi).
        for (const op of group.ops) {
          op.failures = (op.failures ?? 0) + 1;
          op.error = err.message;
          await storage.putOp(op);
        }
        emit('rejected', { items: [{ label: group.ops[0].label, message: err.message }] });
      }
    }
  }

  /* ------------------------------ Réception ------------------------------ */

  async function pull() {
    const tree = await github.getTree(meta.branch);
    const toFetch = [];
    for (const [path, sha] of tree.files) {
      if (!isTracked(path)) continue;
      if (base.get(path)?.sha === sha) continue;
      if (staleShas(path).includes(sha)) continue; // vieille version servie par un cache de GitHub
      toFetch.push([path, sha]);
    }
    const updated = [];
    await pool(toFetch, FETCH_CONCURRENCY, async ([path, sha]) => {
      const content = await github.getBlob(sha);
      await setBase(path, { path, sha, content });
      updated.push(path);
    });
    for (const path of [...base.keys()]) {
      if (tree.files.has(path)) continue;
      if (clockMs() - (recentWrites.get(path) ?? 0) < STALE_WINDOW_MS) continue; // créé à l'instant : pas encore visible
      await setBase(path, null); // supprimé ailleurs (ou dans Obsidian)
      updated.push(path);
    }
    if (updated.length) changed(updated);
    return updated;
  }

  /* ------------------------------ Synchronisation ------------------------------ */

  function describeError(err) {
    switch (err?.kind) {
      case 'network': return 'Hors ligne : tout est gardé sur le téléphone, l’envoi reprendra tout seul.';
      case 'auth': return 'GitHub refuse le jeton (expiré ou révoqué). Reconnecte-toi dans les réglages.';
      case 'forbidden': return 'Le jeton n’a pas le droit d’écrire dans ce dépôt (permission « Contents : Read and write »).';
      case 'notfound': return 'Dépôt introuvable : vérifie son nom et que le jeton y a accès.';
      case 'rate': return 'Trop de requêtes vers GitHub : nouvel essai dans quelques minutes.';
      case 'server': return 'GitHub ne répond pas correctement : nouvel essai bientôt.';
      default: return err?.message || 'Erreur inconnue';
    }
  }

  function stateFor(err) {
    if (err.kind === 'network') return 'offline';
    if (err.kind === 'auth' || err.kind === 'forbidden' || err.kind === 'notfound') return 'auth';
    return 'error';
  }

  async function runSync() {
    setStatus({ state: 'syncing' });
    try {
      do {
        again = false;
        await push();
        await pull();
        if (hooks.afterPull) await hooks.afterPull();
        await push();
      } while (again);
      const lastSync = now().toISOString();
      await setMeta('lastSync', lastSync);
      const failed = ops.find((o) => o.error);
      setStatus({ state: failed ? 'error' : 'ok', error: failed ? failed.error : null, errorKind: null, lastSync });
    } catch (err) {
      setStatus({ state: stateFor(err), error: describeError(err), errorKind: err.kind ?? 'other' });
    }
    return getStatus();
  }

  /** Lance une synchronisation (ou se greffe sur celle en cours). */
  function sync() {
    if (!github) return Promise.resolve(getStatus());
    if (syncing) {
      again = true;
      return syncing;
    }
    syncing = runSync().finally(() => { syncing = null; });
    return syncing;
  }

  return {
    async load() {
      const all = await storage.loadAll();
      base.clear();
      for (const f of all.files) base.set(f.path, f);
      ops = all.ops;
      meta = all.meta;
      view.clear();
      version += 1;
      if (meta.lastSync) status.lastSync = meta.lastSync;
      return this;
    },
    connect(client, { branch } = {}) {
      github = client;
      if (branch && branch !== meta.branch) setMeta('branch', branch);
      setStatus({ state: ops.length ? 'pending' : 'idle', error: null });
    },
    disconnect() {
      github = null;
      setStatus({ state: 'disconnected', error: null });
    },
    get connected() { return Boolean(github); },
    get version() { return version; },
    get syncing() { return Boolean(syncing); },
    meta: (key) => meta[key],
    setMeta,
    read,
    exists: (path) => read(path) !== null,
    paths,
    pendingOps: () => ops.map((o) => ({ ...o })),
    isPending: (seq) => ops.some((o) => o.seq === seq),
    enqueue,
    cancel,
    sync,
    status: getStatus,
    setHooks(next) { hooks = { ...hooks, ...next }; },
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** Efface tout ce qui est stocké sur le téléphone (déconnexion complète). */
    async reset() {
      await storage.clear();
      base.clear();
      ops = [];
      meta = {};
      view.clear();
      recentWrites.clear();
      github = null;
      changed([]);
      setStatus({ state: 'disconnected', error: null, lastSync: null });
    },
  };
}
