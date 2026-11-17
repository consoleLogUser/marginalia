'use strict';
/**
 * lire.js — L'onglet « Lire » : prendre des notes pendant la lecture, et suivre sa session.
 * Version téléphone : on n'ouvre jamais le clavier tout seul (seulement quand tu touches un champ),
 * et le bouton « Coller » récupère un passage copié depuis Safari, Kindle ou un PDF.
 */
(() => {
  const { api, $, $$, h, state, toast, ok, debounce } = M;

  const TYPES = ['citation', 'idee', 'question', 'appliquer'];
  const PLACEHOLDERS = {
    citation: 'Le passage qui t’a arrêté…',
    idee: 'L’idée que cette lecture t’inspire…',
    question: 'Ce que tu te demandes, ce que tu veux creuser…',
    appliquer: 'Quand [situation], je [action]. Une action par ligne.',
  };
  const RING = 2 * Math.PI * 15; // périmètre de l'anneau du jour (rayon 15)
  const pad = (n) => String(n).padStart(2, '0');

  const el = {
    bookSelect: $('#bookSelect'),
    bookMenuBtn: $('#bookMenuBtn'),
    bookAuthor: $('#bookAuthor'),
    progress: $('#progress'),
    progressBar: $('#progressBar'),
    progressText: $('#progressText'),
    emptyBook: $('#emptyBook'),
    strip: $('#todayStrip'),
    ring: $('#todayRing'),
    todayMain: $('#todayMain'),
    todaySub: $('#todaySub'),
    sessionBtn: $('#sessionBtn'),
    form: $('#noteForm'),
    chips: $$('.chip'),
    text: $('#textInput'),
    comment: $('#commentInput'),
    applyHint: $('#applyHint'),
    pageInput: $('#pageInput'),
    tags: $('#tagsInput'),
    tagSuggestions: $('#tagSuggestions'),
    notesSection: $('.notes'),
    noteCount: $('#noteCount'),
    filter: $('#filterInput'),
    notesList: $('#notesList'),
    notesEmpty: $('#notesEmpty'),
    newBookDialog: $('#newBookDialog'),
    newBookForm: $('#newBookForm'),
    nbTitle: $('#nbTitle'),
    bookDialog: $('#bookDialog'),
    bdFinish: $('#bdFinish'),
    bdAbandon: $('#bdAbandon'),
    bdPage: $('#bdPage'),
    sessionDialog: $('#sessionDialog'),
    ssMinutes: $('#ssMinutes'),
    ssPage: $('#ssPage'),
    recapDialog: $('#recapDialog'),
    rcText: $('#rcText'),
  };

  const ui = {
    type: 'citation',
    filter: '',
    lastSaved: null, // { bookId, block, note, input } : pour pouvoir annuler la dernière note
    carryOver: null, // texte capturé avant qu'un livre existe : on le garde pour la fiche qu'on va créer
    timer: null, // rafraîchit le chronomètre de session chaque seconde
    recapBookId: null,
  };

  /* ---------------- Brouillons : une note en cours n'est jamais perdue ---------------- */

  const draftKey = (bookId) => `marginalia:draft:${bookId}`;

  function saveDraft() {
    if (!state.book) return;
    const draft = { type: ui.type, text: el.text.value, comment: el.comment.value, tags: el.tags.value };
    try {
      if (draft.text.trim() || draft.comment.trim()) localStorage.setItem(draftKey(state.book.id), JSON.stringify(draft));
      else localStorage.removeItem(draftKey(state.book.id));
    } catch { /* stockage indisponible : tant pis pour le brouillon */ }
  }
  const scheduleDraft = debounce(saveDraft, 400);

  function clearDraft(bookId) {
    try { localStorage.removeItem(draftKey(bookId)); } catch { /* rien */ }
  }

  function fillForm({ type, text = '', comment = '', tags = '' } = {}) {
    el.text.value = text;
    el.comment.value = comment;
    el.tags.value = tags;
    if (TYPES.includes(type)) ui.type = type;
    renderTypes();
    M.autosize(el.text);
    M.autosize(el.comment);
  }

  /** Changement de livre : on remet la page et le brouillon propres à ce livre. */
  function onBookChanged() {
    el.pageInput.value = state.page ?? '';
    el.filter.value = '';
    ui.filter = '';
    if (!state.book) return;
    if (ui.carryOver) {
      fillForm(ui.carryOver);
      ui.carryOver = null;
      return;
    }
    let draft = null;
    try { draft = JSON.parse(localStorage.getItem(draftKey(state.book.id)) || 'null'); } catch { draft = null; }
    fillForm(draft || { type: ui.type });
  }

  /* ---------------- Rendu ---------------- */

  function render() {
    const s = state.settings;
    if (!s?.connected) return;
    const hasBook = Boolean(state.book);
    el.emptyBook.hidden = hasBook;
    el.form.hidden = !hasBook;
    el.notesSection.hidden = !hasBook;
    el.bookMenuBtn.disabled = !hasBook;

    renderBookSelect();
    renderBookMeta();
    renderToday();
    renderTypes();
    renderTagSuggestions();
    renderNotes();
  }

  function renderBookSelect() {
    const select = el.bookSelect;
    select.textContent = '';
    if (!state.books.length) {
      select.append(new Option('Aucun livre', ''));
      select.disabled = true;
      return;
    }
    select.disabled = false;
    const groups = [['en-cours', 'En cours'], ['termine', 'Terminés'], ['abandonne', 'Abandonnés']];
    for (const [statut, label] of groups) {
      const books = state.books.filter((b) => b.statut === statut);
      if (!books.length) continue;
      const group = document.createElement('optgroup');
      group.label = label;
      for (const b of books) group.append(new Option(b.titre, b.id)); // l'auteur est affiché juste en dessous
      select.append(group);
    }
    select.value = state.book?.id ?? '';
  }

  /** La page la plus avancée connue pour le livre affiché (progression enregistrée, ou page en cours de saisie). */
  function reachedPage() {
    const known = state.summary?.progress?.[state.book?.id] ?? 0;
    const typed = /^\d{1,5}$/.test(el.pageInput.value.trim()) ? Number(el.pageInput.value) : 0;
    return Math.max(known, typed);
  }

  function renderBookMeta() {
    const b = state.book;
    el.bookAuthor.textContent = b ? [b.auteur, b.format === 'numerique' ? 'numérique' : 'papier'].filter(Boolean).join(' · ') : '';
    const page = b ? reachedPage() : 0;
    let text = b?.pages ? `${b.pages} pages` : '';
    let pct = null;
    if (b?.pages && page > 0) {
      pct = Math.min(100, Math.round((page / b.pages) * 100));
      text = `p. ${page} / ${b.pages} · ${pct} %`;
    }
    if (b?.statut === 'termine') text = b.fin ? `Terminé le ${M.formatDay(b.fin)}` : 'Terminé';
    if (b?.statut === 'abandonne') text = 'Abandonné';
    el.progressText.textContent = text;
    el.progress.hidden = pct === null || b?.statut !== 'en-cours';
    el.progressBar.style.width = `${pct ?? 0}%`;
  }

  function streakLabel(streak) {
    if (!streak.current) return streak.record > 1 ? `record : ${streak.record} jours — on repart ?` : 'premier jour d’une série ?';
    if (streak.atRisk) return `série de ${M.plural(streak.current, 'jour')} — lis aujourd’hui pour la garder`;
    return `série : ${M.plural(streak.current, 'jour')}${streak.readToday ? '' : ' · à prolonger'}`;
  }

  /** Le bandeau du jour : anneau d'objectif + série, ou chronomètre quand une session est en cours. */
  function renderToday() {
    const s = state.summary;
    clearInterval(ui.timer);
    ui.timer = null;
    const visible = Boolean(s && state.book);
    el.strip.hidden = !visible;
    if (!visible) return;

    const session = s.session;
    el.strip.classList.toggle('active', Boolean(session));
    el.strip.classList.toggle('done', s.today.done);
    el.ring.style.strokeDasharray = `${(s.today.ratio * RING).toFixed(1)} ${RING.toFixed(1)}`;
    el.ring.style.opacity = s.today.ratio > 0 ? '1' : '0'; // à 0 %, le bout arrondi du trait laisserait un point

    if (session) {
      const startedAt = new Date(session.start).getTime();
      const tick = () => {
        const seconds = Math.max(0, Math.floor((M.now() - startedAt) / 1000));
        const hours = Math.floor(seconds / 3600);
        const rest = `${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}`;
        el.todayMain.textContent = hours ? `${hours}:${rest}` : rest;
      };
      tick();
      ui.timer = setInterval(tick, 1000);
      el.todaySub.textContent = session.bookId !== state.book.id ? `en cours · ${session.titre}`
        : session.fromPage ? `depuis la p. ${session.fromPage}` : 'session en cours';
      el.sessionBtn.textContent = 'Terminer';
      el.sessionBtn.classList.remove('ghost');
      el.sessionBtn.classList.add('primary');
    } else {
      el.todayMain.textContent = M.todayLabel(s.today) + (s.today.done ? ' · objectif atteint' : '');
      el.todaySub.textContent = streakLabel(s.streak);
      el.sessionBtn.textContent = '▶ Lire';
      el.sessionBtn.classList.toggle('primary', !s.today.done);
    }
  }

  function renderTypes() {
    for (const chip of el.chips) chip.setAttribute('aria-checked', String(chip.dataset.type === ui.type));
    el.text.placeholder = PLACEHOLDERS[ui.type];
    el.comment.hidden = ui.type !== 'citation';
    el.applyHint.hidden = ui.type !== 'appliquer';
  }

  function setType(type) {
    if (!TYPES.includes(type)) return;
    ui.type = type;
    renderTypes();
    scheduleDraft();
  }

  /** Insère le gabarit « Quand …, je … » et place le curseur après « Quand ». */
  function insertTemplate() {
    const current = el.text.value.replace(/\s+$/, '');
    const prefix = current ? `${current}\n` : '';
    el.text.value = `${prefix}Quand , je `;
    const caret = prefix.length + 'Quand '.length;
    el.text.focus();
    el.text.setSelectionRange(caret, caret);
    M.autosize(el.text);
    scheduleDraft();
  }

  function currentTags() {
    return new Set(el.tags.value.split(/[\s,;]+/).map((t) => t.replace(/^#+/, '').toLowerCase()).filter(Boolean));
  }

  /** Suggestions : les tags les plus utilisés dans ce livre. */
  function renderTagSuggestions() {
    const counts = new Map();
    for (const n of state.notes) for (const t of n.tags) counts.set(t, (counts.get(t) || 0) + 1);
    const already = currentTags();
    const top = [...counts].sort((a, b) => b[1] - a[1]).map(([t]) => t).filter((t) => !already.has(t)).slice(0, 6);
    el.tagSuggestions.textContent = '';
    for (const tag of top) {
      el.tagSuggestions.append(h('button', {
        class: 'tag-suggestion',
        type: 'button',
        onclick: () => {
          el.tags.value = `${`${el.tags.value.trim()} #${tag}`.trim()} `;
          renderTagSuggestions();
          scheduleDraft();
        },
      }, `#${tag}`));
    }
    el.tagSuggestions.hidden = top.length === 0;
  }

  function isUndoable(note) {
    const ls = ui.lastSaved;
    return Boolean(ls && ls.bookId === state.book?.id && note === state.notes[state.notes.length - 1] && note.id === ls.note.id);
  }

  function renderNotes() {
    const query = M.normalizeSearch(ui.filter.trim());
    const notes = state.notes.slice().reverse().filter((n) => {
      if (!query) return true;
      const haystack = [n.text, n.comment, n.page && `p. ${n.page}`, n.label, ...n.tags.map((t) => `#${t}`)].join(' ');
      return M.normalizeSearch(haystack).includes(query);
    });
    el.noteCount.textContent = state.notes.length ? `· ${state.notes.length}` : '';
    el.notesList.textContent = '';
    for (const note of notes) el.notesList.append(noteItem(note));
    el.notesEmpty.hidden = notes.length > 0;
    el.notesEmpty.textContent = state.notes.length
      ? 'Aucune note ne correspond au filtre.'
      : 'Pas encore de note. Le premier passage qui t’arrête mérite sa place ici.';
  }

  function noteItem(note) {
    const li = h('li', { class: `note note--${note.type}`, tabIndex: 0 });
    li.append(h('div', { class: 'note-head' },
      h('span', { class: 'note-type' }, note.label),
      note.page && h('span', { class: 'note-page' }, `p. ${note.page}`),
      h('span', { class: 'note-time' }, M.formatWhen(note.date)),
      isUndoable(note) && h('button', {
        class: 'note-undo',
        type: 'button',
        title: 'Retirer cette note de la fiche et la remettre dans l’éditeur',
        onclick: (e) => { e.stopPropagation(); undo(); },
      }, 'Annuler'),
    ));

    if (note.tasks) {
      li.append(h('ul', { class: 'note-tasks' }, note.tasks.map((task) => h('li', { class: task.status },
        task.text,
        task.result && h('span', { class: 'task-result' }, `→ ${task.result}`),
      ))));
    } else {
      li.append(h('p', { class: 'note-text' }, note.text));
    }
    for (const comment of note.comments || []) li.append(h('p', { class: 'note-comment' }, comment));
    if (note.tags.length) {
      li.append(h('div', { class: 'note-tags' }, note.tags.map((tag) => h('button', {
        class: 'note-tag',
        type: 'button',
        title: 'Filtrer sur ce tag',
        onclick: (e) => {
          e.stopPropagation();
          el.filter.value = `#${tag}`;
          ui.filter = el.filter.value;
          renderNotes();
        },
      }, `#${tag}`))));
    }
    const toggle = () => li.classList.toggle('expanded');
    li.addEventListener('click', toggle);
    li.addEventListener('keydown', (e) => {
      if (e.target === li && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggle(); }
    });
    return li;
  }

  /* ---------------- Notes ---------------- */

  async function save() {
    if (!state.book) return openNewBook();
    if (!el.text.value.trim()) {
      M.shake(el.text.closest('.sheet'));
      return;
    }
    const input = {
      bookId: state.book.id,
      type: ui.type,
      page: el.pageInput.value.trim(),
      text: el.text.value,
      comment: ui.type === 'citation' ? el.comment.value : '',
      tags: el.tags.value,
    };
    const submit = el.form.querySelector('[type="submit"]');
    submit.disabled = true;
    const res = await api.saveNote(input);
    submit.disabled = false;
    if (!ok(res)) return;

    ui.lastSaved = { bookId: input.bookId, block: res.block, note: res.note, input };
    state.notes = res.notes;
    state.book = res.book;
    state.books = state.books.map((b) => (b.id === res.book.id ? res.book : b));
    fillForm({ type: ui.type });
    clearDraft(input.bookId);
    el.filter.value = '';
    ui.filter = '';
    M.applySummary(res.summary);
    render();
    document.activeElement?.blur?.(); // le clavier se range : tu vois ta note arriver dans la liste
    toast(`Note enregistrée${input.page ? ` · p. ${input.page}` : ''}`, { action: 'Annuler', onAction: undo, duration: 7000 });
  }

  async function undo() {
    const ls = ui.lastSaved;
    if (!ls) return;
    const res = await api.undoLastNote({ bookId: ls.bookId, block: ls.block });
    if (!ok(res)) return;
    ui.lastSaved = null;
    M.applySummary(res.summary);
    if (state.book?.id === ls.bookId) {
      state.notes = res.notes;
      state.book = res.book;
      el.pageInput.value = ls.input.page;
      fillForm({ type: ls.input.type, text: ls.input.text, comment: ls.input.comment, tags: ls.input.tags });
      render();
    } else {
      await M.refresh();
    }
    toast('Note annulée — le texte est revenu dans l’éditeur.');
  }

  /* ---------------- Page et progression ---------------- */

  // La page saisie est mémorisée tout de suite ; la PROGRESSION du livre, elle, n'avance qu'une fois
  // la saisie terminée (on ne veut pas compter « 5 » puis « 57 » pendant que tu tapes).
  const persistPage = debounce(() => {
    if (state.book) api.setPage(state.book.id, el.pageInput.value.trim());
  }, 500);
  const commitPage = debounce(async () => {
    if (!state.book) return;
    const res = await api.setPage(state.book.id, el.pageInput.value.trim(), true);
    if (res.ok && res.summary) M.applySummary(res.summary);
  }, 1200);

  function bumpPage(delta) {
    const n = parseInt(el.pageInput.value, 10);
    el.pageInput.value = Number.isFinite(n) ? String(Math.max(1, n + delta)) : delta > 0 ? '1' : '';
    renderBookMeta();
    commitPage();
  }

  /* ---------------- Livres ---------------- */

  async function selectBook(bookId) {
    if (!bookId || bookId === state.book?.id) return;
    saveDraft();
    const res = await api.selectBook(bookId);
    if (!ok(res)) {
      renderBookSelect();
      return;
    }
    M.applyState(res.state);
  }

  function openNewBook() {
    if (!state.settings?.connected) return;
    el.newBookForm.reset();
    M.openDialog(el.newBookDialog);
    el.nbTitle.focus();
  }

  async function createBook(event) {
    event.preventDefault();
    const data = new FormData(el.newBookForm);
    const input = Object.fromEntries(['titre', 'auteur', 'pages', 'pageActuelle', 'format'].map((k) => [k, String(data.get(k) || '').trim()]));
    if (!input.titre) {
      el.nbTitle.focus();
      return;
    }
    // Si une note est en cours de saisie, elle suit vers le nouveau livre.
    if (!ui.carryOver && el.text.value.trim()) {
      ui.carryOver = { type: ui.type, text: el.text.value, comment: el.comment.value, tags: el.tags.value };
      if (state.book) clearDraft(state.book.id);
    }
    const res = await api.createBook(input);
    if (!ok(res)) return;
    el.newBookDialog.close();
    M.applyState(res.state);
    toast(`Fiche créée : ${res.state.book?.titre}`);
  }

  function facts(list, pairs) {
    list.textContent = '';
    for (const [label, value] of pairs) if (value) list.append(h('dt', null, label), h('dd', null, String(value)));
  }

  function openBookDialog() {
    const b = state.book;
    if (!b) return;
    $('#bdTitle').textContent = b.titre;
    $('#bdAuthor').textContent = b.auteur || '';
    $('#bdAuthor').hidden = !b.auteur;
    facts($('#bdFacts'), [
      ['Commencé', M.formatDay(b.debut) || '—'],
      [b.statut === 'abandonne' ? 'Abandonné' : 'Terminé', b.fin && M.formatDay(b.fin)],
      ['Notes', String(b.noteCount)],
      ['Pages', b.pages],
      ['Fichier', `fiches/${b.id}.md`],
    ]);
    const c = state.settings?.connection;
    $('#bdGithub').href = c ? `${c.htmlUrl}/blob/${encodeURIComponent(c.branch || 'main')}/fiches/${b.id.split('/').map(encodeURIComponent).join('/')}.md` : '#';
    el.bdPage.value = state.summary?.progress?.[b.id] ?? '';
    el.bdFinish.textContent = b.statut === 'en-cours' ? 'J’ai terminé ce livre' : 'Reprendre la lecture';
    $('#bdSynthesis').hidden = b.statut !== 'termine';
    el.bdAbandon.hidden = b.statut !== 'en-cours';
    el.bdAbandon.textContent = 'Mettre ce livre de côté';
    el.bdAbandon.classList.remove('danger');
    M.openDialog(el.bookDialog);
  }

  async function setStatus(statut) {
    const res = await api.setBookStatus(state.book.id, statut);
    if (!ok(res)) return;
    el.bookDialog.close();
    M.applyState(res.state);
    if (res.recap) return openRecap(res.recap, state.book.id);
    toast(statut === 'en-cours' ? 'Lecture reprise.' : 'Livre mis de côté. Ses notes restent dans la fiche.');
  }

  async function correctProgress() {
    const res = await api.correctProgress(state.book.id, el.bdPage.value.trim());
    if (!ok(res)) return;
    el.pageInput.value = String(res.page);
    M.applySummary(res.summary);
    renderBookMeta();
    el.bookDialog.close();
    toast(`Progression corrigée : p. ${res.page}`);
  }

  /** Livre terminé : le bilan, puis la synthèse écrite DE MÉMOIRE (avant de relire ses notes). */
  function openRecap(recap, bookId) {
    ui.recapBookId = bookId;
    $('#rcTitle').textContent = recap.titre;
    facts($('#rcFacts'), [
      ['Lu en', recap.span && M.plural(recap.span, 'jour')],
      ['Sessions', recap.sessions && `${recap.sessions} · ${M.duration(recap.minutes)}`],
      ['Notes', `${recap.notes} — ${M.plural(recap.citations, 'citation')}, ${M.plural(recap.idees, 'idée')}, ${M.plural(recap.questions, 'question')}`],
      ['Actions', recap.actions && `${recap.actions} à mettre en pratique`],
    ]);
    $('#rcSynthesis').hidden = !recap.synthesisPending;
    $('#rcSave').hidden = !recap.synthesisPending;
    el.rcText.value = '';
    M.openDialog(el.recapDialog);
  }

  async function saveSynthesis(event) {
    event.preventDefault();
    if (!el.rcText.value.trim()) {
      M.shake(el.rcText);
      return;
    }
    const res = await api.writeSynthesis(ui.recapBookId, el.rcText.value);
    if (!ok(res)) return;
    el.recapDialog.close();
    toast('Synthèse écrite dans la fiche. Compare-la maintenant à tes notes : ce qui manque est ce qu’il faut revoir.', { duration: 8000 });
  }

  /* ---------------- Session de lecture ---------------- */

  async function toggleSession() {
    if (state.summary?.session) return openSessionDialog();
    if (!state.book) return;
    const res = await api.startSession({ bookId: state.book.id, page: el.pageInput.value.trim() });
    if (!ok(res)) return;
    M.applySummary(res.summary);
    toast('Session lancée. Bonne lecture — note ce qui t’arrête.');
  }

  function openSessionDialog() {
    const session = state.summary.session;
    const minutes = Math.max(1, Math.round((M.now() - new Date(session.start).getTime()) / 60000));
    const known = state.summary.progress?.[session.bookId] ?? session.fromPage ?? 0;
    const typed = session.bookId === state.book?.id && /^\d{1,5}$/.test(el.pageInput.value.trim()) ? Number(el.pageInput.value) : 0;
    $('#ssBook').textContent = session.titre;
    el.ssMinutes.value = Math.min(600, minutes);
    el.ssPage.value = Math.max(known, typed) || '';
    $('#ssHint').textContent = minutes > 240
      ? 'Cette session est ouverte depuis longtemps : corrige la durée réellement lue.'
      : session.fromPage ? `Tu étais à la p. ${session.fromPage} en commençant.` : '';
    M.openDialog(el.sessionDialog);
  }

  async function submitSession(event) {
    event.preventDefault();
    const wasDone = state.summary.today.done;
    const res = await api.stopSession({ toPage: el.ssPage.value.trim(), minutes: el.ssMinutes.value.trim() });
    if (!ok(res)) return;
    el.sessionDialog.close();
    const { session, summary } = res;
    if (session.bookId === state.book?.id && session.toPage) el.pageInput.value = String(session.toPage);
    M.applySummary(summary);
    renderBookMeta();

    let message = [M.duration(session.minutes), session.pages && M.plural(session.pages, 'page')].filter(Boolean).join(' · ');
    if (summary.today.done && !wasDone) message += ' — objectif du jour atteint';
    if (summary.streak.current > 1) message += ` · série : ${summary.streak.current} jours`;
    // Le meilleur moment pour réviser : juste après avoir lu.
    toast(message, summary.due
      ? { action: `Réviser (${summary.due})`, onAction: () => M.setTab('retenir'), duration: 9000 }
      : { duration: 5000 });
  }

  async function discardSession() {
    const res = await api.cancelSession();
    if (!ok(res)) return;
    el.sessionDialog.close();
    M.applySummary(res.summary);
    toast('Session non comptée.');
  }

  /* ---------------- Coller un passage copié (Safari, Kindle, PDF) ---------------- */

  /** Insère du texte à l'endroit du curseur (ou à la fin), comme un collage normal. */
  function insertText(text) {
    const area = el.text;
    const start = document.activeElement === area ? area.selectionStart : area.value.length;
    const end = document.activeElement === area ? area.selectionEnd : area.value.length;
    const before = area.value.slice(0, start);
    const glue = before && !/\s$/.test(before) ? '\n' : '';
    area.setRangeText(glue + text, start, end, 'end');
    M.autosize(area);
    scheduleDraft();
  }

  async function pasteFromClipboard() {
    if (!state.book) return openNewBook();
    let raw = '';
    try {
      raw = await navigator.clipboard.readText(); // iOS affiche sa bulle « Coller » : touche-la
    } catch {
      toast('Touche longuement la zone de texte, puis « Coller ».', { duration: 5000 });
      return;
    }
    if (!raw.trim()) {
      toast('Rien à coller : copie d’abord un passage (dans Safari, Kindle, un PDF…).', { duration: 5000 });
      return;
    }
    let text = raw.trim();
    let page = '';
    if (state.settings?.cleanCapture) {
      const res = await api.cleanText(raw);
      if (res.ok) ({ text, page } = res);
    }
    if (!el.text.value.trim()) setType('citation'); // un passage collé dans une note vide : c'est une citation
    insertText(text);
    if (page) {
      el.pageInput.value = page;
      renderBookMeta();
      persistPage();
    }
    toast(`Passage collé${page ? ` · p. ${page}` : ''}${ui.type === 'citation' ? ' — ajoute ton commentaire si tu veux.' : ''}`);
  }

  /* ---------------- Branchements ---------------- */

  function init() {
    el.form.addEventListener('submit', (e) => { e.preventDefault(); save(); });
    for (const chip of el.chips) chip.addEventListener('click', () => setType(chip.dataset.type));
    $('#applyTemplateBtn').addEventListener('click', insertTemplate);
    $('#pasteBtn').addEventListener('click', pasteFromClipboard);

    for (const textarea of [el.text, el.comment]) {
      textarea.addEventListener('input', () => { M.autosize(textarea); scheduleDraft(); });
    }
    el.tags.addEventListener('input', () => { renderTagSuggestions(); scheduleDraft(); });

    // Collage depuis un PDF : on recolle les lignes et césures automatiquement.
    el.text.addEventListener('paste', async (e) => {
      const raw = e.clipboardData?.getData('text/plain') || '';
      if (!state.settings?.cleanCapture || !/\n|­|[ﬀ-ﬆ]/.test(raw)) return;
      e.preventDefault();
      const res = await api.cleanText(raw);
      const cleaned = res.ok ? res.text : raw;
      if (!document.execCommand('insertText', false, cleaned)) el.text.setRangeText(cleaned, el.text.selectionStart, el.text.selectionEnd, 'end');
      M.autosize(el.text);
      scheduleDraft();
    });

    el.pageInput.addEventListener('input', () => { renderBookMeta(); persistPage(); });
    el.pageInput.addEventListener('change', commitPage);
    $('#pageUp').addEventListener('click', () => bumpPage(1));
    $('#pageDown').addEventListener('click', () => bumpPage(-1));

    el.bookSelect.addEventListener('change', () => selectBook(el.bookSelect.value));
    $('#newBookBtn').addEventListener('click', openNewBook);
    $('#emptyNewBookBtn').addEventListener('click', openNewBook);
    el.bookMenuBtn.addEventListener('click', openBookDialog);
    el.newBookForm.addEventListener('submit', createBook);

    $('#bdPageSave').addEventListener('click', correctProgress);
    $('#bdSynthesis').addEventListener('click', async () => {
      const bookId = state.book.id;
      const res = await api.getRecap(bookId);
      if (!ok(res)) return;
      el.bookDialog.close();
      openRecap(res.recap, bookId);
    });
    el.bdFinish.addEventListener('click', () => setStatus(state.book.statut === 'en-cours' ? 'termine' : 'en-cours'));
    el.bdAbandon.addEventListener('click', () => {
      if (!el.bdAbandon.classList.contains('danger')) { // deuxième clic pour confirmer
        el.bdAbandon.classList.add('danger');
        el.bdAbandon.textContent = 'Confirmer l’abandon';
        return;
      }
      setStatus('abandonne');
    });

    el.sessionBtn.addEventListener('click', toggleSession);
    $('#sessionForm').addEventListener('submit', submitSession);
    $('#ssDiscard').addEventListener('click', discardSession);
    $('#recapForm').addEventListener('submit', saveSynthesis);

    el.filter.addEventListener('input', () => { ui.filter = el.filter.value; renderNotes(); });

    window.addEventListener('pagehide', saveDraft);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveDraft(); });
    window.addEventListener('resize', debounce(() => { M.autosize(el.text); M.autosize(el.comment); }, 150));

    M.on('state', ({ bookChanged }) => {
      if (bookChanged) onBookChanged();
      render();
    });
    M.on('summary', () => { renderToday(); renderBookMeta(); });
  }

  M.openNewBook = openNewBook;
  M.views.lire = {
    init,
    hide: saveDraft,
    onKey(e) {
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key === 'Enter') { e.preventDefault(); save(); } // clavier d'iPad ou de PC
      else if (ctrl && !e.altKey && /^Digit[1-4]$/.test(e.code)) { e.preventDefault(); setType(TYPES[Number(e.code.slice(5)) - 1]); }
    },
  };
})();
