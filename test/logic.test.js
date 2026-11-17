// Révision espacée et journal de lecture (logique pure, reprise de la V2).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as days from '../app/js/core/days.js';
import * as review from '../app/js/core/review.js';
import * as journal from '../app/js/core/journal.js';

const at = (day, h = 21, m = 0) => { const [y, mo, d] = day.split('-').map(Number); return new Date(y, mo - 1, d, h, m); };
const GOAL = { type: 'minutes', value: 15 };

/* ---------------- Jours ---------------- */

test('days : arithmétique de calendrier', () => {
  assert.equal(days.dayAdd('2026-11-30', 1), '2026-12-01');
  assert.equal(days.dayAdd('2027-03-01', -1), '2027-02-28');
  assert.equal(days.dayDiff('2026-10-24', '2026-10-26'), 2, 'insensible au changement d’heure du 25/10');
  assert.equal(days.weekday('2026-11-16'), 0, 'le 16/11/2026 est un lundi');
  assert.equal(days.weekStart('2026-11-22'), '2026-11-16');
});

/* ---------------- Révision ---------------- */

const note = (id, date = '2026-11-15 20:31', type = 'citation') => ({ id, type, date, text: `Texte ${id}` });
const items = (...notes) => notes.map((n) => ({ book: { id: 'b', titre: 'B' }, note: n }));

test('révision : première carte le lendemain de la note, jamais le jour même', () => {
  const state = review.emptyState();
  const list = items(note('aaaaa1'));
  assert.equal(review.buildQueue(list, state, '2026-11-15').queue.length, 0);
  assert.equal(review.buildQueue(list, state, '2026-11-16').queue.length, 1);
  // Les « À appliquer » et les notes sans identifiant ne sont pas des cartes.
  const others = items(note('bbbbb2', '2026-11-01 10:00', 'appliquer'), note(null, '2026-11-01 10:00'));
  assert.equal(review.buildQueue(others, state, '2026-11-16').dueTotal, 0);
});

test('révision : les boîtes de Leitner (1, 3, 7, 14, 30, 60, 120 jours)', () => {
  const state = review.emptyState();
  const n = note('aaaaa1');
  assert.deepEqual(review.preview(review.cardFor(state, n, '2026-11-16')), { again: 1, good: 3, easy: 7 });

  let card = review.applyGrade(state, n, 'good', '2026-11-16');
  assert.deepEqual([card.box, card.due, card.reviews], [2, '2026-11-19', 1]);
  card = review.applyGrade(state, n, 'good', '2026-11-19');
  assert.deepEqual([card.box, card.due], [3, '2026-11-26']);
  card = review.applyGrade(state, n, 'easy', '2026-11-26');
  assert.deepEqual([card.box, card.due], [5, '2026-12-26']);
  card = review.applyGrade(state, n, 'again', '2026-12-26');
  assert.deepEqual([card.box, card.due, card.lapses], [1, '2026-12-27', 1]);
  for (let k = 0; k < 10; k++) card = review.applyGrade(state, n, 'easy', '2027-01-01');
  assert.deepEqual([card.box, card.due], [7, '2027-05-01'], 'plafonne à 120 jours');

  assert.deepEqual(state.log['2026-11-16'], { again: 0, good: 1, easy: 0 });
  assert.throws(() => review.applyGrade(state, n, 'parfait', '2026-11-16'), /inconnue/);
});

