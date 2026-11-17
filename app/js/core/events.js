/**
 * events.js — Le journal d'événements : révisions, sessions de lecture, progression, action de la semaine.
 *
 * Pourquoi des événements plutôt qu'un fichier d'état ? Parce que deux appareils qui réécrivent le même
 * fichier finissent par s'écraser mutuellement. Ici, chaque appareil n'écrit QUE dans son propre carnet
 * (.marginalia/journal/2026-11-abc123.jsonl, une ligne JSON par événement), et l'état est recalculé en
 * rejouant tous les carnets dans l'ordre chronologique. Deux appareils ne peuvent donc jamais entrer
 * en conflit — c'est le principe de l'« event sourcing ».
 */
import * as review from './review.js';
import * as journal from './journal.js';
import { toDay, isDay } from './days.js';

export const LOG_DIR = '.marginalia/journal';
export const EVENT_TYPES = new Set([
  'review', 'suspend', 'unsuspend', 'progress',
  'session-start', 'session-stop', 'session-cancel',
  'focus', 'unfocus', 'weekly',
]);

/** Identifiant court et unique d'événement (sert à éliminer les doublons d'un envoi répété). */
function eventId() {
  return globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

/** Crée un événement horodaté : `t` = instant précis, `day` = jour local, `dev` = appareil. */
export function makeEvent(type, data, { now = new Date(), deviceId }) {
  if (!EVENT_TYPES.has(type)) throw new Error(`Événement inconnu : ${type}`);
  return { id: eventId(), t: now.toISOString(), day: toDay(now), dev: deviceId, type, ...data };
}

/** Le carnet d'un appareil pour un mois donné : les fichiers restent petits. */
export function logPath(day, deviceId) {
  return `${LOG_DIR}/${day.slice(0, 7)}-${deviceId}.jsonl`;
}

export const isLogPath = (path) => path.startsWith(`${LOG_DIR}/`) && path.endsWith('.jsonl');

export const serialize = (event) => JSON.stringify(event);

/** Lit un carnet ; une ligne abîmée est ignorée plutôt que de tout bloquer. */
export function parseLog(content) {
  const events = [];
  for (const line of String(content ?? '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e && EVENT_TYPES.has(e.type) && typeof e.t === 'string' && isDay(e.day)) events.push(e);
    } catch { /* ligne illisible : ignorée */ }
  }
  return events;
}

/** Ordre chronologique stable, sans doublons (un même événement renvoyé deux fois ne compte qu'une fois). */
export function sortEvents(events) {
  const byId = new Map();
  for (const e of events) if (!byId.has(e.id)) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) => a.t.localeCompare(b.t) || String(a.dev).localeCompare(String(b.dev)) || a.id.localeCompare(b.id));
}

/**
 * Rejoue les événements pour reconstruire l'état de la mémoire (révisions) et du journal de lecture.
 * @param events  tous les événements, de tous les appareils
 * @param notes   Map identifiant de note → note (pour connaître son type et sa date)
 */
export function replay(events, notes = new Map()) {
  const rev = review.emptyState();
  const jr = journal.emptyJournal();
  const errors = [];
  for (const e of sortEvents(events)) {
    try {
      switch (e.type) {
        case 'review': {
          const note = notes.get(e.noteId);
          if (note && review.isReviewable(note)) review.applyGrade(rev, note, e.grade, e.day);
          break;
        }
        case 'suspend': {
          const note = notes.get(e.noteId) ?? { id: e.noteId, type: 'citation', date: '' };
          rev.cards[e.noteId] = { ...review.cardFor(rev, note, e.day), suspended: true };
          break;
        }
        case 'unsuspend':
          if (rev.cards[e.noteId]) delete rev.cards[e.noteId].suspended;
          break;
        case 'progress':
          if (e.mode === 'correct') journal.correct(jr, e.bookId, e.page, e.day);
          else if (e.mode === 'baseline') journal.setBaseline(jr, e.bookId, e.page, e.day);
          else journal.advance(jr, e.bookId, e.page, e.day);
          break;
        case 'session-start':
          jr.active = null; // une session restée ouverte (sur un autre appareil) est abandonnée
          // La page indiquée au démarrage compte comme lue (lecture faite sans chrono entre-temps).
          if (journal.toPageNumber(e.page) !== null) journal.advance(jr, e.bookId, e.page, e.day);
          journal.startSession(jr, { bookId: e.bookId, titre: e.titre, page: e.page }, new Date(e.t));
          break;
        case 'session-stop':
          if (jr.active) {
            const session = journal.stopSession(jr, { toPage: e.toPage, minutes: e.minutes }, new Date(e.t));
            session.id = e.id;
          }
          break;
        case 'session-cancel':
          journal.cancelSession(jr);
          break;
        case 'focus':
          jr.focus = { noteId: e.noteId, text: e.text, since: e.day };
          break;
        case 'unfocus':
          jr.focus = null;
          break;
        case 'weekly':
          jr.weeklyReview = e.day;
          break;
        default:
          break;
      }
    } catch (err) {
      errors.push({ event: e, message: err.message });
    }
  }
  return { rev, jr, errors };
}
