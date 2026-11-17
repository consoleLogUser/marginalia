/**
 * fiche.js — Le format des fiches de lecture (logique pure : texte en entrée, texte en sortie).
 *
 * Une fiche = un livre = un fichier Markdown (frontmatter YAML + sections), lisible dans Obsidian.
 * Une note = un callout Obsidian, suivi de son identifiant de bloc (^abc123) sur sa propre ligne.
 *
 * Toutes les fonctions qui « modifient » une fiche prennent son contenu et renvoient le nouveau contenu.
 * Elles ne touchent ni au disque ni au réseau : c'est ce qui permet de les rejouer telles quelles quand
 * la fiche a changé entre-temps sur GitHub (on relit la nouvelle version, on réapplique l'opération).
 */

/* ------------------------------------------------------------------ */
/* Types de notes                                                      */
/* ------------------------------------------------------------------ */

/** Callouts natifs d'Obsidian : quote = guillemets, tip = flamme, question = ?, todo = case à cocher. */
export const NOTE_TYPES = {
  citation: { callout: 'quote', label: 'Citation' },
  idee: { callout: 'tip', label: 'Idée' },
  question: { callout: 'question', label: 'Question' },
  appliquer: { callout: 'todo', label: 'À appliquer' },
};

const TYPE_BY_LABEL = new Map(Object.entries(NOTE_TYPES).map(([key, def]) => [def.label, key]));

export const BOOK_STATUSES = ['en-cours', 'termine', 'abandonne'];
export const BOOK_FORMATS = ['papier', 'numerique'];
export const LIMITS = { text: 20000, comment: 10000, title: 200, author: 120, page: 20, tags: 20, result: 600, synthesis: 20000 };
export const SYNTHESIS_PLACEHOLDER = "*À écrire en fin de lecture : les 3 idées clés, ce que j'en retiens, ce que j'applique.*";

const SEP = ' · '; // séparateur des segments dans le titre d'un callout
const COMMENT_MARK = '💭';
const DONE_MARK = '✅'; // format du plugin Tasks d'Obsidian : « ✅ 2026-11-21 »
const CANCEL_MARK = '❌';
const RESULT_PREFIX = '→ Résultat : ';

/** Erreur « métier » : la fiche ne permet pas l'opération (note disparue, action modifiée…). */
export class FicheError extends Error {
  constructor(message, code = 'conflict') {
    super(message);
    this.name = 'FicheError';
    this.code = code;
  }
}

/* ------------------------------------------------------------------ */
/* Petits utilitaires                                                  */
/* ------------------------------------------------------------------ */

const pad = (n) => String(n).padStart(2, '0');

