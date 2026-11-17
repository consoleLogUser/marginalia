// Le format des fiches et les opérations sur leur contenu (logique pure).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fiche from '../app/js/core/fiche.js';
import { applyOp, applyOps } from '../app/js/core/ops.js';

const NOW = new Date(2026, 10, 16, 21, 0);
const sequence = (...ids) => { let i = 0; return () => ids[i++]; };

/** Une fiche telle que la V1 l'écrivait : aucune note n'a d'identifiant. */
const V1_FICHE = [
  '---', 'type: lecture', 'titre: "Lettres à Lucilius"', 'auteur: "[[Sénèque]]"', 'statut: en-cours', 'debut: 2026-11-15', 'fin:', 'pages: 520', '---',
  '', '# Lettres à Lucilius', '', '## Synthèse', '', fiche.SYNTHESIS_PLACEHOLDER, '', '## Notes', '',
  '> [!quote] Citation · p. 42 · 2026-11-15 20:31',
  '> Ce n’est pas que nous ayons peu de temps.',
  '>',
  '> 💭 Mon problème le soir.',
  '>',
  '> #temps #discipline',
  '',
  '> [!abstract] Un encadré à moi',
  '> pas une note Marginalia',
  '',
  '> [!tip] Idée · p. 43 · 2026-11-15 20:40',
  '> Tenir un journal du soir.',
  '',
  '> [!todo] À appliquer · p. 43 · 2026-11-15 20:45',
  '> - [ ] Quand un chef d’équipe m’apporte un problème, je lui demande d’abord sa solution',
  '> - [ ] Revoir mon agenda chaque vendredi',
  '',
].join('\n');
const withIds = () => fiche.ensureNoteIds(V1_FICHE, new Set(), sequence('aaaaa1', 'bbbbb2', 'ccccc3')).content;

test('utilitaires : noms de fichiers, tags, titres', () => {
  assert.equal(fiche.slugify("L'Art de la guerre pour les leaders"), 'l-art-de-la-guerre-pour-les-leaders');
  assert.equal(fiche.slugify('Œuvres complètes — Sénèque'), 'oeuvres-completes-seneque');
  assert.deepEqual(fiche.normalizeTags('#Stoïcisme, management  #temps/discipline 2026 #Stoïcisme'), ['stoïcisme', 'management', 'temps/discipline']);
  assert.equal(fiche.sameTitle('Lettres à Lucilius', 'lettres a LUCILIUS'), true);
  assert.equal(fiche.sameTitle('', ''), false);
});

test('texte copié d’un PDF ou de Kindle : recollé, page détectée', () => {
  const pdf = 'Le management ne consiste pas à contrôler mais à créer les condi-\ntions dans lesquelles chacun peut donner le meilleur de lui-même,\njour après jour.';
  assert.equal(fiche.cleanCapturedText(pdf).text, 'Le management ne consiste pas à contrôler mais à créer les conditions dans lesquelles chacun peut donner le meilleur de lui-même, jour après jour.');
  const kindle = 'La vie est longue.\r\n\r\nSénèque. De la brièveté de la vie (p. 57). Édition du Kindle.';
  assert.deepEqual(fiche.cleanCapturedText(kindle), { text: 'La vie est longue.', page: '57' });
  assert.equal(fiche.cleanCapturedText('- un\n- deux\n- trois').text, '- un\n- deux\n- trois');
});

test('formatNote + parseNotes : aller-retour sans perte, identifiant sur sa ligne', () => {
  const block = fiche.formatNote({
    type: 'citation', page: '42', text: 'Ligne 1\n\nLigne 2', comment: 'Mon avis', tags: ['temps'], date: '2026-11-15 20:31', id: 'k3x9q2',
  });
  assert.equal(block, '> [!quote] Citation · p. 42 · 2026-11-15 20:31\n> Ligne 1\n>\n> Ligne 2\n>\n> 💭 Mon avis\n>\n> #temps\n\n^k3x9q2');
  const [note] = fiche.parseNotes(`# Titre\n\n${block}\n`);
  assert.deepEqual([note.type, note.page, note.date, note.text, note.comment, note.tags, note.id], ['citation', '42', '2026-11-15 20:31', 'Ligne 1\n\nLigne 2', 'Mon avis', ['temps'], 'k3x9q2']);
});

test('migration V1 : un identifiant sous chaque note, rien d’autre ne change', () => {
  const { content, added } = fiche.ensureNoteIds(V1_FICHE, new Set(), sequence('aaaaa1', 'bbbbb2', 'ccccc3'));
  assert.equal(added, 3, 'les 3 notes, pas l’encadré personnel');
  assert.equal(content.replace(/\n\n\^[a-z0-9]{6}(?=\n)/g, ''), V1_FICHE);
  assert.deepEqual(fiche.parseNotes(content).map((n) => n.id), ['ccccc3', 'bbbbb2', 'aaaaa1']);
  assert.deepEqual(fiche.ensureNoteIds(content), { content, added: 0 }, 'idempotent');
});

