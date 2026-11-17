
/**
 * review.js — La révision espacée (logique pure, sans fichier ni interface).
 *
 * Pourquoi : relire ou surligner ne fixe presque rien. Ce qui ancre un souvenir, c'est d'aller le
 * RECHERCHER de mémoire (effet de test), à intervalles de plus en plus longs (effet d'espacement).
 *
 * Comment : un système de Leitner. Chaque note est une carte rangée dans une « boîte ».
 *   boîte   1    2    3     4     5     6      7
 *   délai   1 j  3 j  7 j  14 j  30 j  60 j  120 j
 *   « Je l'avais » → boîte suivante (délai plus long)
 *   « Facile »     → saute une boîte
 *   « À revoir »   → retour en boîte 1 (demain)
 * À partir de la boîte 5 (un mois sans oubli), on considère la note « ancrée ».
 */

import { dayAdd, isDay } from './days.js';

const INTERVALS = [1, 3, 7, 14, 30, 60, 120];
const LAST_BOX = INTERVALS.length;
const ANCHORED_BOX = 5;
const GRADES = ['again', 'good', 'easy'];
const REVIEWABLE = new Set(['citation', 'idee', 'question']); // les « À appliquer » vivent dans l'onglet Appliquer

const emptyState = () => ({ version: 1, cards: {}, log: {} });

const isReviewable = (note) => Boolean(note.id) && REVIEWABLE.has(note.type);

/** Première révision : le LENDEMAIN de la prise de note (se tester tout de suite n'apprend rien). */
function firstDue(noteDate, today) {
  const day = String(noteDate || '').slice(0, 10);
  return dayAdd(isDay(day) ? day : today, 1);
}

/** La carte d'une note. Tant qu'elle n'a jamais été révisée, elle n'existe pas dans le fichier : on la calcule. */
function cardFor(state, note, today) {
  return state.cards[note.id] ?? { box: 1, due: firstDue(note.date, today), last: '', reviews: 0, lapses: 0 };
}

function nextBox(box, grade) {
  if (grade === 'again') return 1;
  return Math.min(LAST_BOX, box + (grade === 'easy' ? 2 : 1));
}

/** Dans combien de jours la carte reviendra, selon la réponse (affiché sur les boutons). */
function preview(card) {
  return Object.fromEntries(GRADES.map((grade) => [grade, INTERVALS[nextBox(card.box, grade) - 1]]));
}

/** Enregistre une réponse : déplace la carte de boîte, fixe sa prochaine date, tient le journal du jour. */
function applyGrade(state, note, grade, today) {
  if (!GRADES.includes(grade)) throw new Error('Réponse inconnue');
  const card = { ...cardFor(state, note, today) };
  card.box = nextBox(card.box, grade);
  if (grade === 'again') card.lapses += 1;
  card.reviews += 1;
  card.last = today;
  card.due = dayAdd(today, INTERVALS[card.box - 1]);
  state.cards[note.id] = card;

  const log = (state.log[today] ??= { again: 0, good: 0, easy: 0 });
  log[grade] += 1;
  return card;
}

const countLog = (entry) => (entry ? entry.again + entry.good + entry.easy : 0);

/**
 * Les cartes à réviser aujourd'hui, les plus en retard d'abord, plafonnées à `limit` par jour
 * (mieux vaut 5 minutes tous les jours qu'une heure une fois). `extra` permet d'en demander plus.
 * @param items [{ book, note }]
 */
function buildQueue(items, state, today, { limit = 8, extra = 0 } = {}) {
  const due = [];
  for (const item of items) {
    if (!isReviewable(item.note)) continue;
    const card = cardFor(state, item.note, today);
    if (card.suspended || card.due > today) continue;
    due.push({ ...item, card });
  }
  due.sort((a, b) => a.card.due.localeCompare(b.card.due) || String(a.note.date).localeCompare(String(b.note.date)));
  const doneToday = countLog(state.log[today]);
  const room = Math.max(0, limit - doneToday) + extra;
  return { queue: due.slice(0, room), dueTotal: due.length, doneToday };
}

/** L'état de ta mémoire : répartition par boîte, notes ancrées, taux de réussite, prochaine échéance. */
function stats(items, state, today) {
  const boxes = Array(LAST_BOX).fill(0);
  let rotation = 0;
  let fresh = 0;
  let anchored = 0;
  let suspended = 0;
  const upcoming = new Map();

  for (const item of items) {
    if (!isReviewable(item.note)) continue;
    const card = cardFor(state, item.note, today);
    if (card.suspended) { suspended++; continue; }
    rotation++;
    if (card.reviews === 0) fresh++;
    else boxes[card.box - 1]++;
    if (card.reviews > 0 && card.box >= ANCHORED_BOX) anchored++;
    if (card.due > today) upcoming.set(card.due, (upcoming.get(card.due) || 0) + 1);
  }

  let good = 0;
  let total = 0;
  for (let k = 0; k < 30; k++) {
    const entry = state.log[dayAdd(today, -k)];
    if (!entry) continue;
    good += entry.good + entry.easy;
    total += countLog(entry);
  }

  const nextDay = [...upcoming.keys()].sort()[0];
  return {
    rotation, fresh, anchored, suspended, boxes,
    intervals: INTERVALS,
    retention: total ? { rate: Math.round((good / total) * 100), total } : null,
    next: nextDay ? { day: nextDay, count: upcoming.get(nextDay) } : null,
  };
}

/**
 * L'amorce affichée au recto de la carte : les premiers mots seulement.
 * Assez pour savoir de quelle note il s'agit, pas assez pour lire la réponse.
 */
function makeCue(text) {
  const words = String(text).replace(/\s+/g, ' ').trim().split(' ');
  // Note très courte : un seul mot, sinon l'amorce donnerait toute la réponse.
  const n = words.length <= 5 ? 1 : Math.min(9, Math.max(3, Math.ceil(words.length * 0.3)));
  return `${words.slice(0, n).join(' ').replace(/[\s,;:.!?…«»"“”]+$/u, '')}…`;
}

export {
  INTERVALS, ANCHORED_BOX, GRADES,
  emptyState, isReviewable, firstDue, cardFor, preview, applyGrade, countLog, buildQueue, stats, makeCue,
};
