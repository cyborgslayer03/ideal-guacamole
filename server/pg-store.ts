// PostgreSQL storage for the hub (production). Schema changes are applied as
// numbered migrations at startup, under an advisory lock so several instances
// can boot at once.

import pg from 'pg';
import type { Bundle, BundleKind } from '../src/core/share';
import type { ContentPreview } from '../src/online/protocol';
import {
  DuplicateHandleError, SESSION_TTL_MS,
  type ContentFields, type ContentQuery, type ContentRecord, type HubStore, type NewContent, type UserRecord,
} from './store';

const MIGRATIONS: string[] = [
  // 1: initial schema
  `
  CREATE TABLE users (
    id            text PRIMARY KEY,
    handle        text NOT NULL,
    handle_lower  text NOT NULL UNIQUE,
    password_hash text NOT NULL,
    created_at    bigint NOT NULL
  );
  CREATE TABLE sessions (
    token_hash text PRIMARY KEY,
    user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at bigint NOT NULL
  );
  CREATE INDEX sessions_created ON sessions (created_at);
  CREATE TABLE content (
    id          text PRIMARY KEY,
    kind        text NOT NULL,
    name        text NOT NULL,
    description text NOT NULL,
    tags        text[] NOT NULL,
    author_id   text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    version     integer NOT NULL DEFAULT 1,
    downloads   integer NOT NULL DEFAULT 0,
    likes       integer NOT NULL DEFAULT 0,
    reports     integer NOT NULL DEFAULT 0,
    preview     jsonb NOT NULL,
    bundle      jsonb NOT NULL,
    search_text text NOT NULL,
    created_at  bigint NOT NULL,
    updated_at  bigint NOT NULL
  );
  CREATE INDEX content_kind_created ON content (kind, created_at DESC);
  CREATE INDEX content_author ON content (author_id);
  CREATE TABLE likes (
    content_id text NOT NULL REFERENCES content(id) ON DELETE CASCADE,
    user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (content_id, user_id)
  );
  CREATE TABLE reports (
    content_id text NOT NULL REFERENCES content(id) ON DELETE CASCADE,
    user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at bigint NOT NULL,
    PRIMARY KEY (content_id, user_id)
  );
  `,
];

const MIGRATION_LOCK = 724_000_001;

interface ContentRow {
  id: string;
  kind: BundleKind;
  name: string;
  description: string;
  tags: string[];
  author_id: string;
  author_handle: string;
  version: number;
  downloads: number;
  likes: number;
  reports: number;
  liked: boolean;
  preview: ContentPreview;
  created_at: string;
  updated_at: string;
}

const CONTENT_COLUMNS = `
  c.id, c.kind, c.name, c.description, c.tags, c.author_id, u.handle AS author_handle,
  c.version, c.downloads, c.likes, c.reports, c.preview, c.created_at, c.updated_at,
  EXISTS (SELECT 1 FROM likes l WHERE l.content_id = c.id AND l.user_id = $1) AS liked`;

const SORT_SQL = {
  new: 'c.created_at DESC',
  top: '(c.likes * 3 + c.downloads) DESC, c.created_at DESC',
  downloads: 'c.downloads DESC, c.created_at DESC',
} as const;

