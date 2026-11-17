/**
 * api.js — Le « cerveau » de l'app, côté téléphone.
 *
 * L'interface (les fichiers ui/*.js) ne parle qu'à l'objet `window.marginalia` défini ici : exactement
 * les mêmes fonctions que dans la V2 de bureau, plus la connexion à GitHub. Chaque fonction renvoie
 * { ok: true, … } ou { ok: false, error } — jamais d'exception qui remonterait jusqu'à l'écran.
 *
 * Ici, pas de dossier sur le disque : les fichiers vivent dans un dépôt GitHub privé, avec une copie
 * sur le téléphone (IndexedDB) pour fonctionner hors ligne. Les envois partent tout seuls en arrière-plan.
 */
import * as fiche from './core/fiche.js';
import { createGitHub, GitHubError } from './data/github.js';
import { idbStorage, memoryStorage } from './data/storage.js';
import { createRepo } from './data/repo.js';
import { createLibrary } from './data/library.js';

export const VERSION = '3.0.0';
const INTRO_VERSION = '3';

/* ------------------------------------------------------------------ */
/* Horloge (les tests peuvent la décaler) et identifiant de l'appareil */
/* ------------------------------------------------------------------ */

const testFlag = (key) => { try { return localStorage.getItem(`marginalia:${key}`); } catch { return null; } };
const now = () => new Date(Date.now() + Number(testFlag('clockOffset') || 0));

function newDeviceId() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
}

/** Lien de création d'un jeton GitHub à accès limité, pré-rempli (seul le dépôt reste à choisir). */
export function tokenUrl(owner) {
  const params = new URLSearchParams({
    name: 'Marginalia (iPhone)',
    description: 'Lecture et écriture de mes notes de lecture (dépôt marginalia-data uniquement).',
    target_name: owner || '',
    expires_in: '366',
    contents: 'write',
  });
  return `https://github.com/settings/personal-access-tokens/new?${params}`;
}

/* ------------------------------------------------------------------ */
/* Démarrage                                                           */
/* ------------------------------------------------------------------ */

let storage;
try {
  storage = typeof indexedDB !== 'undefined' && !testFlag('memory') ? idbStorage('marginalia') : memoryStorage();
} catch {
  storage = memoryStorage();
}
let storageWarning = null;
const repo = createRepo({
  // Si IndexedDB est indisponible (navigation privée ancienne, stockage plein), l'app marche quand même,
  // en mémoire : ce qui n'est pas encore envoyé serait perdu à la fermeture — l'interface le signale.
  storage: {
    async loadAll() {
      try {
        return await storage.loadAll();
      } catch (err) {
        console.error('Stockage local indisponible', err);
        storageWarning = 'Stockage du téléphone indisponible : tes notes partent directement sur GitHub, garde du réseau.';
        storage = memoryStorage();
        return storage.loadAll();
      }
    },
    putFile: (...a) => storage.putFile(...a),
    deleteFile: (...a) => storage.deleteFile(...a),
    putOp: (...a) => storage.putOp(...a),
    deleteOp: (...a) => storage.deleteOp(...a),
    putMeta: (...a) => storage.putMeta(...a),
    deleteMeta: (...a) => storage.deleteMeta(...a),
    clear: () => storage.clear(),
  },
  now,
});
let library = null;
const listeners = {};
const emit = (event, payload) => { for (const fn of listeners[event] || []) { try { fn(payload); } catch (err) { console.error(err); } } };

const local = (key, fallback) => repo.meta(key) ?? fallback;

function makeClient(connection) {
  return createGitHub({
    apiBase: testFlag('apiBase') || 'https://api.github.com',
    owner: connection.owner,
    repo: connection.repo,
    token: connection.token,
  });
}

const ready = (async () => {
  // Demande au navigateur de ne jamais effacer les données de l'app pour faire de la place.
  try { await navigator.storage?.persist?.(); } catch { /* facultatif */ }
  await repo.load();
  if (!repo.meta('deviceId')) await repo.setMeta('deviceId', newDeviceId());
  library = createLibrary({ repo, deviceId: repo.meta('deviceId'), now });
  repo.setHooks({ afterPull: async () => {
    const { added } = await library.maintain({ currentBookId: local('currentBookId', null) });
    if (added.length) emit('app:inbox', { added });
  } });
  const connection = repo.meta('connection');
  if (connection?.token) repo.connect(makeClient(connection), { branch: connection.branch });
})();

