// Synchronisation avec GitHub : hors ligne, deux appareils, conflits, boîte de réception du raccourci, pannes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MockGitHub } from '../scripts/mock-github.js';
import { createGitHub } from '../app/js/data/github.js';
import { memoryStorage } from '../app/js/data/storage.js';
import { createRepo } from '../app/js/data/repo.js';
import { createLibrary } from '../app/js/data/library.js';
import * as fiche from '../app/js/core/fiche.js';

/** Une horloge qu'on avance à la main. */
function clock(start = new Date(2026, 10, 17, 21, 0)) {
  let t = start.getTime();
  return { now: () => new Date(t), ms: () => t, advance: (minutes) => { t += minutes * 60000; } };
}

/** Un appareil : stockage local + copie du dépôt + bibliothèque, branché (ou non) sur le faux GitHub. */
async function device(gh, { id = 'iphone1', time = clock(), storage = memoryStorage(), online = true } = {}) {
  const repo = createRepo({ storage, now: time.now, clockMs: time.ms });
  await repo.load();
  const lib = createLibrary({ repo, deviceId: id, now: time.now });
  repo.setHooks({ afterPull: () => lib.maintain() });
  const client = createGitHub({ apiBase: 'http://mock.local', owner: gh.owner, repo: gh.repo, token: gh.token, fetchImpl: (...a) => gh.fetch(...a) });
  const connect = () => repo.connect(client, { branch: 'main' });
  if (online) connect();
  return { repo, lib, storage, time, connect };
}

const fichePath = (id) => `fiches/${id}.md`;
const notesOf = (gh, id) => fiche.parseNotes(gh.read(fichePath(id)) ?? '');

test('hors ligne d’abord : tout fonctionne sans réseau, puis part en un commit par fichier', async () => {
  const gh = new MockGitHub();
  const d = await device(gh, { online: false });
  const { book } = await d.lib.createBook({ titre: 'Lettres à Lucilius', auteur: 'Sénèque', pages: 520, pageActuelle: '40' });
  await d.lib.saveNote(book.id, { type: 'citation', page: '42', text: 'La vie est longue si tu sais t’en servir.', comment: 'Mon problème le soir.' });
  await d.lib.saveNote(book.id, { type: 'appliquer', page: '45', text: 'Quand je rentre, je lis 15 min avant d’ouvrir le PC' });

  // Avant tout envoi : l'app voit déjà ses notes, sa progression et sa liste de livres.
  assert.equal(d.lib.index()[0].notes.length, 2);
  assert.equal(d.lib.overview({ goal: { type: 'minutes', value: 15 }, limit: 8 }).progress[book.id], 45);
  assert.equal(gh.files.size, 0);
  assert.ok(d.repo.status().pending >= 4);

  d.connect();
  const status = await d.repo.sync();
  assert.equal(status.state, 'ok');
  assert.equal(status.pending, 0);
  assert.equal(notesOf(gh, book.id).length, 2);
  assert.deepEqual(JSON.parse(gh.read('.marginalia/livres.json')).enCours, ['Lettres à Lucilius']);
  assert.match(gh.read('.marginalia/journal/2026-11-iphone1.jsonl'), /"mode":"baseline"[\s\S]*"mode":"advance"/);
  // Un seul commit pour la fiche malgré la création + 2 notes faites hors ligne.
  const ficheCommits = gh.commits.filter((c) => c.path === fichePath(book.id));
  assert.equal(ficheCommits.length, 1);
  assert.match(ficheCommits[0].message, /^Marginalia : nouveau livre « Lettres à Lucilius » \(\+2\)$/);
});

