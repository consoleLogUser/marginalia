/**
 * serve.js — Petit serveur local pour essayer l'app sur ton PC (ou la tester automatiquement).
 *
 *   node scripts/serve.js            → http://localhost:8080/  (l'app, qui parle au vrai GitHub)
 *   node scripts/serve.js --mock     → + un faux GitHub sur /gh (aucun compte nécessaire)
 *
 * Avec --mock, l'app doit être pointée vers /gh : ouvre une fois http://localhost:8080/?mock
 * (la page enregistre l'adresse du faux GitHub et se recharge). Jeton à saisir : « github_pat_11TEST0000000000000000 ».
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockGitHub } from './mock-github.js';

const ROOT = fileURLToPath(new URL('../app/', import.meta.url));
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.md': 'text/markdown; charset=utf-8',
};

export function startServer({ port = 8080, mock = false, owner = 'moi', repo = 'marginalia-data', token = 'github_pat_11TEST0000000000000000' } = {}) {
  let gh = mock ? new MockGitHub({ owner, repo, token }) : null;

  async function body(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);

      // Petit script de démarrage pour ?mock (servi à part : la CSP de l'app interdit le JavaScript en ligne).
      if (gh && url.pathname === '/__mockboot.js') {
        res.writeHead(200, { 'content-type': TYPES['.js'], 'cache-control': 'no-store' });
        res.end("localStorage.setItem('marginalia:apiBase', location.origin + '/gh'); localStorage.setItem('marginalia:noSW', '1'); location.replace('/');");
        return;
      }

      // ----- Faux GitHub -----
      if (gh && url.pathname.startsWith('/gh/')) {
        const raw = await body(req);
        const response = await gh.fetch(`http://mock.local${url.pathname.slice(3)}${url.search}`, {
          method: req.method,
          headers: req.headers,
          body: raw || undefined,
        }).catch(() => null);
        if (!response) {
          req.socket.destroy(); // panne réseau simulée
          return;
        }
        res.writeHead(response.status, { 'content-type': response.headers.get('content-type') || 'text/plain', 'cache-control': 'no-store' });
        res.end(Buffer.from(await response.arrayBuffer()));
        return;
      }

      // ----- Pilotage du faux GitHub par les tests -----
      if (gh && url.pathname.startsWith('/__mock/')) {
        const action = url.pathname.slice('/__mock/'.length);
        const data = req.method === 'POST' ? JSON.parse((await body(req)) || '{}') : {};
        let out = { ok: true };
        if (action === 'state') out = { files: Object.fromEntries(gh.files), commits: gh.commits };
        else if (action === 'write') gh.writeExternal(data.path, data.content ?? null, data.message);
        else if (action === 'fault') gh.failNext(data);
        else if (action === 'token') gh.token = data.token;
        else if (action === 'stale') gh.staleTreeReads = Number(data.reads) || 1;
        else if (action === 'private') gh.isPrivate = data.value !== false;
        else if (action === 'reset') gh = new MockGitHub({ owner, repo, token });
        else out = { ok: false, error: 'action inconnue' };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out));
        return;
      }

      // ----- Fichiers de l'app -----
      let path = decodeURIComponent(url.pathname);
      if (path.endsWith('/')) path += 'index.html';
      const file = normalize(join(ROOT, path));
      if (!file.startsWith(ROOT)) {
        res.writeHead(403).end();
        return;
      }
      const info = await stat(file).catch(() => null);
      if (!info?.isFile()) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Introuvable');
        return;
      }
      const content = await readFile(file);
      // ?mock : la page de démarrage enregistre l'adresse du faux GitHub avant de charger l'app.
      if (gh && path === '/index.html' && url.searchParams.has('mock')) {
        res.writeHead(200, { 'content-type': TYPES['.html'], 'cache-control': 'no-store' });
        res.end('<!doctype html><meta charset="utf-8"><script src="/__mockboot.js"></script>');
        return;
      }
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(content);
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end(String(err?.stack || err));
    }
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port, mock: () => gh }));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mock = process.argv.includes('--mock');
  const port = Number(process.argv.find((a) => a.startsWith('--port='))?.slice(7)) || 8080;
  startServer({ port, mock }).then(({ port: p }) => {
    console.log(`Marginalia : http://localhost:${p}/${mock ? '?mock  (faux GitHub, jeton : github_pat_11TEST0000000000000000, compte : moi)' : ''}`);
  });
}
