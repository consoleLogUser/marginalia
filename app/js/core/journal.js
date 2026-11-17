/**
 * journal.js — Le journal de lecture (logique pure) : sessions chronométrées, progression page par page,
 * série de jours, calendrier et date de fin estimée.
 *
 * Deux idées de conception :
 *   1. La progression d'un livre ne fait qu'AVANCER (sauf correction explicite). Revenir p. 12 pour
 *      noter une citation ne te fait pas « reculer » dans le livre.
 *   2. Les pages lues un jour donné = page atteinte en fin de journée − page de départ ce jour-là.
 *      Pas besoin de chronomètre pour que ta lecture compte.
 */

import { toDay, dayAdd, dayDiff, weekStart } from './days.js';

/** ≈ 40 pages à l'heure : sert seulement d'équivalence minutes ↔ pages quand tu lis sans chrono. */
const PAGES_PER_MINUTE = 2 / 3;

const emptyJournal = () => ({ version: 1, sessions: [], progress: {}, days: {}, active: null, focus: null, weeklyReview: '' });

/** « 42 » → 42. Tout le reste (« xii », « empl. 120 ») → null : pas de suivi de progression possible. */
function toPageNumber(value) {
  const s = String(value ?? '').trim();
  return /^\d{1,5}$/.test(s) ? Number(s) : null;
}

/** Fixe le point de départ d'un livre sans compter de pages lues (livre déjà entamé avant d'utiliser l'app). */
function setBaseline(journal, bookId, page, today) {
  if (journal.progress[bookId]) return false;
  journal.progress[bookId] = { page: toPageNumber(page) ?? 0, updated: today };
  return true;
}

/** Avance la progression d'un livre. Renvoie true si elle a bougé. */
function advance(journal, bookId, page, today) {
  const n = toPageNumber(page);
  if (n === null) return false;
  const previous = journal.progress[bookId];
  if (!previous) {
    journal.progress[bookId] = { page: n, updated: today }; // premier repère : rien à créditer
    return true;
  }
  if (n <= previous.page) return false;
  const day = (journal.days[today] ??= {});
  const entry = (day[bookId] ??= { from: previous.page, to: previous.page });
  entry.to = n;
  journal.progress[bookId] = { page: n, updated: today };
  return true;
}

/** Correction explicite (faute de frappe, mauvaise page) : la seule façon de faire reculer la progression. */
function correct(journal, bookId, page, today) {
  const n = toPageNumber(page);
  if (n === null) throw new Error('Numéro de page invalide');
  journal.progress[bookId] = { page: n, updated: today };
  const entry = journal.days[today]?.[bookId];
  if (entry) {
    entry.to = n;
    if (entry.from > n) entry.from = n;
  }
  return n;
}

function startSession(journal, { bookId, titre, page }, now) {
  if (journal.active) throw new Error('Une session est déjà en cours.');
  setBaseline(journal, bookId, page, toDay(now));
  journal.active = { bookId, titre, start: now.toISOString(), fromPage: journal.progress[bookId].page };
  return journal.active;
}

/**
 * Termine la session : durée (celle du chrono, ou celle que tu corriges) et page atteinte.
 * Une session à cheval sur minuit est comptée le jour où elle a commencé.
 */
function stopSession(journal, { toPage, minutes } = {}, now) {
  const active = journal.active;
  if (!active) throw new Error('Aucune session en cours.');
  const day = toDay(new Date(active.start));
  const elapsed = Math.round((now - new Date(active.start)) / 60000);
  const asked = minutes === undefined || minutes === null || minutes === '' ? NaN : Number(minutes);
  const duration = Math.min(600, Math.max(0, Math.round(Number.isFinite(asked) ? asked : elapsed)));

  const before = journal.progress[active.bookId]?.page ?? active.fromPage ?? 0;
  advance(journal, active.bookId, toPage, day);
  const after = journal.progress[active.bookId]?.page ?? before;

  const session = {
    id: globalThis.crypto.randomUUID().slice(0, 8),
    bookId: active.bookId,
    titre: active.titre,
    start: active.start,
    day,
    minutes: duration,
    fromPage: before,
    toPage: after,
    pages: Math.max(0, after - before),
  };
  if (session.minutes > 0 || session.pages > 0) journal.sessions.push(session);
  journal.active = null;
  return session;
}

function cancelSession(journal) {
  journal.active = null;
}

/** Prépare deux tables jour → minutes et jour → pages (évite de reparcourir tout le journal à chaque question). */
function indexDays(journal) {
  const minutes = new Map();
  for (const s of journal.sessions) minutes.set(s.day, (minutes.get(s.day) || 0) + s.minutes);
  const pages = new Map();
  for (const [day, books] of Object.entries(journal.days)) {
    let sum = 0;
    for (const entry of Object.values(books)) sum += Math.max(0, entry.to - entry.from);
    if (sum) pages.set(day, sum);
  }
  return { minutes, pages };
}

