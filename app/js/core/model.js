/**
 * model.js — Ce que l'app calcule à partir des fichiers : la liste des livres, la file de révision,
 * le plan d'action, les statistiques. Logique pure : on lui donne des fichiers et des événements,
 * il renvoie des données prêtes à afficher. Aucune lecture de réseau ni de disque.
 */
import * as fiche from './fiche.js';
import * as review from './review.js';
import * as journal from './journal.js';
import { isDay, dayAdd, dayDiff, weekStart } from './days.js';

export const FICHES_DIR = 'fiches';
export const BOOKS_INDEX_PATH = '.marginalia/livres.json';
export const SETTINGS_PATH = '.marginalia/reglages.json';

export const isFichePath = (path) => path.startsWith(`${FICHES_DIR}/`) && path.endsWith('.md');
export const bookIdFromPath = (path) => path.slice(FICHES_DIR.length + 1, -3);
export const pathFromBookId = (id) => `${FICHES_DIR}/${id}.md`;

/* ------------------------------------------------------------------ */
/* Index des fiches                                                    */
/* ------------------------------------------------------------------ */

/** Lit une fiche du dépôt : { path, book, notes, synthesisPending }, ou null si ce n'est pas une fiche. */
export function readEntry(path, content) {
  if (!isFichePath(path) || typeof content !== 'string') return null;
  const parsed = fiche.readFiche(bookIdFromPath(path), content);
  return parsed ? { ...parsed, path } : null;
}

/** Livres en cours d'abord, puis par activité récente (dernière note, ou date de début). */
export function sortIndex(entries) {
  const rank = (b) => (b.statut === 'en-cours' ? 0 : 1);
  const activity = (b) => b.lastNoteDate || b.debut || '';
  return [...entries].sort((a, b) => rank(a.book) - rank(b.book)
    || activity(b.book).localeCompare(activity(a.book))
    || a.book.titre.localeCompare(b.book.titre, 'fr'));
}

/** [{path, content}] → [{ path, book, notes, synthesisPending }], livres en cours d'abord. */
export function buildIndex(files) {
  return sortIndex(files.map(({ path, content }) => readEntry(path, content)).filter(Boolean));
}

/** [{ book, notes }] → [{ book, note }] : une ligne par note, tous livres confondus. */
export const flatten = (index) => index.flatMap(({ book, notes }) => notes.map((note) => ({ book, note })));

/** Identifiant de note → note (pour rejouer les révisions). */
export function noteMap(index) {
  const map = new Map();
  for (const { note } of flatten(index)) if (note.id) map.set(note.id, note);
  return map;
}

/** Retrouve un livre par identifiant ou par titre (« Lettres à Lucilius » = « lettres-a-lucilius »). */
export function findBook(index, ref) {
  const key = String(ref ?? '').trim();
  if (!key) return null;
  return index.find((e) => e.book.id === key)
    ?? index.find((e) => fiche.sameTitle(e.book.titre, key) || fiche.slugify(e.book.id) === fiche.slugify(key))
    ?? null;
}

/** Le contenu du fichier lu par le raccourci iOS pour proposer la liste des livres. */
export function booksJson(index) {
  const livres = index.map(({ book }) => ({ id: book.id, titre: book.titre, auteur: book.auteur, statut: book.statut }));
  return {
    version: 1,
    enCours: livres.filter((b) => b.statut === 'en-cours').map((b) => b.titre),
    livres,
  };
}

/** Nombre de notes prises par jour (un jour avec une note est un jour « lu »). */
export function noteDays(index) {
  const days = new Map();
  for (const { note } of flatten(index)) {
    const day = String(note.date || '').slice(0, 10);
    if (isDay(day)) days.set(day, (days.get(day) || 0) + 1);
  }
  return days;
}

/** Retrouve une note par son identifiant, dans n'importe quelle fiche. */
export function locate(index, noteId) {
  if (!/^[A-Za-z0-9-]{1,40}$/.test(String(noteId))) throw new fiche.FicheError('Identifiant de note invalide', 'input');
  for (const entry of index) {
    const note = entry.notes.find((n) => n.id === noteId);
    if (note) return { ...entry, note };
  }
  throw new fiche.FicheError('Note introuvable : elle a peut-être été supprimée de la fiche.', 'missing');
}