/** 2026-11-15 (heure locale). */
export function formatDate(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 2026-11-15 20:31 (heure locale). */
export function formatDateTime(d = new Date()) {
  return `${formatDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** « L'Art de la guerre » → « l-art-de-la-guerre » : pas d'espaces ni d'accents dans les noms de fichiers. */
export function slugify(input) {
  return String(input || '')
    .replace(/œ/g, 'oe').replace(/Œ/g, 'OE').replace(/æ/g, 'ae').replace(/Æ/g, 'AE').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
}

/** « [[Sénèque]] » → « Sénèque ». */
export function stripWikilink(value) {
  const s = String(value ?? '').trim();
  const m = s.match(/^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/);
  return m ? (m[2] || m[1]).trim() : s;
}

/** Normalise un texte saisi : fins de ligne, espaces en fin de ligne, lignes vides multiples. */
export function normalizeBody(s) {
  return String(s ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Un texte ramené sur une seule ligne (résultat d'une action). */
export function oneLine(s) {
  return normalizeBody(s).replace(/\s*\n+\s*/g, ' — ');
}

/** « #Stoïcisme, management temps/discipline » → ['stoïcisme', 'management', 'temps/discipline']. */
export function normalizeTags(input) {
  const raw = Array.isArray(input) ? input.join(' ') : String(input ?? '');
  const seen = new Set();
  const tags = [];
  for (let token of raw.split(/[\s,;]+/)) {
    token = token
      .replace(/^#+/, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_\-/]+/gu, '-')
      .replace(/^[-/]+|[-/]+$/g, '');
    if (!token || /^\d+$/.test(token) || seen.has(token)) continue;
    seen.add(token);
    tags.push(token);
  }
  return tags.slice(0, LIMITS.tags);
}

export function detectEol(content) {
  return String(content).includes('\r\n') ? '\r\n' : '\n';
}

/** Comparaison souple de titres : « Lettres à Lucilius » = « lettres a lucilius ». */
export const sameTitle = (a, b) => slugify(a) === slugify(b) && slugify(a) !== '';

/* ------------------------------------------------------------------ */
/* Nettoyage du texte copié depuis un PDF / ebook                      */
/* ------------------------------------------------------------------ */

const LIGATURES = { 'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl', 'ﬅ': 'st', 'ﬆ': 'st' };

/** Recolle les lignes et les césures d'un paragraphe copié depuis un PDF (sauf listes et vers). */
function unwrapParagraph(paragraph) {
  const lines = paragraph.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length <= 1) return lines.join('');
  const listLines = lines.filter((l) => /^([•\-–*·▪]|\d+[.)])\s/.test(l)).length;
  const avgLength = lines.slice(0, -1).reduce((sum, l) => sum + l.length, 0) / (lines.length - 1);
  if (listLines >= 2 || avgLength < 30) return lines.join('\n');
  let out = lines[0];
  for (const line of lines.slice(1)) {
    if (/\p{L}[-‐]$/u.test(out) && /^\p{Ll}/u.test(line)) out = out.slice(0, -1) + line; // césure
    else out += ` ${line}`;
  }
  return out.replace(/ {2,}/g, ' ');
}

/**
 * Nettoie un passage copié et détecte la page quand c'est possible (référence ajoutée par Kindle).
 * @returns {{ text: string, page: string }}
 */
export function cleanCapturedText(raw) {
  let text = String(raw ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/­/g, '')
    .replace(/[ﬀ-ﬆ]/g, (c) => LIGATURES[c] || c)
    .replace(/\t/g, ' ');
  let page = '';
  const paragraphs = text.split(/\n[ \t]*\n/);
  if (paragraphs.length > 1) {
    const last = paragraphs[paragraphs.length - 1];
    if (/kindle/i.test(last) && last.length < 400) {
      const p = last.match(/\(p\.\s*([0-9ivxlcdm]+)\)/i);
      const loc = last.match(/\((?:emplacements?|locations?)\s*([0-9]+(?:\s*[-–]\s*[0-9]+)?)\)/i);
      if (p) page = p[1];
      else if (loc) page = `empl. ${loc[1].replace(/\s/g, '')}`;
      paragraphs.pop();
    }
  }
  text = paragraphs.map(unwrapParagraph).filter(Boolean).join('\n\n').trim();
  return { text, page };
}

/* ------------------------------------------------------------------ */
/* Frontmatter YAML (sous-ensemble volontairement simple)              */
/* ------------------------------------------------------------------ */

function formatYamlValue(value) {
  if (value === null || value === undefined || value === '') return '';
  const s = String(value);
  return /^[\w\-.:/]+$/.test(s) ? s : JSON.stringify(s); // une chaîne JSON est une chaîne YAML valide
}

function parseYamlScalar(raw) {
  const v = raw.trim();
  if (v === '' || v === '~' || v === 'null') return '';
  if (v.startsWith('"')) {
    try { return JSON.parse(v); } catch { return v.replace(/^"|"$/g, ''); }
  }
  if (v.startsWith("'")) return v.replace(/^'|'$/g, '').replace(/''/g, "'");
  if (v.startsWith('[') || v.startsWith('{')) return v;
  return v.replace(/\s+#.*$/, '');
}

/** Lit le frontmatter (entre les deux lignes « --- » du début). Tolère le style d'Obsidian. */
export function parseFrontmatter(content) {
  const lines = String(content).replace(/^﻿/, '').replace(/\r\n/g, '\n').split('\n');
  if (lines[0].trim() !== '---') return { data: null, endLine: -1 };
  const end = lines.findIndex((l, i) => i > 0 && (l.trim() === '---' || l.trim() === '...'));
  if (end === -1) return { data: null, endLine: -1 };
  const data = {};
  for (const line of lines.slice(1, end)) {
    const m = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (m) data[m[1]] = parseYamlScalar(m[2]);
  }
  return { data, endLine: end };
}

/** Met à jour (ou ajoute) des clés du frontmatter sans toucher au reste du fichier. */
export function updateFrontmatter(content, updates) {
  const eol = detectEol(content);
  const lines = String(content).replace(/\r\n/g, '\n').split('\n');
  const { endLine } = parseFrontmatter(content);
  if (endLine === -1) throw new FicheError('Frontmatter introuvable', 'format');
  for (const [key, value] of Object.entries(updates)) {
    const formatted = formatYamlValue(value);
    const line = formatted ? `${key}: ${formatted}` : `${key}:`;
    const idx = lines.findIndex((l, i) => i > 0 && i < endLine && new RegExp(`^${key}\\s*:`).test(l));
    if (idx !== -1) lines[idx] = line;
    else lines.splice(endLine, 0, line);
  }
  return lines.join(eol);
}

/* ------------------------------------------------------------------ */
/* Format d'une note                                                   */
/* ------------------------------------------------------------------ */

/**
 *   > [!quote] Citation · p. 42 · 2026-11-15 20:31
 *   > Ce n'est pas que nous ayons peu de temps…
 *   >
 *   > 💭 Exactement mon problème le soir.
 *   >
 *   > #temps #discipline
 *
 *   ^k3x9q2
 */
export function formatNote({ type, page = '', text, comment = '', tags = [], date, id = '' }) {
  const def = NOTE_TYPES[type];
  if (!def) throw new FicheError(`Type de note inconnu : ${type}`, 'input');
  const title = [def.label, page ? `p. ${page}` : null, date].filter(Boolean).join(SEP);
  const lines = [`> [!${def.callout}] ${title}`];
  const body = normalizeBody(text);
  if (type === 'appliquer') {
    for (const line of body.split('\n')) {
      const action = line.trim().replace(/^(?:[-•*]\s+)?(?:\[[ xX]\]\s+)?/, '');
      if (action) lines.push(`> - [ ] ${action}`);
    }
  } else {
    for (const line of body.split('\n')) lines.push(line ? `> ${line}` : '>');
  }
  const cleanComment = normalizeBody(comment);
  if (cleanComment) {
    const [first, ...rest] = cleanComment.split('\n');
    lines.push('>', `> ${COMMENT_MARK} ${first}`);
    for (const line of rest) lines.push(line ? `> ${line}` : '>');
  }
  if (tags.length) lines.push('>', `> ${tags.map((t) => `#${t}`).join(' ')}`);
  if (id) lines.push('', `^${id}`);
  return lines.join('\n');
}

const HEADER_RE = /^>\s*\[!([\w-]+)\][+-]?\s*(.*)$/;
const ID_LINE_RE = /^\^([A-Za-z0-9-]{1,40})\s*$/;
const TASK_RE = /^- \[(.)\]\s*(.*)$/;
const STAMP_RE = /\s*[✅❌]️?\s*(\d{4}-\d{2}-\d{2})\s*$/;

/** Les actions d'une note « À appliquer » (format compatible avec le plugin Tasks d'Obsidian). */
function parseTasks(textLines) {
  const tasks = [];
  textLines.forEach((line, k) => {
    const offset = k + 1;
    const m = line.match(TASK_RE);
    if (m) {
      const status = m[1] === ' ' ? 'open' : m[1] === '-' ? 'cancelled' : 'done';
      let text = m[2].trim();
      let doneDate = '';
      const stamp = text.match(STAMP_RE);
      if (stamp) {
        doneDate = stamp[1];
        text = text.slice(0, stamp.index).trimEnd();
      }
      tasks.push({ text, status, done: status === 'done', doneDate, result: '', offset, span: 1 });
    } else if (tasks.length && /^(\s+\S|→)/.test(line)) {
      const task = tasks[tasks.length - 1];
      const piece = line.trim().replace(/^→\s*(?:Résultat\s*:\s*)?/i, '');
      task.result = task.result ? `${task.result}\n${piece}` : piece;
      task.span = offset - task.offset + 1;
    } else if (line.trim()) {
      tasks.push({ text: line.trim(), status: 'open', done: false, doneDate: '', result: '', offset, span: 1 });
    }
  });
  return tasks;
}

function parseBlock(blockLines) {
  const header = blockLines[0].match(HEADER_RE);
  if (!header) return null;
  const segments = header[2].split(SEP).map((s) => s.trim());
  const type = TYPE_BY_LABEL.get(segments[0]);
  if (!type) return null; // un callout qui n'est pas une note Marginalia : ignoré

  let page = '';
  let date = '';
  for (const seg of segments.slice(1)) {
    const pm = seg.match(/^p\.\s*(.+)$/);
    if (pm) page = pm[1];
    else if (/^\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?$/.test(seg)) date = seg;
  }

  const body = blockLines.slice(1).map((l) => l.replace(/^>\s?/, ''));
  let end = body.length;
  while (end > 0 && body[end - 1].trim() === '') end--;
  let tags = [];
  if (end > 0 && /^(#[^\s#]+\s*)+$/.test(body[end - 1].trim())) {
    tags = body[end - 1].trim().split(/\s+/).map((t) => t.slice(1));
    end--;
    while (end > 0 && body[end - 1].trim() === '') end--;
  }
  const contentEnd = end;

  const firstComment = body.findIndex((l, i) => i < end && l.startsWith(COMMENT_MARK));
  const textLines = body.slice(0, firstComment === -1 ? end : firstComment);
  const comments = [];
  if (firstComment !== -1) {
    for (const line of body.slice(firstComment, end)) {
      if (line.startsWith(COMMENT_MARK)) comments.push(line.slice(COMMENT_MARK.length).replace(/^\s/, ''));
      else comments[comments.length - 1] += `\n${line}`;
    }
  }
  const cleanComments = comments.map((c) => c.trim()).filter(Boolean);

  let text = textLines.join('\n').trim();
  let tasks = null;
  if (type === 'appliquer') {
    tasks = parseTasks(textLines);
    text = tasks.map((t) => t.text).join('\n');
  }
  return {
    type, label: NOTE_TYPES[type].label, page, date, text,
    comment: cleanComments.join('\n\n'), comments: cleanComments, tags, tasks, contentEnd,
  };
}

/**
 * Toutes les notes Marginalia d'une fiche, dans l'ordre du fichier.
 * `start`/`end` : index (base 0) des lignes « > » de la note ; `id` : identifiant de bloc
 * (null s'il manque ou s'il est en double) ; `idLine` : index de la ligne ^id, ou -1.
 */
export function parseNotes(content) {
  const lines = String(content).replace(/\r\n/g, '\n').split('\n');
  const notes = [];
  const seen = new Set();
  let i = 0;
  while (i < lines.length) {
    const startsBlock = HEADER_RE.test(lines[i]) && (i === 0 || !lines[i - 1].startsWith('>'));
    if (!startsBlock) { i++; continue; }
    const start = i;
    while (i < lines.length && lines[i].startsWith('>')) i++;
    const end = i - 1;
    const note = parseBlock(lines.slice(start, end + 1));
    if (!note) continue;
    let j = i;
    while (j < lines.length && lines[j].trim() === '') j++;
    const m = j < lines.length ? lines[j].match(ID_LINE_RE) : null;
    const id = m && !seen.has(m[1]) ? m[1] : null;
    if (id) seen.add(id);
    notes.push({ ...note, id, line: start + 1, start, end, idLine: m ? j : -1 });
  }
  return notes;
}

/* ------------------------------------------------------------------ */
/* Identifiants de note                                                */
/* ------------------------------------------------------------------ */

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function randomIndex(n) {
  const buf = new Uint8Array(1);
  for (;;) {
    globalThis.crypto.getRandomValues(buf);
    if (buf[0] < 252) return buf[0] % n; // 252 = 7 × 36 : pas de biais
  }
}

/** 6 caractères tirés au hasard, jamais déjà utilisés, avec au moins une lettre. */
export function generateId(used = new Set()) {
  for (;;) {
    let id = '';
    for (let k = 0; k < 6; k++) id += ID_ALPHABET[randomIndex(ID_ALPHABET.length)];
    if (/[a-z]/.test(id) && !used.has(id)) return id;
  }
}

/**
 * Identifiant DÉTERMINISTE tiré d'un nom (fichier de la boîte de réception) : deux appareils qui intègrent
 * la même note obtiennent le même identifiant, donc la note n'est jamais ajoutée deux fois.
 */
export function idFromName(name) {
  let h = 0x811c9dc5; // FNV-1a 32 bits
  for (const ch of String(name)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  let id = h.toString(36).padStart(6, '0').slice(-6);
  if (!/[a-z]/.test(id)) id = `m${id.slice(1)}`;
  return id;
}

/** Ajoute un identifiant sous chaque note qui n'en a pas. Fonction pure : texte → texte. */
export function ensureNoteIds(content, taken = new Set(), makeId = generateId) {
  const eol = detectEol(content);
  const lines = String(content).replace(/\r\n/g, '\n').split('\n');
  const notes = parseNotes(lines.join('\n'));
  const used = new Set(taken);
  for (const note of notes) if (note.id) used.add(note.id);
  let added = 0;
  for (const note of notes.slice().reverse()) {
    if (note.id) continue;
    const id = makeId(used);
    used.add(id);
    if (note.idLine !== -1) {
      lines[note.idLine] = `^${id}`;
    } else {
      const next = lines[note.end + 1];
      const insert = ['', `^${id}`];
      if (next === undefined || next.trim() !== '') insert.push('');
      lines.splice(note.end + 1, 0, ...insert);
    }
    added++;
  }
  return { content: lines.join(eol), added };
}

/* ------------------------------------------------------------------ */
/* Fiches                                                              */
/* ------------------------------------------------------------------ */

export function bookTemplate({ titre, auteur = '', format = 'papier', pages = null }, now = new Date()) {
  const authorLink = auteur ? `[[${auteur}]]` : '';
  return [
    '---',
    'type: lecture',
    `titre: ${JSON.stringify(titre)}`,
    authorLink ? `auteur: ${JSON.stringify(authorLink)}` : 'auteur:',
    `format: ${format}`,
    'statut: en-cours',
    `debut: ${formatDate(now)}`,
    'fin:',
    pages ? `pages: ${pages}` : 'pages:',
    'tags:',
    '  - lecture',
    '---',
    '',
    `# ${titre}`,
    ...(authorLink ? [`*${authorLink}*`] : []),
    '',
    '## Synthèse',
    '',
    SYNTHESIS_PLACEHOLDER,
    '',
    '## Notes',
    '',
  ].join('\n');
}