/* ------------------------------------------------------------------ */
/* Synchronisation automatique                                         */
/* ------------------------------------------------------------------ */

let syncTimer = null;
let syncDueAt = 0;
let retryDelay = 0;
let lastSyncAttempt = 0;

/** Les notes partent vite (3 s) ; les événements de journal (révisions…) sont regroupés (30 s). */
function scheduleSync(delay = null) {
  if (!repo.connected) return;
  const pending = repo.pendingOps();
  const wanted = delay ?? (pending.some((o) => !o.path.startsWith('.marginalia/journal/')) ? 3000 : 30000);
  const at = Date.now() + wanted;
  if (syncTimer && syncDueAt <= at) return;
  clearTimeout(syncTimer);
  syncDueAt = at;
  syncTimer = setTimeout(() => { syncTimer = null; runSync(); }, wanted);
}

async function runSync() {
  if (!repo.connected) return repo.status();
  lastSyncAttempt = Date.now();
  const status = await repo.sync();
  if (status.state === 'offline' || status.state === 'error') {
    // Nouvel essai de plus en plus espacé (15 s, 1 min, 5 min), tant qu'il reste des choses à envoyer.
    retryDelay = Math.min(300000, retryDelay ? retryDelay * 4 : 15000);
    if (status.pending) scheduleSync(retryDelay);
  } else {
    retryDelay = 0;
    if (status.pending) scheduleSync();
  }
  return status;
}

repo.on((event) => {
  if (event.type === 'status') emit('app:sync', event.status);
  if (event.type === 'change' && !event.local) emit('app:changed', { paths: event.paths });
  if (event.type === 'rejected') emit('app:rejected', { items: event.items });
});

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (!repo.connected) return;
    if (document.visibilityState === 'hidden') {
      if (repo.status().pending) runSync(); // tu quittes l'app : on envoie ce qui attend
    } else if (Date.now() - lastSyncAttempt > 30000) {
      runSync(); // retour dans l'app : on récupère ce qui a changé ailleurs (PC, raccourci)
    }
  });
  window.addEventListener('online', () => { retryDelay = 0; runSync(); });
  setInterval(() => { if (document.visibilityState === 'visible' && repo.connected) runSync(); }, 5 * 60000);
}

/* ------------------------------------------------------------------ */
/* État envoyé à l'interface                                           */
/* ------------------------------------------------------------------ */

function publicConnection() {
  const c = repo.meta('connection');
  return c ? { owner: c.owner, repo: c.repo, branch: c.branch, htmlUrl: c.htmlUrl || `https://github.com/${c.owner}/${c.repo}` } : null;
}

function settingsBlock() {
  const shared = library.settings();
  return {
    connected: Boolean(repo.meta('connection')?.token),
    connection: publicConnection(),
    ritual: shared.ritual,
    goal: shared.goal,
    reviewLimit: shared.reviewLimit,
    cleanCapture: local('cleanCapture', true),
    introPending: local('seenVersion', '') !== INTRO_VERSION,
    version: VERSION,
    deviceId: repo.meta('deviceId'),
  };
}

function summary() {
  const s = library.settings();
  return library.overview({ goal: s.goal, limit: s.reviewLimit });
}

function currentBookId(books) {
  let id = local('currentBookId', null);
  if (!books.some((b) => b.id === id)) {
    id = books.find((b) => b.statut === 'en-cours')?.id ?? books[0]?.id ?? null;
  }
  return id;
}

function pageFor(bookId, sum) {
  if (!bookId) return '';
  const typed = local('lastPageByBook', {})[bookId];
  if (typed !== undefined && typed !== '') return typed;
  const known = sum.progress?.[bookId];
  return known ? String(known) : '';
}