/** Toutes les actions « À appliquer » de tous les livres. */
export function allTasks(index, today) {
  const out = [];
  for (const { book, note } of flatten(index)) {
    if (note.type !== 'appliquer' || !note.id || !note.tasks) continue;
    const day = String(note.date || '').slice(0, 10);
    note.tasks.forEach((task, i) => out.push({
      key: `${note.id}:${i}`,
      noteId: note.id,
      index: i,
      text: task.text,
      status: task.status,
      doneDate: task.doneDate,
      result: task.result,
      bookId: book.id,
      titre: book.titre,
      page: note.page,
      date: note.date,
      ageDays: isDay(day) ? Math.max(0, dayDiff(day, today)) : 0,
    }));
  }
  return out;
}

/** L'action de la semaine, si elle existe toujours et n'est pas encore faite. */
function resolveFocus(jr, open) {
  if (!jr.focus) return null;
  const task = open.find((t) => t.noteId === jr.focus.noteId && t.text === jr.focus.text);
  return task ? { ...task, since: jr.focus.since } : null;
}

/** La revue hebdo est « due » à partir du vendredi tant qu'elle n'a pas été faite cette semaine. */
function weeklyDue(jr, open, today) {
  if (!open.length) return false;
  const friday = dayAdd(weekStart(today), 4);
  if (today >= friday && jr.weeklyReview < friday) return true;
  return Boolean(jr.weeklyReview) && dayDiff(jr.weeklyReview, today) > 9;
}

function todayBlock(jr, days, goal, today, index = journal.indexDays(jr)) {
  const totals = journal.dayTotals(jr, today, index);
  const ratio = journal.goalRatio(totals, goal);
  return { ...totals, notes: days.get(today) || 0, goal, ratio: Math.min(1, ratio), done: ratio >= 1 };
}

/* ------------------------------------------------------------------ */
/* Le résumé permanent (pastilles, bandeau du jour)                    */
/* ------------------------------------------------------------------ */

export function overview({ index, rev, jr, today, goal, limit }) {
  const days = noteDays(index);
  const open = allTasks(index, today).filter((t) => t.status === 'open');
  const queue = review.buildQueue(flatten(index), rev, today, { limit });
  return {
    due: queue.queue.length,
    dueTotal: queue.dueTotal,
    actionsOpen: open.length,
    focus: resolveFocus(jr, open),
    weeklyReviewDue: weeklyDue(jr, open, today),
    today: todayBlock(jr, days, goal, today),
    streak: journal.streak(journal.readDays(jr, days), today),
    session: jr.active,
    progress: Object.fromEntries(Object.entries(jr.progress).map(([id, p]) => [id, p.page])),
  };
}

/* ------------------------------------------------------------------ */
/* Retenir                                                             */
/* ------------------------------------------------------------------ */

export function reviewPayload({ index, rev, today, limit, extra = 0 }) {
  const items = flatten(index);
  const { queue, dueTotal, doneToday } = review.buildQueue(items, rev, today, { limit, extra });
  return {
    queue: queue.map(({ book, note, card }) => ({
      noteId: note.id,
      bookId: book.id,
      titre: book.titre,
      auteur: book.auteur,
      type: note.type,
      label: note.label,
      page: note.page,
      date: note.date,
      text: note.text,
      comments: note.comments,
      tags: note.tags,
      cue: review.makeCue(note.text),
      box: card.box,
      isNew: card.reviews === 0,
      next: review.preview(card),
    })),
    dueTotal,
    doneToday,
    limit,
    stats: review.stats(items, rev, today),
  };
}

/* ------------------------------------------------------------------ */
/* Appliquer                                                           */
/* ------------------------------------------------------------------ */