function dayTotals(journal, day, index = indexDays(journal)) {
  return { minutes: index.minutes.get(day) || 0, pages: index.pages.get(day) || 0 };
}

/** Part de l'objectif du jour accomplie (1 = atteint). Minutes et pages comptent toutes les deux. */
function goalRatio({ minutes, pages }, goal) {
  const targetMinutes = goal.type === 'pages' ? goal.value / PAGES_PER_MINUTE : goal.value;
  const targetPages = goal.type === 'pages' ? goal.value : goal.value * PAGES_PER_MINUTE;
  return Math.max(minutes / targetMinutes, pages / targetPages);
}

/** Les jours « lus » : une session, des pages avancées, ou au moins une note prise. */
function readDays(journal, noteDays, index = indexDays(journal)) {
  return new Set([...index.minutes.keys(), ...index.pages.keys(), ...noteDays.keys()]);
}

/**
 * La série de jours de lecture, avec la règle « jamais deux jours de suite sans lire » :
 * un jour manqué ne casse rien, deux jours manqués d'affilée remettent à zéro.
 * (Lally et al., 2010 : rater une occasion isolée n'empêche pas une habitude de se former.)
 */
function streak(days, today) {
  const sorted = [...days].filter((d) => d <= today).sort();
  let record = 0;
  let run = 0;
  let previous = null;
  for (const day of sorted) {
    run = previous && dayDiff(previous, day) <= 2 ? run + 1 : 1;
    record = Math.max(record, run);
    previous = day;
  }
  const gap = previous ? dayDiff(previous, today) : Infinity; // 0 = lu aujourd'hui, 1 = hier, 2 = avant-hier
  const current = gap <= 2 ? run : 0;
  return { current, record, readToday: gap === 0, atRisk: current > 0 && gap === 2 };
}

/** Intensité d'un jour pour le calendrier : 0 rien · 1 un peu · 2 moitié de l'objectif · 3 objectif · 4 le double. */
function level(totals, notes, goal) {
  const ratio = goalRatio(totals, goal);
  if (ratio >= 2) return 4;
  if (ratio >= 1) return 3;
  if (ratio >= 0.5) return 2;
  return ratio > 0 || notes > 0 ? 1 : 0;
}

/** Les `weeks` dernières semaines, jour par jour, du lundi au dimanche (pour le calendrier de lecture). */
function calendar(journal, noteDays, goal, today, weeks = 12) {
  const index = indexDays(journal);
  const start = dayAdd(weekStart(today), -7 * (weeks - 1));
  const out = [];
  for (let k = 0; k < weeks * 7; k++) {
    const day = dayAdd(start, k);
    const totals = dayTotals(journal, day, index);
    const notes = noteDays.get(day) || 0;
    const future = day > today;
    out.push({ day, future, ...totals, notes, level: future ? 0 : level(totals, notes, goal) });
  }
  return out;
}

/** Minutes et pages depuis lundi. */
function weekTotals(journal, today, index = indexDays(journal)) {
  let minutes = 0;
  let pages = 0;
  for (let day = weekStart(today); day <= today; day = dayAdd(day, 1)) {
    minutes += index.minutes.get(day) || 0;
    pages += index.pages.get(day) || 0;
  }
  return { minutes, pages };
}

function yearTotals(journal, year, index = indexDays(journal)) {
  const sum = (map) => [...map].reduce((total, [day, value]) => (day.startsWith(year) ? total + value : total), 0);
  return { minutes: sum(index.minutes), pages: sum(index.pages) };
}

/**
 * « À ce rythme, tu finis le… » : pages restantes ÷ rythme des 14 derniers jours pour CE livre.
 * On moyenne sur 3 jours minimum pour ne pas extrapoler une seule grosse soirée.
 */
function projection(journal, bookId, totalPages, today) {
  const page = journal.progress[bookId]?.page;
  if (!page || !totalPages || page >= totalPages) return null;
  let sum = 0;
  let first = null;
  for (let k = 0; k < 14; k++) {
    const day = dayAdd(today, -k);
    const entry = journal.days[day]?.[bookId];
    if (entry && entry.to > entry.from) {
      sum += entry.to - entry.from;
      first = day;
    }
  }
  if (!first) return null;
  const perDay = sum / Math.max(3, dayDiff(first, today) + 1);
  const daysLeft = Math.ceil((totalPages - page) / perDay);
  if (daysLeft > 730) return null;
  return { perDay: Math.round(perDay * 10) / 10, daysLeft, eta: dayAdd(today, daysLeft) };
}

export {
  PAGES_PER_MINUTE,
  emptyJournal, toPageNumber, setBaseline, advance, correct,
  startSession, stopSession, cancelSession,
  indexDays, dayTotals, goalRatio, readDays, streak, level, calendar, weekTotals, yearTotals, projection,
};