function buildState() {
  const index = library.index();
  const books = index.map((e) => e.book);
  const id = currentBookId(books);
  const entry = index.find((e) => e.book.id === id) ?? null;
  const sum = summary();
  return {
    settings: settingsBlock(),
    books,
    book: entry?.book ?? null,
    notes: entry?.notes ?? [],
    page: pageFor(id, sum),
    summary: sum,
    sync: repo.status(),
    storageWarning,
    now: now().getTime(),
  };
}

function bookReply(bookId) {
  const entry = library.entryFor(bookId);
  return { book: entry.book, notes: entry.notes, summary: summary() };
}

async function setLastPage(bookId, page) {
  await repo.setMeta('lastPageByBook', { ...local('lastPageByBook', {}), [bookId]: String(page ?? '').trim().slice(0, fiche.LIMITS.page) });
}

/* ------------------------------------------------------------------ */
/* Connexion à GitHub                                                  */
/* ------------------------------------------------------------------ */

function connectionError(err) {
  if (!(err instanceof GitHubError)) return err;
  switch (err.kind) {
    case 'auth': return new Error('GitHub refuse ce jeton. Vérifie que tu l’as copié en entier (il commence par « github_pat_ »).');
    case 'notfound': return new Error('Dépôt introuvable avec ce jeton. Vérifie le nom du dépôt, et que le jeton y a accès (« Only select repositories »).');
    case 'forbidden': return new Error('Le jeton ne peut pas écrire : dans GitHub, donne-lui « Contents : Read and write ».');
    case 'network': return new Error('Pas de connexion internet. Réessaie dès que tu as du réseau.');
    default: return new Error(`GitHub : ${err.message}`);
  }
}

async function connect({ owner, repo: name, token } = {}) {
  const clean = {
    owner: String(owner ?? '').trim().replace(/^@/, ''),
    repo: String(name ?? '').trim().replace(/\.git$/, ''),
    token: String(token ?? '').trim(),
  };
  if (!/^[A-Za-z0-9-]{1,39}$/.test(clean.owner)) throw new Error('Nom de compte GitHub invalide');
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(clean.repo)) throw new Error('Nom de dépôt invalide');
  if (clean.token.length < 20 || /\s/.test(clean.token)) throw new Error('Jeton invalide : colle-le en entier.');

  const client = makeClient(clean);
  let info;
  try {
    info = await client.getRepo();
  } catch (err) {
    throw connectionError(err);
  }
  if (!info.isPrivate) {
    throw new Error(`Le dépôt « ${info.fullName} » est PUBLIC : tes notes seraient visibles par tous. Rends-le privé (Settings › Danger Zone › Change visibility), puis reconnecte-toi.`);
  }
  const previous = repo.meta('connection');
  const sameRepo = previous && previous.owner === clean.owner && previous.repo === clean.repo;
  if (previous && !sameRepo) {
    const pending = repo.status().pending;
    if (pending) throw new Error(`${pending} modification${pending > 1 ? 's' : ''} du dépôt actuel pas encore envoyée${pending > 1 ? 's' : ''} : synchronise d’abord.`);
    await repo.reset(); // autre dépôt : on repart d'une copie vide
    await repo.setMeta('deviceId', newDeviceId());
    library = createLibrary({ repo, deviceId: repo.meta('deviceId'), now });
  }

  // Premier échange : on récupère tout et on écrit la liste des livres — ce qui vérifie au passage
  // que le jeton a bien le droit d'ÉCRIRE (un jeton en lecture seule passerait l'étape précédente).
  repo.connect(client, { branch: info.defaultBranch });
  const first = await repo.sync();
  if (first.state === 'auth' || first.state === 'offline') {
    if (sameRepo && previous?.token) repo.connect(makeClient(previous), { branch: previous.branch });
    else repo.disconnect();
    throw connectionError(new GitHubError(first.error, { kind: first.errorKind }));
  }
  await repo.setMeta('connection', { ...clean, branch: info.defaultBranch, htmlUrl: info.htmlUrl });
  await library.ensureReadme();
  return runSync();
}

