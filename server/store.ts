// Hub persistence. A JSON-file store keeps the server dependency-free and easy
// to self-host; everything goes through `HubStore` so a real database can
// replace it without touching the HTTP layer.

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Bundle, BundleKind } from '../src/core/share';
import type { ContentPreview } from '../src/online/protocol';

export interface UserRecord {
  id: string;
  handle: string;
  passwordHash: string;
  createdAt: number;
}

export interface SessionRecord {
  /** sha256 of the bearer token; the token itself is never stored. */
  tokenHash: string;
  userId: string;
  createdAt: number;
}

export interface ContentRecord {
  id: string;
  kind: BundleKind;
  name: string;
  description: string;
  tags: string[];
  authorId: string;
  version: number;
  downloads: number;
  likedBy: string[];
  reportedBy: string[];
  preview: ContentPreview;
  createdAt: number;
  updatedAt: number;
}

interface Snapshot {
  users: UserRecord[];
  sessions: SessionRecord[];
  content: ContentRecord[];
}

export interface HubStore {
  findUserByHandle(handle: string): UserRecord | undefined;
  getUser(id: string): UserRecord | undefined;
  addUser(user: UserRecord): void;
  addSession(session: SessionRecord): void;
  findSession(tokenHash: string): SessionRecord | undefined;
  removeSession(tokenHash: string): void;
  allContent(): ContentRecord[];
  getContent(id: string): ContentRecord | undefined;
  saveContent(record: ContentRecord, bundle?: Bundle): void;
  removeContent(id: string): void;
  getBundle(id: string): Bundle | null;
}

export function newHubId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString('base64url')}`;
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

  findUserByHandle(handle: string) {
    const h = handle.toLowerCase();
    return this.data.users.find((u) => u.handle.toLowerCase() === h);
  }

  getUser(id: string) {
    return this.data.users.find((u) => u.id === id);
  }

  addUser(user: UserRecord) {
    this.data.users.push(user);
    this.flush();
  }

  addSession(session: SessionRecord) {
    this.data.sessions.push(session);
    this.flush();
  }

  findSession(tokenHash: string) {
    return this.data.sessions.find((s) => s.tokenHash === tokenHash);
  }

  removeSession(tokenHash: string) {
    this.data.sessions = this.data.sessions.filter((s) => s.tokenHash !== tokenHash);
    this.flush();
  }

  allContent() {
    return this.data.content;
  }

  getContent(id: string) {
    return this.data.content.find((c) => c.id === id);
  }

  saveContent(record: ContentRecord, bundle?: Bundle) {
    if (bundle) writeAtomic(this.bundlePath(record.id), JSON.stringify(bundle));
    const i = this.data.content.findIndex((c) => c.id === record.id);
    if (i >= 0) this.data.content[i] = record;
    else this.data.content.push(record);
    this.flush();
  }

  removeContent(id: string) {
    this.data.content = this.data.content.filter((c) => c.id !== id);
    rmSync(this.bundlePath(id), { force: true });
    this.flush();
  }

  getBundle(id: string): Bundle | null {
    try {
      return JSON.parse(readFileSync(this.bundlePath(id), 'utf8')) as Bundle;
    } catch {
      return null;
    }
  }
}
