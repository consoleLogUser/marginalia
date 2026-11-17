'use strict';
/**
 * connexion.js — Le premier lancement : installer l'app sur l'écran d'accueil, puis la relier
 * au dépôt GitHub privé qui contiendra les notes. Sert aussi à changer de jeton (expiré, révoqué).
 */
(() => {
  const { api, $, state, toast } = M;

  const el = {
    section: $('#connect'),
    install: $('#installStep'),
    form: $('#connectForm'),
    owner: $('#cxOwner'),
    repo: $('#cxRepo'),
    token: $('#cxToken'),
    error: $('#cxError'),
    submit: $('#cxSubmit'),
    tokenLink: $('#tokenLink'),
  };
  let reconnecting = false;

  /** Sur GitHub Pages, l'adresse dit déjà qui tu es : https://<compte>.github.io/marginalia/ */
  function guessOwner() {
    const m = /^([a-z0-9-]+)\.github\.io$/i.exec(window.location.hostname);
    return m ? m[1] : '';
  }

  function updateTokenLink() {
    el.tokenLink.href = api.tokenUrl(el.owner.value.trim());
  }

  function showError(message) {
    el.error.textContent = message;
    el.error.hidden = !message;
  }

  /** iPhone dans Safari (pas encore installée) : on propose d'abord l'installation. */
  function needsInstall() {
    let skipped = false;
    try { skipped = sessionStorage.getItem('marginalia:skipInstall') === '1'; } catch { skipped = false; }
    return M.isIOS && !M.isStandalone() && !skipped && !reconnecting;
  }

  function render() {
    const install = needsInstall();
    el.install.hidden = !install;
    el.form.hidden = install;
    const c = state.settings?.connection;
    if (!el.owner.value) el.owner.value = c?.owner || guessOwner();
    if (c?.repo) el.repo.value = c.repo;
    updateTokenLink();
    $('#cxCancel')?.toggleAttribute('hidden', !reconnecting);
  }

  async function submit(event) {
    event.preventDefault();
    showError('');
    el.submit.disabled = true;
    el.submit.textContent = 'Connexion…';
    const res = await api.connect({ owner: el.owner.value, repo: el.repo.value, token: el.token.value });
    el.submit.disabled = false;
    el.submit.textContent = 'Connecter';
    if (!res.ok) {
      showError(res.error);
      return;
    }
    el.token.value = '';
    const wasReconnecting = reconnecting;
    reconnecting = false;
    M.applyState(res.state);
    $('#app').hidden = false;
    el.section.hidden = true;
    M.setTab('lire', { keepScroll: true });
    const books = res.state.books.length;
    toast(wasReconnecting ? 'Reconnecté.' : books ? `Connecté : ${M.plural(books, 'livre trouvé', 'livres trouvés')}.` : 'Connecté. Ton dépôt est prêt.', { duration: 5000 });
    M.emit('connected');
  }

  function init() {
    el.form.addEventListener('submit', submit);
    el.owner.addEventListener('input', updateTokenLink);
    $('#skipInstall').addEventListener('click', () => {
      try { sessionStorage.setItem('marginalia:skipInstall', '1'); } catch { /* rien */ }
      render();
    });
    $('#cxPaste').addEventListener('click', async () => {
      try {
        el.token.value = (await navigator.clipboard.readText()).trim();
      } catch {
        toast('Touche longuement le champ « Jeton », puis « Coller ».', { duration: 5000 });
      }
    });
    // Bouton « Retour » quand on vient des réglages (changer de jeton).
    const cancel = M.h('button', { type: 'button', class: 'link-btn', id: 'cxCancel', hidden: true }, 'Retour à l’app');
    cancel.addEventListener('click', () => {
      reconnecting = false;
      el.section.hidden = true;
      $('#app').hidden = false;
    });
    el.form.append(cancel);

    M.on('show-connect', render);
    M.on('reconnect', () => {
      reconnecting = true;
      showError('');
      $('#app').hidden = true;
      el.section.hidden = false;
      render();
      window.scrollTo(0, 0);
    });
    // Revenir dans l'app après l'avoir installée depuis Safari : on réaffiche la bonne étape.
    window.matchMedia('(display-mode: standalone)').addEventListener?.('change', render);
  }

  M.views.connexion = { init };
})();