test('deux appareils : notes croisées sur la même fiche, révisions fusionnées, aucun écrasement', async () => {
  const gh = new MockGitHub();
  const time = clock();
  const phone = await device(gh, { id: 'iphone1', time });
  const { book } = await phone.lib.createBook({ titre: 'Le Prince', auteur: 'Machiavel' });
  await phone.lib.saveNote(book.id, { type: 'idee', text: 'Rendre visibles les progrès de l’équipe.' });
  await phone.repo.sync();

  const pc = await device(gh, { id: 'pc1', time });
  await pc.repo.sync();
  assert.equal(pc.lib.index()[0].notes.length, 1, 'le PC reçoit la fiche');

  // Chacun ajoute une note de son côté, sans s'être resynchronisé.
  await phone.lib.saveNote(book.id, { type: 'question', text: 'Mieux vaut être craint ou aimé ?' });
  await pc.lib.saveNote(book.id, { type: 'citation', page: '12', text: 'Il faut être renard pour connaître les pièges.' });
  await phone.repo.sync();
  await pc.repo.sync(); // conflit 409 : le PC relit la fiche et réapplique SA note dessus
  await phone.repo.sync();

  assert.equal(notesOf(gh, book.id).length, 3);
  assert.deepEqual(phone.lib.index()[0].notes.map((n) => n.type).sort(), ['citation', 'idee', 'question']);

  // Le lendemain, le téléphone révise ; le PC voit la même mémoire après synchronisation.
  time.advance(24 * 60);
  const queue = phone.lib.reviewPayload({ limit: 8 }).queue;
  assert.equal(queue.length, 3);
  for (const card of queue) await phone.lib.gradeCard(card.noteId, 'good');
  await phone.repo.sync();
  await pc.repo.sync();
  assert.equal(pc.lib.reviewPayload({ limit: 8 }).queue.length, 0);
  assert.equal(pc.lib.reviewPayload({ limit: 8 }).doneToday, 3);
  assert.match(gh.read('.marginalia/journal/2026-11-iphone1.jsonl'), /"type":"review"/);
  assert.doesNotMatch(gh.read('.marginalia/journal/2026-11-pc1.jsonl'), /"type":"review"/, 'chaque appareil n’écrit que dans son carnet');
});

test('le raccourci iPhone : la boîte de réception est rangée dans les bonnes fiches, sans doublon', async () => {
  const gh = new MockGitHub();
  const d = await device(gh);
  const { book } = await d.lib.createBook({ titre: 'Lettres à Lucilius', auteur: 'Sénèque' });
  await d.repo.sync();

  // Ce que le raccourci envoie : un petit fichier par note.
  const inbox1 = 'boite/20261117-213000-a1b2.md';
  gh.writeExternal(inbox1, '---\nlivre: Lettres à Lucilius\ntype: citation\npage: 57\ndate: 2026-11-17 21:30\n---\nLa vie est longue.\n\n💭 À relire demain\n');
  gh.writeExternal('boite/20261117-214500-c3d4.md', 'livre: Méditations\ntype: idée\n\nChaque soir, revoir sa journée.');
  gh.writeExternal('boite/20261117-215000-e5f6.md', '   \n');
  await d.repo.sync();

  const lettres = notesOf(gh, book.id);
  assert.equal(lettres.length, 1);
  assert.deepEqual([lettres[0].type, lettres[0].page, lettres[0].date, lettres[0].text, lettres[0].comment, lettres[0].id],
    ['citation', '57', '2026-11-17 21:30', 'La vie est longue.', 'À relire demain', fiche.idFromName(inbox1)]);
  const meditations = d.lib.index().find((e) => e.book.titre === 'Méditations');
  assert.ok(meditations, 'livre inconnu : créé automatiquement');
  assert.equal(meditations.notes[0].date, '2026-11-17 21:45', 'date tirée du nom du fichier');
  assert.deepEqual([...gh.files.keys()].filter((p) => p.startsWith('boite/')), [], 'boîte vidée');
  assert.deepEqual(JSON.parse(gh.read('.marginalia/livres.json')).enCours.sort(), ['Lettres à Lucilius', 'Méditations']);
  assert.equal(d.lib.overview({ goal: { type: 'minutes', value: 15 }, limit: 8 }).progress[book.id], 57);

});

