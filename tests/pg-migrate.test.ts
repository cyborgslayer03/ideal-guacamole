// Several hub instances booting at once must not race on schema migrations.
// Runs only when HUB_TEST_DATABASE_URL points at a disposable database.

import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { PgHubStore } from '../server/pg-store';

const PG_URL = process.env.HUB_TEST_DATABASE_URL;

describe.skipIf(!PG_URL)('postgres migrations', () => {
  it('apply exactly once when instances start concurrently', async () => {
    // A private schema keeps this test apart from the hub suite running in parallel.
    const admin = new pg.Client({ connectionString: PG_URL });
    await admin.connect();
    await admin.query('DROP SCHEMA IF EXISTS migrate_test CASCADE; CREATE SCHEMA migrate_test');
    const url = new URL(PG_URL!);
    url.searchParams.set('options', '-c search_path=migrate_test');
    const stores = await Promise.all([1, 2, 3, 4].map(() => PgHubStore.connect(url.toString())));
    const { rows } = await admin.query('SELECT version FROM migrate_test.schema_migrations ORDER BY version');
    expect(rows.map((r) => r.version)).toEqual([1]);
    await Promise.all(stores.map((s) => s.close()));
    await admin.query('DROP SCHEMA migrate_test CASCADE');
    await admin.end();
  });
});
