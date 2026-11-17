/**
 * e2e.js — Tests de bout en bout sur un iPhone simulé (WebKit, le moteur de Safari, écran d'iPhone 15).
 *
 * Un vrai navigateur, la vraie app, et un faux GitHub (scripts/mock-github.js) derrière /gh :
 * on vérifie l'écran ET ce qui arrive réellement dans le dépôt (fichiers, commits).
 * Captures d'écran (clair, sombre, petit écran) dans test-results/.
 *
 *   node scripts/e2e.js
 */
import { webkit, devices } from 'playwright';
import { mkdirSync } from 'node:fs';
import { startServer } from './serve.js';

const SHOTS = new URL('../test-results/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });
const TOKEN = 'github_pat_11TEST0000000000000000';
const NEW_TOKEN = 'github_pat_11NOUVEAU0000000000000';
let token = TOKEN; // le jeton valide du moment (il change dans le scénario « jeton révoqué »)
const DAY = 24 * 3600 * 1000;

const { server, port } = await startServer({ port: 0, mock: true });
const base = `http://127.0.0.1:${port}`;
const browser = await webkit.launch();
const pageErrors = [];
const results = [];

/* ------------------------------ Outils ------------------------------ */

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function mock(action, data) {
  const res = await fetch(`${base}/__mock/${action}`, data ? { method: 'POST', body: JSON.stringify(data) } : undefined);
  return res.json();
}
const files = async () => (await mock('state')).files;

async function scenario(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`  ✗ ${name}\n      ${err.message.split('\n').join('\n      ')}`);
  }
}

/** Un « iPhone » : l'app est ouverte depuis l'écran d'accueil (standalone), sauf indication contraire. */
async function phone({ standalone = true, colorScheme = 'light', device = 'iPhone 15', clockOffset = 0 } = {}) {
  const context = await browser.newContext({ ...devices[device], locale: 'fr-FR', timezoneId: 'Europe/Paris', colorScheme, reducedMotion: 'reduce' });
  await context.addInitScript(({ api, standalone: s, offset }) => {
    localStorage.setItem('marginalia:apiBase', api);
    localStorage.setItem('marginalia:noSW', '1');
    if (offset && !localStorage.getItem('marginalia:clockOffset')) localStorage.setItem('marginalia:clockOffset', String(offset));
    if (s) Object.defineProperty(Navigator.prototype, 'standalone', { get: () => true });
  }, { api: `${base}/gh`, standalone, offset: clockOffset });
  const page = await context.newPage();
  page.on('pageerror', (err) => pageErrors.push(`${device} : ${err.message}`));
  await page.goto(`${base}/`);
  await page.waitForSelector('#boot', { state: 'hidden' });
  return { context, page };
}

async function connect(page, value = token) {
  await page.fill('#cxOwner', 'moi');
  await page.fill('#cxRepo', 'marginalia-data');
  await page.fill('#cxToken', value);
  await page.click('#cxSubmit');
}

async function syncNow(page) {
  const res = await page.evaluate(() => window.marginalia.syncNow());
  check(res.ok, `synchronisation : ${res.error}`);
  return res.status;
}

async function shiftClock(page, ms) {
  await page.evaluate(async (offset) => {
    localStorage.setItem('marginalia:clockOffset', String(offset));
    await window.M.refresh();
  }, ms);
}

const toastText = (page) => page.textContent('#toastText');
const shot = (page, name, fullPage = false) => page.screenshot({ path: `${SHOTS}${name}.png`, fullPage, caret: 'initial' });

async function waitToast(page, pattern) {
  await page.waitForFunction((re) => new RegExp(re).test(document.querySelector('#toastText')?.textContent || '')
    && !document.querySelector('#toast').hidden, pattern.source, { timeout: 8000 });
}

/* ------------------------------ Scénarios ------------------------------ */

console.log('\nMarginalia — tests de bout en bout (WebKit, iPhone 15)\n');

