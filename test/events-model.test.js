// Journal d'événements rejoué + calculs de l'app (révision, actions, progrès) + boîte de réception.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fiche from '../app/js/core/fiche.js';
import * as model from '../app/js/core/model.js';
import { makeEvent, replay, parseLog, serialize, logPath } from '../app/js/core/events.js';
import { parseInboxFile, isInboxPath } from '../app/js/core/inbox.js';

const at = (day, h = 21, m = 0) => { const [y, mo, d] = day.split('-').map(Number); return new Date(y, mo - 1, d, h, m); };
const GOAL = { type: 'minutes', value: 15 };
const ev = (type, data, when, dev = 'iphone') => makeEvent(type, data, { now: when, deviceId: dev });

/** Une fiche avec trois notes prises le 16/11, comme le ferait l'app. */
function lettres() {
  let c = fiche.bookTemplate({ titre: 'Lettres à Lucilius', auteur: 'Sénèque', pages: 520 }, at('2026-11-16'));
  const add = (input, id) => {
    const note = fiche.sanitizeNoteInput(input);
    c = fiche.appendNoteBlock(c, fiche.formatNote({ ...note, date: '2026-11-16 21:10', id }));
  };
  add({ type: 'citation', page: '42', text: 'La vie est longue si tu sais t’en servir.', tags: 'temps' }, 'cit001');
  add({ type: 'question', page: '44', text: 'Où part mon temps le soir ?' }, 'que001');
  add({ type: 'appliquer', page: '45', text: 'Quand je rentre, je lis 15 min avant d’ouvrir le PC\nRevoir mon agenda le vendredi' }, 'act001');
  return c;
}

test('scénario complet : session, révision le lendemain, action de la semaine, progrès', () => {
  let content = lettres();
  const index = () => model.buildIndex([{ path: 'fiches/lettres-a-lucilius.md', content }]);
  const events = [
    ev('progress', { bookId: 'lettres-a-lucilius', page: '40', mode: 'baseline' }, at('2026-11-16', 20, 55)),
    ev('session-start', { bookId: 'lettres-a-lucilius', titre: 'Lettres à Lucilius', page: '40' }, at('2026-11-16', 21, 0)),
    ev('session-stop', { toPage: '58' }, at('2026-11-16', 21, 25)),
  ];
  const state = () => replay(events, model.noteMap(index()));

  // Jour J : 25 min, 18 pages, objectif atteint, rien à réviser, 2 actions ouvertes.
  let { rev, jr } = state();
  let o = model.overview({ index: index(), rev, jr, today: '2026-11-16', goal: GOAL, limit: 8 });
  assert.deepEqual([o.due, o.actionsOpen, o.today.notes, o.today.minutes, o.today.pages, o.today.done, o.streak.current, o.session],
    [0, 2, 3, 25, 18, true, 1, null]);
  assert.equal(o.progress['lettres-a-lucilius'], 58);

  // J+1 : la citation et la question reviennent (pas l'action).
  let r = model.reviewPayload({ index: index(), rev, today: '2026-11-17', limit: 8 });
  assert.deepEqual(r.queue.map((c) => [c.noteId, c.cue, c.isNew]), [['cit001', 'La vie est…', true], ['que001', 'Où part mon…', true]]);
  events.push(ev('review', { noteId: 'cit001', grade: 'good' }, at('2026-11-17', 8)));
  events.push(ev('suspend', { noteId: 'que001' }, at('2026-11-17', 8, 1)));
  ({ rev, jr } = state());
  r = model.reviewPayload({ index: index(), rev, today: '2026-11-17', limit: 8 });
  assert.deepEqual([r.queue.length, r.doneToday, r.stats.suspended, rev.cards.cit001.due], [0, 1, 1, '2026-11-20']);

  // Action de la semaine, faite le vendredi avec son résultat.
  events.push(ev('focus', { noteId: 'act001', text: 'Quand je rentre, je lis 15 min avant d’ouvrir le PC' }, at('2026-11-17', 8, 2)));
  ({ rev, jr } = state());
  let a = model.actionsPayload({ index: index(), jr, today: '2026-11-20' });
  assert.deepEqual([a.open.length, a.focus.text, a.open[0].focus, a.open[0].ageDays, a.weeklyReviewDue], [2, 'Quand je rentre, je lis 15 min avant d’ouvrir le PC', true, 4, true]);
  content = fiche.updateTaskInContent(content, 'act001', 0, { status: 'done', result: 'Tenu 3 soirs sur 4.' }, at('2026-11-20'));
  events.push(ev('unfocus', {}, at('2026-11-20', 20)));
  events.push(ev('weekly', {}, at('2026-11-20', 20, 1)));
  ({ rev, jr } = state());
  a = model.actionsPayload({ index: index(), jr, today: '2026-11-20' });
  assert.deepEqual([a.open.length, a.focus, a.done[0].result, a.done[0].doneDate, a.weeklyReviewDue], [1, null, 'Tenu 3 soirs sur 4.', '2026-11-20', false]);

  // Progrès et bilan.
  const s = model.statsPayload({ index: index(), rev, jr, today: '2026-11-20', goal: GOAL });
  assert.deepEqual(s.pillars, {
    lire: { minutes: 25, pages: 18 },
    retenir: { reviews: 1, rate: 100, anchored: 0, rotation: 1 },
    appliquer: { done: 1, open: 1 },
  });
  assert.deepEqual([s.books[0].page, s.books[0].pct, s.year.notes, s.quote.titre, s.calendar.length], [58, 11, 3, 'Lettres à Lucilius', 84]);
  const recap = model.bookRecap({ index: index(), jr, bookId: 'lettres-a-lucilius', today: '2026-11-20' });
  assert.deepEqual([recap.sessions, recap.minutes, recap.notes, recap.actions, recap.span, recap.synthesisPending], [1, 25, 3, 2, 5, true]);
});

