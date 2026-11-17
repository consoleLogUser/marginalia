'use strict';
/**
 * core.js — Le socle de l'interface : l'état partagé, les petits outils, les onglets, la barre de synchro.
 *
 * Pas de framework : chaque onglet a son fichier (lire.js, retenir.js, appliquer.js, progres.js)
 * et s'enregistre dans `M.views`. Ils se parlent par un mini « bus » d'événements (M.on / M.emit).
 * Tout ce qui touche aux données passe par `window.marginalia` (api.js).
 * Sécurité : le texte des notes est toujours inséré comme TEXTE (jamais innerHTML).
 */
(() => {
  const api = window.marginalia;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  /**
   * Fabrique un élément : h('button', { class: 'btn', onclick: fn }, 'Texte').
   * Les enfants de type chaîne deviennent des nœuds texte : rien de ce que tu écris n'est interprété comme du HTML.
   */
  function h(tag, props, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'style') node.style.cssText = value; // via le CSSOM : compatible avec notre CSP stricte
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else if (key in node) node[key] = value;
      else node.setAttribute(key, value);
    }
    for (const child of children.flat()) {
      if (child !== null && child !== undefined && child !== false) node.append(child);
    }
    return node;
  }

  /** Même idée pour le SVG (qui a son propre espace de noms). */
  function svg(tag, attrs, ...children) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, value);
    node.append(...children);
    return node;
  }

  const state = {
    settings: null,
    books: [],
    book: null,
    notes: [],
    page: '',
    summary: null, // cartes à réviser, actions, lecture du jour, série, session en cours
    sync: null,
    tab: 'lire',
    clockDelta: 0, // écart entre l'horloge de l'app et celle de la page (0 en usage normal)
  };

  /* ---------------- Bus d'événements ---------------- */

  const handlers = {};
  const on = (event, fn) => { (handlers[event] ??= []).push(fn); };
  const emit = (event, payload) => { for (const fn of handlers[event] || []) fn(payload); };

  /* ---------------- Outils ---------------- */

  const debounce = (fn, ms) => {
    let timer;
    return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
  };
  const pad = (n) => String(n).padStart(2, '0');
  const now = () => Date.now() + state.clockDelta;
  const dayOf = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const today = () => dayOf(new Date(now()));
  const toDate = (day) => { const [y, m, d] = day.split('-').map(Number); return new Date(y, m - 1, d); };
  const daysBetween = (a, b) => Math.round((toDate(b) - toDate(a)) / 86400000);
  const plural = (n, one, many = `${one}s`) => `${n} ${n > 1 ? many : one}`;
  const normalizeSearch = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

  /** 85 → « 1 h 25 », 25 → « 25 min ». */
  function duration(minutes) {
    const m = Math.round(minutes);
    return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${pad(m % 60)}`;
  }

  function formatDay(isoDay, options = { day: 'numeric', month: 'long', year: 'numeric' }) {
    return /^\d{4}-\d{2}-\d{2}/.test(isoDay || '') ? toDate(isoDay.slice(0, 10)).toLocaleDateString('fr-FR', options) : '';
  }

  /** Un jour par rapport à aujourd'hui : « aujourd’hui », « hier », « demain », « dans 3 j », « 12 déc. ». */
  function relativeDay(isoDay) {
    const diff = daysBetween(today(), isoDay);
    if (diff === 0) return 'aujourd’hui';
    if (diff === 1) return 'demain';
    if (diff === -1) return 'hier';
    if (diff > 1 && diff <= 6) return `dans ${diff} j`;
    const sameYear = isoDay.slice(0, 4) === today().slice(0, 4);
    return formatDay(isoDay, { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
  }

  /** « 2026-11-15 20:31 » → « aujourd’hui · 20:31 », « hier · 08:10 », « 3 nov. · 21:02 ». */
  function formatWhen(value) {
    const m = /^(\d{4}-\d{2}-\d{2})(?: (\d{2}:\d{2}))?$/.exec(value || '');
    if (!m) return '';
    const label = relativeDay(m[1]);
    return m[2] ? `${label} · ${m[2]}` : label;
  }

  /** « il y a 2 min », « à 14:05 », « hier à 21:40 ». */
  function since(iso) {
    if (!iso) return 'jamais';
    const date = new Date(iso);
    const minutes = Math.round((now() - date.getTime()) / 60000);
    if (minutes < 1) return 'à l’instant';
    if (minutes < 60) return `il y a ${minutes} min`;
    const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    const day = dayOf(date);
    return day === today() ? `à ${time}` : `${relativeDay(day)} à ${time}`;
  }

  /** La lecture du jour en clair : « 12 / 15 min », « 8 / 10 p. », ou « 14 p. lues » (lecture sans chrono). */
  function todayLabel(t) {
    if (t.goal.type === 'pages') return `${t.pages} / ${t.goal.value} p.`;
    if (t.minutes === 0 && t.pages > 0) return `${plural(t.pages, 'page')} aujourd’hui`;
    return `${t.minutes} / ${t.goal.value} min`;
  }

  /* ---------------- Toast ---------------- */

  // Le message s'affiche dans la « couche du dessus » du navigateur (popover) : il reste visible
  // même quand une feuille (dialogue) est ouverte par-dessus l'app.
  let toastTimer = null;
  const popoverToast = typeof HTMLElement.prototype.showPopover === 'function';
  function toast(message, { action, onAction, duration: ms = 3200, error = false } = {}) {
    clearTimeout(toastTimer);
    const box = $('#toast');
    $('#toastText').textContent = message;
    box.classList.toggle('error', error);
    const button = $('#toastAction');
    button.hidden = !action;
    button.textContent = action || '';
    button.onclick = action ? () => { hideToast(); onAction(); } : null;
    box.hidden = false;
    if (popoverToast) {
      try { box.hidePopover(); } catch { /* pas encore affiché */ }
      try { box.showPopover(); } catch { /* rien */ }
    }
    toastTimer = setTimeout(hideToast, ms);
  }
  function hideToast() {
    const box = $('#toast');
    if (popoverToast) {
      try { box.hidePopover(); } catch { /* déjà masqué */ }
    }
    box.hidden = true;
  }

  /** Affiche l'erreur d'une réponse { ok: false } et renvoie true si tout va bien. */
  function ok(res, options = {}) {
    if (res.ok) return true;
    toast(res.error, { error: true, duration: 6000, ...options });
    return false;
  }

  function shake(node) {
    node.classList.remove('shake');
    void node.offsetWidth; // relance l'animation
    node.classList.add('shake');
  }

  /** Les zones de texte grandissent avec leur contenu (jusqu'à ~45 % de l'écran). */
  function autosize(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight + 2, Math.round(window.innerHeight * 0.45))}px`;
  }

  /* ---------------- Dialogues (feuilles qui montent du bas) ---------------- */

  const dialogOpen = () => Boolean($('dialog[open]'));

  function openDialog(dialog) {
    if (!dialog.open) dialog.showModal();
    document.body.classList.add('modal-open');
    // Un message affiché juste avant (« Connecté ») repasse au-dessus de la feuille qui vient de s'ouvrir.
    const box = $('#toast');
    if (popoverToast && !box.hidden) {
      try { box.hidePopover(); box.showPopover(); } catch { /* rien */ }
    }
  }

  /* ---------------- Synchronisation : la pastille en haut ---------------- */

  function syncLabel(s) {
    if (!s || s.state === 'disconnected') return { text: '', tone: 'off' };
    if (s.state === 'syncing') return { text: 'Envoi…', tone: 'busy' };
    if (s.state === 'offline') return { text: s.pending ? `Hors ligne · ${s.pending}` : 'Hors ligne', tone: 'offline' };
    if (s.state === 'auth') return { text: 'À reconnecter', tone: 'error' };
    if (s.state === 'error') return { text: 'Erreur', tone: 'error' };
    if (s.pending) return { text: `${s.pending} à envoyer`, tone: 'pending' };
    return { text: 'À jour', tone: 'ok' };
  }

  function renderSync(status) {
    if (status) state.sync = status;
    const { text, tone } = syncLabel(state.sync);
    const pill = $('#syncBtn');
    pill.hidden = tone === 'off';
    pill.dataset.state = tone;
    $('#syncText').textContent = text;
    emit('sync', state.sync);
  }

  /* ---------------- État ---------------- */

  function renderBadges() {
    const s = state.summary;
    const due = $('#badgeRetenir');
    due.hidden = !s?.due;
    due.textContent = s?.due || '';
    $('#badgeAppliquer').hidden = !s?.weeklyReviewDue;
  }

  /** Le résumé du jour vient d'être recalculé. */
  function applySummary(summary) {
    if (!summary) return;
    state.summary = summary;
    renderBadges();
    emit('summary', summary);
  }

  function applyState(next) {
    const bookChanged = state.book?.id !== next.book?.id;
    const wasConnected = Boolean(state.settings?.connected);
    Object.assign(state, {
      settings: next.settings,
      books: next.books,
      book: next.book,
      notes: next.notes,
      page: next.page,
      summary: next.summary,
      // En usage normal les deux horloges sont identiques : on ne garde l'écart que s'il est franc,
      // c'est-à-dire quand un test fait « voyager » l'app dans le temps.
      clockDelta: Math.abs(next.now - Date.now()) > 60000 ? next.now - Date.now() : 0,
    });
    const connected = Boolean(state.settings?.connected);
    $('#boot').hidden = true;
    $('#app').hidden = !connected;
    $('#connect').hidden = connected;
    if (!connected) emit('show-connect');
    renderBadges();
    renderSync(next.sync);
    emit('state', { bookChanged: bookChanged || connected !== wasConnected });
    if (state.summary) emit('summary', state.summary);
  }

  async function refresh() {
    const res = await api.getState();
    if (res.ok) applyState(res.state);
    return res.ok;
  }

  /* ---------------- Onglets ---------------- */

  const views = {};
  const TABS = ['lire', 'retenir', 'appliquer', 'progres'];
  const TITLES = { lire: 'Lire', retenir: 'Retenir', appliquer: 'Appliquer', progres: 'Progrès' };
  const scrollByTab = {};

  function setTab(tab, options = {}) {
    if (!TABS.includes(tab)) return;
    const previous = state.tab;
    if (previous !== tab) scrollByTab[previous] = window.scrollY;
    state.tab = tab;
    for (const button of $$('.tab')) button.setAttribute('aria-selected', String(button.dataset.tab === tab));
    for (const name of TABS) $(`#view-${name}`).hidden = name !== tab;
    $('#viewTitle').textContent = TITLES[tab];
    if (previous !== tab) {
      views[previous]?.hide?.();
      window.scrollTo(0, scrollByTab[tab] ?? 0);
    } else if (!options.keepScroll) {
      window.scrollTo({ top: 0, behavior: 'smooth' }); // toucher l'onglet actif remonte en haut, comme sur iOS
    }
    views[tab]?.show?.(options);
  }

  /* ---------------- Clavier virtuel : on masque la barre d'onglets pendant la saisie ---------------- */

  function watchTyping() {
    const isField = (t) => t instanceof HTMLTextAreaElement || (t instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'file'].includes(t.type)) || t instanceof HTMLSelectElement;
    let timer = null;
    document.addEventListener('focusin', (e) => {
      if (!isField(e.target)) return;
      clearTimeout(timer);
      document.body.classList.add('typing');
    });
    document.addEventListener('focusout', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!isField(document.activeElement)) document.body.classList.remove('typing');
      }, 120);
    });
  }

  /* ---------------- Mise à jour de l'app (service worker) ---------------- */

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator) || localStorage.getItem('marginalia:noSW')) return;
    let reloading = false;
    const hadController = Boolean(navigator.serviceWorker.controller); // premier lancement : pas de rechargement
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading || !hadController) return;
      reloading = true;
      window.location.reload();
    });
    navigator.serviceWorker.register('sw.js').then((reg) => {
      const offer = (worker) => toast('Une nouvelle version de Marginalia est prête.', {
        action: 'Mettre à jour',
        onAction: () => worker.postMessage('skip-waiting'),
        duration: 15000,
      });
      if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const worker = reg.installing;
        worker?.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) offer(worker);
        });
      });
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
    }).catch(() => { /* pas de mode hors ligne pour l'app elle-même : tant pis */ });
  }

  /* ---------------- Démarrage ---------------- */

  async function init() {
    for (const button of $$('.tab')) button.addEventListener('click', () => setTab(button.dataset.tab));
    for (const button of $$('[data-close]')) button.addEventListener('click', () => button.closest('dialog').close());
    for (const dialog of $$('dialog')) {
      // Toucher le fond grisé ferme la feuille ; fermer libère le défilement de la page.
      dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
      dialog.addEventListener('close', () => { if (!dialogOpen()) document.body.classList.remove('modal-open'); });
    }
    for (const view of Object.values(views)) view.init?.();
    watchTyping();

    document.addEventListener('keydown', (e) => {
      if (dialogOpen() || $('#app').hidden) return;
      views[state.tab]?.onKey?.(e); // pratique avec un clavier (iPad, PC)
    });

    $('#syncBtn').addEventListener('click', () => emit('open-sync'));
    $('#settingsBtn').addEventListener('click', () => emit('open-settings'));

    const refreshSoon = debounce(async () => {
      await refresh();
      views[state.tab]?.onRefresh?.(); // une fiche a peut-être changé ailleurs (PC, Obsidian, raccourci)
    }, 250);
    api.on('app:changed', refreshSoon);
    api.on('app:settings', refreshSoon);
    api.on('app:sync', (status) => renderSync(status));
    api.on('app:inbox', ({ added }) => {
      const books = [...new Set(added.map((a) => a.titre))];
      toast(`${plural(added.length, 'note arrivée', 'notes arrivées')} par le raccourci · ${books.join(', ')}`, { duration: 5000 });
    });
    api.on('app:rejected', ({ items }) => {
      toast(`Modification non appliquée (${items[0].label}) : ${items[0].message}`, { error: true, duration: 8000 });
    });

    const res = await api.getState();
    if (!res.ok) {
      $('#boot').hidden = true;
      $('#connect').hidden = false;
      ok(res, { duration: 15000 });
      return;
    }
    applyState(res.state);
    if (res.state.storageWarning) toast(res.state.storageWarning, { error: true, duration: 10000 });
    const wanted = new URLSearchParams(window.location.search).get('onglet');
    setTab(TABS.includes(wanted) ? wanted : 'lire', { quiet: true, keepScroll: true });
    emit('ready');
    registerServiceWorker();
  }

  window.M = {
    api, $, $$, h, svg, state, views, on, emit,
    debounce, now, today, daysBetween, plural, duration, normalizeSearch, isIOS, isStandalone,
    formatDay, relativeDay, formatWhen, todayLabel, since, syncLabel,
    toast, hideToast, ok, shake, autosize, openDialog,
    applyState, applySummary, refresh, setTab, dialogOpen, TABS,
  };
  document.addEventListener('DOMContentLoaded', init);
})();