await scenario('Dans Safari : l’app propose d’abord l’installation sur l’écran d’accueil', async () => {
  const { context, page } = await phone({ standalone: false });
  check(await page.isVisible('#installStep'), 'étape d’installation absente');
  check(!(await page.isVisible('#connectForm')), 'le formulaire ne doit pas apparaître avant l’installation');
  await shot(page, '01-installer');
  await page.click('#skipInstall');
  check(await page.isVisible('#connectForm'), 'le formulaire doit apparaître après « Continuer »');
  await context.close();
});

const { context: ctx, page } = await phone();

await scenario('Connexion : propriétaire deviné, jeton refusé, dépôt public refusé, puis connecté', async () => {
  check(await page.isVisible('#connectForm'), 'formulaire de connexion absent');
  check((await page.getAttribute('#tokenLink', 'href')).includes('personal-access-tokens/new'), 'lien de création du jeton absent');
  await shot(page, '02-connexion');
  await connect(page, 'github_pat_11MAUVAIS000000000000');
  await page.waitForSelector('#cxError:not([hidden])');
  check(/refuse ce jeton/.test(await page.textContent('#cxError')), `message : ${await page.textContent('#cxError')}`);
  await mock('private', { value: false });
  await connect(page);
  await page.waitForFunction(() => /PUBLIC/.test(document.querySelector('#cxError').textContent));
  await mock('private', { value: true });
  await connect(page);
  await page.waitForSelector('#app:not([hidden])');
  await page.waitForSelector('#introDialog[open]');
  const repo = await files();
  check(repo['README.md']?.includes('Mes lectures'), 'README du dépôt non créé');
  check(JSON.parse(repo['.marginalia/livres.json']).livres.length === 0, 'livres.json non créé');
});

await scenario('Bienvenue : rituel (20:30, 20 min) puis premier livre déjà entamé', async () => {
  await shot(page, '03-bienvenue');
  await page.fill('#inTime', '20:30');
  await page.fill('#inGoal', '20');
  await page.click('#introForm button[type=submit]');
  await page.waitForSelector('#newBookDialog[open]');
  await page.fill('#nbTitle', 'Lettres à Lucilius');
  await page.fill('#nbAuthor', 'Sénèque');
  await page.fill('#nbPages', '520');
  await page.fill('#nbStart', '40');
  await shot(page, '04-nouveau-livre');
  await page.click('#newBookForm button[type=submit]');
  await page.waitForSelector('#newBookDialog[open]', { state: 'detached' });
  check((await page.inputValue('#bookSelect')) === 'lettres-a-lucilius', 'livre non sélectionné');
  check(/p\. 40 \/ 520 · 8 %/.test(await page.textContent('#progressText')), `progression : ${await page.textContent('#progressText')}`);
  check(/0 \/ 20 min/.test(await page.textContent('#todayMain')), `objectif : ${await page.textContent('#todayMain')}`);
});

await scenario('Noter une citation (page + commentaire), l’annuler, la reprendre et l’enregistrer', async () => {
  await page.fill('#textInput', 'Ce n’est pas que nous ayons peu de temps, c’est que nous en perdons beaucoup.');
  await page.fill('#commentInput', 'Mon problème le soir : le téléphone.');
  await page.fill('#pageInput', '42');
  await page.click('#saveBtn');
  await waitToast(page, /Note enregistrée · p\. 42/);
  check(await page.locator('#notesList .note').count() === 1, 'la note doit apparaître dans la liste');
  await shot(page, '05-lire-note');
  await page.click('#toastAction'); // « Annuler »
  await page.waitForFunction(() => document.querySelectorAll('#notesList .note').length === 0);
  check((await page.inputValue('#textInput')).startsWith('Ce n’est pas'), 'le texte doit revenir dans l’éditeur');
  await page.click('#saveBtn');
  await waitToast(page, /Note enregistrée/);
  await syncNow(page);
  const fiche = (await files())['fiches/lettres-a-lucilius.md'];
  check(fiche.includes('> [!quote] Citation · p. 42 ·') && fiche.includes('> 💭 Mon problème le soir'), 'note absente de la fiche sur GitHub');
  check((fiche.match(/\[!quote\]/g) || []).length === 1, 'la note annulée ne doit pas avoir été envoyée');
});