/** Valide un nouveau livre saisi dans l'interface. */
export function sanitizeBookInput(input) {
  const titre = String(input?.titre ?? '').trim().slice(0, LIMITS.title);
  const auteur = String(input?.auteur ?? '').trim().replace(/[[\]|#^]/g, '').slice(0, LIMITS.author);
  if (!titre) throw new FicheError('Le titre est obligatoire', 'input');
  const format = BOOK_FORMATS.includes(input?.format) ? input.format : 'papier';
  const pagesNum = parseInt(input?.pages, 10);
  const pages = Number.isFinite(pagesNum) && pagesNum > 0 && pagesNum < 100000 ? pagesNum : null;
  return { titre, auteur, format, pages };
}

/** Les métadonnées d'une fiche, à partir de son frontmatter et de ses notes. */
export function toBook(id, data, notes) {
  const pages = parseInt(data.pages, 10);
  const lastNote = notes.reduce((max, n) => (n.date > max ? n.date : max), '');
  return {
    id,
    titre: data.titre || id.split('/').pop(),
    auteur: stripWikilink(data.auteur),
    format: BOOK_FORMATS.includes(data.format) ? data.format : 'papier',
    statut: BOOK_STATUSES.includes(data.statut) ? data.statut : 'en-cours',
    debut: data.debut || '',
    fin: data.fin || '',
    pages: Number.isFinite(pages) && pages > 0 ? pages : null,
    noteCount: notes.length,
    missingIds: notes.filter((n) => !n.id).length,
    lastNoteDate: lastNote,
  };
}

/** Lit une fiche : null si ce n'est pas une fiche de lecture (frontmatter `type: lecture`). */
export function readFiche(id, content) {
  const { data } = parseFrontmatter(content);
  if (!data || String(data.type).toLowerCase() !== 'lecture') return null;
  const notes = parseNotes(content);
  return { book: toBook(id, data, notes), notes, synthesisPending: content.includes(SYNTHESIS_PLACEHOLDER) };
}

/** Valide et nettoie une note reçue de l'interface. */
export function sanitizeNoteInput(input) {
  const type = String(input?.type ?? '');
  if (!NOTE_TYPES[type]) throw new FicheError('Type de note inconnu', 'input');
  const text = normalizeBody(input.text);
  if (!text) throw new FicheError('La note est vide', 'input');
  if (text.length > LIMITS.text) throw new FicheError('Note trop longue', 'input');
  const comment = type === 'citation' ? normalizeBody(input.comment).slice(0, LIMITS.comment) : '';
  const page = String(input.page ?? '').trim().slice(0, LIMITS.page);
  if (page && !/^[\p{L}\p{N} .,\-–/]+$/u.test(page)) throw new FicheError('Numéro de page invalide', 'input');
  return { type, text, comment, page, tags: normalizeTags(input.tags) };
}

/* ------------------------------------------------------------------ */
/* Opérations sur le contenu d'une fiche (pures, rejouables)           */
/* ------------------------------------------------------------------ */

function findNote(notes, noteId) {
  const note = notes.find((n) => n.id === noteId);
  if (!note) throw new FicheError('Note introuvable : la fiche a été modifiée entre-temps.', 'missing');
  return note;
}

function edit(content, mutate) {
  const eol = detectEol(content);
  const lines = String(content).replace(/\r\n/g, '\n').split('\n');
  mutate(lines, parseNotes(lines.join('\n')));
  return lines.join(eol);
}

/**
 * Ajoute une note (bloc déjà formaté, identifiant compris) à la fin de la fiche.
 * Idempotent : si une note porte déjà cet identifiant avec le même texte, rien ne change.
 */
export function appendNoteBlock(content, block) {
  const own = parseNotes(block)[0];
  if (own?.id) {
    const existing = parseNotes(content).find((n) => n.id === own.id);
    if (existing) {
      if (existing.text === own.text) return content; // déjà là (opération rejouée, ou intégrée par un autre appareil)
      throw new FicheError('Identifiant déjà utilisé par une autre note', 'id-taken');
    }
  }
  const eol = detectEol(content);
  const separator = content.endsWith(`${eol}${eol}`) || content === '' ? '' : content.endsWith(eol) ? eol : eol + eol;
  return content + separator + block.split('\n').join(eol) + eol;
}

/** Retire une note (annulation). Refuse si la note a été modifiée depuis qu'on l'a écrite. */
export function removeNoteBlock(content, noteId, block) {
  const eol = detectEol(content);
  const normalized = content.replace(/\r\n/g, '\n');
  const expected = String(block ?? '').replace(/\r\n/g, '\n').trim();
  const trimmed = normalized.replace(/\s+$/, '');
  if (expected && trimmed.endsWith(expected)) {
    return `${trimmed.slice(0, -expected.length).replace(/\s+$/, '')}\n`.split('\n').join(eol);
  }
  const lines = normalized.split('\n');
  const note = parseNotes(normalized).find((n) => n.id === noteId);
  if (!note) return content; // déjà retirée
  const last = note.idLine !== -1 ? note.idLine : note.end;
  const actual = lines.slice(note.start, last + 1).join('\n').trim();
  if (expected && actual !== expected) {
    throw new FicheError('La note a été modifiée depuis : annulation impossible sans risque.', 'conflict');
  }
  let from = note.start;
  let to = last;
  while (to + 1 < lines.length && lines[to + 1].trim() === '' && from > 0 && lines[from - 1].trim() === '') to++;
  lines.splice(from, to - from + 1);
  return lines.join(eol);
}

/** Change l'état d'une action « À appliquer » : faite (avec son résultat), rouverte ou abandonnée. */
export function updateTaskInContent(content, noteId, index, change, now = new Date()) {
  const status = String(change?.status ?? '');
  if (!['done', 'open', 'cancelled'].includes(status)) throw new FicheError("État d'action inconnu", 'input');
  const result = status === 'done' ? oneLine(change.result).slice(0, LIMITS.result) : '';
  return edit(content, (lines, notes) => {
    const note = findNote(notes, noteId);
    const task = note.tasks?.[index];
    if (!task) throw new FicheError('Action introuvable : la fiche a été modifiée entre-temps.', 'missing');
    if (change.expectedText !== undefined && change.expectedText !== task.text) {
      throw new FicheError('Cette action a été modifiée entre-temps.', 'conflict');
    }
    const at = note.start + task.offset;
    const prefix = (lines[at].match(/^>\s?/) || ['> '])[0];
    const box = status === 'done' ? 'x' : status === 'cancelled' ? '-' : ' ';
    const stamp = status === 'done' ? ` ${DONE_MARK} ${formatDate(now)}` : status === 'cancelled' ? ` ${CANCEL_MARK} ${formatDate(now)}` : '';
    const replacement = [`${prefix}- [${box}] ${task.text}${stamp}`];
    if (result) replacement.push(`${prefix}  ${RESULT_PREFIX}${result}`);
    else replacement.push(...lines.slice(at + 1, at + task.span)); // on garde un résultat déjà écrit
    lines.splice(at, task.span, ...replacement);
  });
}

/** Ajoute une réflexion datée à une note (après le texte et les commentaires, avant les tags). */
export function addReflectionToContent(content, noteId, text, now = new Date()) {
  const clean = normalizeBody(text).slice(0, LIMITS.comment);
  if (!clean) throw new FicheError('La réflexion est vide', 'input');
  return edit(content, (lines, notes) => {
    const note = findNote(notes, noteId);
    if (note.type === 'appliquer') throw new FicheError('Une action se complète par son résultat, pas par une réflexion.', 'input');
    if (note.comments.includes(`${formatDate(now)} — ${clean}`)) return; // déjà ajoutée (opération rejouée)
    const [first, ...rest] = clean.split('\n');
    const insert = ['>', `> ${COMMENT_MARK} ${formatDate(now)} — ${first}`, ...rest.map((l) => (l ? `> ${l}` : '>'))];
    lines.splice(note.start + note.contentEnd + 1, 0, ...insert);
  });
}

/** Écrit la synthèse de fin de lecture dans la section « ## Synthèse » (la complète si elle existe). */
export function writeSynthesisToContent(content, text, now = new Date()) {
  const clean = normalizeBody(text).slice(0, LIMITS.synthesis);
  if (!clean) throw new FicheError('La synthèse est vide', 'input');
  const block = clean.split('\n');
  return edit(content, (lines) => {
    const { endLine } = parseFrontmatter(lines.join('\n'));
    const heading = lines.findIndex((l, i) => i > endLine && /^##\s+Synth[èe]se\s*$/i.test(l));
    if (heading === -1) {
      const notesAt = lines.findIndex((l, i) => i > endLine && /^##\s+Notes\s*$/i.test(l));
      if (notesAt !== -1) {
        lines.splice(notesAt, 0, '## Synthèse', '', ...block, '');
      } else {
        let last = lines.length;
        while (last > 0 && lines[last - 1].trim() === '') last--;
        lines.splice(last, lines.length - last, '', '## Synthèse', '', ...block, '');
      }
      return;
    }
    let next = lines.findIndex((l, i) => i > heading && /^#{1,6}\s/.test(l));
    if (next === -1) next = lines.length;
    const kept = lines.slice(heading + 1, next).filter((l) => l.trim() !== SYNTHESIS_PLACEHOLDER);
    while (kept.length && kept[0].trim() === '') kept.shift();
    while (kept.length && kept[kept.length - 1].trim() === '') kept.pop();
    if (kept.join('\n').includes(block.join('\n'))) return; // déjà écrite (opération rejouée)
    const body = kept.length ? [...kept, '', `*Complément du ${formatDate(now)} :*`, '', ...block] : block;
    lines.splice(heading + 1, next - heading - 1, '', ...body, '');
  });
}

/** Change le statut d'un livre et date la fin de lecture. */
export function setStatusInContent(content, statut, now = new Date()) {
  if (!BOOK_STATUSES.includes(statut)) throw new FicheError('Statut inconnu', 'input');
  return updateFrontmatter(content, { statut, fin: statut === 'en-cours' ? '' : formatDate(now) });
}
