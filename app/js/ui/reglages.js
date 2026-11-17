'use strict';
/**
 * reglages.js — Réglages, bienvenue (rituel), état de la synchronisation, et les deux guides iPhone :
 * le raccourci « Noter » et le rappel du soir. Les guides sont personnalisés avec TON dépôt :
 * chaque valeur à saisir dans l'app Raccourcis a son bouton « Copier ».
 */
(() => {
  const { api, $, h, state, toast, ok } = M;
  const INTRO_VERSION = '3';

  const el = {
    settings: $('#settingsDialog'),
    rtTime: $('#rtTime'),
    rtGoal: $('#rtGoal'),
    rtUnit: $('#rtUnit'),
    rvLimit: $('#rvLimit'),
    optClean: $('#optClean'),
    intro: $('#introDialog'),
    sync: $('#syncDialog'),
    guide: $('#guideDialog'),
    guideBody: $('#guideBody'),
  };

  async function setSetting(key, value) {
    const res = await api.setSetting(key, value);
    if (!ok(res)) {
      fill();
      return false;
    }
    M.applyState(res.state);
    M.emit('settings-changed');
    return true;
  }

  const goalText = (goal) => `${goal.value} ${goal.type === 'pages' ? 'pages' : 'minutes'}`;

  /* ---------------- Réglages ---------------- */

  function fill() {
    const s = state.settings;
    if (!s) return;
    el.rtTime.value = s.ritual.time;
    el.rtGoal.value = s.goal.value;
    el.rtUnit.value = s.goal.type;
    el.rvLimit.value = s.reviewLimit;
    el.optClean.checked = Boolean(s.cleanCapture);
    const c = s.connection;
    $('#sdRepo').textContent = c ? `github.com/${c.owner}/${c.repo}` : 'Non connecté';
    $('#sdGithub').href = c?.htmlUrl || '#';
    $('#openReminderGuide span').textContent = `Ton iPhone te rappelle ton rituel, à ${s.ritual.time}`;
    $('#sdVersion').textContent = `Marginalia ${s.version} · cet appareil : ${s.deviceId}`;
    resetDisconnect();
  }

  function open() {
    fill();
    M.openDialog(el.settings);
  }

  function readTime(input) {
    const value = input.value.trim();
    return /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : null;
  }

  function readGoal(valueInput, unitSelect) {
    const value = parseInt(valueInput.value, 10);
    return Number.isFinite(value) && value >= 1 && value <= 600 ? { type: unitSelect.value, value } : null;
  }

  async function saveGoal() {
    const goal = readGoal(el.rtGoal, el.rtUnit);
    if (!goal) {
      M.shake(el.rtGoal);
      return;
    }
    await setSetting('goal', goal);
  }

  /* ---------------- Déconnexion (deux touches pour confirmer) ---------------- */

  function resetDisconnect() {
    const button = $('#sdDisconnect');
    button.classList.remove('danger');
    button.textContent = 'Se déconnecter';
  }

  async function disconnect() {
    const button = $('#sdDisconnect');
    const pending = state.sync?.pending ?? 0;
    if (!button.classList.contains('danger')) {
      button.classList.add('danger');
      button.textContent = pending ? `Confirmer : ${pending} modif. non envoyée${pending > 1 ? 's' : ''} perdue${pending > 1 ? 's' : ''}` : 'Confirmer la déconnexion';
      return;
    }
    const res = await api.disconnect({ force: true });
    if (!ok(res)) return;
    el.settings.close();
    M.applyState(res.state);
    toast('Déconnecté. Tes notes restent dans ton dépôt GitHub.');
  }

  /* ---------------- Import de fiches .md ---------------- */

  async function importFiles(input) {
    const files = [...input.files];
    input.value = '';
    if (!files.length) return;
    const payload = [];
    for (const file of files) {
      if (file.size > 2_000_000) {
        toast(`« ${file.name} » est trop gros pour une fiche.`, { error: true });
        continue;
      }
      payload.push({ name: file.name, content: await file.text() });
    }
    const res = await api.importFiles(payload);
    if (!ok(res)) return;
    M.applyState(res.state);
    const parts = [];
    if (res.imported.length) parts.push(`${M.plural(res.imported.length, 'fiche importée', 'fiches importées')}`);
    if (res.skipped.length) parts.push(`${res.skipped.length} déjà présente${res.skipped.length > 1 ? 's' : ''}`);
    if (res.errors.length) parts.push(res.errors[0]);
    toast(parts.join(' · ') || 'Rien à importer.', { error: res.errors.length > 0 && !res.imported.length, duration: 7000 });
  }

  /* ---------------- Bienvenue + rituel (une seule fois) ---------------- */

  function maybeIntro() {
    const s = state.settings;
    if (!s?.connected || !s.introPending || M.dialogOpen()) return;
    $('#inTime').value = s.ritual.time;
    $('#inGoal').value = s.goal.value;
    $('#inUnit').value = s.goal.type;
    M.openDialog(el.intro);
  }

  async function submitIntro(event) {
    event.preventDefault();
    const time = readTime($('#inTime'));
    const goal = readGoal($('#inGoal'), $('#inUnit'));
    if (!time || !goal) {
      M.shake(goal ? $('#inTime') : $('#inGoal'));
      return;
    }
    await api.setSetting('ritualTime', time);
    await api.setSetting('goal', goal);
    if (!(await setSetting('seenVersion', INTRO_VERSION))) return;
    el.intro.close();
    if (!state.book) M.openNewBook();
    else toast(`Rituel noté : ${time}, ${goalText(goal)}.`);
  }

  /* ---------------- Synchronisation ---------------- */

  const STATE_TEXT = {
    ok: 'Tout est envoyé, et ton téléphone a la dernière version de tes fiches.',
    pending: 'Des modifications attendent d’être envoyées (quelques secondes).',
    busy: 'Échange en cours avec GitHub…',
    offline: 'Pas de réseau : tout est gardé sur ton téléphone, l’envoi reprendra tout seul.',
    error: 'Un envoi a échoué. Il sera retenté automatiquement.',
  };

  function renderSyncDialog() {
    const s = state.sync || api.syncStatus();
    const { tone } = M.syncLabel(s);
    $('#sySummary').textContent = s.state === 'auth' ? s.error : (STATE_TEXT[tone] || '');
    $('#sySummary').dataset.state = tone;
    const facts = $('#syFacts');
    facts.textContent = '';
    const c = state.settings?.connection;
    for (const [label, value] of [
      ['Dernière synchro', M.since(s.lastSync)],
      ['En attente', s.pending ? M.plural(s.pending, 'modification') : 'rien'],
      ['Dépôt', c ? `${c.owner}/${c.repo}` : '—'],
    ]) facts.append(h('dt', null, label), h('dd', null, value));
    const errors = $('#syErrors');
    errors.textContent = '';
    errors.hidden = !(s.error && s.state !== 'auth');
    if (!errors.hidden) errors.append(h('li', null, s.error));
  }

  async function syncNow(button) {
    button.disabled = true;
    const res = await api.syncNow();
    button.disabled = false;
    if (!ok(res)) return;
    renderSyncDialog();
    const { tone } = M.syncLabel(res.status);
    if (tone === 'ok') toast('Synchronisé.');
    else if (res.status.state === 'auth') toast(res.status.error, { error: true, duration: 8000, action: 'Reconnecter', onAction: () => M.emit('reconnect') });
    else if (res.status.error) toast(res.status.error, { error: tone === 'error', duration: 6000 });
  }

  /* ---------------- Guides iPhone ---------------- */

  async function copy(text, what) {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${what} copié.`);
    } catch {
      toast('Copie impossible : sélectionne le texte et copie-le à la main.', { error: true });
    }
  }

  const copyLine = (label, value, what = label) => h('div', { class: 'copy-line' },
    h('span', { class: 'copy-label' }, label),
    h('code', { class: 'copy-value' }, value),
    h('button', { class: 'btn small', type: 'button', onclick: () => copy(value, what) }, 'Copier'),
  );

  /** Le jeton n'est jamais affiché : on le copie seulement, à la demande, précédé de « Bearer ». */
  const tokenLine = () => h('div', { class: 'copy-line' },
    h('span', { class: 'copy-label' }, 'Authorization'),
    h('code', { class: 'copy-value' }, 'Bearer github_pat_••••••'),
    h('button', {
      class: 'btn small',
      type: 'button',
      onclick: async () => {
        const res = await api.getToken();
        if (ok(res)) copy(`Bearer ${res.token}`, 'En-tête avec ton jeton');
      },
    }, 'Copier'),
  );

  const step = (title, ...body) => h('li', { class: 'guide-step' }, h('strong', null, title), ...body);
  const p = (...parts) => h('p', null, ...parts);
  const act = (name) => h('span', { class: 'action-name' }, name);

  function shortcutGuide() {
    const c = state.settings.connection;
    const base = `https://api.github.com/repos/${c.owner}/${c.repo}/contents`;
    const template = '---\nlivre: [Livre]\ntype: [Type]\npage: [Page]\ndate: [Date]\n---\n[Texte]';
    return [
      h('p', { class: 'eyebrow' }, 'Raccourci iPhone'),
      h('h2', null, 'Noter, depuis n’importe où'),
      p('Un raccourci « Noter » qui envoie ta note directement dans ton dépôt : depuis la feuille de partage (un passage sélectionné dans Safari, Kindle, Livres…), en dictant, ou d’une pression sur le bouton Action. L’app la range dans la bonne fiche à sa prochaine ouverture.'),
      p('À construire une fois, dans l’app Raccourcis (5 minutes). Les noms d’actions sont ceux d’iOS en français ; tape-les dans la recherche d’actions.'),
      h('ol', { class: 'guide' },
        step('Crée le raccourci',
          p('Raccourcis › ', act('+'), ' › nomme-le « Noter ». Touche ', act('ⓘ'), ' (en bas) › active ', act('Afficher dans la feuille de partage'), '. En haut apparaît « Recevoir … depuis Feuille de partage » : choisis ', act('Texte'), ', et « Si aucune entrée » : ', act('Continuer'), '.')),
        step('Le texte : partagé ou dicté',
          p('Ajoute ', act('Si'), ' › « Entrée du raccourci » ', act('n’a aucune valeur'), '. Dans le Si : ', act('Dicter le texte'), ' (langue : français). Dans le Sinon : une action ', act('Texte'), ' contenant « Entrée du raccourci ». Après « Fin de si », le résultat s’appelle « Si le résultat ».')),
        step('Facultatif : corriger la dictée (Apple Intelligence)',
          p(act('Utiliser le modèle'), ' › « Sur l’appareil », avec la consigne : « Corrige uniquement les erreurs de dictée et la ponctuation de ce texte, sans reformuler ni rien ajouter. Réponds seulement par le texte corrigé : » suivi de « Si le résultat ». C’est la réponse du modèle que tu utiliseras comme [Texte].')),
        step('Le type de note',
          p(act('Liste'), ' avec 4 éléments : Citation, Idée, Question, À appliquer. Puis ', act('Choisir dans la liste'), ' (invite : « Type ? »).')),
        step('Le livre (la liste vient de ton dépôt)',
          p(act('Obtenir le contenu de l’URL'), ' › URL ci-dessous, méthode ', act('GET'), ', et deux en-têtes :'),
          copyLine('URL', `${base}/.marginalia/livres.json`, 'URL de la liste des livres'),
          tokenLine(),
          copyLine('Accept', 'application/vnd.github.raw+json', 'En-tête Accept'),
          p('Puis ', act('Obtenir la valeur du dictionnaire'), ' › valeur pour la clé ', h('code', null, 'enCours'), ', et ', act('Choisir dans la liste'), ' (invite : « Livre ? »).')),
        step('La page (facultative)',
          p(act('Demander une entrée'), ' › type ', act('Texte'), ', invite « Page ? (vide si tu ne sais pas) ».')),
        step('La date',
          p(act('Date actuelle'), ' puis ', act('Formater la date'), ' › format personnalisé ', h('code', null, 'yyyy-MM-dd HH:mm'), '. Ajoute un second ', act('Formater la date'), ' (même Date actuelle) avec ', h('code', null, 'yyyyMMdd-HHmmss'), ' : il servira de nom de fichier.')),
        step('Le contenu de la note',
          p('Une action ', act('Texte'), ' avec exactement ce modèle, où tu remplaces chaque [crochet] par la variable correspondante (touche-la pour l’insérer) :'),
          h('pre', { class: 'template' }, template),
          h('button', { class: 'btn small', type: 'button', onclick: () => copy(template, 'Modèle') }, 'Copier le modèle'),
          p('Puis ', act('Encoder en base64'), ' ce Texte (si l’option existe : coupures de ligne « Aucune »).')),
        step('L’envoi',
          p(act('Obtenir le contenu de l’URL'), ' › méthode ', act('PUT'), ' › URL : ce début, suivi de la date « yyyyMMdd-HHmmss », puis ', h('code', null, '.md'), ' :'),
          copyLine('URL', `${base}/boite/`, 'Début de l’URL d’envoi'),
          tokenLine(),
          copyLine('Accept', 'application/vnd.github+json', 'En-tête Accept'),
          p('Corps de la requête : ', act('JSON'), ', deux champs de type Texte : ', h('code', null, 'message'), ' = « Raccourci : note », et ', h('code', null, 'content'), ' = le résultat de « Encoder en base64 ».')),
        step('La confirmation',
          p(act('Afficher la notification'), ' › « Noté dans [Livre] ✓ ».')),
        step('Un geste pour le lancer',
          p('iPhone avec bouton Action : Réglages › ', act('Bouton Action'), ' › Raccourci › Noter. Sinon : Réglages › Accessibilité › Toucher › ', act('Toucher le dos'), ' › Toucher deux fois › Noter. Et pour un passage lu dans Safari : sélectionne-le › Partager › Noter.')),
      ),
      h('p', { class: 'dialog-note' }, 'Ton jeton est dans le raccourci : ne partage pas ce raccourci. Si tu changes de jeton, remplace-le aux deux endroits « Authorization ».'),
      h('div', { class: 'dialog-actions' }, h('button', { class: 'btn primary', type: 'button', onclick: () => el.guide.close() }, 'Fermer')),
    ];
  }

  function reminderGuide() {
    const s = state.settings;
    return [
      h('p', { class: 'eyebrow' }, 'Rappel du soir'),
      h('h2', null, `À ${s.ritual.time}, c’est l’heure de lire`),
      p('Une web app ne peut pas t’envoyer de notification toute seule sans serveur. Ton iPhone, lui, sait le faire très bien, gratuitement, avec une automatisation :'),
      h('ol', { class: 'guide' },
        step('Crée l’automatisation',
          p('App Raccourcis › onglet ', act('Automatisation'), ' › ', act('+'), ' › ', act('Heure de la journée'), ' › ', s.ritual.time, ', ', act('Quotidien'), ' › ', act('Exécuter immédiatement'), '.')),
        step('Le message',
          p('Action ', act('Afficher la notification'), ' › « C’est l’heure de lire : ', goalText(s.goal), '. Note ce qui t’arrête. »')),
        step('Facultatif : le calme',
          p('Ajoute ', act('Définir la concentration'), ' › « Lecture » (ou « Ne pas déranger ») › activée jusqu’à « Désactivation » ou pour 1 h. Les notifications se taisent pendant que tu lis.')),
        step('Facultatif : l’app sous le pouce',
          p('Place l’icône Marginalia dans le Dock de ton écran d’accueil. Quand le rappel arrive : une pression, ▶ Lire, et le chrono tourne.')),
      ),
      h('p', { class: 'dialog-note' }, `Si tu changes l’heure de ton rituel ici, change-la aussi dans l’automatisation.`),
      h('div', { class: 'dialog-actions' }, h('button', { class: 'btn primary', type: 'button', onclick: () => el.guide.close() }, 'Fermer')),
    ];
  }

  function openGuide(kind) {
    if (!state.settings?.connection) return;
    el.guideBody.textContent = '';
    el.guideBody.append(...(kind === 'rappel' ? reminderGuide() : shortcutGuide()));
    el.settings.close();
    M.openDialog(el.guide);
    el.guideBody.scrollTop = 0;
  }

  /* ---------------- Branchements ---------------- */

  function init() {
    el.optClean.addEventListener('change', () => setSetting('cleanCapture', el.optClean.checked));
    el.rtTime.addEventListener('change', () => {
      const time = readTime(el.rtTime);
      if (!time) {
        M.shake(el.rtTime);
        return;
      }
      setSetting('ritualTime', time);
    });
    el.rtGoal.addEventListener('change', saveGoal);
    el.rtUnit.addEventListener('change', saveGoal);
    el.rvLimit.addEventListener('change', async () => {
      const limit = parseInt(el.rvLimit.value, 10);
      if (!Number.isFinite(limit) || limit < 1 || limit > 50) {
        M.shake(el.rvLimit);
        return;
      }
      await setSetting('reviewLimit', limit);
    });
    $('#sdSync').addEventListener('click', (e) => syncNow(e.currentTarget));
    $('#sySync').addEventListener('click', (e) => syncNow(e.currentTarget));
    $('#sdImport').addEventListener('change', (e) => importFiles(e.target));
    $('#sdDisconnect').addEventListener('click', disconnect);
    $('#sdReconnect').addEventListener('click', () => { el.settings.close(); M.emit('reconnect'); });
    $('#openShortcutGuide').addEventListener('click', () => openGuide('raccourci'));
    $('#openReminderGuide').addEventListener('click', () => openGuide('rappel'));
    $('#introForm').addEventListener('submit', submitIntro);
    el.intro.addEventListener('cancel', () => { api.setSetting('seenVersion', INTRO_VERSION); });

    M.on('open-settings', open);
    M.on('open-sync', () => {
      renderSyncDialog();
      M.openDialog(el.sync);
    });
    M.on('sync', () => { if (el.sync.open) renderSyncDialog(); });
    M.on('ready', () => setTimeout(maybeIntro, 300));
    M.on('connected', () => setTimeout(maybeIntro, 300));
  }

  M.views.reglages = { init };
})();