await scenario('Coller un passage copié d’un PDF : lignes et césures recollées', async () => {
  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, 'readText', {
      configurable: true,
      value: async () => 'Le management ne consiste pas à contrôler mais à créer les condi-\ntions dans lesquelles chacun peut donner le meilleur de lui-même.',
    });
  });
  await page.click('#pasteBtn');
  await page.waitForFunction(() => document.querySelector('#textInput').value.length > 0);
  const text = await page.inputValue('#textInput');
  check(text.includes('les conditions dans lesquelles'), `texte collé : ${text}`);
  check(await page.getAttribute('.chip[data-type="citation"]', 'aria-checked') === 'true', 'un passage collé est une citation');
  await page.fill('#pageInput', '57');
  await page.click('#saveBtn');
  await waitToast(page, /Note enregistrée · p\. 57/);
});

await scenario('« À appliquer » → action de la semaine → faite, avec ce que ça a donné', async () => {
  await page.click('.chip[data-type="appliquer"]');
  check(await page.isVisible('#applyHint'), 'l’aide « Quand…, je… » doit apparaître');
  await page.click('#applyTemplateBtn');
  check((await page.inputValue('#textInput')).startsWith('Quand , je'), 'gabarit non inséré');
  await page.fill('#textInput', 'Quand je rentre le soir, je lis 15 min avant d’ouvrir le PC');
  await page.click('#saveBtn');
  await waitToast(page, /Note enregistrée/);
  await page.click('.tab[data-tab="appliquer"]');
  await page.waitForSelector('#openActions .action');
  await page.click('#openActions .action [data-act="focus"]');
  await page.waitForSelector('#focusCard');
  await shot(page, '06-appliquer');
  await page.click('#focusCard .btn.primary'); // « Je l'ai fait »
  await page.fill('#resultInput', 'Tenu 4 soirs sur 5 : 1 h de lecture en plus.');
  await page.click('#resultSave');
  await waitToast(page, /Action faite/);
  await page.waitForSelector('#doneActions .action');
  await syncNow(page);
  const fiche = (await files())['fiches/lettres-a-lucilius.md'];
  check(/> - \[x\] Quand je rentre le soir, je lis 15 min avant d’ouvrir le PC ✅ \d{4}-\d{2}-\d{2}/.test(fiche), 'action non cochée dans la fiche');
  check(fiche.includes('→ Résultat : Tenu 4 soirs sur 5'), 'résultat absent de la fiche');
});

await scenario('Session de lecture chronométrée : 25 min, jusqu’à la p. 58, objectif atteint', async () => {
  await page.click('.tab[data-tab="lire"]');
  await page.click('#sessionBtn'); // ▶ Lire
  await waitToast(page, /Session lancée/);
  check(await page.isVisible('#todayStrip.active'), 'le bandeau doit passer en mode chrono');
  await shot(page, '07-session');
  await shiftClock(page, 25 * 60000);
  await page.click('#sessionBtn'); // Terminer
  await page.waitForSelector('#sessionDialog[open]');
  check(Math.abs(Number(await page.inputValue('#ssMinutes')) - 25) <= 1, `durée proposée : ${await page.inputValue('#ssMinutes')}`);
  await page.fill('#ssPage', '58');
  await page.click('#sessionForm button[type=submit]');
  await waitToast(page, /25 min · 1 page|25 min/);
  const main = await page.textContent('#todayMain');
  check(/objectif atteint/.test(main), `bandeau : ${main}`);
  check(/p\. 58 \/ 520/.test(await page.textContent('#progressText')), 'progression non mise à jour');
});

