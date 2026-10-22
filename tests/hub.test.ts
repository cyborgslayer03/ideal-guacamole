// End-to-end tests of the Multiverse Hub: a real HTTP server on a random port,
// driven through the same HubClient the game uses. The suite runs against the
// file store, and also against PostgreSQL when HUB_TEST_DATABASE_URL points at
// a disposable database (its tables are dropped first).

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateUniverse } from '../src/core/generator';
import { bundleCharacter, bundleUniverse, mergeBundle } from '../src/core/share';
import { emptyUniverse } from '../src/core/generator';
import { HubClient, HubError } from '../src/online/client';
import pg from 'pg';
import { createHub } from '../server/app';
import { PgHubStore } from '../server/pg-store';
import { FileHubStore, type HubStore } from '../server/store';

interface Backend {
  name: string;
  open(dir: string): Promise<HubStore>;
}

const PG_URL = process.env.HUB_TEST_DATABASE_URL;

async function resetPg(url: string) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query('DROP TABLE IF EXISTS reports, likes, content, sessions, users, schema_migrations CASCADE');
  await c.end();
}

const BACKENDS: Backend[] = [
  { name: 'file store', open: async (dir) => new FileHubStore(join(dir, 'data')) },
  ...(PG_URL ? [{ name: 'postgres', open: () => PgHubStore.connect(PG_URL) }] : []),
];

