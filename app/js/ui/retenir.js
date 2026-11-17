'use strict';
/**
 * retenir.js — L'onglet « Retenir » : la révision espacée de tes notes.
 *
 * Le principe (voir src/main/review.js) : au lieu de RELIRE une note, tu essaies d'abord de la
 * RETROUVER de mémoire à partir d'une amorce, puis tu retournes la carte pour vérifier.
 * C'est cet effort de rappel qui ancre le souvenir.
 */
(() => {
  const { api, $, h, state, toast, ok } = M;
  const root = $('#view-retenir');

  const PROMPTS = {
    citation: 'Retrouve l’idée, et dis-la avec tes mots.',
    idee: 'Retrouve ton idée. Tient-elle toujours ?',
    question: 'Où en es-tu de cette question ? Réponds de mémoire.',
  };
  const GRADES = [
    { key: 'again', label: 'À revoir', hint: 'je l’avais perdue' },
    { key: 'good', label: 'Je l’avais', hint: 'retrouvée' },
    { key: 'easy', label: 'Facile', hint: 'sans effort' },
  ];

  let data = null; // ce que le process principal sait : cartes du jour + état de la mémoire
  let run = null; // la séance en cours : { cards, index, flipped, answer, recalled, graded }

  const inDays = (n) => (n === 1 ? 'demain' : `dans ${n} j`);

  async function load(extra = 0) {
    const res = await api.getReview({ extra });
    if (!ok(res)) return false;
    data = res;
    return true;
  }

  /* ---------------- Accueil de l'onglet ---------------- */

  function renderHome() {
    run = null;
    root.textContent = '';
    if (!data) return;
    const { queue, dueTotal, doneToday, stats } = data;
    const waiting = dueTotal - queue.length;

    const hero = h('section', { class: 'hero' });
    if (queue.length) {
      hero.append(
        h('p', { class: 'eyebrow' }, doneToday ? `Déjà ${M.plural(doneToday, 'carte')} aujourd’hui` : 'À réviser aujourd’hui'),
        h('h2', { class: 'hero-title' }, M.plural(queue.length, 'carte')),
        h('p', { class: 'hero-text' }, `Environ ${Math.max(1, Math.round(queue.length * 0.6))} min. Tu retrouves l’idée de mémoire, puis tu retournes la carte.`),
        h('button', { class: 'btn primary big wide', type: 'button', id: 'reviewStart', onclick: start }, 'Commencer'),
      );
    } else if (stats.rotation === 0) {
      hero.append(
        h('p', { class: 'eyebrow' }, 'Retenir'),
        h('h2', { class: 'hero-title' }, 'Pas encore de carte'),
        h('p', { class: 'hero-text' }, 'Chaque citation, idée ou question que tu notes dans « Lire » reviendra ici le lendemain, puis de plus en plus rarement.'),
      );
    } else {
      hero.append(
        h('p', { class: 'eyebrow' }, doneToday ? `${M.plural(doneToday, 'carte révisée', 'cartes révisées')} aujourd’hui` : 'Retenir'),
        h('h2', { class: 'hero-title' }, waiting > 0 ? 'Dose du jour faite' : 'Tout est à jour'),
        h('p', { class: 'hero-text' }, stats.next
          ? `Prochaine révision ${M.relativeDay(stats.next.day)} · ${M.plural(stats.next.count, 'carte')}.`
          : 'Rien de prévu pour l’instant.'),
      );
    }
    if (waiting > 0) {
      hero.append(h('p', { class: 'hero-more' },
        `${M.plural(waiting, 'autre carte attend', 'autres cartes attendent')} : ce sera pour demain. `,
        h('button', { class: 'link-btn', type: 'button', onclick: more }, `En faire ${Math.min(5, waiting)} de plus`),
      ));
    }
    root.append(hero);

    if (stats.rotation > 0) {
      root.append(
        h('h3', { class: 'section-title' }, 'Ta mémoire'),
        h('div', { class: 'tiles' },
          tile(stats.rotation, stats.rotation > 1 ? 'notes en rotation' : 'note en rotation'),
          tile(stats.anchored, stats.anchored > 1 ? 'ancrées (un mois sans oubli)' : 'ancrée (un mois sans oubli)'),
          tile(stats.retention ? `${stats.retention.rate} %` : '—', 'retrouvées sur 30 jours'),
        ),
        boxes(stats),
      );
    }
    root.append(h('details', { class: 'explain' },
      h('summary', null, 'Comment ça marche'),
      h('p', null, 'Relire une note donne l’impression de la connaître. La retrouver de mémoire, puis vérifier, est ce qui la fixe : c’est l’effet de test.'),
      h('p', null, 'Chaque carte est rangée dans une boîte. « Je l’avais » l’envoie dans la boîte suivante, revue plus tard (1, 3, 7, 14, 30, 60 puis 120 jours). « À revoir » la ramène au début. Les révisions s’espacent donc toutes seules pour ce que tu sais, et se resserrent sur ce que tu oublies.'),
      h('p', null, `Tu fais au plus ${data.limit} cartes par jour (réglable). Mieux vaut trois minutes chaque jour qu’une heure de temps en temps.`),
    ));
  }

  const tile = (value, label) => h('div', { class: 'tile' }, h('strong', null, String(value)), h('span', null, label));

  /** La répartition des cartes par boîte : on voit sa mémoire se remplir vers la droite. */
  function boxes(stats) {
    const max = Math.max(1, stats.fresh, ...stats.boxes);
    const column = (count, label, extra = '') => h('div', { class: `box ${extra}`, title: `${M.plural(count, 'carte')} · ${label}` },
      h('div', { class: 'box-bar' }, h('div', { class: 'box-fill', style: `height:${Math.round((count / max) * 100)}%` })),
      h('span', { class: 'box-count' }, String(count)),
      h('span', { class: 'box-label' }, label),
    );
    return h('div', { class: 'boxes' },
      column(stats.fresh, 'nouv.', 'fresh'),
      stats.boxes.map((count, i) => column(count, `${stats.intervals[i]} j`, i >= 4 ? 'anchored' : '')),
    );
  }

  async function more() {
    if (await load(5)) renderHome();
  }

  /* ---------------- Séance de révision ---------------- */

  function start() {
    if (!data?.queue.length) return;
    run = { cards: data.queue.map((card) => ({ ...card })), index: 0, flipped: false, answer: '', recalled: 0, graded: 0 };
    renderCard();
  }

  function cardHeader(card) {
    return h('div', { class: 'card-meta' },
      h('span', { class: 'card-source' }, [card.titre, card.page && `p. ${card.page}`].filter(Boolean).join(' · ')),
      h('span', { class: `card-type note--${card.type}` }, card.label),
    );
  }

  function renderCard() {
    const card = run.cards[run.index];
    root.textContent = '';
    root.append(h('div', { class: 'review-top' },
      h('span', { class: 'review-count' }, `${run.index + 1} / ${run.cards.length}`),
      h('div', { class: 'review-track' }, h('div', { class: 'review-fill', style: `width:${Math.round((run.index / run.cards.length) * 100)}%` })),
      h('button', { class: 'link-btn', type: 'button', onclick: finish }, 'Quitter'),
    ));

    const face = h('article', { class: `index-card${run.flipped ? ' flipped' : ''}`, id: 'reviewCard' }, cardHeader(card));
    if (!run.flipped) {
      // (append du DOM écrirait « false » pour un enfant absent : on filtre d'abord)
      face.append(...[
        h('p', { class: 'card-cue' }, card.type === 'question' ? card.text : card.cue),
        card.tags.length > 0 && h('p', { class: 'card-tags' }, card.tags.map((t) => `#${t}`).join(' ')),
        h('p', { class: 'card-prompt' }, card.redo ? 'Deuxième passage : redis-la une fois avant de continuer.' : PROMPTS[card.type]),
      ].filter(Boolean));
      const answer = h('textarea', {
        class: 'plain-area',
        id: 'reviewAnswer',
        rows: 2,
        spellcheck: true,
        placeholder: 'Écris-la si tu veux (facultatif) — ou dis-la à voix haute.',
        value: run.answer,
        oninput: (e) => { run.answer = e.target.value; M.autosize(e.target); },
      });
      root.append(face, answer, h('div', { class: 'review-actions' },
        h('button', { class: 'btn primary big wide', type: 'button', id: 'reviewFlip', onclick: flip }, 'Retourner la carte'),
      ));
    } else {
      face.append(h('p', { class: 'card-text' }, card.text));
      for (const comment of card.comments) face.append(h('p', { class: 'card-comment' }, comment));
      if (card.tags.length) face.append(h('p', { class: 'card-tags' }, card.tags.map((t) => `#${t}`).join(' ')));
      root.append(face);

      if (run.answer.trim()) {
        root.append(h('div', { class: 'your-answer' },
          h('span', { class: 'your-answer-label' }, 'Ta réponse'),
          h('p', null, run.answer.trim()),
          h('button', { class: 'link-btn', type: 'button', id: 'reviewKeep', onclick: keepAnswer }, 'Ajouter à la note'),
        ));
      }

      if (card.redo) {
        root.append(h('div', { class: 'review-actions' },
          h('button', { class: 'btn primary big wide', type: 'button', id: 'reviewNext', onclick: next }, 'C’est noté'),
        ));
      } else {
        root.append(
          h('div', { class: 'grades' }, GRADES.map((g, i) => h('button', {
            class: `grade grade--${g.key}`,
            type: 'button',
            'data-grade': g.key,
            title: `${g.hint} (${i + 1})`,
            onclick: () => grade(g.key),
          }, h('strong', null, g.label), h('span', null, inDays(card.next[g.key]))))),
          h('p', { class: 'review-foot' },
            h('button', { class: 'link-btn muted', type: 'button', onclick: suspend }, 'Ne plus réviser cette note'),
          ),
        );
      }
    }
    window.scrollTo(0, 0);
  }

  function flip() {
    if (!run || run.flipped) return;
    run.flipped = true;
    renderCard();
  }

  function next() {
    run.index += 1;
    run.flipped = false;
    run.answer = '';
    if (run.index >= run.cards.length) finish();
    else renderCard();
  }

  async function grade(key) {
    if (!run?.flipped || run.busy) return;
    const card = run.cards[run.index];
    if (card.redo) return next();
    run.busy = true;
    document.activeElement?.blur?.();
    const res = await api.gradeCard(card.noteId, key);
    run.busy = false;
    if (!ok(res)) return;
    M.applySummary(res.summary);
    run.graded += 1;
    if (key === 'again') run.cards.push({ ...card, redo: true }); // elle repasse une fois en fin de séance
    else run.recalled += 1;
    next();
  }

  async function suspend() {
    const card = run.cards[run.index];
    const res = await api.suspendCard(card.noteId);
    if (!ok(res)) return;
    M.applySummary(res.summary);
    toast('Cette note ne reviendra plus en révision. Elle reste dans ta fiche.');
    run.cards = run.cards.filter((c, i) => i <= run.index || c.noteId !== card.noteId);
    next();
  }

  /** Ta reformulation du jour rejoint la note dans la fiche (💭 daté) : la note s'enrichit à chaque passage. */
  async function keepAnswer() {
    const card = run.cards[run.index];
    const res = await api.addReflection(card.noteId, run.answer);
    if (!ok(res)) return;
    card.comments = [...card.comments, run.answer.trim()];
    run.answer = '';
    renderCard();
    toast('Ajouté à la note, dans ta fiche.');
  }

  async function finish() {
    const done = run && run.graded > 0 ? { graded: run.graded, recalled: run.recalled } : null;
    await load();
    renderHome();
    if (!done) return;
    const hero = $('.hero', root);
    hero.prepend(h('p', { class: 'session-result', id: 'reviewResult' },
      `${M.plural(done.graded, 'carte révisée', 'cartes révisées')} · ${done.recalled} retrouvée${done.recalled > 1 ? 's' : ''} de mémoire.`));
  }

  M.views.retenir = {
    async show() {
      if (run) return; // une séance est en cours : on ne la réinitialise pas
      if (await load()) renderHome();
    },
    async onRefresh() {
      if (!run && (await load())) renderHome();
    },
    onKey(e) {
      const typing = e.target instanceof HTMLTextAreaElement;
      const confirm = e.code === 'Space' || e.key === 'Enter';
      if (!run) {
        if (e.key === 'Enter' && !typing && $('#reviewStart')) { e.preventDefault(); start(); }
        return;
      }
      if (!run.flipped) {
        // Dans la zone de réponse, Entrée et Espace écrivent ; Ctrl+Entrée retourne la carte.
        if (confirm && (!typing || e.ctrlKey)) { e.preventDefault(); flip(); }
        return;
      }
      if (typing || e.ctrlKey || e.altKey || e.metaKey) return;
      const card = run.cards[run.index];
      // On lit la POSITION de la touche (e.code), pas le caractère : sur un clavier AZERTY,
      // les touches 1 2 3 du haut produisent « & é " » sans Maj. Le pavé numérique marche aussi.
      const digit = /^(?:Digit|Numpad)([1-3])$/.exec(e.code);
      if (card.redo && confirm) { e.preventDefault(); next(); }
      else if (digit) { e.preventDefault(); grade(GRADES[Number(digit[1]) - 1].key); }
    },
  };
})();