await scenario('Le lendemain : les cartes reviennent, de mémoire puis vérification', async () => {
  await shiftClock(page, DAY + 25 * 60000);
  await page.waitForFunction(() => document.querySelector('#badgeRetenir').textContent === '2');
  await page.click('.tab[data-tab="retenir"]');
  await page.waitForSelector('#reviewStart');
  await shot(page, '08-retenir');
  await page.click('#reviewStart');
  await page.waitForSelector('#reviewFlip');
  await shot(page, '09-carte');
  await page.fill('#reviewAnswer', 'On gaspille son temps, on n’en manque pas.');
  await page.click('#reviewFlip');
  await page.click('#reviewKeep'); // « Ajouter à la note »
  await waitToast(page, /Ajouté à la note/);
  await shot(page, '10-carte-retournee');
  await page.click('.grade--good');
  await page.click('#reviewFlip');
  await page.click('.grade--again');
  await page.waitForSelector('#reviewFlip'); // la carte ratée repasse une fois, en fin de séance
  check(/Deuxième passage/.test(await page.textContent('#view-retenir')), 'la carte ratée doit repasser');
  await page.click('#reviewFlip');
  await page.click('#reviewNext');
  await page.waitForSelector('#reviewResult');
  check(/2 cartes révisées · 1 retrouvée/.test(await page.textContent('#reviewResult')), `bilan : ${await page.textContent('#reviewResult')}`);
  await syncNow(page);
  const repo = await files();
  const journal = Object.entries(repo).find(([p]) => p.startsWith('.marginalia/journal/'))[1];
  check((journal.match(/"type":"review"/g) || []).length === 2, 'les 2 révisions doivent être dans le journal');
  check(repo['fiches/lettres-a-lucilius.md'].includes('— On gaspille son temps'), 'reformulation absente de la fiche');
});

await scenario('Raccourci iPhone : une note déposée dans la boîte arrive dans la bonne fiche', async () => {
  await mock('write', {
    path: 'boite/20261118-213000-ab12.md',
    content: '---\nlivre: Lettres à Lucilius\ntype: Idée\npage: 61\ndate: 2026-11-18 21:30\n---\nTenir un journal du soir, trois lignes.\n',
    message: 'Raccourci : note',
  });
  await page.click('.tab[data-tab="lire"]');
  await page.click('#syncBtn');
  await page.waitForSelector('#syncDialog[open]');
  await page.click('#sySync');
  await waitToast(page, /Synchronisé|note arrivée/);
  await page.click('#syncDialog [data-close]');
  await page.waitForFunction(() => [...document.querySelectorAll('#notesList .note-text')].some((n) => n.textContent.includes('journal du soir')));
  const repo = await files();
  check(!Object.keys(repo).some((p) => p.startsWith('boite/')), 'la boîte doit être vidée');
  check(repo['fiches/lettres-a-lucilius.md'].includes('> [!tip] Idée · p. 61 · 2026-11-18 21:30'), 'note du raccourci absente de la fiche');
});

await scenario('Hors ligne : on note quand même, tout part au retour du réseau', async () => {
  await ctx.setOffline(true);
  await page.click('.chip[data-type="question"]');
  await page.fill('#textInput', 'Qu’est-ce que je ferais de 1 h gagnée chaque soir ?');
  await page.click('#saveBtn');
  await waitToast(page, /Note enregistrée/);
  await page.waitForSelector('#syncBtn[data-state="offline"]', { timeout: 10000 });
  await shot(page, '11-hors-ligne');
  check(!(await files())['fiches/lettres-a-lucilius.md'].includes('1 h gagnée'), 'rien ne doit partir hors ligne');
  await ctx.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForSelector('#syncBtn[data-state="ok"]', { timeout: 15000 });
  check((await files())['fiches/lettres-a-lucilius.md'].includes('1 h gagnée'), 'la note doit être arrivée sur GitHub');
});

