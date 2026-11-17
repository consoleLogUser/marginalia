/**
 * github.js — Un petit client pour l'API REST de GitHub, limité à ce dont Marginalia a besoin :
 * lire l'arborescence du dépôt, lire un fichier, écrire un fichier, en supprimer un.
 *
 * Chaque écriture crée un commit : l'historique Git devient le journal (et la sauvegarde) de tes lectures.
 * Pour écrire un fichier existant, GitHub exige l'identifiant (sha) de la version qu'on remplace : si le
 * fichier a changé entre-temps, il refuse (409). C'est notre garde-fou contre l'écrasement silencieux.
 */

export class GitHubError extends Error {
  /** kind : network | auth | forbidden | notfound | conflict | rate | server | other */
  constructor(message, { status = 0, kind = 'other' } = {}) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.kind = kind;
  }
}

/** Texte → Base64, en passant par l'UTF-8 (btoa seul casse les accents). */
export function encodeBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Base64 (avec ou sans retours à la ligne, comme GitHub les renvoie) → texte UTF-8. */
export function decodeBase64(b64) {
  const binary = atob(String(b64).replace(/\s/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

const encodePath = (path) => path.split('/').map(encodeURIComponent).join('/');

function errorKind(status, headers) {
  if (status === 401) return 'auth';
  if (status === 403 || status === 429) return headers.get('x-ratelimit-remaining') === '0' || status === 429 ? 'rate' : 'forbidden';
  if (status === 404) return 'notfound';
  if (status === 409 || status === 422) return 'conflict'; // version périmée, ou fichier déjà créé ailleurs
  if (status >= 500) return 'server';
  return 'other';
}

export function createGitHub({
  apiBase = 'https://api.github.com', owner, repo, token,
  fetchImpl = (...args) => globalThis.fetch(...args), timeoutMs = 20000,
}) {
  const base = `${String(apiBase).replace(/\/$/, '')}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  async function call(method, url, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(url, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store', // jamais de réponse en cache : on veut l'état réel du dépôt
        signal: controller.signal,
      });
    } catch {
      throw new GitHubError('Réseau indisponible', { kind: 'network' });
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (res.ok) return data;
    const message = (data && typeof data === 'object' && data.message) || `${res.status} ${res.statusText}`;
    throw new GitHubError(message, { status: res.status, kind: errorKind(res.status, res.headers) });
  }

  /** Contenu d'un fichier à partir de son sha (immuable). */
  async function getBlob(sha) {
    const data = await call('GET', `${base}/git/blobs/${encodeURIComponent(sha)}`);
    return data.encoding === 'base64' ? decodeBase64(data.content) : String(data.content ?? '');
  }

  return {
    /** Vérifie l'accès au dépôt et renvoie sa branche par défaut. */
    async getRepo() {
      const data = await call('GET', base);
      return {
        fullName: data.full_name,
        defaultBranch: data.default_branch || 'main',
        isPrivate: Boolean(data.private),
        canPush: data.permissions ? Boolean(data.permissions.push) : true,
        htmlUrl: data.html_url,
      };
    },

    /** Tous les fichiers du dépôt : Map chemin → sha. Un dépôt vide renvoie une Map vide. */
    async getTree(branch) {
      try {
        const data = await call('GET', `${base}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
        const files = new Map();
        for (const item of data.tree || []) if (item.type === 'blob') files.set(item.path, item.sha);
        return { empty: false, files, truncated: Boolean(data.truncated) };
      } catch (err) {
        // GitHub répond 409 « Git Repository is empty » tant qu'aucun commit n'existe, et 404 si la branche
        // n'existe pas encore : dans les deux cas, il n'y a simplement rien à lire.
        if (err.status === 409 || (err.status === 404 && /branch|empty|not found/i.test(err.message))) {
          return { empty: true, files: new Map(), truncated: false };
        }
        throw err;
      }
    },

    getBlob,

    /** Un fichier et sa version actuelle, ou null s'il n'existe pas. */
    async getFile(path, branch) {
      try {
        const ref = branch ? `?ref=${encodeURIComponent(branch)}` : '';
        const data = await call('GET', `${base}/contents/${encodePath(path)}${ref}`);
        if (Array.isArray(data) || data.type !== 'file') return null;
        // Au-delà de 1 Mo, l'API « contents » ne renvoie pas le contenu : on passe par le blob.
        if (!data.content && data.size > 0) return { content: await getBlob(data.sha), sha: data.sha };
        return { content: decodeBase64(data.content ?? ''), sha: data.sha };
      } catch (err) {
        if (err.kind === 'notfound') return null;
        throw err;
      }
    },

    /** Crée (sans sha) ou remplace (avec le sha de la version remplacée) un fichier : un commit. */
    async putFile(path, content, { sha, message }) {
      const data = await call('PUT', `${base}/contents/${encodePath(path)}`, {
        message,
        content: encodeBase64(content),
        ...(sha ? { sha } : {}),
      });
      return { sha: data.content.sha, commit: data.commit?.sha };
    },

    /** Supprime un fichier (déjà absent : rien à faire). */
    async deleteFile(path, { sha, message }) {
      try {
        await call('DELETE', `${base}/contents/${encodePath(path)}`, { message, sha });
      } catch (err) {
        if (err.kind !== 'notfound') throw err;
      }
    },
  };
}