test('boîte de réception : deux appareils rangent la même note, ou l’app s’arrête au milieu — jamais de doublon', async () => {
  const gh = new MockGitHub();
  const time = clock();
  const phone = await device(gh, { id: 'iphone1', time });
  const { book } = await phone.lib.createBook({ titre: 'Walden' });
  await phone.repo.sync();
  const pc = await device(gh, { id: 'pc1', time });
  await pc.repo.sync();

  const inbox = 'boite/20261117-220000-z9y8.md';
  gh.writeExternal(inbox, 'livre: Walden\ntype: citation\n\nJe suis allé dans les bois.');
  // Le PC voit la note et la range… mais la connexion coupe avant l'envoi.
  gh.failNext({ method: 'PUT', pathIncludes: 'fiches/', kind: 'network' });
  assert.equal((await pc.repo.sync()).state, 'offline');
  // Pendant ce temps, le téléphone range la même note et vide la boîte.
  await phone.repo.sync();
  assert.equal(notesOf(gh, book.id).length, 1);
  // Le PC revient : même identifiant, même texte → rien à ajouter ; la boîte est déjà vide.
  const status = await pc.repo.sync();
  assert.deepEqual([status.state, status.pending], ['ok', 0]);
  assert.equal(notesOf(gh, book.id).length, 1);
  assert.equal(gh.read(inbox), null);

  // L'app est fermée entre l'ajout de la note et le vidage de la boîte : au redémarrage, la file reprend.
  const inbox2 = 'boite/20261117-221500-x7w6.md';
  gh.writeExternal(inbox2, 'livre: Walden\ntype: idée\n\nSimplifier.');
  gh.failNext({ method: 'DELETE', pathIncludes: 'boite/', kind: 'network' });
  await phone.repo.sync();
  assert.equal(notesOf(gh, book.id).length, 2);
  assert.ok(gh.read(inbox2), 'boîte pas encore vidée');
  const reopened = await device(gh, { id: 'iphone1', time, storage: phone.storage });
  await reopened.repo.sync();
  assert.equal(notesOf(gh, book.id).length, 2);
  assert.equal(gh.read(inbox2), null);
});

test('réponse perdue après une écriture réussie : renvoyée sans doublon', async () => {
  const gh = new MockGitHub();
  const d = await device(gh);
  const { book } = await d.lib.createBook({ titre: 'Essais' });
  await d.repo.sync();

  await d.lib.saveNote(book.id, { type: 'idee', text: 'Philosopher, c’est apprendre à mourir.' });
  gh.failNext({ method: 'PUT', pathIncludes: 'fiches/', kind: 'lost-response' });
  const failed = await d.repo.sync();
  assert.equal(failed.state, 'offline');
  assert.equal(failed.pending, 1, 'la note reste dans la file');
  assert.equal(notesOf(gh, book.id).length, 1, 'mais elle est bien arrivée');

  const ok = await d.repo.sync(); // sha périmé → 409 → relecture → la note est déjà là → rien à écrire
  assert.equal(ok.state, 'ok');
  assert.equal(ok.pending, 0);
  assert.equal(notesOf(gh, book.id).length, 1);

  // Même chose pour le journal : un événement renvoyé n'est pas compté deux fois.
  await d.lib.startSession({ bookId: book.id, page: '10' });
  d.time.advance(20);
  await d.lib.stopSession({ toPage: '30' });
  gh.failNext({ method: 'PUT', pathIncludes: 'journal', kind: 'lost-response' });
  await d.repo.sync();
  await d.repo.sync();
  const lines = gh.read('.marginalia/journal/2026-11-iphone1.jsonl').trim().split('\n');
  assert.equal(new Set(lines).size, lines.length);
  assert.deepEqual(d.lib.statsPayload({ goal: { type: 'minutes', value: 15 } }).today.minutes, 20);
});

test('annuler une note : retirée de la file si elle n’est pas partie, sinon retirée de la fiche', async () => {
  const gh = new MockGitHub();
  const d = await device(gh);
  const { book } = await d.lib.createBook({ titre: 'Essais' });
  await d.repo.sync();
  const commits = gh.commits.length;

  const first = await d.lib.saveNote(book.id, { type: 'idee', text: 'Oups' });
  await d.lib.undoNote(book.id, first.block);
  assert.equal(d.repo.status().pending, 0);
  await d.repo.sync();
  assert.equal(gh.commits.length, commits, 'rien n’a été envoyé');

  const second = await d.lib.saveNote(book.id, { type: 'idee', text: 'Envoyée puis annulée' });
  await d.repo.sync();
  assert.equal(notesOf(gh, book.id).length, 1);
  await d.lib.undoNote(book.id, second.block);
  await d.repo.sync();
  assert.equal(notesOf(gh, book.id).length, 0);
});