await scenario('Jeton révoqué : l’app garde tout, signale, et se reconnecte avec un nouveau jeton', async () => {
  await mock('token', { token: NEW_TOKEN });
  token = NEW_TOKEN;
  await page.reload();
  await page.waitForSelector('#boot', { state: 'hidden' });
  check(await page.locator('#notesList .note').count() >= 4, 'les notes doivent être là, lues sur le téléphone');
  await syncNow(page);
  await page.waitForSelector('#syncBtn[data-state="error"]');
  check(/reconnecter/i.test(await page.textContent('#syncText')), `pastille : ${await page.textContent('#syncText')}`);
  await page.click('#settingsBtn');
  await page.click('#sdReconnect');
  await page.waitForSelector('#connect:not([hidden])');
  check(await page.inputValue('#cxOwner') === 'moi', 'compte pré-rempli');
  await connect(page, NEW_TOKEN);
  await waitToast(page, /Reconnecté/);
  await page.waitForSelector('#syncBtn[data-state="ok"]');
});

await scenario('Progrès : anneau, série, piliers de la semaine, calendrier, livre en cours', async () => {
  await page.click('.tab[data-tab="progres"]');
  await page.waitForSelector('#view-progres .today-card');
  const text = await page.textContent('#view-progres');
  check(/Série : 2 jours/.test(text), 'série de 2 jours attendue');
  check(/25 min/.test(text) && /1 action faite/.test(text), `piliers : ${text.slice(0, 300)}`);
  check(await page.locator('#calendar .cal-day').count() === 84, 'calendrier de 12 semaines');
  check(/p\. 61 \/ 520/.test(text), 'livre en cours (page de la note du raccourci)');
  await shot(page, '12-progres', true);
});

await scenario('Réglages : rituel partagé, guide du raccourci personnalisé, rappel du soir', async () => {
  await page.click('#settingsBtn');
  await page.waitForSelector('#settingsDialog[open]');
  check(await page.inputValue('#rtTime') === '20:30' && await page.inputValue('#rtGoal') === '20', 'rituel non repris');
  await shot(page, '13-reglages');
  await page.click('#openShortcutGuide');
  await page.waitForSelector('#guideDialog[open]');
  const guide = await page.textContent('#guideBody');
  check(guide.includes('https://api.github.com/repos/moi/marginalia-data/contents/.marginalia/livres.json'), 'URL de la liste des livres');
  check(guide.includes('https://api.github.com/repos/moi/marginalia-data/contents/boite/'), 'URL d’envoi');
  check(!guide.includes(TOKEN) && !guide.includes(NEW_TOKEN), 'le jeton ne doit jamais être affiché');
  await shot(page, '14-guide-raccourci');
  await page.click('#guideBody .btn.primary');
  await page.click('#settingsBtn');
  await page.click('#openReminderGuide');
  check((await page.textContent('#guideBody')).includes('20:30'), 'heure du rituel dans le guide du rappel');
  await page.click('#guideBody .btn.primary');
  const shared = JSON.parse((await files())['.marginalia/reglages.json']);
  check(shared.ritual.time === '20:30' && shared.goal.value === 20, 'réglages partagés dans le dépôt');
});

await scenario('Import d’une fiche de la V1 (sans identifiants) depuis le PC', async () => {
  await page.click('#settingsBtn');
  await page.setInputFiles('#sdImport', {
    name: 'le-prince.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('---\ntype: lecture\ntitre: "Le Prince"\nauteur: "[[Machiavel]]"\nstatut: en-cours\ndebut: 2026-10-01\nfin:\npages: 180\n---\n\n# Le Prince\n\n## Notes\n\n> [!quote] Citation · p. 12 · 2026-10-02 21:00\n> Il faut être renard pour connaître les pièges.\n'),
  });
  await waitToast(page, /1 fiche importée/);
  await page.click('#settingsDialog [data-close]');
  check(await page.locator('#bookSelect option[value="le-prince"]').count() === 1, 'livre importé absent');
  await syncNow(page);
  const fiche = (await files())['fiches/le-prince.md'];
  check(/Il faut être renard pour connaître les pièges\.\n\n\^[a-z0-9]{6}/.test(fiche), 'identifiant de note non ajouté à l’import');
});