describe.each(BACKENDS)('hub on $name', (backend) => {
let dir: string;
let base: string;
let store: HubStore;
let close: () => Promise<void>;

function client(token: { value: string | null } = { value: null }) {
  return { c: new HubClient(`${base}/api`, () => token.value), token };
}

async function signedIn(handle: string) {
  const { c, token } = client();
  token.value = (await c.register(handle, 'correct-horse')).token;
  return c;
}

async function status(p: Promise<unknown>): Promise<number> {
  try {
    await p;
    return 200;
  } catch (e) {
    return e instanceof HubError ? e.status : -1;
  }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hub-test-'));
  const staticDir = join(dir, 'static');
  mkdirSync(staticDir);
  writeFileSync(join(staticDir, 'index.html'), '<h1>game</h1>');
  writeFileSync(join(dir, 'secret.txt'), 'nope');
  if (backend.name === 'postgres') await resetPg(PG_URL!);
  store = await backend.open(dir);
  const server = createHub({ store, staticDir, rateLimit: 10_000 });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise((r) => server.close(() => r()));
});

afterAll(async () => {
  await close();
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('accounts', () => {
  it('registers, rejects duplicates and bad passwords, and logs in', async () => {
    const { c } = client();
    const reg = await c.register('StarForger', 'correct-horse');
    expect(reg.user.handle).toBe('StarForger');
    expect(await status(c.register('starforger', 'another-pass'))).toBe(409);
    expect(await status(c.register('x', 'correct-horse'))).toBe(400);
    expect(await status(c.register('ShortPw', 'short'))).toBe(400);
    expect(await status(c.login('StarForger', 'wrong-password'))).toBe(401);
    const login = await c.login('starforger', 'correct-horse');
    const me = new HubClient(`${base}/api`, () => login.token);
    expect((await me.me()).handle).toBe('StarForger');
  });

  it('logging out invalidates the token', async () => {
    const c = await signedIn('Leaver');
    await c.logout();
    expect(await status(c.me())).toBe(401);
  });
});

describe('publishing and browsing', () => {
  it('requires sign-in and a valid, non-empty bundle', async () => {
    const anon = client().c;
    const u = generateUniverse(1);
    expect(await status(anon.publish({ bundle: bundleUniverse(u), description: '', tags: [] }))).toBe(401);
    const c = await signedIn('Validator');
    expect(await status(c.publish({ bundle: { hello: 'world' } as never, description: '', tags: [] }))).toBe(400);
    expect(await status(c.publish({ bundle: bundleUniverse(emptyUniverse()), description: '', tags: [] }))).toBe(400);
  });

  it('publishes, lists, searches, downloads, and likes', async () => {
    const author = await signedIn('Architect');
    const u = generateUniverse(2);
    const pub = await author.publish({ bundle: bundleUniverse(u), description: 'A city of neon gods.', tags: ['Neon', 'neon', 'Cyber Punk', '!!'] });
    expect(pub.tags).toEqual(['neon', 'cyber-punk']);
    expect(pub.preview.counts.characters).toBe(u.characters.length);
    const hero = u.characters[0];
    await author.publish({ bundle: bundleCharacter(u, hero.id)!, description: '', tags: [] });

    const anon = client().c;
    const characters = await anon.list({ kind: 'character' });
    expect(characters.items.every((i) => i.kind === 'character')).toBe(true);
    expect((await anon.list({ q: 'neon gods' })).items.map((i) => i.id)).toContain(pub.id);
    expect((await anon.list({ q: hero.alias.toLowerCase() })).items.length).toBeGreaterThan(0);

    const detail = await anon.get(pub.id);
    expect(detail.bundle.payload.characters).toHaveLength(u.characters.length);
    expect(detail.bundle.author).toBe('Architect');
    expect((await anon.countDownload(pub.id)).downloads).toBe(1);

    // A downloaded character merges into another universe with fresh ids.
    const charListing = characters.items.find((i) => i.name === hero.alias)!;
    const target = emptyUniverse();
    mergeBundle(target, (await anon.get(charListing.id)).bundle);
    expect(target.characters[0].alias).toBe(hero.alias);
    expect(target.characters[0].id).not.toBe(hero.id);

    const fan = await signedIn('Fan');
    expect(await fan.like(pub.id)).toEqual({ liked: true, likes: 1 });
    expect((await fan.list({ sort: 'top' })).items[0].liked).toBe(true);
    expect(await fan.like(pub.id)).toEqual({ liked: false, likes: 0 });
    expect(await status(anon.like(pub.id))).toBe(401);
  });

  it('only the creator can update or delete, and updates bump the version', async () => {
    const owner = await signedIn('Owner');
    const other = await signedIn('Other');
    const u = generateUniverse(3);
    const pub = await owner.publish({ bundle: bundleUniverse(u), description: 'v1', tags: [] });
    expect(await status(other.update(pub.id, { bundle: bundleUniverse(u), description: 'hijack', tags: [] }))).toBe(403);
    const updated = await owner.update(pub.id, { bundle: bundleUniverse(u), description: 'v2', tags: [] });
    expect(updated.version).toBe(2);
    expect(await status(owner.update(pub.id, { bundle: bundleCharacter(u, u.characters[0].id)!, description: '', tags: [] }))).toBe(400);
    expect(await status(other.remove(pub.id))).toBe(403);
    await owner.remove(pub.id);
    expect(await status(owner.get(pub.id))).toBe(404);
  });

  it('hides content after enough reports, except from its creator', async () => {
    const owner = await signedIn('Edgy');
    const pub = await owner.publish({ bundle: bundleUniverse(generateUniverse(4)), description: 'reported', tags: ['reportme'] });
    for (const h of ['ReporterA', 'ReporterB', 'ReporterC']) await (await signedIn(h)).report(pub.id);
    const anon = client().c;
    expect((await anon.list({ q: 'reportme' })).items).toHaveLength(0);
    expect((await owner.list({ q: 'reportme' })).items).toHaveLength(1);
  });

  it('persists across restarts', async () => {
    const reopened = await backend.open(dir);
    expect(await reopened.findUserByHandle('architect')).toBeDefined();
    const { total } = await reopened.listContent({ sort: 'new', page: 1, pageSize: 10, viewerId: null, hideAtReports: 3 });
    expect(total).toBeGreaterThan(0);
    await reopened.close();
  });

  it('treats search text literally and pages results', async () => {
    const c = await signedIn('Pager');
    for (let i = 0; i < 3; i++) await c.publish({ bundle: bundleUniverse(generateUniverse(100 + i)), description: `paged batch 100%_${i}`, tags: [] });
    expect((await c.list({ q: '100%_' })).total).toBe(3);
    expect((await c.list({ q: '%' })).items.every((i) => i.description.includes('%'))).toBe(true);
    expect((await c.list({ q: 'paged batch', page: 2 })).items).toHaveLength(0);
  });
});

describe('server hardening', () => {
  it('rejects oversized bodies', async () => {
    const res = await fetch(`${base}/api/auth/register`, { method: 'POST', body: 'x'.repeat(2_100_000) });
    expect(res.status).toBe(413);
  });

  it('serves the game but never files outside the static directory', async () => {
    expect(await (await fetch(`${base}/`)).text()).toContain('game');
    const escape = await fetch(`${base}/..%2Fsecret.txt`);
    expect(await escape.text()).not.toContain('nope');
  });

  it('rate limits writes', async () => {
    const server = createHub({ store: new FileHubStore(join(dir, 'rl')), rateLimit: 25 });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/auth/login`;
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) codes.push((await fetch(url, { method: 'POST', body: '{}' })).status);
    await new Promise((r) => server.close(() => r(null)));
    expect(codes).toContain(429);
  });
});
});
