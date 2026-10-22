// Hub persistence contract plus a dependency-free JSON-file implementation
// for local development. Production uses PgHubStore (server/pg-store.ts).

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Bundle, BundleKind } from '../src/core/share';
import type { ContentPreview, SortOrder } from '../src/online/protocol';

/** Sessions expire after this long without signing in again. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface UserRecord {
  id: string;
  handle: string;
  passwordHash: string;
  createdAt: number;
}

export interface NewContent {
  id: string;
  kind: BundleKind;
  name: string;
  description: string;
  tags: string[];
  authorId: string;
  preview: ContentPreview;
  /** Lower-cased text that search matches against. */
  searchText: string;
  createdAt: number;
}

export type ContentFields = Pick<NewContent, 'name' | 'description' | 'tags' | 'preview' | 'searchText'>;

export interface ContentRecord {
  id: string;
  kind: BundleKind;
  name: string;
  description: string;
  tags: string[];
  authorId: string;
  authorHandle: string;
  version: number;
  downloads: number;
  likes: number;
  reports: number;
  /** Whether the viewer the record was fetched for has liked it. */
  liked: boolean;
  preview: ContentPreview;
  createdAt: number;
  updatedAt: number;
}

export interface ContentQuery {
  kind?: BundleKind;
  /** Lower-cased search text. */
  q?: string;
  sort: SortOrder;
  authorId?: string;
  page: number;
  pageSize: number;
  viewerId: string | null;
  /** Hide listings with at least this many reports, except from their author. */
  hideAtReports: number;
}

export class DuplicateHandleError extends Error {}

export interface HubStore {
  /** Verifies the backing storage is reachable (used by the health check). */
  ping(): Promise<void>;
  findUserByHandle(handle: string): Promise<UserRecord | undefined>;
  getUser(id: string): Promise<UserRecord | undefined>;
  /** Throws DuplicateHandleError if the handle is taken (case-insensitive). */
  addUser(user: UserRecord): Promise<void>;
  addSession(tokenHash: string, userId: string, createdAt: number): Promise<void>;
  /** The session's user id, if the session exists and hasn't expired. */
  findSessionUser(tokenHash: string): Promise<string | undefined>;
  removeSession(tokenHash: string): Promise<void>;
  listContent(q: ContentQuery): Promise<{ records: ContentRecord[]; total: number }>;
  getContent(id: string, viewerId: string | null): Promise<ContentRecord | undefined>;
  createContent(c: NewContent, bundle: Bundle): Promise<void>;
  /** Replaces a listing's bundle and metadata and bumps its version. */
  updateContent(id: string, fields: ContentFields, bundle: Bundle, updatedAt: number): Promise<void>;
  removeContent(id: string): Promise<void>;
  getBundle(id: string): Promise<Bundle | null>;
  incrementDownloads(id: string): Promise<number>;
  toggleLike(id: string, userId: string): Promise<{ liked: boolean; likes: number }>;
  addReport(id: string, userId: string): Promise<void>;
  /** Deletes an account and everything tied to it: sessions, listings, likes, and reports. */
  removeUser(id: string): Promise<void>;
  close(): Promise<void>;
}