test('révision : file plafonnée par jour, les plus en retard d’abord', () => {
  const state = review.emptyState();
  const list = items(note('recent', '2026-11-14 09:00'), note('ancien', '2026-11-01 09:00'), note('milieu', '2026-11-10 09:00'), note('futur1', '2026-11-16 09:00'));
  let q = review.buildQueue(list, state, '2026-11-16', { limit: 2 });
  assert.deepEqual(q.queue.map((x) => x.note.id), ['ancien', 'milieu']);
  assert.equal(q.dueTotal, 3);

  review.applyGrade(state, list[1].note, 'good', '2026-11-16');
  review.applyGrade(state, list[2].note, 'again', '2026-11-16');
  q = review.buildQueue(list, state, '2026-11-16', { limit: 2 });
  assert.deepEqual([q.queue.length, q.dueTotal, q.doneToday], [0, 1, 2], 'dose du jour faite');
  assert.equal(review.buildQueue(list, state, '2026-11-16', { limit: 2, extra: 5 }).queue.length, 1, '« encore quelques-unes »');

  state.cards.recent = { ...review.cardFor(state, list[0].note, '2026-11-16'), suspended: true };
  assert.equal(review.buildQueue(list, state, '2026-11-17', { limit: 9 }).queue.some((x) => x.note.id === 'recent'), false);

  const s = review.stats(list, state, '2026-11-16');
  assert.deepEqual([s.rotation, s.fresh, s.suspended, s.anchored], [3, 1, 1, 0]);
  assert.deepEqual(s.retention, { rate: 50, total: 2 });
  assert.deepEqual(s.next, { day: '2026-11-17', count: 2 });
});

test('révision : l’amorce ne montre que le début de la note', () => {
  const cue = review.makeCue('Ce n’est pas que nous ayons peu de temps, c’est que nous en perdons beaucoup.');
  assert.equal(cue, 'Ce n’est pas que nous…');
  assert.equal(review.makeCue('Memento mori.'), 'Memento…', 'note très courte : un seul mot');
  assert.ok(review.makeCue('un deux trois quatre cinq six sept huit neuf dix onze douze treize quatorze quinze seize dix-sept dix-huit dix-neuf vingt '.repeat(3)).split(' ').length <= 9);
});

/* ---------------- Journal ---------------- */

test('journal : la progression ne fait qu’avancer et crédite les pages du jour', () => {
  const j = journal.emptyJournal();
  assert.equal(journal.advance(j, 'b', '57', '2026-11-16'), true, 'premier repère');
  assert.deepEqual(journal.dayTotals(j, '2026-11-16'), { minutes: 0, pages: 0 }, 'livre déjà entamé : rien à créditer');
  journal.advance(j, 'b', '71', '2026-11-16');
  assert.equal(journal.advance(j, 'b', '12', '2026-11-16'), false, 'revenir p. 12 pour une citation ne fait pas reculer');
  assert.equal(journal.advance(j, 'b', 'xii', '2026-11-16'), false);
  journal.advance(j, 'b', '80', '2026-11-17');
  assert.equal(j.progress.b.page, 80);
  assert.deepEqual([journal.dayTotals(j, '2026-11-16').pages, journal.dayTotals(j, '2026-11-17').pages], [14, 9]);

  // Faute de frappe (800 au lieu de 80) puis correction explicite.
  journal.advance(j, 'b', '800', '2026-11-17');
  assert.equal(journal.dayTotals(j, '2026-11-17').pages, 729);
  journal.correct(j, 'b', '85', '2026-11-17');
  assert.deepEqual([j.progress.b.page, journal.dayTotals(j, '2026-11-17').pages], [85, 14]);
});

test('journal : session chronométrée, y compris à cheval sur minuit', () => {
  const j = journal.emptyJournal();
  journal.startSession(j, { bookId: 'b', titre: 'B', page: '10' }, at('2026-11-16', 23, 40));
  assert.throws(() => journal.startSession(j, { bookId: 'b', titre: 'B' }, at('2026-11-16', 23, 41)), /déjà en cours/);
  const s = journal.stopSession(j, { toPage: '34' }, at('2026-11-17', 0, 15));
  assert.deepEqual([s.day, s.minutes, s.fromPage, s.toPage, s.pages], ['2026-11-16', 35, 10, 34, 24]);
  assert.equal(j.active, null);
  assert.deepEqual(journal.dayTotals(j, '2026-11-16'), { minutes: 35, pages: 24 });

  // Durée corrigée à la main, sans page : la session compte quand même.
  journal.startSession(j, { bookId: 'b', titre: 'B' }, at('2026-11-18', 21, 0));
  const s2 = journal.stopSession(j, { minutes: 20, toPage: '' }, at('2026-11-18', 23, 0));
  assert.deepEqual([s2.minutes, s2.pages, j.sessions.length], [20, 0, 2]);
  assert.throws(() => journal.stopSession(j, {}, at('2026-11-18')), /Aucune session/);
});

