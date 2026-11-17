'use strict';
/**
 * progres.js — L'onglet « Progrès » : ce que tu vois d'un coup d'œil pour avoir envie de continuer.
 *
 * Le retour est volontairement INFORMATIF (où j'en suis, ce que j'ai retenu, ce que j'ai appliqué)
 * plutôt que des points ou des badges : on reste motivé par le sentiment de progresser,
 * pas par une récompense qui finit par remplacer l'envie de lire.
 */
(() => {
  const { api, $, h, svg, state, ok } = M;
  const root = $('#view-progres');
  const RING = 2 * Math.PI * 34;
  const DAY_LETTERS = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];

  let stats = null;

  async function load() {
    const res = await api.getStats();
    if (!ok(res)) return false;
    stats = res.stats;
    return true;
  }

  function ring(ratio, done) {
    const value = svg('circle', { class: 'ring-value', cx: 40, cy: 40, r: 34 });
    value.style.strokeDasharray = `${(ratio * RING).toFixed(1)} ${RING.toFixed(1)}`; // la portion remplie de l'anneau
    value.style.opacity = ratio > 0 ? '1' : '0'; // à 0 %, le bout arrondi du trait laisserait un point
    return svg('svg', { class: `big-ring${done ? ' done' : ''}`, viewBox: '0 0 80 80', 'aria-hidden': 'true' },
      svg('circle', { class: 'ring-track', cx: 40, cy: 40, r: 34 }),
      value,
    );
  }

  function streakText(streak) {
    if (!streak.current) return streak.record > 1 ? `Série à relancer · record ${streak.record} jours` : 'Pas encore de série';
    const base = `Série : ${M.plural(streak.current, 'jour')}`;
    return streak.record > streak.current ? `${base} · record ${streak.record}` : `${base} · ton record`;
  }

  function dayTitle(day) {
    const bits = [M.formatDay(day.day, { weekday: 'long', day: 'numeric', month: 'long' })];
    if (day.minutes) bits.push(M.duration(day.minutes));
    if (day.pages) bits.push(M.plural(day.pages, 'page'));
    if (day.notes) bits.push(M.plural(day.notes, 'note'));
    if (bits.length === 1 && !day.future) bits.push('pas de lecture');
    return bits.join(' · ');
  }

  function render() {
    root.textContent = '';
    if (!stats) return;
    const { today, streak, calendar, pillars, books, year, quote } = stats;
    const todayDay = M.today();

    // Une de tes citations, différente chaque jour.
    if (quote) {
      root.append(h('figure', { class: 'quote-card' },
        h('blockquote', null, quote.text),
        h('figcaption', null, [quote.auteur, quote.titre].filter(Boolean).join(' — ')),
      ));
    }

    // Aujourd'hui + série + la semaine en sept points
    const week = calendar.slice(-7);
    root.append(h('section', { class: 'today-card' },
      h('div', { class: 'ring-wrap' }, ring(today.ratio, today.done), h('span', { class: 'ring-center' }, today.done ? '✓' : `${Math.round(today.ratio * 100)}%`)),
      h('div', { class: 'today-body' },
        h('p', { class: 'today-title' }, today.done ? 'Objectif du jour atteint' : M.todayLabel(today)),
        h('p', { class: 'today-streak' }, streakText(streak)),
        streak.atRisk && h('p', { class: 'today-risk' }, 'Un jour manqué, ça va. Deux, la série repart de zéro : lis aujourd’hui.'),
        h('div', { class: 'week-dots' }, week.map((day, i) => h('span', {
          class: `dot l${day.level}${day.day === todayDay ? ' is-today' : ''}${day.future ? ' future' : ''}`,
          title: dayTitle(day),
        }, DAY_LETTERS[i]))),
      ),
    ));

    // Les trois piliers, cette semaine
    root.append(
      h('h3', { class: 'section-title' }, 'Cette semaine'),
      h('div', { class: 'pillars' },
        pillar('Lire', pillars.lire.minutes ? M.duration(pillars.lire.minutes) : M.plural(pillars.lire.pages, 'page'),
          pillars.lire.minutes ? M.plural(pillars.lire.pages, 'page') : 'pas de session chronométrée', 'lire'),
        pillar('Retenir', M.plural(pillars.retenir.reviews, 'carte'),
          pillars.retenir.rate === null ? `${pillars.retenir.anchored} / ${pillars.retenir.rotation} ancrées` : `${pillars.retenir.rate} % retrouvées`, 'retenir'),
        pillar('Appliquer', M.plural(pillars.appliquer.done, 'action faite', 'actions faites'),
          `${pillars.appliquer.open} à tester`, 'appliquer'),
      ),
    );

    // Calendrier : 12 semaines, une colonne par semaine, du lundi (haut) au dimanche (bas)
    const columns = [];
    for (let w = 0; w < calendar.length / 7; w++) columns.push(calendar.slice(w * 7, w * 7 + 7));
    root.append(
      h('h3', { class: 'section-title' }, '12 dernières semaines'),
      h('div', { class: 'calendar', id: 'calendar' }, columns.map((col) => h('div', { class: 'cal-col' },
        col.map((day) => h('span', { class: `cal-day l${day.level}${day.future ? ' future' : ''}${day.day === todayDay ? ' is-today' : ''}`, title: dayTitle(day) })),
      ))),
      h('p', { class: 'cal-legend' }, 'moins ', [0, 1, 2, 3, 4].map((l) => h('span', { class: `cal-day l${l}` })), ' plus · objectif atteint à partir de ', h('span', { class: 'cal-day l3' })),
    );

    // Livres en cours
    if (books.length) {
      root.append(h('h3', { class: 'section-title' }, 'En cours'));
      for (const book of books) {
        const p = book.projection;
        const line = book.pages
          ? `p. ${book.page} / ${book.pages} · ${book.pct} %${p ? ` · fin vers le ${M.formatDay(p.eta, { day: 'numeric', month: 'long' })} à ${String(p.perDay).replace('.', ',')} p./jour` : ''}`
          : book.page ? `p. ${book.page}` : 'progression inconnue (indique le nombre de pages dans la fiche)';
        root.append(h('div', { class: 'book-line' },
          h('p', { class: 'book-line-title' }, book.titre, book.auteur && h('span', { class: 'muted' }, ` — ${book.auteur}`)),
          book.pages && h('div', { class: 'progress' }, h('div', { class: 'progress-bar', style: `width:${book.pct}%` })),
          h('p', { class: 'action-meta' }, line),
        ));
      }
    }

    // L'année
    root.append(
      h('h3', { class: 'section-title' }, `En ${year.label}`),
      h('p', { class: 'year-line', id: 'yearLine' }, [
        M.plural(year.finished, 'livre terminé', 'livres terminés'),
        year.pages && M.plural(year.pages, 'page'),
        year.minutes && `${M.duration(year.minutes)} de lecture`,
        M.plural(year.notes, 'note'),
      ].filter(Boolean).join(' · ')),
    );

    // Le rituel
    const s = state.settings;
    root.append(h('p', { class: 'ritual-recap' },
      `Ton rituel : quand il est ${s.ritual.time}, je lis ${s.goal.value} ${s.goal.type === 'pages' ? 'pages' : 'minutes'}. `,
      h('button', { class: 'link-btn', type: 'button', onclick: () => M.emit('open-settings') }, 'Modifier'),
    ));
  }

  function pillar(title, value, sub, tab) {
    return h('button', { class: 'pillar', type: 'button', title: `Ouvrir « ${title} »`, onclick: () => M.setTab(tab) },
      h('span', { class: 'pillar-title' }, title),
      h('strong', null, value),
      h('span', { class: 'pillar-sub' }, sub),
    );
  }

  M.views.progres = {
    async show() {
      if (await load()) render();
    },
    async onRefresh() {
      if (await load()) render();
    },
  };
  M.on('settings-changed', () => { if (state.tab === 'progres') M.views.progres.show(); });
})();