export function newHubId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString('base64url')}`;
}

// --- File store ----------------------------------------------------------------

interface StoredContent extends NewContent {
  version: number;
  downloads: number;
  likedBy: string[];
  reportedBy: string[];
  updatedAt: number;
}

interface Snapshot {
  users: UserRecord[];
  sessions: { tokenHash: string; userId: string; createdAt: number }[];
  content: StoredContent[];
}

/** Writes via a temp file + rename so a crash never leaves half-written JSON. */
function writeAtomic(path: string, data: string) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

export class FileHubStore implements HubStore {
  private data: Snapshot;
  private readonly indexPath: string;
  private readonly bundleDir: string;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.bundleDir = join(dir, 'bundles');
    mkdirSync(this.bundleDir, { recursive: true });
    this.indexPath = join(dir, 'hub.json');
    this.data = existsSync(this.indexPath)
      ? (JSON.parse(readFileSync(this.indexPath, 'utf8')) as Snapshot)
      : { users: [], sessions: [], content: [] };
  }

  private flush() {
    writeAtomic(this.indexPath, JSON.stringify(this.data));
  }

  private bundlePath(id: string) {
    // Ids are server-generated, but never trust a path segment.
    if (!/^[\w-]+$/.test(id)) throw new Error('bad id');
    return join(this.bundleDir, `${id}.json`);
  }

  private toRecord(c: StoredContent, viewerId: string | null): ContentRecord {
    return {
      id: c.id,
      kind: c.kind,
      name: c.name,
      description: c.description,
      tags: c.tags,
      authorId: c.authorId,
      authorHandle: this.data.users.find((u) => u.id === c.authorId)?.handle ?? 'unknown',
      version: c.version,
      downloads: c.downloads,
      likes: c.likedBy.length,
      reports: c.reportedBy.length,
      liked: !!viewerId && c.likedBy.includes(viewerId),
      preview: c.preview,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    };
  }

  private stored(id: string) {
    return this.data.content.find((c) => c.id === id);
  }

  async ping() {}

  async findUserByHandle(handle: string) {
    const h = handle.toLowerCase();
    return this.data.users.find((u) => u.handle.toLowerCase() === h);
  }

  async getUser(id: string) {
    return this.data.users.find((u) => u.id === id);
  }

  async addUser(user: UserRecord) {
    if (await this.findUserByHandle(user.handle)) throw new DuplicateHandleError();
    this.data.users.push(user);
    this.flush();
  }

  async addSession(tokenHash: string, userId: string, createdAt: number) {
    const cutoff = Date.now() - SESSION_TTL_MS;
    this.data.sessions = this.data.sessions.filter((s) => s.createdAt > cutoff);
    this.data.sessions.push({ tokenHash, userId, createdAt });
    this.flush();
  }

  async findSessionUser(tokenHash: string) {
    const s = this.data.sessions.find((x) => x.tokenHash === tokenHash);
    return s && s.createdAt > Date.now() - SESSION_TTL_MS ? s.userId : undefined;
  }

  async removeSession(tokenHash: string) {
    this.data.sessions = this.data.sessions.filter((s) => s.tokenHash !== tokenHash);
    this.flush();
  }

  async listContent(q: ContentQuery) {
    let items = this.data.content.filter((c) => c.reportedBy.length < q.hideAtReports || c.authorId === q.viewerId);
    if (q.kind) items = items.filter((c) => c.kind === q.kind);
    if (q.authorId) items = items.filter((c) => c.authorId === q.authorId);
    if (q.q) items = items.filter((c) => c.searchText.includes(q.q!));
    const score = (c: StoredContent) => (q.sort === 'top' ? c.likedBy.length * 3 + c.downloads : q.sort === 'downloads' ? c.downloads : c.createdAt);
    items = [...items].sort((a, b) => score(b) - score(a) || b.createdAt - a.createdAt);
    const start = (q.page - 1) * q.pageSize;
    return { records: items.slice(start, start + q.pageSize).map((c) => this.toRecord(c, q.viewerId)), total: items.length };
  }

  async getContent(id: string, viewerId: string | null) {
    const c = this.stored(id);
    return c && this.toRecord(c, viewerId);
  }

  async createContent(c: NewContent, bundle: Bundle) {
    writeAtomic(this.bundlePath(c.id), JSON.stringify(bundle));
    this.data.content.push({ ...c, version: 1, downloads: 0, likedBy: [], reportedBy: [], updatedAt: c.createdAt });
    this.flush();
  }

  async updateContent(id: string, fields: ContentFields, bundle: Bundle, updatedAt: number) {
    const c = this.stored(id);
    if (!c) return;
    writeAtomic(this.bundlePath(id), JSON.stringify(bundle));
    Object.assign(c, fields, { version: c.version + 1, updatedAt });
    this.flush();
  }

  async removeContent(id: string) {
    this.data.content = this.data.content.filter((c) => c.id !== id);
    rmSync(this.bundlePath(id), { force: true });
    this.flush();
  }

  async getBundle(id: string): Promise<Bundle | null> {
    try {
      return JSON.parse(readFileSync(this.bundlePath(id), 'utf8')) as Bundle;
    } catch {
      return null;
    }
  }

  async incrementDownloads(id: string) {
    const c = this.stored(id);
    if (!c) return 0;
    c.downloads++;
    this.flush();
    return c.downloads;
  }

  async toggleLike(id: string, userId: string) {
    const c = this.stored(id);
    if (!c) return { liked: false, likes: 0 };
    const liked = !c.likedBy.includes(userId);
    c.likedBy = liked ? [...c.likedBy, userId] : c.likedBy.filter((x) => x !== userId);
    this.flush();
    return { liked, likes: c.likedBy.length };
  }

  async addReport(id: string, userId: string) {
    const c = this.stored(id);
    if (c && !c.reportedBy.includes(userId)) {
      c.reportedBy.push(userId);
      this.flush();
    }
  }

  async removeUser(id: string) {
    for (const c of this.data.content.filter((x) => x.authorId === id)) rmSync(this.bundlePath(c.id), { force: true });
    this.data.content = this.data.content.filter((c) => c.authorId !== id);
    for (const c of this.data.content) {
      c.likedBy = c.likedBy.filter((x) => x !== id);
      c.reportedBy = c.reportedBy.filter((x) => x !== id);
    }
    this.data.sessions = this.data.sessions.filter((s) => s.userId !== id);
    this.data.users = this.data.users.filter((u) => u.id !== id);
    this.flush();
  }

  async close() {}
}