test('journal : la série tolère un jour manqué, pas deux d’affilée', () => {
  const read = (...d) => new Set(d);
  assert.deepEqual(journal.streak(read(), '2026-11-16'), { current: 0, record: 0, readToday: false, atRisk: false });
  // Lu lundi, mardi, (mercredi manqué), jeudi → série de 3, intacte.
  let s = journal.streak(read('2026-11-16', '2026-11-17', '2026-11-19'), '2026-11-19');
  assert.deepEqual([s.current, s.readToday, s.atRisk], [3, true, false]);
  // Vendredi pas encore lu : tranquille. Samedi pas encore lu : dernier jour pour sauver la série.
  assert.deepEqual(journal.streak(read('2026-11-16', '2026-11-17', '2026-11-19'), '2026-11-20').atRisk, false);
  s = journal.streak(read('2026-11-16', '2026-11-17', '2026-11-19'), '2026-11-21');
  assert.deepEqual([s.current, s.atRisk], [3, true]);
  // Dimanche : deux jours manqués d'affilée → remise à zéro, le record reste.
  s = journal.streak(read('2026-11-16', '2026-11-17', '2026-11-19'), '2026-11-22');
  assert.deepEqual([s.current, s.record], [0, 3]);
});

test('journal : objectif du jour, calendrier et date de fin estimée', () => {
  assert.equal(journal.goalRatio({ minutes: 15, pages: 0 }, GOAL), 1);
  assert.equal(journal.goalRatio({ minutes: 0, pages: 10 }, GOAL), 1, '10 pages sans chrono valent 15 min');
  assert.equal(journal.goalRatio({ minutes: 0, pages: 5 }, { type: 'pages', value: 10 }), 0.5);
  assert.deepEqual([0, 5, 8, 15, 30].map((m) => journal.level({ minutes: m, pages: 0 }, 0, GOAL)), [0, 1, 2, 3, 4]);
  assert.equal(journal.level({ minutes: 0, pages: 0 }, 2, GOAL), 1, 'un jour avec seulement des notes compte un peu');

  const j = journal.emptyJournal();
  journal.setBaseline(j, 'b', '100', '2026-11-10');
  journal.advance(j, 'b', '120', '2026-11-12');
  journal.advance(j, 'b', '150', '2026-11-16');
  const cal = journal.calendar(j, new Map([['2026-11-11', 1]]), GOAL, '2026-11-16', 12);
  assert.equal(cal.length, 84);
  assert.equal(days.weekday(cal[0].day), 0);
  assert.equal(cal.find((c) => c.day === '2026-11-16').pages, 30);
  assert.equal(cal.find((c) => c.day === '2026-11-11').level, 1);
  assert.equal(cal.find((c) => c.day === '2026-11-17').future, true);
  assert.deepEqual(journal.weekTotals(j, '2026-11-16'), { minutes: 0, pages: 30 });

  // 50 pages en 5 jours (du 12 au 16) → 10 p./jour ; il en reste 250 → 25 jours.
  assert.deepEqual(journal.projection(j, 'b', 400, '2026-11-16'), { perDay: 10, daysLeft: 25, eta: '2026-12-11' });
  assert.equal(journal.projection(j, 'b', null, '2026-11-16'), null);
  assert.equal(journal.projection(j, 'inconnu', 400, '2026-11-16'), null);
});

