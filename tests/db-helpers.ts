/**
 * Integration-test database helper.
 *
 * Creates a throwaway database on the PostgreSQL server named by
 * TEST_DATABASE_URL, ensures the Supabase roles (anon / authenticated /
 * service_role) exist, applies every file in supabase/migrations/ in order,
 * and drops the database again on close().
 *
 * When TEST_DATABASE_URL is not set, setupTestDatabase() returns null and the
 * caller skips loudly — the suite never silently pretends to have run.
 *
 * DATE columns are returned as raw 'YYYY-MM-DD' strings (pg type parser for
 * OID 1082), exactly like the PostgREST wire format the repositories expect.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client, types } from 'pg';

types.setTypeParser(1082, (value: string) => value);

export type PgRole = 'anon' | 'authenticated' | 'service_role';

export interface TestDb {
  dbName: string;
  client: Client;
  /** Run SQL, return rows. */
  q<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Run SQL, return the single first row. */
  one<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T>;
  /** Call an RPC: rpc('post_movement', '($1::uuid, $2::text, $3::date)', [...]) → the jsonb result. */
  rpc<T = Record<string, unknown>>(name: string, signature: string, params?: unknown[]): Promise<T>;
  /** Run fn on a separate connection acting as the given (non-superuser) role — RLS applies. */
  asRole<T>(role: PgRole, fn: (db: Pick<TestDb, 'q' | 'one' | 'rpc'>) => Promise<T>): Promise<T>;
  /** Drop the throwaway database and close every connection. */
  close(): Promise<void>;
}

function connectionStringFor(url: string, dbName: string): string {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

function makeHelpers(client: Client): Pick<TestDb, 'q' | 'one' | 'rpc'> {
  return {
    async q<T>(sql: string, params?: unknown[]): Promise<T[]> {
      const res = await client.query(sql, params);
      return res.rows as T[];
    },
    async one<T>(sql: string, params?: unknown[]): Promise<T> {
      const res = await client.query(sql, params);
      if (res.rows.length === 0) throw new Error(`no row returned by: ${sql}`);
      return res.rows[0] as T;
    },
    async rpc<T>(name: string, signature: string, params?: unknown[]): Promise<T> {
      const res = await client.query(`SELECT ${name}${signature} AS r`, params);
      return res.rows[0].r as T;
    },
  };
}

const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations');

/** Returns null (and prints why) when TEST_DATABASE_URL is not configured. */
export async function setupTestDatabase(label: string): Promise<TestDb | null> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    console.log(
      `\n${label}: SKIPPED — TEST_DATABASE_URL is not set.\n` +
        '  Point it at a local PostgreSQL 16 server, e.g.\n' +
        '    docker run -d --name fefo-test -e POSTGRES_PASSWORD=test -p 54329:5432 postgres:16\n' +
        '    TEST_DATABASE_URL=postgres://postgres:test@localhost:54329/postgres npx tsx tests/<file>.ts\n' +
        '  Nothing was tested. Do not treat this run as a pass.',
    );
    return null;
  }

  const dbName = `fefo_it_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  const maint = new Client({ connectionString: url });
  await maint.connect();
  await maint.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        CREATE ROLE anon NOLOGIN;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        CREATE ROLE authenticated NOLOGIN;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        CREATE ROLE service_role NOLOGIN;
      END IF;
    END $$;
  `);
  await maint.query(`CREATE DATABASE ${dbName}`);
  await maint.end();

  const client = new Client({ connectionString: connectionStringFor(url, dbName) });
  await client.connect();

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  if (files.length === 0) throw new Error(`no migrations found in ${MIGRATIONS_DIR}`);
  for (const f of files) {
    await client.query(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
  }
  console.log(`${label}: fresh database "${dbName}" created, migrations applied: ${files.join(', ')}`);

  let closed = false;
  const db: TestDb = {
    dbName,
    client,
    ...makeHelpers(client),
    async asRole<T>(role: PgRole, fn: (d: Pick<TestDb, 'q' | 'one' | 'rpc'>) => Promise<T>): Promise<T> {
      const roleClient = new Client({ connectionString: connectionStringFor(url, dbName) });
      await roleClient.connect();
      try {
        await roleClient.query(`SET ROLE ${role}`);
        return await fn(makeHelpers(roleClient));
      } finally {
        await roleClient.end();
      }
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await client.end();
      const m = new Client({ connectionString: url });
      await m.connect();
      await m.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await m.end();
    },
  };
  return db;
}

/** Insert a stock row directly (superuser connection — bypasses RLS by design).
 *  Also writes the INITIAL_IMPORT ledger row so stock_vs_ledger stays balanced,
 *  exactly like the initial_import RPC would. */
export async function seedStock(
  db: TestDb,
  row: {
    location: string;
    sku: string;
    batch?: string | null;
    expiry: string;
    qty: number;
    upp?: number;
    description?: string;
  },
  txDate = '2026-09-18',
): Promise<void> {
  await db.q(
    `INSERT INTO stock (location, sku, description, batch, expiry_date, quantity, upp)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [row.location, row.sku, row.description ?? '', row.batch ?? null, row.expiry, row.qty, row.upp ?? 48],
  );
  if (row.qty !== 0) {
    await db.q(
      `INSERT INTO stock_transactions
         (transaction_type, transaction_date, sku, location, batch, expiry_date,
          quantity_delta, reference_type, reference_id, notes, created_by)
       VALUES ('INITIAL_IMPORT', $1, $2, $3, $4, $5, $6, 'INITIAL_IMPORT', 'test-seed', 'seed', 'seed')`,
      [txDate, row.sku, row.location, row.batch ?? null, row.expiry, row.qty],
    );
  }
}

/** Current quantity of one physical identity (0 when the row does not exist). */
export async function qtyAt(
  db: Pick<TestDb, 'one'>,
  location: string,
  sku: string,
  batch: string | null,
  expiry: string,
): Promise<number> {
  const r = await db.one<{ q: number }>(
    `SELECT coalesce(sum(quantity), 0)::int AS q FROM stock
      WHERE location = $1 AND sku = $2 AND coalesce(batch, '') = $3 AND expiry_date = $4`,
    [location, sku, batch ?? '', expiry],
  );
  return r.q;
}
