/**
 * library.js — Ta bibliothèque : tout ce que l'app sait faire (noter, réviser, cocher une action,
 * chronométrer une lecture…), traduit en opérations sur le dépôt.
 *
 * Deux sortes d'écritures :
 *  - les FICHES (fiches/*.md) : modifiées par des opérations ciblées (ajouter une note, cocher une action) ;
 *  - le JOURNAL (.marginalia/journal/*.jsonl) : chaque révision, session ou progression est un événement
 *    ajouté au carnet de CET appareil. L'état (cartes, séries, pages lues) se recalcule en rejouant tout.
 */
import * as fiche from '../core/fiche.js';
import * as model from '../core/model.js';
import * as events from '../core/events.js';
import * as review from '../core/review.js';
import * as journal from '../core/journal.js';
import { toDay } from '../core/days.js';
import { parseInboxFile, isInboxPath } from '../core/inbox.js';

export const DEFAULT_SETTINGS = {
  goal: { type: 'minutes', value: 15 },
  reviewLimit: 8,
  ritual: { time: '21:00' },
};

export const README_PATH = 'README.md';

export const DATA_README = `# Mes lectures — données Marginalia

Ce dépôt privé contient tes notes de lecture. L'app Marginalia (sur ton iPhone) le lit et l'écrit ;
tu peux aussi l'ouvrir dans Obsidian sur ton PC.

| Dossier | Contenu |
|---|---|
| \`fiches/\` | Une fiche Markdown par livre : métadonnées, synthèse, notes (citations, idées, questions, actions). |
| \`boite/\` | La boîte de réception du raccourci iPhone « Noter ». L'app range chaque note dans la bonne fiche, puis vide la boîte. |
| \`.marginalia/journal/\` | Le journal de chaque appareil : révisions, sessions de lecture, progression (une ligne JSON par événement). |
| \`.marginalia/livres.json\` | La liste des livres, lue par le raccourci iPhone. Générée par l'app. |
| \`.marginalia/reglages.json\` | Tes réglages partagés entre appareils (objectif du jour, cartes par jour). |

Tu peux modifier les fiches à la main (dans Obsidian ou sur GitHub) : l'app relit tout à la synchronisation suivante.
Évite seulement de toucher aux lignes \`^abc123\` sous les notes : ce sont leurs identifiants (ils relient
une note à son historique de révision).
`;

const clone = (x) => (typeof structuredClone === 'function' ? structuredClone(x) : JSON.parse(JSON.stringify(x)));