test('lecture d’une fiche : métadonnées, synthèse à écrire', () => {
  const { book, notes, synthesisPending } = fiche.readFiche('lettres', withIds());
  assert.deepEqual([book.titre, book.auteur, book.pages, book.statut, book.noteCount, book.lastNoteDate], ['Lettres à Lucilius', 'Sénèque', 520, 'en-cours', 3, '2026-11-15 20:45']);
  assert.equal(notes.length, 3);
  assert.equal(synthesisPending, true);
  assert.equal(fiche.readFiche('x', '# Pas une fiche'), null);
});

test('ajout de note : idempotent, collision d’identifiant détectée', () => {
  const base = fiche.bookTemplate({ titre: 'Test' }, NOW);
  const block = fiche.formatNote({ type: 'idee', text: 'Une idée', date: '2026-11-16 21:00', id: 'abc123' });
  const once = fiche.appendNoteBlock(base, block);
  assert.ok(once.endsWith('## Notes\n\n> [!tip] Idée · 2026-11-16 21:00\n> Une idée\n\n^abc123\n'));
  assert.equal(fiche.appendNoteBlock(once, block), once, 'rejouée : aucun doublon');
  const other = fiche.formatNote({ type: 'idee', text: 'Autre chose', date: '2026-11-16 21:05', id: 'abc123' });
  assert.throws(() => fiche.appendNoteBlock(once, other), (e) => e.code === 'id-taken');
  // L'opération « append-note » choisit alors un nouvel identifiant.
  const fixed = applyOp(once, { kind: 'append-note', args: { block: other } });
  const ids = fiche.parseNotes(fixed).map((n) => n.id);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[1], 'abc123');
});

test('annulation : en fin de fiche, au milieu, et refus si modifiée', () => {
  const base = fiche.bookTemplate({ titre: 'Test' }, NOW);
  const a = fiche.formatNote({ type: 'idee', text: 'A', date: '2026-11-16 21:00', id: 'aaaaaa' });
  const b = fiche.formatNote({ type: 'idee', text: 'B', date: '2026-11-16 21:01', id: 'bbbbbb' });
  const one = fiche.appendNoteBlock(base, a);
  const two = fiche.appendNoteBlock(one, b);
  assert.equal(fiche.removeNoteBlock(two, 'bbbbbb', b), one, 'dernière note');
  const middle = fiche.removeNoteBlock(two, 'aaaaaa', a);
  assert.deepEqual(fiche.parseNotes(middle).map((n) => n.id), ['bbbbbb'], 'note du milieu');
  assert.ok(!/\n\n\n/.test(middle), 'pas de lignes vides en trop');
  assert.equal(fiche.removeNoteBlock(one, 'zzzzzz', b), one, 'déjà retirée');
  const edited = two.replace('> A', '> A modifiée');
  assert.throws(() => fiche.removeNoteBlock(edited, 'aaaaaa', a), /modifiée/);
});

test('action : faite avec résultat, rouverte, abandonnée — et protection contre les modifications', () => {
  const content = withIds();
  const first = 'Quand un chef d’équipe m’apporte un problème, je lui demande d’abord sa solution';
  let c = fiche.updateTaskInContent(content, 'aaaaa1', 0, { status: 'done', result: 'Il avait la réponse.\nGain : 20 min.', expectedText: first }, NOW);
  assert.ok(c.includes(`> - [x] ${first} ✅ 2026-11-16\n>   → Résultat : Il avait la réponse. — Gain : 20 min.\n> - [ ] Revoir mon agenda chaque vendredi\n`));
  const tasks = fiche.parseNotes(c).find((n) => n.id === 'aaaaa1').tasks;
  assert.deepEqual(tasks.map((t) => [t.status, t.doneDate, t.result]), [['done', '2026-11-16', 'Il avait la réponse. — Gain : 20 min.'], ['open', '', '']]);
  assert.equal(fiche.updateTaskInContent(c, 'aaaaa1', 0, { status: 'done', result: 'Il avait la réponse.\nGain : 20 min.' }, NOW), c, 'rejouée : identique');
  c = fiche.updateTaskInContent(c, 'aaaaa1', 0, { status: 'open' }, NOW);
  assert.equal(fiche.parseNotes(c).find((n) => n.id === 'aaaaa1').tasks[0].result, 'Il avait la réponse. — Gain : 20 min.', 'résultat gardé');
  c = fiche.updateTaskInContent(c, 'aaaaa1', 1, { status: 'cancelled' }, NOW);
  assert.ok(c.includes('> - [-] Revoir mon agenda chaque vendredi ❌ 2026-11-16\n'));
  assert.throws(() => fiche.updateTaskInContent(c, 'aaaaa1', 0, { status: 'open', expectedText: 'autre' }, NOW), /modifiée/);
  assert.throws(() => fiche.updateTaskInContent(c, 'zzzzzz', 0, { status: 'done' }, NOW), (e) => e.code === 'missing');
});

