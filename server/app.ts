// Multiverse Hub HTTP API. Plain node:http keeps the server small and
// dependency-free; every bundle is validated with the same code the game uses.

import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { BundleError, parseBundle, type BundleKind } from '../src/core/share';
import { previewBundle } from '../src/online/preview';
import {
  HUB_API_VERSION, LIMITS, normalizeTags,
  type AuthResponse, type ContentDetail, type ContentSummary, type HubUser, type ListResponse, type SortOrder,
} from '../src/online/protocol';
import { newHubId, type ContentRecord, type HubStore, type UserRecord } from './store';

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;
const KINDS: BundleKind[] = ['universe', 'character', 'item', 'story'];

export interface HubOptions {
  store: HubStore;
  /** Serve the built game from this directory (single-service deploys). */
  staticDir?: string;
  /** Allowed browser origins for cross-origin use; '*' allows any. */
  corsOrigin?: string;
  /** Trust X-Forwarded-For for rate limiting (only behind a proxy you control). */
  trustProxy?: boolean;
  /** Requests per minute per client; writes get a fifth of this. */
  rateLimit?: number;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

// --- Passwords and tokens ------------------------------------------------------

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scryptAsync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(expected, actual);
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// --- Rate limiting -----------------------------------------------------------

class RateLimiter {
  private windows = new Map<string, { start: number; count: number }>();
  constructor(private readonly perMinute: number) {}

  hit(key: string): boolean {
    const now = Date.now();
    const w = this.windows.get(key);
    if (!w || now - w.start > 60_000) {
      this.windows.set(key, { start: now, count: 1 });
      if (this.windows.size > 10_000) this.prune(now);
      return true;
    }
    w.count++;
    return w.count <= this.perMinute;
  }

