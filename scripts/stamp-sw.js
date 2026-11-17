/**
 * stamp-sw.js — Donne au service worker une version tirée du contenu de l'app.
 * Lancé avant chaque publication : si un seul fichier change, la version change, et les iPhone
 * qui ont installé l'app se voient proposer la mise à jour.
 * Vérifie aussi que la liste SHELL de sw.js contient bien tous les fichiers de l'app.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../app/', import.meta.url));
const swPath = join(root, 'sw.js');

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

export function shellFiles() {
  return walk(root).map((f) => relative(root, f).split('\\').join('/')).filter((f) => f !== 'sw.js' && !f.endsWith('.map')).sort();
}

export function listedFiles(source = readFileSync(swPath, 'utf8')) {
  const block = /const SHELL = \[([\s\S]*?)\];/.exec(source)[1];
  return [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]).filter((f) => f !== './').sort();
}

export function stamp() {
  const files = shellFiles();
  const listed = listedFiles();
  const missing = files.filter((f) => !listed.includes(f));
  const extra = listed.filter((f) => !files.includes(f));
  if (missing.length || extra.length) {
    throw new Error(`Liste SHELL de sw.js à corriger. Manquants : ${missing.join(', ') || '—'} · En trop : ${extra.join(', ') || '—'}`);
  }
  const hash = createHash('sha256');
  for (const f of files) hash.update(f).update(readFileSync(join(root, f)));
  const version = `marginalia-${hash.digest('hex').slice(0, 12)}`;
  const source = readFileSync(swPath, 'utf8').replace(/const VERSION = '[^']*';/, `const VERSION = '${version}';`);
  writeFileSync(swPath, source);
  return version;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(stamp());
}