test('rejeu : ordre chronologique entre appareils, doublons ignorés, session reprise ailleurs', () => {
  const start = ev('session-start', { bookId: 'b', titre: 'B', page: '10' }, at('2026-11-16', 20), 'iphone');
  const startPc = ev('session-start', { bookId: 'b', titre: 'B', page: '12' }, at('2026-11-16', 20, 30), 'pc');
  const stop = ev('session-stop', { toPage: '30', minutes: 20 }, at('2026-11-16', 21), 'pc');
  // Les carnets arrivent dans le désordre, et un événement a été envoyé deux fois.
  const { jr, errors } = replay([stop, startPc, start, stop]);
  assert.deepEqual(errors, []);
  assert.equal(jr.sessions.length, 1);
  assert.deepEqual([jr.sessions[0].minutes, jr.sessions[0].fromPage, jr.sessions[0].toPage, jr.active], [20, 12, 30, null]);
});

test('carnets : sérialisation ligne par ligne, lignes abîmées ignorées, un fichier par mois et par appareil', () => {
  const e = ev('weekly', {}, at('2026-11-20'));
  const content = `${serialize(e)}\n{pas du json\n${serialize(ev('review', { noteId: 'x', grade: 'good' }, at('2026-11-21')))}\n`;
  const events = parseLog(content);
  assert.deepEqual(events.map((x) => x.type), ['weekly', 'review']);
  assert.equal(logPath('2026-11-20', 'a1b2c3'), '.marginalia/journal/2026-11-a1b2c3.jsonl');
  assert.throws(() => ev('inconnu', {}, at('2026-11-20')), /inconnu/);
});

test('boîte de réception : formats tolérés et note propre', () => {
  const full = parseInboxFile('---\nlivre: Lettres à Lucilius\ntype: À appliquer\npage: 42\ntags: temps discipline\ndate: 2026-11-17 21:30\n---\nQuand je rentre,\nje lis.\n\n💭 À tester cette semaine\n');
  assert.deepEqual(full, {
    livre: 'Lettres à Lucilius', type: 'appliquer', page: '42', tags: 'temps discipline', date: '2026-11-17 21:30',
    text: 'Quand je rentre,\nje lis.', comment: 'À tester cette semaine',
  });
  const bare = parseInboxFile('Livre : Le Prince\nType: idée\n\nRendre visibles les progrès.');
  assert.deepEqual([bare.livre, bare.type, bare.text, bare.date], ['Le Prince', 'idee', 'Rendre visibles les progrès.', '']);
  assert.equal(parseInboxFile('Juste un passage, sans en-tête.').type, 'citation');
  assert.equal(parseInboxFile('---\ndate: hier\n---\nX').date, '', 'date invalide ignorée');
  assert.throws(() => parseInboxFile('---\nlivre: X\n---\n   \n'), /vide/);
  assert.equal(isInboxPath('boite/20261117-213000-4821.md'), true);
  assert.equal(isInboxPath('boite/sous/x.md'), false);
});

test('index des livres : tri, recherche par titre, fichier pour le raccourci', () => {
  const prince = fiche.bookTemplate({ titre: 'Le Prince', auteur: 'Machiavel' }, at('2026-10-01'));
  const done = fiche.setStatusInContent(fiche.bookTemplate({ titre: 'Fini' }, at('2026-09-01')), 'termine', at('2026-10-15'));
  const index = model.buildIndex([
    { path: 'fiches/fini.md', content: done },
    { path: 'fiches/lettres-a-lucilius.md', content: lettres() },
    { path: 'fiches/le-prince.md', content: prince },
    { path: 'README.md', content: '# Pas une fiche' },
  ]);
  assert.deepEqual(index.map((e) => e.book.id), ['lettres-a-lucilius', 'le-prince', 'fini']);
  assert.equal(model.findBook(index, 'lettres a lucilius').book.id, 'lettres-a-lucilius');
  assert.equal(model.findBook(index, 'le-prince').book.titre, 'Le Prince');
  assert.equal(model.findBook(index, 'Inconnu'), null);
  assert.deepEqual(model.booksJson(index).enCours, ['Lettres à Lucilius', 'Le Prince']);
  assert.equal(model.locate(index, 'que001').note.type, 'question');
  assert.throws(() => model.locate(index, '../x'), /invalide/);
});