test('GitHub sert une arborescence périmée juste après une écriture : rien ne recule ni ne disparaît', async () => {
  const gh = new MockGitHub();
  const d = await device(gh);
  const { book } = await d.lib.createBook({ titre: 'Essais' });
  await d.repo.sync();
  await d.lib.saveNote(book.id, { type: 'idee', text: 'Note récente' });
  gh.staleTreeReads = 1;
  await d.repo.sync(); // push OK, puis la lecture de l'arborescence renvoie l'état d'avant
  assert.equal(d.lib.index()[0].notes.length, 1, 'la note est toujours là');

  // Un livre créé à l'instant n'est pas pris pour « supprimé ailleurs ».
  const { book: other } = await d.lib.createBook({ titre: 'Walden' });
  gh.staleTreeReads = 5;
  await d.repo.sync();
  assert.ok(d.repo.exists(fichePath(other.id)));
});

test('modifications faites ailleurs : note ajoutée dans Obsidian (identifiant posé), fiche supprimée', async () => {
  const gh = new MockGitHub();
  const time = clock();
  const d = await device(gh, { time });
  const { book } = await d.lib.createBook({ titre: 'Walden' });
  const { book: gone } = await d.lib.createBook({ titre: 'À supprimer' });
  await d.repo.sync();

  const content = gh.read(fichePath(book.id));
  gh.writeExternal(fichePath(book.id), `${content}\n> [!tip] Idée · 2026-11-17 22:00\n> Écrite dans Obsidian.\n`);
  time.advance(10); // au-delà de la fenêtre où une absence peut venir d'un cache
  gh.writeExternal(fichePath(gone.id), null);
  await d.repo.sync();

  const [note] = notesOf(gh, book.id);
  assert.match(note.id, /^[a-z0-9]{6}$/, 'identifiant ajouté pour pouvoir la réviser');
  assert.equal(d.lib.index().length, 1);
  assert.deepEqual(JSON.parse(gh.read('.marginalia/livres.json')).enCours, ['Walden']);
});

test('redémarrage de l’app : la file d’attente survit, puis part', async () => {
  const gh = new MockGitHub();
  const storage = memoryStorage();
  const first = await device(gh, { storage, online: false });
  const { book } = await first.lib.createBook({ titre: 'Walden' });
  await first.lib.saveNote(book.id, { type: 'citation', text: 'Je suis allé dans les bois…' });

  const second = await device(gh, { storage }); // même stockage = l'app rouverte
  assert.equal(second.lib.index()[0].notes.length, 1);
  await second.repo.sync();
  assert.equal(notesOf(gh, book.id).length, 1);
  assert.equal(second.repo.status().pending, 0);
});

test('erreurs : jeton refusé, action supprimée ailleurs, saisie invalide', async () => {
  const gh = new MockGitHub();
  const d = await device(gh);
  const { book } = await d.lib.createBook({ titre: 'Walden' });
  await d.lib.saveNote(book.id, { type: 'appliquer', text: 'Marcher 30 min chaque jour' });
  await d.repo.sync();

  // L'action est supprimée sur le PC pendant que le téléphone la coche hors ligne.
  const [action] = d.lib.actionsPayload().open;
  const content = gh.read(fichePath(book.id));
  gh.writeExternal(fichePath(book.id), content.replace(/> \[!todo\][\s\S]*$/, ''));
  await d.lib.setTask({ noteId: action.noteId, index: 0, status: 'done', result: 'Fait 5 jours', expectedText: action.text });
  const rejected = [];
  d.repo.on((e) => { if (e.type === 'rejected') rejected.push(...e.items); });
  await d.repo.sync();
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].message, /n'existe plus|introuvable|supprim/i);
  assert.equal(d.repo.status().pending, 0);

  await assert.rejects(d.lib.saveNote(book.id, { type: 'idee', text: '   ' }), /vide/);
  await assert.rejects(d.lib.gradeCard('zzzzzz', 'good'), /introuvable/);
  await assert.rejects(d.lib.createBook({ titre: 'walden' }), /déjà/);

  gh.token = 'autre';
  await d.lib.saveNote(book.id, { type: 'idee', text: 'Après révocation du jeton' });
  const status = await d.repo.sync();
  assert.deepEqual([status.state, status.pending], ['auth', 1]);
  assert.match(status.error, /jeton/);
});