export function createLibrary({ repo, deviceId, now = () => new Date() }) {
  const ficheCache = new Map(); // chemin → { content, entry }
  const logCache = new Map(); // chemin → { content, events }
  let memo = { version: -1 };
  let lastSaved = null; // dernière note enregistrée (pour « Annuler »)

  const today = () => toDay(now());

  /* ------------------------------ Lecture de l'état ------------------------------ */

  function snapshot() {
    if (memo.version === repo.version) return memo;
    const entries = [];
    const all = [];
    for (const path of repo.paths()) {
      if (model.isFichePath(path)) {
        const content = repo.read(path);
        let cached = ficheCache.get(path);
        if (!cached || cached.content !== content) {
          cached = { content, entry: model.readEntry(path, content) };
          ficheCache.set(path, cached);
        }
        if (cached.entry) entries.push(cached.entry);
      } else if (events.isLogPath(path)) {
        const content = repo.read(path);
        let cached = logCache.get(path);
        if (!cached || cached.content !== content) {
          cached = { content, events: events.parseLog(content) };
          logCache.set(path, cached);
        }
        all.push(...cached.events);
      }
    }
    const index = model.sortIndex(entries);
    const { rev, jr, errors } = events.replay(all, model.noteMap(index));
    memo = { version: repo.version, index, rev, jr, errors };
    return memo;
  }

  const index = () => snapshot().index;

  function entryFor(bookId) {
    const entry = index().find((e) => e.book.id === bookId);
    if (!entry) throw new fiche.FicheError('Livre introuvable : la fiche a peut-être été renommée ou supprimée.', 'missing');
    return entry;
  }

  /** Les réglages partagés entre tes appareils (.marginalia/reglages.json), complétés par les valeurs par défaut. */
  function settings() {
    let stored = {};
    try { stored = JSON.parse(repo.read(model.SETTINGS_PATH) || '{}') || {}; } catch { stored = {}; }
    return {
      goal: stored.goal?.value ? { type: stored.goal.type === 'pages' ? 'pages' : 'minutes', value: Number(stored.goal.value) } : DEFAULT_SETTINGS.goal,
      reviewLimit: Number(stored.reviewLimit) || DEFAULT_SETTINGS.reviewLimit,
      ritual: { ...DEFAULT_SETTINGS.ritual, ...(stored.ritual || {}) },
    };
  }

  async function setSharedSetting(key, value) {
    await repo.enqueue({ path: model.SETTINGS_PATH, kind: 'json-set', args: { key, value }, label: `réglage ${key}` });
  }

  /* ------------------------------ Journal d'événements ------------------------------ */

  async function record(type, data, label) {
    const event = events.makeEvent(type, data, { now: now(), deviceId });
    await repo.enqueue({
      path: events.logPath(event.day, deviceId),
      kind: 'append-lines',
      args: { lines: [events.serialize(event)] },
      label: label || `journal (${type})`,
    });
    return event;
  }

  /** La page d'une note (ou saisie) fait avancer la progression — seulement si elle avance vraiment. */
  async function advancePage(bookId, page) {
    if (journal.toPageNumber(page) === null) return { moved: false };
    const jr = clone(snapshot().jr);
    if (!journal.advance(jr, bookId, page, today())) return { moved: false };
    await record('progress', { bookId, page: String(page), mode: 'advance' }, 'progression');
    return { moved: true };
  }

  /* ------------------------------ Livres ------------------------------ */

  function freeBookId(titre, auteur) {
    const base = fiche.slugify(titre) || 'livre';
    const candidates = [base];
    if (fiche.slugify(auteur)) candidates.push(`${base}-${fiche.slugify(auteur)}`);
    for (let n = 2; n < 100; n++) candidates.push(`${base}-${n}`);
    const id = candidates.find((c) => !repo.exists(model.pathFromBookId(c)));
    if (!id) throw new fiche.FicheError('Impossible de trouver un nom de fichier libre pour ce livre', 'input');
    return id;
  }

  async function createBook(input = {}) {
    const clean = fiche.sanitizeBookInput(input);
    const existing = index().find((e) => fiche.sameTitle(e.book.titre, clean.titre)
      && (!clean.auteur || !e.book.auteur || fiche.sameTitle(e.book.auteur, clean.auteur)));
    if (existing) throw new fiche.FicheError(`« ${existing.book.titre} » est déjà dans ta bibliothèque.`, 'input');
    const id = freeBookId(clean.titre, clean.auteur);
    await repo.enqueue({
      path: model.pathFromBookId(id),
      kind: 'create',
      args: { content: fiche.bookTemplate(clean, now()) },
      label: `nouveau livre « ${clean.titre} »`,
    });
    // Livre déjà entamé : la page actuelle sert de point de départ, sans compter de pages « lues ».
    const start = String(input.pageActuelle ?? '').trim();
    await record('progress', { bookId: id, page: /^\d{1,5}$/.test(start) ? start : '0', mode: 'baseline' }, 'point de départ');
    await syncBooksJson();
    return { book: entryFor(id).book };
  }

  async function setBookStatus(bookId, statut) {
    const entry = entryFor(bookId);
    if (!fiche.BOOK_STATUSES.includes(statut)) throw new fiche.FicheError('Statut inconnu', 'input');
    const label = { 'en-cours': 'repris', termine: 'terminé', abandonne: 'mis de côté' }[statut];
    await repo.enqueue({ path: entry.path, kind: 'set-status', args: { statut }, label: `« ${entry.book.titre} » ${label}` });
    await syncBooksJson();
    return { recap: statut === 'termine' ? bookRecap(bookId) : null };
  }

  function bookRecap(bookId) {
    const { index: idx, jr } = snapshot();
    return model.bookRecap({ index: idx, jr, bookId, today: today() });
  }

  async function writeSynthesis(bookId, text) {
    const entry = entryFor(bookId);
    const clean = fiche.normalizeBody(text);
    if (!clean) throw new fiche.FicheError('La synthèse est vide', 'input');
    if (clean.length > fiche.LIMITS.synthesis) throw new fiche.FicheError('Synthèse trop longue', 'input');
    await repo.enqueue({ path: entry.path, kind: 'write-synthesis', args: { text: clean }, label: `synthèse de « ${entry.book.titre} »` });
    return {};
  }

  async function correctProgress(bookId, page) {
    entryFor(bookId);
    const value = journal.toPageNumber(page);
    if (value === null) throw new fiche.FicheError('Numéro de page invalide', 'input');
    await record('progress', { bookId, page: String(value), mode: 'correct' }, 'progression corrigée');
    return { page: value };
  }

  /** Importe une fiche Markdown existante (V1/V2 sur le PC, ou écrite dans Obsidian). */
  async function importFiche(name, content) {
    const text = String(content ?? '').replace(/\r\n/g, '\n');
    const parsed = fiche.readFiche('import', text);
    if (!parsed) throw new fiche.FicheError(`« ${name} » n'est pas une fiche de lecture (il manque « type: lecture » en en-tête).`, 'format');
    const existing = index().find((e) => fiche.sameTitle(e.book.titre, parsed.book.titre));
    if (existing) return { book: existing.book, skipped: true };
    const id = freeBookId(parsed.book.titre, parsed.book.auteur);
    const used = new Set(model.flatten(index()).map(({ note }) => note.id).filter(Boolean));
    await repo.enqueue({
      path: model.pathFromBookId(id),
      kind: 'create',
      args: { content: fiche.ensureNoteIds(text, used).content },
      label: `import de « ${parsed.book.titre} »`,
    });
    await syncBooksJson();
    return { book: entryFor(id).book, skipped: false };
  }

  /* ------------------------------ Notes ------------------------------ */

  function usedIds() {
    return new Set(model.flatten(index()).map(({ note }) => note.id).filter(Boolean));
  }

  async function saveNote(bookId, input = {}) {
    const entry = entryFor(bookId);
    const note = fiche.sanitizeNoteInput(input);
    const block = fiche.formatNote({ ...note, date: fiche.formatDateTime(now()), id: fiche.generateId(usedIds()) });
    const where = note.page ? ` p. ${note.page}` : '';
    const { op } = await repo.enqueue({
      path: entry.path,
      kind: 'append-note',
      args: { block },
      label: `${fiche.NOTE_TYPES[note.type].label.toLowerCase()}${where} dans « ${entry.book.titre} »`,
    });
    if (note.page) await advancePage(bookId, note.page); // noter p. 71, c'est avoir lu jusqu'à la p. 71
    lastSaved = { bookId, block, seq: op?.seq ?? null };
    return { block, note: fiche.parseNotes(block)[0] };
  }

  /** Annule la dernière note : simplement retirée de la file si elle n'est pas encore partie, sinon retirée de la fiche. */
  async function undoNote(bookId, block) {
    const entry = entryFor(bookId);
    if (lastSaved && lastSaved.block === block && lastSaved.seq !== null && await repo.cancel(lastSaved.seq)) {
      lastSaved = null;
      return {};
    }
    const id = /\n\^([A-Za-z0-9-]+)\s*$/.exec(String(block ?? ''))?.[1];
    if (!id) throw new fiche.FicheError('Note introuvable', 'missing');
    await repo.enqueue({ path: entry.path, kind: 'remove-note', args: { noteId: id, block }, label: `note annulée dans « ${entry.book.titre} »` });
    lastSaved = null;
    return {};
  }

  async function addReflection(noteId, text) {
    const { book, path } = model.locate(index(), noteId);
    const clean = fiche.normalizeBody(text);
    if (!clean) throw new fiche.FicheError('Écris d’abord ta reformulation', 'input');
    await repo.enqueue({ path, kind: 'add-reflection', args: { noteId, text: clean }, label: `reformulation dans « ${book.titre} »` });
    return {};
  }

  /* ------------------------------ Retenir ------------------------------ */

  function reviewPayload({ limit, extra = 0 }) {
    const { index: idx, rev } = snapshot();
    return model.reviewPayload({ index: idx, rev, today: today(), limit, extra });
  }

  async function gradeCard(noteId, grade) {
    const { note } = model.locate(index(), noteId);
    if (!review.isReviewable(note)) throw new fiche.FicheError('Cette note ne fait pas partie des révisions.', 'input');
    if (!review.GRADES.includes(grade)) throw new fiche.FicheError('Réponse inconnue', 'input');
    const rev = clone(snapshot().rev);
    const card = review.applyGrade(rev, note, grade, today());
    await record('review', { noteId, grade }, 'révision');
    return { card };
  }

  async function suspendCard(noteId) {
    model.locate(index(), noteId);
    await record('suspend', { noteId }, 'carte retirée des révisions');
    return {};
  }

  /* ------------------------------ Appliquer ------------------------------ */

  function actionsPayload() {
    const { index: idx, jr } = snapshot();
    return model.actionsPayload({ index: idx, jr, today: today() });
  }

  async function setTask({ noteId, index: i, status, result, expectedText } = {}) {
    const { book, note, path } = model.locate(index(), noteId);
    const n = Number(i);
    if (!Number.isInteger(n) || n < 0 || n > 500) throw new fiche.FicheError('Action invalide', 'input');
    if (!['done', 'open', 'cancelled'].includes(status)) throw new fiche.FicheError("État d'action inconnu", 'input');
    const task = note.tasks?.[n];
    if (!task) throw new fiche.FicheError('Action introuvable : la fiche a été modifiée entre-temps.', 'missing');
    const label = { done: 'action faite', open: 'action rouverte', cancelled: 'action abandonnée' }[status];
    await repo.enqueue({
      path,
      kind: 'update-task',
      args: { noteId, index: n, status, result: status === 'done' ? String(result ?? '') : undefined, expectedText },
      label: `${label} (« ${book.titre} »)`,
    });
    const { jr } = snapshot();
    if (status !== 'open' && jr.focus && jr.focus.noteId === noteId && jr.focus.text === task.text) {
      await record('unfocus', {}, 'action de la semaine terminée'); // faite (ou abandonnée) : le focus se libère
    }
    return { text: task.text };
  }

  async function setFocus(target) {
    if (!target) {
      await record('unfocus', {}, 'action de la semaine retirée');
      return {};
    }
    const { note } = model.locate(index(), target.noteId);
    const task = note.tasks?.[Number(target.index)];
    if (!task || task.status !== 'open') throw new fiche.FicheError('Action introuvable : la fiche a été modifiée entre-temps.', 'missing');
    await record('focus', { noteId: note.id, text: task.text }, 'action de la semaine');
    return {};
  }

  async function weeklyReviewDone() {
    await record('weekly', {}, 'revue de la semaine');
    return {};
  }

  /* ------------------------------ Lire ------------------------------ */

  async function startSession({ bookId, page } = {}) {
    const { book } = entryFor(bookId);
    const jr = clone(snapshot().jr);
    if (jr.active) throw new fiche.FicheError('Une session est déjà en cours.', 'input');
    const clean = String(page ?? '').trim().slice(0, fiche.LIMITS.page);
    const event = await record('session-start', { bookId: book.id, titre: book.titre, page: clean }, `lecture de « ${book.titre} »`);
    return { session: snapshot().jr.active ?? { bookId: book.id, titre: book.titre, start: event.t } };
  }

  async function stopSession({ toPage, minutes } = {}) {
    const jr = clone(snapshot().jr);
    if (!jr.active) throw new fiche.FicheError('Aucune session en cours.', 'input');
    const preview = journal.stopSession(jr, { toPage, minutes }, now()); // calcule la durée et les pages
    const event = await record('session-stop', { toPage: String(toPage ?? '').trim().slice(0, fiche.LIMITS.page), minutes: preview.minutes }, 'fin de lecture');
    const saved = snapshot().jr.sessions.find((s) => s.id === event.id);
    return { session: saved ?? { ...preview, id: event.id } };
  }

  async function cancelSession() {
    if (!snapshot().jr.active) return {};
    await record('session-cancel', {}, 'session annulée');
    return {};
  }

  /* ------------------------------ Résumés ------------------------------ */

  function overview({ goal, limit }) {
    const { index: idx, rev, jr } = snapshot();
    return model.overview({ index: idx, rev, jr, today: today(), goal, limit });
  }

  function statsPayload({ goal }) {
    const { index: idx, rev, jr } = snapshot();
    return model.statsPayload({ index: idx, rev, jr, today: today(), goal });
  }

  /* ------------------------------ Entretien (après chaque réception) ------------------------------ */

  /** Garde à jour la liste des livres lue par le raccourci iPhone. */
  async function syncBooksJson() {
    const wanted = model.booksJson(index());
    let current = null;
    try { current = JSON.parse(repo.read(model.BOOKS_INDEX_PATH) || 'null'); } catch { current = null; }
    if (JSON.stringify(current) === JSON.stringify(wanted)) return false;
    await repo.enqueue({
      path: model.BOOKS_INDEX_PATH,
      kind: 'write',
      args: { content: `${JSON.stringify(wanted, null, 2)}\n` },
      label: 'liste des livres pour le raccourci',
    });
    return true;
  }

  /** Notes ajoutées à la main (Obsidian) ou fiches de la V1 : chaque note reçoit son identifiant. */
  async function ensureIds() {
    let fixed = 0;
    for (const entry of index()) {
      if (!entry.book.missingIds) continue;
      await repo.enqueue({ path: entry.path, kind: 'ensure-ids', label: `identifiants des notes de « ${entry.book.titre} »` });
      fixed += 1;
    }
    return fixed;
  }

  /** « 20261117-213012-ab12.md » → « 2026-11-17 21:30 » (si l'en-tête ne donne pas de date). */
  function dateFromName(path) {
    const m = /(\d{4})(\d{2})(\d{2})[-_T]?(\d{2})(\d{2})/.exec(path.split('/').pop());
    return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : '';
  }

  /** Le livre où ranger une note de la boîte : celui nommé (créé s'il n'existe pas), sinon le livre en cours. */
  async function inboxTarget(livre, currentBookId) {
    if (livre) {
      const found = model.findBook(index(), livre);
      if (found) return found;
      const { book } = await createBook({ titre: livre });
      return entryFor(book.id);
    }
    const idx = index();
    const current = idx.find((e) => e.book.id === currentBookId && e.book.statut === 'en-cours')
      ?? idx.find((e) => e.book.statut === 'en-cours');
    if (current) return current;
    const { book } = await createBook({ titre: 'À classer' });
    return entryFor(book.id);
  }

  /**
   * Range les notes envoyées par le raccourci iPhone (dossier boite/) dans leurs fiches, puis vide la boîte.
   * L'identifiant de la note est calculé à partir du nom du fichier : si l'app s'arrête au milieu (ou si
   * deux appareils rangent la même note), la note n'est jamais ajoutée deux fois.
   */
  async function integrateInbox({ currentBookId = null } = {}) {
    const leaving = new Set(repo.pendingOps().filter((o) => o.kind === 'delete').map((o) => o.path));
    const files = repo.paths('boite/').filter((p) => isInboxPath(p) && !leaving.has(p));
    const added = [];
    for (const path of files) {
      let parsed;
      try {
        parsed = parseInboxFile(repo.read(path));
      } catch {
        await repo.enqueue({ path, kind: 'delete', label: 'boîte : note vide retirée' });
        continue;
      }
      const target = await inboxTarget(parsed.livre, currentBookId);
      // Le 💭 d'une idée ou d'une question rejoint son texte (seules les citations ont un commentaire séparé).
      const text = parsed.type !== 'citation' && parsed.comment ? `${parsed.text}\n\n${parsed.comment}` : parsed.text;
      let note;
      try {
        note = fiche.sanitizeNoteInput({ ...parsed, text });
      } catch {
        note = fiche.sanitizeNoteInput({ ...parsed, text, page: '' }); // page illisible : la note passe quand même
      }
      const date = parsed.date || dateFromName(path) || fiche.formatDateTime(now());
      const block = fiche.formatNote({ ...note, date, id: fiche.idFromName(path) });
      await repo.enqueue({
        path: target.path,
        kind: 'append-note',
        args: { block },
        label: `${fiche.NOTE_TYPES[note.type].label.toLowerCase()} (raccourci) dans « ${target.book.titre} »`,
      });
      if (note.page) await advancePage(target.book.id, note.page);
      await repo.enqueue({ path, kind: 'delete', label: 'boîte : note rangée' });
      added.push({ titre: target.book.titre, type: note.type });
    }
    return added;
  }

  async function ensureReadme() {
    if (repo.exists(README_PATH)) return false;
    await repo.enqueue({ path: README_PATH, kind: 'create', args: { content: DATA_README }, label: 'présentation du dépôt' });
    return true;
  }

  async function maintain({ currentBookId } = {}) {
    const added = await integrateInbox({ currentBookId });
    await ensureIds();
    await syncBooksJson();
    return { added };
  }

  return {
    snapshot, index, today, settings, setSharedSetting, entryFor,
    createBook, setBookStatus, bookRecap, writeSynthesis, correctProgress, importFiche,
    saveNote, undoNote, addReflection, advancePage,
    reviewPayload, gradeCard, suspendCard,
    actionsPayload, setTask, setFocus, weeklyReviewDone,
    startSession, stopSession, cancelSession,
    overview, statsPayload,
    syncBooksJson, ensureIds, integrateInbox, ensureReadme, maintain,
  };
}
