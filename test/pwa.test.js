// L'app installable : chaque fichier est bien mis en cache hors ligne, les références existent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { shellFiles, listedFiles } from '../scripts/stamp-sw.js';

const app = (path) => new URL(`../app/${path}`, import.meta.url);

test('service worker : la liste des fichiers gardés hors ligne est complète', () => {
  assert.deepEqual(listedFiles(), shellFiles());
});

test('index.html : scripts, styles, icônes et manifeste existent ; CSP stricte', () => {
  const html = readFileSync(app('index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="([^"#:]+)"/g)].map((m) => m[1]);
  assert.ok(refs.length > 10);
  for (const ref of refs) assert.ok(existsSync(app(ref)), `référence manquante : ${ref}`);
  assert.match(html, /script-src 'self';/);
  assert.match(html, /connect-src 'self' https:\/\/api\.github\.com;/);
  assert.doesNotMatch(html, /<script>(?!<\/script>)/, 'aucun script en ligne');
});

test('manifeste : installable (standalone, icônes 192 et 512, chemins relatifs pour GitHub Pages)', () => {
  const manifest = JSON.parse(readFileSync(app('manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, './');
  for (const icon of manifest.icons) assert.ok(existsSync(app(icon.src)), icon.src);
  assert.ok(manifest.icons.some((i) => i.sizes === '512x512' && i.purpose === 'maskable'));
});