await scenario('Livre terminé : bilan, puis synthèse de mémoire écrite dans la fiche', async () => {
  await page.click('.tab[data-tab="lire"]');
  await page.selectOption('#bookSelect', 'lettres-a-lucilius');
  await page.click('#bookMenuBtn');
  await page.waitForSelector('#bookDialog[open]');
  check((await page.getAttribute('#bdGithub', 'href')).endsWith('/blob/main/fiches/lettres-a-lucilius.md'), 'lien GitHub de la fiche');
  await page.click('#bdFinish');
  await page.waitForSelector('#recapDialog[open]');
  check(/Notes/.test(await page.textContent('#rcFacts')), 'bilan absent');
  await shot(page, '15-bilan');
  await page.fill('#rcText', '1. Le temps est un capital.\n2. Le soir décide de la journée.\n3. Lire 15 min avant l’écran.');
  await page.click('#rcSave');
  await waitToast(page, /Synthèse écrite/);
  await syncNow(page);
  const fiche = (await files())['fiches/lettres-a-lucilius.md'];
  check(/\nstatut: termine\n/.test(fiche) && fiche.includes('## Synthèse\n\n1. Le temps est un capital.'), 'statut ou synthèse absents');
  check(JSON.parse((await files())['.marginalia/livres.json']).enCours.join() === 'Le Prince', 'liste du raccourci à jour');
});

await scenario('Deuxième appareil : il retrouve tout, et ses notes reviennent sur le premier', async () => {
  const { context, page: other } = await phone({ clockOffset: DAY + 25 * 60000 });
  await connect(other);
  await other.waitForSelector('#app:not([hidden])');
  await other.waitForSelector('#introDialog[open]');
  await other.click('#introForm button[type=submit]');
  check(await other.locator('#bookSelect option').count() === 2, 'les 2 livres doivent être là');
  await other.selectOption('#bookSelect', 'le-prince');
  await other.click('.chip[data-type="idee"]');
  await other.fill('#textInput', 'Rendre visibles les progrès de l’équipe.');
  await other.click('#saveBtn');
  await waitToast(other, /Note enregistrée/);
  await syncNow(other);
  check(await other.locator('#view-retenir').count() === 1, 'vue');
  await context.close();
  await syncNow(page);
  await page.selectOption('#bookSelect', 'le-prince');
  await page.waitForFunction(() => [...document.querySelectorAll('#notesList .note-text')].some((n) => n.textContent.includes('progrès de l’équipe')));
  const commits = (await mock('state')).commits.map((c) => c.message);
  check(commits.every((m) => m.startsWith('Marginalia : ') || m.startsWith('Raccourci') || m.startsWith('Modification')), 'messages de commit');
});

await ctx.close();

await scenario('Captures : mode sombre et petit écran (iPhone SE)', async () => {
  const dark = await phone({ colorScheme: 'dark', clockOffset: DAY + 25 * 60000 });
  await connect(dark.page);
  await dark.page.waitForSelector('#introDialog[open]');
  await dark.page.click('#introForm button[type=submit]');
  await dark.page.selectOption('#bookSelect', 'le-prince');
  await shot(dark.page, '16-sombre-lire');
  await dark.page.click('.tab[data-tab="progres"]');
  await dark.page.waitForSelector('#view-progres .today-card');
  await shot(dark.page, '17-sombre-progres');
  await dark.context.close();
  const small = await phone({ device: 'iPhone SE', clockOffset: DAY + 25 * 60000 });
  await connect(small.page);
  await small.page.waitForSelector('#introDialog[open]');
  await small.page.click('#introForm button[type=submit]');
  const overflow = await small.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check(!overflow, 'rien ne doit déborder en largeur sur un petit écran');
  await shot(small.page, '18-iphone-se');
  await small.context.close();
});

await scenario('Aucune erreur JavaScript pendant toute la séance', async () => {
  check(pageErrors.length === 0, pageErrors.join('\n'));
});

await browser.close();
server.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} scénarios réussis · captures dans test-results/\n`);
process.exit(failed.length ? 1 : 0);