function toRecord(r: ContentRow): ContentRecord {
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    description: r.description,
    tags: r.tags,
    authorId: r.author_id,
    authorHandle: r.author_handle,
    version: r.version,
    downloads: r.downloads,
    likes: r.likes,
    reports: r.reports,
    liked: r.liked,
    preview: r.preview,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function toUser(r: { id: string; handle: string; password_hash: string; created_at: string }): UserRecord {
  return { id: r.id, handle: r.handle, passwordHash: r.password_hash, createdAt: Number(r.created_at) };
}

/** Escapes LIKE wildcards so user search text matches literally. */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

export class PgHubStore implements HubStore {
  private constructor(private readonly pool: pg.Pool) {}

  /** Connects and brings the schema up to date. */
  static async connect(connectionString: string, opts: { ssl?: boolean } = {}): Promise<PgHubStore> {
    const pool = new pg.Pool({
      connectionString,
      max: 10,
      ssl: opts.ssl ? { rejectUnauthorized: false } : undefined,
    });
    const store = new PgHubStore(pool);
    await store.migrate();
    return store;
  }

  private async migrate() {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK]);
      await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
      const { rows } = await client.query<{ v: number | null }>('SELECT max(version) AS v FROM schema_migrations');
      const current = rows[0]?.v ?? 0;
      for (let v = current + 1; v <= MIGRATIONS.length; v++) {
        await client.query(MIGRATIONS[v - 1]);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [v]);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  /** Runs `fn` in a transaction. */
  private async tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async ping() {
    await this.pool.query('SELECT 1');
  }

  async findUserByHandle(handle: string) {
    const { rows } = await this.pool.query('SELECT * FROM users WHERE handle_lower = $1', [handle.toLowerCase()]);
    return rows[0] ? toUser(rows[0]) : undefined;
  }

  async getUser(id: string) {
    const { rows } = await this.pool.query('SELECT * FROM users WHERE id = $1', [id]);
    return rows[0] ? toUser(rows[0]) : undefined;
  }

  async addUser(user: UserRecord) {
    try {
      await this.pool.query(
        'INSERT INTO users (id, handle, handle_lower, password_hash, created_at) VALUES ($1, $2, $3, $4, $5)',
        [user.id, user.handle, user.handle.toLowerCase(), user.passwordHash, user.createdAt],
      );
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new DuplicateHandleError();
      throw e;
    }
  }

  async addSession(tokenHash: string, userId: string, createdAt: number) {
    await this.pool.query('DELETE FROM sessions WHERE created_at < $1', [Date.now() - SESSION_TTL_MS]);
    await this.pool.query('INSERT INTO sessions (token_hash, user_id, created_at) VALUES ($1, $2, $3)', [tokenHash, userId, createdAt]);
  }

  async findSessionUser(tokenHash: string) {
    const { rows } = await this.pool.query<{ user_id: string }>(
      'SELECT user_id FROM sessions WHERE token_hash = $1 AND created_at > $2',
      [tokenHash, Date.now() - SESSION_TTL_MS],
    );
    return rows[0]?.user_id;
  }

  async removeSession(tokenHash: string) {
    await this.pool.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
  }

  async listContent(q: ContentQuery) {
    // $1 viewer, $2 kind, $3 author, $4 search, $5 report threshold
    const where = `
      ($2::text IS NULL OR c.kind = $2)
      AND ($3::text IS NULL OR c.author_id = $3)
      AND ($4::text IS NULL OR c.search_text LIKE $4)
      AND (c.reports < $5 OR c.author_id = $1)`;
    const params = [q.viewerId, q.kind ?? null, q.authorId ?? null, q.q ? likePattern(q.q) : null, q.hideAtReports];
    const [list, count] = await Promise.all([
      this.pool.query<ContentRow>(
        `SELECT ${CONTENT_COLUMNS} FROM content c JOIN users u ON u.id = c.author_id
         WHERE ${where} ORDER BY ${SORT_SQL[q.sort] ?? SORT_SQL.new} LIMIT $6 OFFSET $7`,
        [...params, q.pageSize, (q.page - 1) * q.pageSize],
      ),
      this.pool.query<{ n: string }>(`SELECT count(*) AS n FROM content c WHERE ${where}`, params),
    ]);
    return { records: list.rows.map(toRecord), total: Number(count.rows[0].n) };
  }

  async getContent(id: string, viewerId: string | null) {
    const { rows } = await this.pool.query<ContentRow>(
      `SELECT ${CONTENT_COLUMNS} FROM content c JOIN users u ON u.id = c.author_id WHERE c.id = $2`,
      [viewerId, id],
    );
    return rows[0] ? toRecord(rows[0]) : undefined;
  }

  async createContent(c: NewContent, bundle: Bundle) {
    await this.pool.query(
      `INSERT INTO content (id, kind, name, description, tags, author_id, preview, bundle, search_text, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
      [c.id, c.kind, c.name, c.description, c.tags, c.authorId, JSON.stringify(c.preview), JSON.stringify(bundle), c.searchText, c.createdAt],
    );
  }

  async updateContent(id: string, f: ContentFields, bundle: Bundle, updatedAt: number) {
    await this.pool.query(
      `UPDATE content SET name = $2, description = $3, tags = $4, preview = $5, bundle = $6, search_text = $7,
         version = version + 1, updated_at = $8 WHERE id = $1`,
      [id, f.name, f.description, f.tags, JSON.stringify(f.preview), JSON.stringify(bundle), f.searchText, updatedAt],
    );
  }

  async removeContent(id: string) {
    await this.pool.query('DELETE FROM content WHERE id = $1', [id]);
  }

  async getBundle(id: string): Promise<Bundle | null> {
    const { rows } = await this.pool.query<{ bundle: Bundle }>('SELECT bundle FROM content WHERE id = $1', [id]);
    return rows[0]?.bundle ?? null;
  }

  async incrementDownloads(id: string) {
    const { rows } = await this.pool.query<{ downloads: number }>('UPDATE content SET downloads = downloads + 1 WHERE id = $1 RETURNING downloads', [id]);
    return rows[0]?.downloads ?? 0;
  }

  async toggleLike(id: string, userId: string) {
    return this.tx(async (c) => {
      const removed = await c.query('DELETE FROM likes WHERE content_id = $1 AND user_id = $2', [id, userId]);
      const liked = removed.rowCount === 0;
      if (liked) await c.query('INSERT INTO likes (content_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, userId]);
      const { rows } = await c.query<{ likes: number }>(
        'UPDATE content SET likes = (SELECT count(*) FROM likes WHERE content_id = $1) WHERE id = $1 RETURNING likes',
        [id],
      );
      return { liked, likes: rows[0]?.likes ?? 0 };
    });
  }

  async addReport(id: string, userId: string) {
    await this.tx(async (c) => {
      const res = await c.query('INSERT INTO reports (content_id, user_id, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [id, userId, Date.now()]);
      if (res.rowCount) await c.query('UPDATE content SET reports = reports + 1 WHERE id = $1', [id]);
    });
  }

  async close() {
    await this.pool.end();
  }
}