test('réflexion ajoutée à une note (avant les tags), sans doublon si rejouée', () => {
  const once = fiche.addReflectionToContent(withIds(), 'ccccc3', 'Avec mes mots : on gaspille le temps.', NOW);
  assert.ok(once.includes('> 💭 Mon problème le soir.\n>\n> 💭 2026-11-16 — Avec mes mots : on gaspille le temps.\n>\n> #temps #discipline\n\n^ccccc3'));
  assert.equal(fiche.addReflectionToContent(once, 'ccccc3', 'Avec mes mots : on gaspille le temps.', NOW), once);
  assert.throws(() => fiche.addReflectionToContent(once, 'aaaaa1', 'x', NOW), /action/);
});

test('synthèse : remplace le texte d’attente, puis complète, sans doublon', () => {
  let c = fiche.writeSynthesisToContent(withIds(), '1. Le temps est un capital.', NOW);
  assert.ok(c.includes('## Synthèse\n\n1. Le temps est un capital.\n\n## Notes\n'));
  assert.equal(fiche.writeSynthesisToContent(c, '1. Le temps est un capital.', NOW), c);
  c = fiche.writeSynthesisToContent(c, 'Relu six mois après.', NOW);
  assert.ok(c.includes('1. Le temps est un capital.\n\n*Complément du 2026-11-16 :*\n\nRelu six mois après.\n\n## Notes\n'));
  assert.equal(fiche.parseNotes(c).length, 3);
});

test('statut du livre : terminé daté, puis repris', () => {
  const done = fiche.setStatusInContent(withIds(), 'termine', NOW);
  assert.match(done, /\nstatut: termine\n/);
  assert.match(done, /\nfin: 2026-11-16\n/);
  assert.match(fiche.setStatusInContent(done, 'en-cours', NOW), /\nfin:\n/);
});

test('saisie : validations', () => {
  assert.throws(() => fiche.sanitizeNoteInput({ type: 'hack', text: 'x' }), /Type/);
  assert.throws(() => fiche.sanitizeNoteInput({ type: 'idee', text: '  ' }), /vide/);
  assert.throws(() => fiche.sanitizeNoteInput({ type: 'idee', text: 'x', page: '<script>' }), /page/);
  assert.equal(fiche.sanitizeNoteInput({ type: 'idee', text: 'x', comment: 'y' }).comment, '');
  assert.throws(() => fiche.sanitizeBookInput({ titre: ' ' }), /obligatoire/);
  assert.deepEqual(fiche.sanitizeBookInput({ titre: ' Le Prince ', auteur: '[[Machiavel]]', pages: '180', format: 'numerique' }),
    { titre: 'Le Prince', auteur: 'Machiavel', format: 'numerique', pages: 180 });
});

test('identifiant déterministe pour la boîte de réception', () => {
  const a = fiche.idFromName('boite/20261117-213000-4821.md');
  assert.match(a, /^[a-z0-9]{6}$/);
  assert.match(a, /[a-z]/);
  assert.equal(fiche.idFromName('boite/20261117-213000-4821.md'), a);
  assert.notEqual(fiche.idFromName('boite/20261117-213000-4822.md'), a);
});

test('opérations : création qui ne remplace jamais, journal qui s’allonge, opérations rejetées', () => {
  assert.equal(applyOp(null, { kind: 'create', args: { content: 'A' } }), 'A');
  assert.equal(applyOp('existant', { kind: 'create', args: { content: 'A' } }), 'existant');
  assert.equal(applyOp(null, { kind: 'append-lines', args: { lines: ['{"a":1}'] } }), '{"a":1}\n');
  assert.equal(applyOp('{"a":1}\n', { kind: 'append-lines', args: { lines: ['{"b":2}'] } }), '{"a":1}\n{"b":2}\n');
  assert.equal(applyOp('x', { kind: 'delete' }), null);
  const { content, rejected } = applyOps(withIds(), [
    { kind: 'update-task', args: { noteId: 'zzzzzz', index: 0, status: 'done' } },
    { kind: 'set-status', args: { statut: 'termine' }, at: NOW.toISOString() },
  ]);
  assert.equal(rejected.length, 1);
  assert.match(content, /statut: termine/);
});
