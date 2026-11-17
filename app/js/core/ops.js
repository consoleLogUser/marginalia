/**
 * ops.js — Les opérations en attente d'envoi vers GitHub.
 *
 * Une opération ne décrit pas « le nouveau fichier » mais « ce qu'il faut faire au fichier » :
 * ajouter telle note, cocher telle action… Si la fiche a changé sur GitHub entre-temps (modifiée depuis
 * un autre appareil ou dans Obsidian), on relit la nouvelle version et on RÉAPPLIQUE l'opération dessus.
 * Toutes les opérations sont idempotentes : appliquées deux fois, elles donnent le même résultat qu'une
 * seule fois. C'est ce qui rend la synchronisation sûre même quand le réseau coupe au mauvais moment.
 */
import * as fiche from './fiche.js';

export const OP_KINDS = new Set([
  'create', 'write', 'delete', 'append-lines', 'json-set',
  'append-note', 'remove-note', 'update-task', 'add-reflection', 'write-synthesis', 'set-status', 'ensure-ids',
]);

function requireContent(content) {
  if (content === null || content === undefined) throw new fiche.FicheError("La fiche n'existe plus.", 'missing');
  return content;
}

/** Remplace l'identifiant d'un bloc de note par un nouvel identifiant libre (collision, très rare). */
function reId(block, content) {
  const used = new Set(fiche.parseNotes(content).map((n) => n.id).filter(Boolean));
  const fresh = fiche.generateId(used);
  return block.replace(/\n\^[A-Za-z0-9-]+$/, `\n^${fresh}`);
}

/**
 * Applique une opération au contenu actuel d'un fichier.
 * @param content contenu actuel (null si le fichier n'existe pas)
 * @returns le nouveau contenu, ou null pour supprimer le fichier
 */
export function applyOp(content, op) {
  const at = op.at ? new Date(op.at) : new Date();
  const a = op.args || {};
  switch (op.kind) {
    case 'create':
      return content ?? a.content; // si le fichier existe déjà (même livre créé ailleurs), on le garde
    case 'write':
      return a.content;
    case 'delete':
      return null;
    case 'append-lines': {
      // Un envoi répété (réseau coupé juste après l'envoi) ne doit pas doubler les lignes déjà présentes.
      const base = content ?? '';
      const present = new Set(base.split('\n'));
      const lines = a.lines.filter((line) => !present.has(line));
      if (!lines.length) return content;
      const sep = base === '' || base.endsWith('\n') ? '' : '\n';
      return `${base}${sep}${lines.join('\n')}\n`;
    }
    case 'json-set': {
      // Réglage partagé : on ne touche qu'à SA clé, les autres réglages (venus d'un autre appareil) restent.
      let data = {};
      try { data = content ? JSON.parse(content) : {}; } catch { data = {}; }
      if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
      if (JSON.stringify(data[a.key]) === JSON.stringify(a.value) && content) return content;
      return `${JSON.stringify({ ...data, [a.key]: a.value }, null, 2)}\n`;
    }
    case 'append-note': {
      const base = requireContent(content);
      try {
        return fiche.appendNoteBlock(base, a.block);
      } catch (err) {
        if (err.code !== 'id-taken') throw err;
        return fiche.appendNoteBlock(base, reId(a.block, base));
      }
    }
    case 'remove-note':
      return fiche.removeNoteBlock(requireContent(content), a.noteId, a.block);
    case 'update-task':
      return fiche.updateTaskInContent(requireContent(content), a.noteId, a.index, a, at);
    case 'add-reflection':
      return fiche.addReflectionToContent(requireContent(content), a.noteId, a.text, at);
    case 'write-synthesis':
      return fiche.writeSynthesisToContent(requireContent(content), a.text, at);
    case 'set-status':
      return fiche.setStatusInContent(requireContent(content), a.statut, at);
    case 'ensure-ids':
      return content === null || content === undefined ? null : fiche.ensureNoteIds(content).content;
    default:
      throw new fiche.FicheError(`Opération inconnue : ${op.kind}`, 'input');
  }
}

/** Applique une suite d'opérations ; renvoie le contenu final et les opérations rejetées. */
export function applyOps(content, ops) {
  let current = content;
  const rejected = [];
  for (const op of ops) {
    try {
      current = applyOp(current, op);
    } catch (err) {
      if (!(err instanceof fiche.FicheError)) throw err;
      rejected.push({ op, error: err });
    }
  }
  return { content: current, rejected };
}
