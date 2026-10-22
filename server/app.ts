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
import { DuplicateHandleError, newHubId, type ContentRecord, type HubStore, type UserRecord } from './store';

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;
const KINDS: BundleKind[] = ['universe', 'character', 'item', 'story'];
const SORTS: SortOrder[] = ['new', 'top', 'downloads'];

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

  const summarize = (c: ContentRecord): ContentSummary => ({
    id: c.id,
    kind: c.kind,
    name: c.name,
    description: c.description,
    tags: c.tags,
    author: { id: c.authorId, handle: c.authorHandle },
    version: c.version,
    downloads: c.downloads,
    likes: c.likes,
    liked: c.liked,
    preview: c.preview,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  });

  const viewer = async (req: IncomingMessage): Promise<UserRecord | null> => {
    const auth = req.headers.authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) return null;
    const userId = await store.findSessionUser(sha256(token));
    return userId ? (await store.getUser(userId)) ?? null : null;
  };

  const requireUser = async (req: IncomingMessage): Promise<UserRecord> => {
    const u = await viewer(req);
    if (!u) throw new HttpError(401, 'Sign in to do that.');
    return u;
  };

  const openSession = async (user: UserRecord): Promise<AuthResponse> => {
    const token = randomBytes(32).toString('base64url');
    await store.addSession(sha256(token), user.id, Date.now());
    return { token, user: toUser(user) };
  };

  const validatePublish = (body: unknown, author: UserRecord) => {
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
    bundle.author = author.handle;
    const name = bundle.name || u.name;
    const description = str(body, 'description').slice(0, LIMITS.description);
    const tags = normalizeTags((body as Record<string, unknown>)?.tags);
    const preview = previewBundle(bundle);
    const searchText = [name, description, author.handle, ...tags, ...u.characters.map((c) => c.alias)].join(' ').toLowerCase();
    return { bundle, fields: { name, description, tags, preview, searchText } };
  };

  const ownContent = async (req: IncomingMessage, id: string) => {
    const user = await requireUser(req);
    const c = await store.getContent(id, user.id);
    if (!c) throw new HttpError(404, 'Not found.');
    if (c.authorId !== user.id) throw new HttpError(403, 'Only the creator can change this.');
    return { user, c };
  };

  async function api(req: IncomingMessage, res: ServerResponse, path: string, url: URL) {
    const method = req.method ?? 'GET';
    const parts = path.split('/').filter(Boolean); // ['api', ...]
    const route = `${method} /${parts.slice(1).join('/')}`;
    const id = parts[2] ?? '';

    if (route === 'GET /health') {
      try {
        await store.ping();
      } catch {
        throw new HttpError(503, 'The hub database is unavailable.');
      }
      return send(res, 200, { ok: true, version: HUB_API_VERSION });
    }

    if (route === 'POST /auth/register') {
      const body = await readJson(req);
      const handle = str(body, 'handle').trim();
      const password = str(body, 'password');
      if (!LIMITS.handle.test(handle)) throw new HttpError(400, 'Handles are 3-24 letters, numbers, dashes, or underscores.');
      if (password.length < LIMITS.passwordMin) throw new HttpError(400, `Passwords need at least ${LIMITS.passwordMin} characters.`);
      const user: UserRecord = { id: newHubId('usr'), handle, passwordHash: await hashPassword(password), createdAt: Date.now() };
      try {
        await store.addUser(user);
      } catch (e) {
        if (e instanceof DuplicateHandleError) throw new HttpError(409, 'That handle is taken.');
        throw e;
      }
      return send(res, 201, await openSession(user));
    }

    if (route === 'POST /auth/login') {
      const body = await readJson(req);
      const user = await store.findUserByHandle(str(body, 'handle').trim());
      if (!user || !(await verifyPassword(str(body, 'password'), user.passwordHash))) {
        throw new HttpError(401, 'Wrong handle or password.');
      }
      return send(res, 200, await openSession(user));
    }

    if (route === 'POST /auth/logout') {
      const auth = req.headers.authorization ?? '';
      if (auth.startsWith('Bearer ')) await store.removeSession(sha256(auth.slice(7)));
      return send(res, 200, { ok: true });
    }

    if (route === 'GET /me') return send(res, 200, toUser(await requireUser(req)));

    if (route === 'GET /content') {
      const me = await viewer(req);
      const kind = url.searchParams.get('kind') as BundleKind | null;
      const sort = url.searchParams.get('sort') as SortOrder | null;
      const page = Math.max(1, Math.min(1000, Number(url.searchParams.get('page')) || 1));
      const { records, total } = await store.listContent({
        kind: kind && KINDS.includes(kind) ? kind : undefined,
        q: (url.searchParams.get('q') ?? '').trim().toLowerCase().slice(0, 80) || undefined,
        sort: sort && SORTS.includes(sort) ? sort : 'new',
        authorId: url.searchParams.get('author') || undefined,
        page,
        pageSize: LIMITS.pageSize,
        viewerId: me?.id ?? null,
        hideAtReports: LIMITS.reportsToHide,
      });
      const body: ListResponse = { items: records.map(summarize), page, pageSize: LIMITS.pageSize, total };
      return send(res, 200, body);
    }

    if (route === 'POST /content') {
      const user = await requireUser(req);
      const { bundle, fields } = validatePublish(await readJson(req), user);
      const contentId = newHubId('hub');
      await store.createContent({ ...fields, id: contentId, kind: bundle.kind, authorId: user.id, createdAt: Date.now() }, bundle);
      return send(res, 201, summarize((await store.getContent(contentId, user.id))!));
    }

    if (parts[1] === 'content' && id) {
      const action = parts[3] ?? '';
      if (method === 'GET' && !action) {
        const c = await store.getContent(id, (await viewer(req))?.id ?? null);
        const bundle = c && (await store.getBundle(id));
        if (!c || !bundle) throw new HttpError(404, 'Not found.');
        const detail: ContentDetail = { ...summarize(c), bundle };
        return send(res, 200, detail);
      }
      if (method === 'PUT' && !action) {
        const { user, c } = await ownContent(req, id);
        const { bundle, fields } = validatePublish(await readJson(req), user);
        if (bundle.kind !== c.kind) throw new HttpError(400, `This listing holds a ${c.kind}; publish a ${bundle.kind} as a new listing.`);
        await store.updateContent(id, fields, bundle, Date.now());
        return send(res, 200, summarize((await store.getContent(id, user.id))!));
      }
      if (method === 'DELETE' && !action) {
        await ownContent(req, id);
        await store.removeContent(id);
        return send(res, 200, { ok: true });
      }
      const me = await viewer(req);
      const c = await store.getContent(id, me?.id ?? null);
      if (!c) throw new HttpError(404, 'Not found.');
      if (method === 'POST' && action === 'download') {
        return send(res, 200, { downloads: await store.incrementDownloads(id) });
      }
      if (method === 'POST' && action === 'like') {
        const user = await requireUser(req);
        return send(res, 200, await store.toggleLike(id, user.id));
      }
      if (method === 'POST' && action === 'report') {
        const user = await requireUser(req);
        if (user.id !== c.authorId) await store.addReport(id, user.id);
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
