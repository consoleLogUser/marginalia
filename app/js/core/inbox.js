/**
 * inbox.js — La boîte de réception : les notes envoyées par le raccourci iOS « Noter ».
 *
 * Le raccourci ne modifie jamais une fiche : il dépose un NOUVEAU petit fichier dans boite/.
 * Créer un fichier ne peut pas entrer en conflit avec quoi que ce soit. L'app range ensuite la note
 * dans la bonne fiche et supprime le fichier de la boîte.
 *
 * Format attendu (facile à construire avec l'action « Texte » de Raccourcis) :
 *
 *   ---
 *   livre: Lettres à Lucilius
 *   type: citation
 *   page: 42
 *   tags: temps discipline
 *   date: 2026-11-17 21:30
 *   ---
 *   Le passage, sur une ou plusieurs lignes.
 *
 *   💭 Mon commentaire (facultatif)
 */
import { normalizeBody } from './fiche.js';

export const INBOX_DIR = 'boite';
export const isInboxPath = (path) => new RegExp(`^${INBOX_DIR}/[^/]+\\.(md|txt)$`, 'i').test(path);

const TYPE_ALIASES = {
  citation: 'citation', quote: 'citation', passage: 'citation',
  idee: 'idee', idea: 'idee',
  question: 'question',
  appliquer: 'appliquer', 'a appliquer': 'appliquer', action: 'appliquer', todo: 'appliquer',
};

const simplify = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const HEADER_KEYS = new Set(['livre', 'book', 'type', 'page', 'tags', 'date', 'commentaire']);

/** Lit un fichier de la boîte de réception. Lève une erreur s'il ne contient pas de texte. */
export function parseInboxFile(raw) {
  const lines = String(raw ?? '').replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  const meta = {};
  let i = 0;
  const readHeader = (line) => {
    const m = line.match(/^\s*([\p{L}]+)\s*:\s*(.*)$/u);
    if (!m || !HEADER_KEYS.has(simplify(m[1]))) return false;
    meta[simplify(m[1])] = m[2].trim();
    return true;
  };
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, k) => k > 0 && l.trim() === '---');
    if (end !== -1) {
      for (const line of lines.slice(1, end)) readHeader(line);
      i = end + 1;
    }
  } else {
    while (i < lines.length && readHeader(lines[i])) i++; // en-tête sans « --- »
  }

  const body = lines.slice(i);
  const commentAt = body.findIndex((l) => /^\s*(💭|commentaire\s*:)/iu.test(l));
  const textLines = commentAt === -1 ? body : body.slice(0, commentAt);
  const commentLines = commentAt === -1 ? [] : body.slice(commentAt);
  if (commentLines.length) commentLines[0] = commentLines[0].replace(/^\s*(💭|commentaire\s*:)\s*/iu, '');
  const text = normalizeBody(textLines.join('\n'));
  if (!text) throw new Error('Note vide');

  const typeKey = simplify(meta.type).replace(/^à /, 'a ');
  const date = String(meta.date ?? '').trim();
  return {
    livre: meta.livre || meta.book || '',
    type: TYPE_ALIASES[typeKey] || 'citation',
    page: String(meta.page ?? '').trim(),
    tags: meta.tags || '',
    date: /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/.test(date) ? date : '',
    text,
    comment: normalizeBody([meta.commentaire, ...commentLines].filter(Boolean).join('\n')),
  };
}