  private prune(now: number) {
    for (const [k, w] of this.windows) if (now - w.start > 60_000) this.windows.delete(k);
  }
}

// --- Helpers -------------------------------------------------------------------

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > LIMITS.body) throw new HttpError(413, 'That upload is too large.');
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body must be JSON.');
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function str(o: unknown, key: string): string {
  const v = (o as Record<string, unknown> | null)?.[key];
  return typeof v === 'string' ? v : '';
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

// --- App -----------------------------------------------------------------------

export function createHub(opts: HubOptions): Server {
  const { store } = opts;
  const perMinute = opts.rateLimit ?? 240;
  const readLimiter = new RateLimiter(perMinute);
  const writeLimiter = new RateLimiter(Math.max(5, Math.floor(perMinute / 5)));

  const toUser = (u: UserRecord): HubUser => ({ id: u.id, handle: u.handle, createdAt: u.createdAt });

  const summarize = (c: ContentRecord, viewerId: string | null): ContentSummary => {
    const author = store.getUser(c.authorId);
    return {
      id: c.id,
      kind: c.kind,
      name: c.name,
      description: c.description,
      tags: c.tags,
      author: { id: c.authorId, handle: author?.handle ?? 'unknown' },
      version: c.version,
      downloads: c.downloads,
      likes: c.likedBy.length,
      liked: !!viewerId && c.likedBy.includes(viewerId),
      preview: c.preview,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    };
  };

  const viewer = (req: IncomingMessage): UserRecord | null => {
    const auth = req.headers.authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) return null;
    const session = store.findSession(sha256(token));
    return session ? store.getUser(session.userId) ?? null : null;
  };

  const requireUser = (req: IncomingMessage): UserRecord => {
    const u = viewer(req);
    if (!u) throw new HttpError(401, 'Sign in to do that.');
    return u;
  };

  const openSession = (user: UserRecord): AuthResponse => {
    const token = randomBytes(32).toString('base64url');
    store.addSession({ tokenHash: sha256(token), userId: user.id, createdAt: Date.now() });
    return { token, user: toUser(user) };
  };

  const validatePublish = (body: unknown) => {
    let bundle;
    try {
      bundle = parseBundle(JSON.stringify((body as Record<string, unknown>)?.bundle ?? null));
    } catch (e) {
      throw new HttpError(400, e instanceof BundleError ? e.message : 'Invalid bundle.');
    }
    const u = bundle.payload;
    if (!u.characters.length && !u.items.length && !u.stories.length && !u.locations.length) {
      throw new HttpError(400, 'That bundle is empty.');
    }
    return {
      bundle,
      description: str(body, 'description').slice(0, LIMITS.description),
      tags: normalizeTags((body as Record<string, unknown>)?.tags),
    };
  };

  const ownContent = (req: IncomingMessage, id: string) => {
    const user = requireUser(req);
    const c = store.getContent(id);
    if (!c) throw new HttpError(404, 'Not found.');
    if (c.authorId !== user.id) throw new HttpError(403, 'Only the creator can change this.');
    return { user, c };
  };

  async function api(req: IncomingMessage, res: ServerResponse, path: string, url: URL) {
    const method = req.method ?? 'GET';
    const parts = path.split('/').filter(Boolean); // ['api', ...]
    const route = `${method} /${parts.slice(1).join('/')}`;
    const id = parts[2] ?? '';

    if (route === 'GET /health') return send(res, 200, { ok: true, version: HUB_API_VERSION });

    if (route === 'POST /auth/register') {
      const body = await readJson(req);
      const handle = str(body, 'handle').trim();
      const password = str(body, 'password');
      if (!LIMITS.handle.test(handle)) throw new HttpError(400, 'Handles are 3-24 letters, numbers, dashes, or underscores.');
      if (password.length < LIMITS.passwordMin) throw new HttpError(400, `Passwords need at least ${LIMITS.passwordMin} characters.`);
      if (store.findUserByHandle(handle)) throw new HttpError(409, 'That handle is taken.');
      const user: UserRecord = { id: newHubId('usr'), handle, passwordHash: await hashPassword(password), createdAt: Date.now() };
      store.addUser(user);
      return send(res, 201, openSession(user));
    }

    if (route === 'POST /auth/login') {
      const body = await readJson(req);
      const user = store.findUserByHandle(str(body, 'handle').trim());
      if (!user || !(await verifyPassword(str(body, 'password'), user.passwordHash))) {
        throw new HttpError(401, 'Wrong handle or password.');
      }
      return send(res, 200, openSession(user));
    }

    if (route === 'POST /auth/logout') {
      const auth = req.headers.authorization ?? '';
      if (auth.startsWith('Bearer ')) store.removeSession(sha256(auth.slice(7)));
      return send(res, 200, { ok: true });
    }

    if (route === 'GET /me') return send(res, 200, toUser(requireUser(req)));

    if (route === 'GET /content') {
      const me = viewer(req);
      const kind = url.searchParams.get('kind') as BundleKind | null;
      const q = (url.searchParams.get('q') ?? '').trim().toLowerCase().slice(0, 80);
      const sort = (url.searchParams.get('sort') ?? 'new') as SortOrder;
      const author = url.searchParams.get('author');
      const page = Math.max(1, Math.min(1000, Number(url.searchParams.get('page')) || 1));
      let items = store.allContent().filter((c) => c.reportedBy.length < LIMITS.reportsToHide || c.authorId === me?.id);
      if (kind && KINDS.includes(kind)) items = items.filter((c) => c.kind === kind);
      if (author) items = items.filter((c) => c.authorId === author);
      if (q) {
        items = items.filter((c) => {
          const handle = store.getUser(c.authorId)?.handle ?? '';
          const hay = [c.name, c.description, handle, ...c.tags, ...c.preview.characters.map((x) => x.alias)].join(' ').toLowerCase();
          return hay.includes(q);
        });
      }
      const score = (c: ContentRecord) => (sort === 'top' ? c.likedBy.length * 3 + c.downloads : sort === 'downloads' ? c.downloads : c.createdAt);
      items = [...items].sort((a, b) => score(b) - score(a) || b.createdAt - a.createdAt);
      const start = (page - 1) * LIMITS.pageSize;
      const body: ListResponse = {
        items: items.slice(start, start + LIMITS.pageSize).map((c) => summarize(c, me?.id ?? null)),
        page,
        pageSize: LIMITS.pageSize,
        total: items.length,
      };
      return send(res, 200, body);
    }

    if (route === 'POST /content') {
      const user = requireUser(req);
      const { bundle, description, tags } = validatePublish(await readJson(req));
      const now = Date.now();
      const record: ContentRecord = {
        id: newHubId('hub'),
        kind: bundle.kind,
        name: bundle.name || bundle.payload.name,
        description,
        tags,
        authorId: user.id,
        version: 1,
        downloads: 0,
        likedBy: [],
        reportedBy: [],
        preview: previewBundle(bundle),
        createdAt: now,
        updatedAt: now,
      };
      bundle.author = user.handle;
      store.saveContent(record, bundle);
      return send(res, 201, summarize(record, user.id));
    }

    if (parts[1] === 'content' && id) {
      const action = parts[3] ?? '';
      if (method === 'GET' && !action) {
        const c = store.getContent(id);
        const bundle = c && store.getBundle(id);
        if (!c || !bundle) throw new HttpError(404, 'Not found.');
        const detail: ContentDetail = { ...summarize(c, viewer(req)?.id ?? null), bundle };
        return send(res, 200, detail);
      }
      if (method === 'PUT' && !action) {
        const { user, c } = ownContent(req, id);
        const { bundle, description, tags } = validatePublish(await readJson(req));
        if (bundle.kind !== c.kind) throw new HttpError(400, `This listing holds a ${c.kind}; publish a ${bundle.kind} as a new listing.`);
        bundle.author = user.handle;
        Object.assign(c, { name: bundle.name || c.name, description, tags, version: c.version + 1, preview: previewBundle(bundle), updatedAt: Date.now() });
        store.saveContent(c, bundle);
        return send(res, 200, summarize(c, user.id));
      }
      if (method === 'DELETE' && !action) {
        ownContent(req, id);
        store.removeContent(id);
        return send(res, 200, { ok: true });
      }
      const c = store.getContent(id);
      if (!c) throw new HttpError(404, 'Not found.');
      if (method === 'POST' && action === 'download') {
        c.downloads++;
        store.saveContent(c);
        return send(res, 200, { downloads: c.downloads });
      }
      if (method === 'POST' && action === 'like') {
        const user = requireUser(req);
        const liked = !c.likedBy.includes(user.id);
        c.likedBy = liked ? [...c.likedBy, user.id] : c.likedBy.filter((x) => x !== user.id);
        store.saveContent(c);
        return send(res, 200, { liked, likes: c.likedBy.length });
      }
      if (method === 'POST' && action === 'report') {
        const user = requireUser(req);
        if (user.id !== c.authorId && !c.reportedBy.includes(user.id)) {
          c.reportedBy.push(user.id);
          store.saveContent(c);
        }
        return send(res, 200, { ok: true });
      }
    }
    throw new HttpError(404, 'Unknown endpoint.');
  }

  function serveStatic(res: ServerResponse, path: string): boolean {
    if (!opts.staticDir) return false;
    const root = resolve(opts.staticDir);
    let file = resolve(join(root, normalize(decodeURIComponent(path))));
    if (file !== root && !file.startsWith(root + sep)) return false;
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html');
    if (!existsSync(file)) return false;
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': file.includes(`${join(root, 'assets')}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    createReadStream(file).pipe(res);
    return true;
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://hub.local');
    const path = url.pathname;
    try {
      if (opts.corsOrigin) {
        res.setHeader('access-control-allow-origin', opts.corsOrigin);
        res.setHeader('access-control-allow-headers', 'authorization, content-type');
        res.setHeader('access-control-allow-methods', 'GET, POST, PUT, DELETE, OPTIONS');
        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          return res.end();
        }
      }
      if (!path.startsWith('/api/')) {
        if (req.method === 'GET' && serveStatic(res, path)) return;
        throw new HttpError(404, 'Not found.');
      }
      const forwarded = opts.trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : '';
      const client = forwarded || req.socket.remoteAddress || 'unknown';
      const limiter = req.method === 'GET' ? readLimiter : writeLimiter;
      if (!limiter.hit(client)) throw new HttpError(429, 'Too many requests. Wait a minute and try again.');
      await api(req, res, path, url);
    } catch (e) {
      if (e instanceof HttpError) {
        // An oversized upload is still streaming in; close the connection instead of reading it all.
        if (e.status === 413) {
          res.setHeader('connection', 'close');
          res.on('finish', () => req.socket?.destroy());
        }
        send(res, e.status, { error: e.message });
      }
      else {
        console.error(e);
        send(res, 500, { error: 'Something went wrong on the hub.' });
      }
    }
  });
}
