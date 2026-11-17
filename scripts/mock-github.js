/**
 * mock-github.js — Un faux GitHub (en mémoire) pour tester la synchronisation sans réseau.
 *
 * Il reproduit le comportement réel de l'API REST dont l'app dépend :
 *  - dépôt vide : l'arborescence répond 409 « Git Repository is empty » ;
 *  - écrire un fichier existant exige son sha : sha périmé → 409, sha absent → 422 ;
 *  - Accept: application/vnd.github.raw+json → contenu brut (ce qu'utilise le raccourci iPhone) ;
 *  - jeton absent ou faux → 401.
 * Et il sait simuler les ennuis : arborescence périmée (cache), réseau coupé, réponse perdue après écriture.
 */
import { createHash } from 'node:crypto';

const gitSha = (content) => {
  const body = Buffer.from(content, 'utf8');
  return createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex');
};

const json = (status, data, headers = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
});

export class MockGitHub {
  constructor({ owner = 'moi', repo = 'marginalia-data', token = 'github_pat_11TEST0000000000000000', branch = 'main', isPrivate = true } = {}) {
    Object.assign(this, { owner, repo, token, branch, isPrivate });
    this.files = new Map(); // chemin → contenu
    this.history = []; // instantanés successifs de l'arborescence (pour simuler un cache périmé)
    this.commits = []; // { message, path, action }
    this.requests = []; // { method, path }
    this.staleTreeReads = 0; // les N prochaines lectures d'arborescence renvoient l'état d'avant la dernière écriture
    this.faults = []; // [{ method, pathIncludes, kind: 'network' | 'lost-response' | 500 | 403 }]
  }

  /* ----- Outils pour les tests ----- */

  seed(path, content) {
    this.files.set(path, content);
  }

  read(path) {
    return this.files.get(path) ?? null;
  }

  /** Simule une écriture faite ailleurs (Obsidian, le raccourci iPhone, un autre appareil). */
  writeExternal(path, content, message = 'Modification externe') {
    this.snapshot();
    if (content === null) this.files.delete(path);
    else this.files.set(path, content);
    this.commits.push({ message, path, action: content === null ? 'delete' : 'put' });
  }

  failNext(fault) {
    this.faults.push(fault);
  }

  snapshot() {
    this.history.push(new Map(this.files));
  }

  /* ----- L'API ----- */

  takeFault(method, path) {
    const i = this.faults.findIndex((f) => (!f.method || f.method === method) && (!f.pathIncludes || path.includes(f.pathIncludes)));
    return i === -1 ? null : this.faults.splice(i, 1)[0];
  }

  /** Compatible avec fetch(url, init). */
  async fetch(url, init = {}) {
    const method = (init.method || 'GET').toUpperCase();
    const u = new URL(url, 'http://mock.local');
    const headers = new Headers(init.headers || {});
    const fault = this.takeFault(method, u.pathname);
    if (fault?.kind === 'network') throw new TypeError('Failed to fetch');
    if (typeof fault?.kind === 'number') return json(fault.kind, { message: `Erreur simulée ${fault.kind}` });

    const response = await this.handle(method, u, headers, init.body ? JSON.parse(init.body) : null);
    if (fault?.kind === 'lost-response') throw new TypeError('Failed to fetch'); // l'écriture a eu lieu, la réponse est perdue
    return response;
  }

  async handle(method, u, headers, body) {
    this.requests.push({ method, path: decodeURIComponent(u.pathname) });
    if (headers.get('authorization') !== `Bearer ${this.token}`) return json(401, { message: 'Bad credentials' });
    const prefix = `/repos/${this.owner}/${this.repo}`;
    if (!u.pathname.startsWith(prefix)) return json(404, { message: 'Not Found' });
    const rest = u.pathname.slice(prefix.length);

    if (rest === '' && method === 'GET') {
      return json(200, {
        full_name: `${this.owner}/${this.repo}`,
        default_branch: this.branch,
        private: this.isPrivate,
        permissions: { admin: true, push: true, pull: true },
        html_url: `https://github.com/${this.owner}/${this.repo}`,
      });
    }

    let m = /^\/git\/trees\/([^/]+)$/.exec(rest);
    if (m && method === 'GET') {
      let files = this.files;
      if (this.staleTreeReads > 0 && this.history.length) {
        this.staleTreeReads -= 1;
        files = this.history[this.history.length - 1];
      }
      if (!files.size) return json(409, { message: 'Git Repository is empty.' });
      return json(200, {
        sha: 'tree',
        truncated: false,
        tree: [...files].map(([path, content]) => ({ path, mode: '100644', type: 'blob', sha: gitSha(content), size: Buffer.byteLength(content) })),
      });
    }

    m = /^\/git\/blobs\/([0-9a-f]{40})$/.exec(rest);
    if (m && method === 'GET') {
      const all = [this.files, ...this.history];
      for (const files of all) {
        for (const content of files.values()) {
          if (gitSha(content) === m[1]) {
            // GitHub coupe le base64 en lignes de 60 caractères : on fait pareil.
            const b64 = Buffer.from(content, 'utf8').toString('base64').replace(/(.{60})/g, '$1\n');
            return json(200, { sha: m[1], encoding: 'base64', content: b64, size: Buffer.byteLength(content) });
          }
        }
      }
      return json(404, { message: 'Not Found' });
    }

    m = /^\/contents\/(.+)$/.exec(rest);
    if (m) {
      const path = decodeURIComponent(m[1]);
      const current = this.files.get(path);
      if (method === 'GET') {
        if (current === undefined) return json(404, { message: 'Not Found' });
        if ((headers.get('accept') || '').includes('raw')) return new Response(current, { status: 200 });
        return json(200, { type: 'file', path, sha: gitSha(current), encoding: 'base64', content: Buffer.from(current).toString('base64') });
      }
      if (method === 'PUT') {
        if (!body?.message || typeof body.content !== 'string') return json(422, { message: 'Invalid request.' });
        if (current !== undefined && !body.sha) return json(422, { message: 'Invalid request.\n\n"sha" wasn\'t supplied.' });
        if (current !== undefined && body.sha !== gitSha(current)) return json(409, { message: `${path} does not match ${body.sha}` });
        if (current === undefined && body.sha) return json(409, { message: `${path} does not match ${body.sha}` });
        const content = Buffer.from(body.content, 'base64').toString('utf8');
        this.snapshot();
        this.files.set(path, content);
        this.commits.push({ message: body.message, path, action: 'put' });
        return json(current === undefined ? 201 : 200, { content: { path, sha: gitSha(content) }, commit: { sha: `c${this.commits.length}` } });
      }
      if (method === 'DELETE') {
        if (current === undefined) return json(404, { message: 'Not Found' });
        if (body?.sha !== gitSha(current)) return json(409, { message: `${path} does not match ${body?.sha}` });
        this.snapshot();
        this.files.delete(path);
        this.commits.push({ message: body.message, path, action: 'delete' });
        return json(200, { content: null, commit: { sha: `c${this.commits.length}` } });
      }
    }
    return json(404, { message: 'Not Found' });
  }
}

export { gitSha };
