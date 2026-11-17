
/**
 * days.js — Calculs sur les jours. Dans toute l'app, un jour est une chaîne « 2026-11-16 »
 * (date LOCALE). Avantages : ça se compare et se trie comme du texte, et c'est lisible dans les fichiers.
 */

const pad = (n) => String(n).padStart(2, '0');

/** Date JavaScript → « 2026-11-16 » (heure locale). */
function toDay(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const isDay = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);

function parts(day) {
  const [y, m, d] = day.split('-').map(Number);
  return { y, m, d };
}

/** « 2026-11-30 » + 1 → « 2026-12-01 ». Passer par Date gère les fins de mois et les années bissextiles. */
function dayAdd(day, n) {
  const { y, m, d } = parts(day);
  return toDay(new Date(y, m - 1, d + n));
}

/** Nombre de jours de `a` à `b` (positif si b est après a). Calculé en UTC : insensible au changement d'heure. */
function dayDiff(a, b) {
  const utc = (day) => {
    const { y, m, d } = parts(day);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((utc(b) - utc(a)) / 86400000);
}

/** 0 = lundi … 6 = dimanche (semaine à la française). */
function weekday(day) {
  const { y, m, d } = parts(day);
  return (new Date(y, m - 1, d).getDay() + 6) % 7;
}

/** Le lundi de la semaine qui contient `day`. */
function weekStart(day) {
  return dayAdd(day, -weekday(day));
}

export { toDay, isDay, dayAdd, dayDiff, weekday, weekStart };