/* ------------------------------------------------------------------ */
/* L'API exposée à l'interface                                         */
/* ------------------------------------------------------------------ */

/** Enveloppe commune : attend le démarrage, transforme les exceptions en { ok: false, error }. */
function action(fn, { sync = false } = {}) {
  return async (...args) => {
    try {
      await ready;
      const result = await fn(...args);
      if (sync) scheduleSync();
      return { ok: true, ...result };
    } catch (err) {
      console.warn(err);
      return { ok: false, error: err?.message || String(err) };
    }
  };
}

function requireConnected() {
  if (!repo.meta('connection')?.token) throw new Error('Connecte d’abord l’app à ton dépôt GitHub.');
}

const api = {
  /* ----- État, livres ----- */
  getState: action(async () => ({ state: buildState() })),

  createBook: action(async (input) => {
    requireConnected();
    const { book } = await library.createBook(input ?? {});
    const start = String(input?.pageActuelle ?? '').trim();
    if (/^\d{1,5}$/.test(start)) await setLastPage(book.id, start);
    await repo.setMeta('currentBookId', book.id);
    return { state: buildState() };
  }, { sync: true }),

  selectBook: action(async (bookId) => {
    library.entryFor(String(bookId ?? ''));
    await repo.setMeta('currentBookId', bookId);
    return { state: buildState() };
  }),

  setBookStatus: action(async (bookId, statut) => {
    const { recap } = await library.setBookStatus(String(bookId ?? ''), statut);
    return { recap, state: buildState() };
  }, { sync: true }),

  getRecap: action(async (bookId) => ({ recap: library.bookRecap(String(bookId ?? '')) })),

  writeSynthesis: action(async (bookId, text) => library.writeSynthesis(String(bookId ?? ''), text), { sync: true }),

  correctProgress: action(async (bookId, page) => {
    const out = await library.correctProgress(String(bookId ?? ''), page);
    await setLastPage(bookId, out.page);
    return { ...out, summary: summary() };
  }, { sync: true }),

  /* ----- Notes ----- */
  saveNote: action(async (input) => {
    const bookId = String(input?.bookId ?? '');
    const { block, note } = await library.saveNote(bookId, input ?? {});
    if (note.page) await setLastPage(bookId, note.page);
    return { block, note, ...bookReply(bookId) };
  }, { sync: true }),

  undoLastNote: action(async ({ bookId, block } = {}) => {
    await library.undoNote(String(bookId ?? ''), block);
    return bookReply(String(bookId ?? ''));
  }, { sync: true }),

  addReflection: action(async (noteId, text) => library.addReflection(String(noteId ?? ''), text), { sync: true }),

  /** La page saisie est mémorisée tout de suite ; la progression n'avance qu'à la validation (commit). */
  setPage: action(async (bookId, page, commit = false) => {
    library.entryFor(String(bookId ?? ''));
    await setLastPage(bookId, page);
    if (!commit) return {};
    const { moved } = await library.advancePage(String(bookId), String(page ?? '').trim());
    if (moved) scheduleSync();
    return { summary: summary() };
  }),

  cleanText: action(async (raw) => fiche.cleanCapturedText(String(raw ?? '').slice(0, 100000))),

  /* ----- Retenir ----- */
  getReview: action(async (opts) => library.reviewPayload({
    limit: library.settings().reviewLimit,
    extra: Math.min(50, Math.max(0, Math.round(Number(opts?.extra) || 0))),
  })),

  gradeCard: action(async (noteId, grade) => ({ ...(await library.gradeCard(String(noteId ?? ''), String(grade))), summary: summary() }), { sync: true }),

  suspendCard: action(async (noteId) => {
    await library.suspendCard(String(noteId ?? ''));
    return { summary: summary() };
  }, { sync: true }),

  /* ----- Appliquer ----- */
  getActions: action(async () => ({ payload: library.actionsPayload(), summary: summary() })),

  setAction: action(async (change) => {
    const out = await library.setTask(change ?? {});
    return { ...out, payload: library.actionsPayload(), summary: summary() };
  }, { sync: true }),

  setFocusAction: action(async (target) => {
    await library.setFocus(target ?? null);
    return { payload: library.actionsPayload(), summary: summary() };
  }, { sync: true }),

  weeklyReviewDone: action(async () => {
    await library.weeklyReviewDone();
    return { payload: library.actionsPayload(), summary: summary() };
  }, { sync: true }),

  /* ----- Lire : sessions ----- */
  startSession: action(async (input) => {
    const out = await library.startSession({ bookId: String(input?.bookId ?? ''), page: input?.page });
    return { ...out, summary: summary() };
  }, { sync: true }),

  stopSession: action(async (input) => {
    const out = await library.stopSession({ toPage: input?.toPage, minutes: input?.minutes });
    if (out.session.toPage) await setLastPage(out.session.bookId, out.session.toPage);
    return { ...out, summary: summary() };
  }, { sync: true }),

  cancelSession: action(async () => {
    await library.cancelSession();
    return { summary: summary() };
  }, { sync: true }),

  /* ----- Progrès ----- */
  getStats: action(async () => ({ stats: library.statsPayload({ goal: library.settings().goal }) })),

  /* ----- Réglages ----- */
  setSetting: action(async (key, value) => {
    switch (key) {
      case 'ritualTime':
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(value))) throw new Error('Heure invalide');
        await library.setSharedSetting('ritual', { ...library.settings().ritual, time: value });
        break;
      case 'goal': {
        const amount = Math.round(Number(value?.value));
        if (!Number.isFinite(amount) || amount < 1 || amount > 600) throw new Error('Objectif invalide');
        await library.setSharedSetting('goal', { type: value?.type === 'pages' ? 'pages' : 'minutes', value: amount });
        break;
      }
      case 'reviewLimit': {
        const limit = Math.round(Number(value));
        if (!Number.isFinite(limit) || limit < 1 || limit > 50) throw new Error('Nombre de cartes invalide');
        await library.setSharedSetting('reviewLimit', limit);
        break;
      }
      case 'cleanCapture':
        await repo.setMeta('cleanCapture', Boolean(value));
        break;
      case 'seenVersion':
        await repo.setMeta('seenVersion', String(value).slice(0, 12));
        break;
      default:
        throw new Error(`Réglage inconnu : ${key}`);
    }
    scheduleSync();
    emit('app:settings');
    return { state: buildState() };
  }),

  /* ----- Propre à la version web : GitHub ----- */
  connect: action(async (input) => {
    const status = await connect(input ?? {});
    return { status, state: buildState() };
  }),

  /** Déconnexion. Les modifications pas encore envoyées seraient perdues : on refuse, sauf si on force. */
  disconnect: action(async ({ force = false } = {}) => {
    const pending = repo.status().pending;
    if (pending && !force) throw new Error(`${pending} modification${pending > 1 ? 's' : ''} pas encore envoyée${pending > 1 ? 's' : ''} : synchronise d’abord (ou force la déconnexion).`);
    await repo.reset();
    await repo.setMeta('deviceId', newDeviceId());
    library = createLibrary({ repo, deviceId: repo.meta('deviceId'), now });
    return { state: buildState() };
  }),

  syncNow: action(async () => ({ status: await runSync() })),

  syncStatus: () => repo.status(),

  /** Le jeton, uniquement à la demande (pour le coller dans le raccourci iPhone). */
  getToken: action(async () => ({ token: repo.meta('connection')?.token ?? '' })),

  importFiles: action(async (files) => {
    requireConnected();
    const imported = [];
    const skipped = [];
    const errors = [];
    for (const file of files ?? []) {
      try {
        const out = await library.importFiche(file.name, file.content);
        (out.skipped ? skipped : imported).push(out.book.titre);
      } catch (err) {
        errors.push(err.message);
      }
    }
    return { imported, skipped, errors, state: buildState() };
  }, { sync: true }),

  tokenUrl,

  on(event, callback) {
    (listeners[event] ??= []).push(callback);
    return () => { listeners[event] = listeners[event].filter((fn) => fn !== callback); };
  },
};

window.marginalia = api;
window.dispatchEvent(new Event('marginalia:api'));
