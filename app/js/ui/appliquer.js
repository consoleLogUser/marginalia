'use strict';
/**
 * appliquer.js — L'onglet « Appliquer » : ce que tes lectures changent dans ta façon de faire.
 *
 * Tes notes « À appliquer » de tous les livres arrivent ici. Trois idées :
 *   1. une action s'écrit « Quand [situation], je [action] » : précise, donc faisable ;
 *   2. UNE seule action de la semaine : en viser plusieurs à la fois dilue l'effet ;
 *   3. une action faite se termine par « qu'est-ce que ça a donné ? » — c'est ce résultat,
 *      écrit dans la fiche, qui transforme une lecture en expérience.
 */
(() => {
  const { api, $, h, toast, ok } = M;
  const root = $('#view-appliquer');

  let data = null;
  let editing = null; // clé de l'action dont on saisit le résultat
  let confirming = null; // clé de l'action dont on confirme l'abandon

  async function load() {
    const res = await api.getActions();
    if (!ok(res)) return false;
    apply(res);
    return true;
  }

  function apply(res) {
    data = res.payload;
    M.applySummary(res.summary);
  }

  const source = (task) => [task.titre, task.page && `p. ${task.page}`].filter(Boolean).join(' · ');
  const age = (task) => (task.ageDays === 0 ? 'notée aujourd’hui' : task.ageDays === 1 ? 'notée hier' : `notée il y a ${task.ageDays} j`);
  const target = (task) => ({ noteId: task.noteId, index: task.index });

  function render() {
    root.textContent = '';
    if (!data) return;
    const { open, focus, done } = data;

    if (data.weeklyReviewDue) {
      root.append(h('section', { class: 'weekly', id: 'weeklyBanner' },
        h('div', null,
          h('strong', null, 'Revue de la semaine'),
          h('p', null, 'Deux minutes. Pour chaque action : faite, pas encore, ou abandonnée. Puis choisis celle de la semaine qui vient.'),
        ),
        h('button', { class: 'btn small primary', type: 'button', id: 'weeklyDone', onclick: weeklyDone }, 'Revue faite'),
      ));
    }

    if (!open.length && !done.length) {
      root.append(h('section', { class: 'hero' },
        h('p', { class: 'eyebrow' }, 'Appliquer'),
        h('h2', { class: 'hero-title' }, 'Aucune action pour l’instant'),
        h('p', { class: 'hero-text' }, 'Pendant ta lecture, quand une idée mérite d’être essayée : note-la en « À appliquer », sous la forme « Quand [situation], je [action] ». Elle arrivera ici.'),
      ));
      return;
    }

    // L'action de la semaine
    root.append(h('h3', { class: 'section-title' }, 'Action de la semaine'));
    if (focus) {
      root.append(h('section', { class: 'focus-card', id: 'focusCard' },
        h('p', { class: 'focus-text' }, focus.text),
        h('p', { class: 'action-meta' }, `${source(focus)} · choisie ${M.relativeDay(focus.since)}`),
        editing === focus.key ? resultForm(focus) : h('div', { class: 'action-buttons' },
          h('button', { class: 'btn small primary', type: 'button', onclick: () => edit(focus.key) }, '✓ Je l’ai fait'),
          h('button', { class: 'btn small ghost', type: 'button', onclick: () => setFocus(null) }, 'Changer'),
        ),
      ));
    } else if (open.length) {
      root.append(h('p', { class: 'focus-empty' },
        'Choisis-en UNE ci-dessous (☆). Une seule : c’est ce qui la rend faisable cette semaine.'));
    } else {
      root.append(h('p', { class: 'focus-empty' }, 'Tout est fait. La prochaine viendra de ta lecture.'));
    }

    // À tester
    const others = open.filter((task) => !task.focus);
    if (others.length) {
      root.append(h('h3', { class: 'section-title' }, `À tester · ${others.length}`));
      root.append(h('ul', { class: 'actions', id: 'openActions' }, others.map(openItem)));
    }

    // Faites
    if (done.length) {
      root.append(h('details', { class: 'done-block', open: !open.length },
        h('summary', { class: 'section-title' }, `Faites · ${data.doneCount}`),
        h('ul', { class: 'actions done', id: 'doneActions' }, done.map(doneItem)),
      ));
    }
  }

  function openItem(task) {
    const li = h('li', { class: 'action', 'data-key': task.key });
    li.append(h('p', { class: 'action-text' }, task.text), h('p', { class: 'action-meta' }, `${source(task)} · ${age(task)}`));
    if (editing === task.key) {
      li.append(resultForm(task));
    } else if (confirming === task.key) {
      li.append(h('div', { class: 'action-buttons' },
        h('span', { class: 'action-meta' }, 'Abandonner cette action ?'),
        h('button', { class: 'btn small danger', type: 'button', onclick: () => change(task, 'cancelled') }, 'Oui, abandonner'),
        h('button', { class: 'btn small ghost', type: 'button', onclick: () => { confirming = null; render(); } }, 'Non'),
      ));
    } else {
      li.append(h('div', { class: 'action-buttons' },
        h('button', { class: 'btn small', type: 'button', 'data-act': 'done', onclick: () => edit(task.key) }, '✓ Faite'),
        h('button', { class: 'btn small ghost', type: 'button', 'data-act': 'focus', title: 'En faire l’action de la semaine', onclick: () => setFocus(task) }, '☆ Cette semaine'),
        h('button', { class: 'btn small ghost', type: 'button', 'data-act': 'cancel', title: 'Abandonner', onclick: () => { confirming = task.key; editing = null; render(); } }, '✕'),
      ));
    }
    return li;
  }

  function doneItem(task) {
    return h('li', { class: 'action', 'data-key': task.key },
      h('p', { class: 'action-text' }, task.text),
      task.result && h('p', { class: 'action-result' }, `→ ${task.result}`),
      h('p', { class: 'action-meta' },
        `${source(task)} · faite ${task.doneDate ? M.relativeDay(task.doneDate) : ''} `,
        h('button', { class: 'link-btn muted', type: 'button', onclick: () => change(task, 'open') }, 'Rouvrir'),
      ),
    );
  }

  /** Le petit formulaire « qu'est-ce que ça a donné ? » qui s'ouvre sous l'action. */
  function resultForm(task) {
    const area = h('textarea', {
      class: 'plain-area',
      id: 'resultInput',
      rows: 2,
      spellcheck: true,
      maxLength: 600,
      placeholder: 'Qu’est-ce que ça a donné ? (une phrase suffit)',
      onkeydown: (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); change(task, 'done', area.value); }
      },
    });
    return h('div', { class: 'result-form' },
      area,
      h('div', { class: 'action-buttons end' },
        h('button', { class: 'btn small ghost', type: 'button', onclick: () => { editing = null; render(); } }, 'Annuler'),
        h('button', { class: 'btn small primary', type: 'button', id: 'resultSave', onclick: () => change(task, 'done', area.value) }, 'Enregistrer'),
      ),
    );
  }

  function edit(key) {
    editing = key;
    confirming = null;
    render();
    $('#resultInput')?.focus();
  }

  async function change(task, status, result = '') {
    const res = await api.setAction({ ...target(task), status, result, expectedText: task.text });
    if (!ok(res)) {
      await load(); // la fiche a changé entre-temps : on repart de son état réel
      render();
      return;
    }
    editing = null;
    confirming = null;
    apply(res);
    render();
    if (status === 'done') toast('Action faite — résultat écrit dans la fiche.', { action: 'Annuler', onAction: () => change(task, 'open'), duration: 6000 });
    else if (status === 'cancelled') toast('Action abandonnée.', { action: 'Annuler', onAction: () => change(task, 'open'), duration: 6000 });
  }

  async function setFocus(task) {
    const res = await api.setFocusAction(task ? target(task) : null);
    if (!ok(res)) return;
    apply(res);
    render();
    if (task) toast('C’est ton action de la semaine.');
  }

  async function weeklyDone() {
    const res = await api.weeklyReviewDone();
    if (!ok(res)) return;
    apply(res);
    render();
    toast(data.focus ? 'Revue faite. Cap sur ton action de la semaine.' : 'Revue faite. Choisis ton action de la semaine (☆).', { duration: 5000 });
  }

  M.views.appliquer = {
    async show() {
      if (await load()) render();
    },
    async onRefresh() {
      if (!editing && (await load())) render(); // on ne recharge pas pendant que tu écris un résultat
    },
    onEscape() {
      if (!editing && !confirming) return false;
      editing = null;
      confirming = null;
      render();
      return true;
    },
  };
})();