export function actionsPayload({ index, jr, today }) {
  const tasks = allTasks(index, today);
  const open = tasks.filter((t) => t.status === 'open').sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const focus = resolveFocus(jr, open);
  const done = tasks.filter((t) => t.status === 'done');
  return {
    open: open.map((t) => ({ ...t, focus: Boolean(focus && focus.key === t.key) })),
    focus,
    done: done.sort((a, b) => String(b.doneDate).localeCompare(String(a.doneDate))).slice(0, 30),
    doneCount: done.length,
    cancelledCount: tasks.filter((t) => t.status === 'cancelled').length,
    weeklyReviewDue: weeklyDue(jr, open, today),
    lastWeeklyReview: jr.weeklyReview,
  };
}

/* ------------------------------------------------------------------ */
/* Lire                                                                */
/* ------------------------------------------------------------------ */

/** Le bilan d'un livre, affiché quand tu le termines. */
export function bookRecap({ index, jr, bookId, today }) {
  const entry = index.find((e) => e.book.id === bookId);
  if (!entry) throw new fiche.FicheError('Livre introuvable', 'missing');
  const { book, notes, synthesisPending } = entry;
  const sessions = jr.sessions.filter((s) => s.bookId === book.id);
  const count = (type) => notes.filter((n) => n.type === type).length;
  return {
    titre: book.titre,
    auteur: book.auteur,
    statut: book.statut,
    span: isDay(book.debut) ? dayDiff(book.debut, isDay(book.fin) ? book.fin : today) + 1 : null,
    sessions: sessions.length,
    minutes: sessions.reduce((sum, s) => sum + s.minutes, 0),
    notes: notes.length,
    citations: count('citation'),
    idees: count('idee'),
    questions: count('question'),
    actions: notes.reduce((sum, n) => sum + (n.tasks ? n.tasks.length : 0), 0),
    synthesisPending,
  };
}

/* ------------------------------------------------------------------ */
/* Progrès                                                             */
/* ------------------------------------------------------------------ */

export function statsPayload({ index, rev, jr, today, goal }) {
  const days = noteDays(index);
  const dayIndex = journal.indexDays(jr);
  const items = flatten(index);
  const monday = weekStart(today);
  const year = today.slice(0, 4);

  let reviews = 0;
  let recalled = 0;
  for (let day = monday; day <= today; day = dayAdd(day, 1)) {
    const entry = rev.log[day];
    if (!entry) continue;
    reviews += review.countLog(entry);
    recalled += entry.good + entry.easy;
  }
  const tasks = allTasks(index, today);
  const memory = review.stats(items, rev, today);

  const books = index.filter(({ book }) => book.statut === 'en-cours').map(({ book }) => {
    const page = jr.progress[book.id]?.page ?? 0;
    return {
      id: book.id,
      titre: book.titre,
      auteur: book.auteur,
      page,
      pages: book.pages,
      pct: book.pages ? Math.min(100, Math.round((page / book.pages) * 100)) : null,
      projection: journal.projection(jr, book.id, book.pages, today),
    };
  });

  // Une de tes citations, différente chaque jour (choix stable sur la journée).
  const citations = items.filter(({ note }) => note.type === 'citation' && note.text.length <= 320);
  const pick = citations.length ? citations[[...today].reduce((sum, c) => sum + c.charCodeAt(0), 0) % citations.length] : null;

  return {
    today: todayBlock(jr, days, goal, today, dayIndex),
    streak: journal.streak(journal.readDays(jr, days, dayIndex), today),
    calendar: journal.calendar(jr, days, goal, today, 12),
    pillars: {
      lire: journal.weekTotals(jr, today, dayIndex),
      retenir: { reviews, rate: reviews ? Math.round((recalled / reviews) * 100) : null, anchored: memory.anchored, rotation: memory.rotation },
      appliquer: {
        done: tasks.filter((t) => t.status === 'done' && t.doneDate >= monday).length,
        open: tasks.filter((t) => t.status === 'open').length,
      },
    },
    books,
    year: {
      label: year,
      finished: index.filter(({ book }) => book.statut === 'termine' && String(book.fin).startsWith(year)).length,
      notes: [...days].reduce((sum, [day, n]) => (day.startsWith(year) ? sum + n : sum), 0),
      ...journal.yearTotals(jr, year, dayIndex),
    },
    quote: pick ? { text: pick.note.text, titre: pick.book.titre, auteur: pick.book.auteur } : null,
  };
}
