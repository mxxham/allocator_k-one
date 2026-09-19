/**
 * Database integration tests — run against a real PostgreSQL 16 server.
 *
 *   TEST_DATABASE_URL=postgres://postgres:test@localhost:54329/postgres \
 *     npx tsx tests/db-integration.test.ts
 *
 * Skips loudly (exit 0, nothing claimed as tested) when TEST_DATABASE_URL is
 * not set. Each run creates a throwaway database, applies every migration in
 * supabase/migrations/ from scratch (proving reproducibility) and drops it.
 */

import { setupTestDatabase, seedStock, qtyAt, type TestDb } from './db-helpers.js';
import { describe, it, eq, ok, gt, expectErr, summary } from './harness.js';

const ACTOR = 'integration-test';
const TODAY = '2026-09-18';

const db: TestDb | null = await setupTestDatabase('db-integration');
if (!db) process.exit(0);

async function insertWave(waveNo: string, plannedDate = TODAY): Promise<string> {
  const r = await db!.one<{ id: string }>(
    `INSERT INTO waves (wave_no, planned_date, destination, planned_slot)
     VALUES ($1, $2, 'TEST DEST', '08:00') RETURNING id`,
    [waveNo, plannedDate],
  );
  return r.id;
}

async function insertMovement(m: {
  waveId?: string | null;
  type: string;
  sku: string;
  source: string;
  destination?: string | null;
  batch?: string | null;
  expiry: string;
  qty: number;
  seq?: number;
}): Promise<string> {
  const r = await db!.one<{ id: string }>(
    `INSERT INTO movements
       (wave_id, movement_type, sku, source_location, destination_location, batch, expiry_date, quantity, seq)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [m.waveId ?? null, m.type, m.sku, m.source, m.destination ?? null, m.batch ?? null, m.expiry, m.qty, m.seq ?? null],
  );
  return r.id;
}

async function status(table: string, id: string): Promise<string> {
  const r = await db!.one<{ status: string }>(`SELECT status FROM ${table} WHERE id = $1`, [id]);
  return r.status;
}

async function txCount(identity: string, type?: string): Promise<number> {
  const r = await db!.one<{ n: number }>(
    `SELECT count(*)::int AS n FROM stock_transactions
      WHERE identity_key = $1 ${type ? `AND transaction_type = '${type}'` : ''}`,
    [identity],
  );
  return r.n;
}

try {
  // ── 1. schema ─────────────────────────────────────────────────────────────
  describe('Schema created from migrations');
  await it('all 7 tables + stock_vs_ledger view exist', async () => {
    const tables = await db.q<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
    );
    const names = tables.map((t) => t.table_name);
    for (const t of ['execution_events', 'inbound', 'movements', 'outbound', 'stock', 'stock_transactions', 'waves']) {
      ok(names.includes(t), `table ${t} exists`);
    }
    const view = await db.q(
      `SELECT 1 FROM information_schema.views WHERE table_schema='public' AND table_name='stock_vs_ledger'`,
    );
    eq(view.length, 1, 'stock_vs_ledger view exists');
  });

  // ── 2. physical identity ──────────────────────────────────────────────────
  describe('Physical identity = location + sku + batch + expiry');
  await it('two expiry dates at the same location stay separate rows', async () => {
    await seedStock(db, { location: 'CC21A02', sku: '550076636', batch: '05I26JJ', expiry: '2030-09-01', qty: 10 });
    await seedStock(db, { location: 'CC21A02', sku: '550076636', batch: '05I26JJ', expiry: '2030-09-04', qty: 20 });
    const rows = await db.q<{ identity_key: string; quantity: number }>(
      `SELECT identity_key, quantity FROM stock WHERE sku = '550076636' ORDER BY expiry_date`,
    );
    eq(rows.length, 2, 'two separate rows');
    eq(rows[0].identity_key, 'CC21A02|550076636|05I26JJ|2030-09-01', 'identity_key format mirrors stockIdentityKey()');
    eq(rows[0].quantity, 10, 'first expiry qty');
    eq(rows[1].identity_key, 'CC21A02|550076636|05I26JJ|2030-09-04', 'second expiry identity');
    eq(rows[1].quantity, 20, 'second expiry qty');
  });

  await it('duplicate identity insert is rejected (unique violation)', async () => {
    await expectErr(
      () => seedStock(db, { location: 'CC21A02', sku: '550076636', batch: '05I26JJ', expiry: '2030-09-01', qty: 5 }),
      'ux_stock_identity',
      'duplicate physical identity rejected',
    );
  });

  await it('null batch uses empty segment and is unique too', async () => {
    await seedStock(db, { location: 'CC99B01', sku: 'NULLBATCH', batch: null, expiry: '2031-01-01', qty: 7 });
    const r = await db.one<{ identity_key: string }>(
      `SELECT identity_key FROM stock WHERE sku = 'NULLBATCH'`,
    );
    eq(r.identity_key, 'CC99B01|NULLBATCH||2031-01-01', 'null batch → empty segment');
    await expectErr(
      () => seedStock(db, { location: 'CC99B01', sku: 'NULLBATCH', batch: null, expiry: '2031-01-01', qty: 1 }),
      'ux_stock_identity',
      'duplicate null-batch identity rejected',
    );
  });

  // ── 3. initial_import ─────────────────────────────────────────────────────
  describe('initial_import RPC');
  await it('imports rows, skips zero quantities, writes INITIAL_IMPORT ledger', async () => {
    const res = await db.rpc<{ result: string; imported: number; skipped_zero_qty: number }>(
      'initial_import',
      '($1::jsonb, $2::text, $3::text, $4::date)',
      [
        JSON.stringify([
          { location: 'CC10A01', sku: 'IMP1', description: 'Import one', batch: 'B1', expiry_date: '2030-05-01', quantity: 48, upp: 48 },
          { location: 'CC10A02', sku: 'IMP2', description: 'Import two', batch: null, expiry_date: '2030-06-01', quantity: 12, upp: 48 },
          { location: 'CC10A03', sku: 'IMP3', description: 'Empty bin', batch: 'B3', expiry_date: '2030-07-01', quantity: 0 },
        ]),
        ACTOR,
        'FAIL_ON_CONFLICT',
        TODAY,
      ],
    );
    eq(res.result, 'IMPORTED', 'result IMPORTED');
    eq(res.imported, 2, 'two rows imported');
    eq(res.skipped_zero_qty, 1, 'zero-qty row skipped');
    eq(await qtyAt(db, 'CC10A01', 'IMP1', 'B1', '2030-05-01'), 48, 'IMP1 qty');
    eq(await qtyAt(db, 'CC10A03', 'IMP3', 'B3', '2030-07-01'), 0, 'empty bin not created');
    eq(await txCount('CC10A01|IMP1|B1|2030-05-01', 'INITIAL_IMPORT'), 1, 'ledger row written');
    const full = await db.one<{ is_full_pallet: boolean }>(`SELECT is_full_pallet FROM stock WHERE sku='IMP1'`);
    eq(full.is_full_pallet, true, 'is_full_pallet computed (48 >= upp 48)');
  });

  await it('re-import in FAIL_ON_CONFLICT aborts with PHYSICAL_IDENTITY_CONFLICT', async () => {
    await expectErr(
      () =>
        db!.rpc('initial_import', '($1::jsonb, $2::text, $3::text, $4::date)', [
          JSON.stringify([{ location: 'CC10A01', sku: 'IMP1', batch: 'B1', expiry_date: '2030-05-01', quantity: 48 }]),
          ACTOR,
          'FAIL_ON_CONFLICT',
          TODAY,
        ]),
      'PHYSICAL_IDENTITY_CONFLICT',
      'conflict raises readable code',
    );
    eq(await qtyAt(db, 'CC10A01', 'IMP1', 'B1', '2030-05-01'), 48, 'stock unchanged after aborted import');
  });

  await it('REPLACE mode sets the quantity and writes the difference to the ledger', async () => {
    const res = await db.rpc<{ replaced: number }>('initial_import', '($1::jsonb, $2::text, $3::text, $4::date)', [
      JSON.stringify([{ location: 'CC10A01', sku: 'IMP1', batch: 'B1', expiry_date: '2030-05-01', quantity: 40 }]),
      ACTOR,
      'REPLACE',
      TODAY,
    ]);
    eq(res.replaced, 1, 'one row replaced');
    eq(await qtyAt(db, 'CC10A01', 'IMP1', 'B1', '2030-05-01'), 40, 'quantity replaced');
    const diff = await db.one<{ d: number }>(
      `SELECT quantity_delta AS d FROM stock_transactions
        WHERE identity_key = 'CC10A01|IMP1|B1|2030-05-01' AND notes = 'REPLACE mode'`,
    );
    eq(diff.d, -8, 'difference (-8) written to the ledger — history still explains the balance');
  });

  await it('duplicate identities inside the payload are rejected', async () => {
    await expectErr(
      () =>
        db!.rpc('initial_import', '($1::jsonb, $2::text, $3::text, $4::date)', [
          JSON.stringify([
            { location: 'CC10B01', sku: 'DUP', batch: 'B', expiry_date: '2030-05-01', quantity: 5 },
            { location: 'CC10B01', sku: 'DUP', batch: 'B', expiry_date: '2030-05-01', quantity: 6 },
          ]),
          ACTOR,
          'FAIL_ON_CONFLICT',
          TODAY,
        ]),
      'DUPLICATE_IDENTITY',
      'payload duplicates rejected',
    );
    eq(await qtyAt(db, 'CC10B01', 'DUP', 'B', '2030-05-01'), 0, 'nothing written');
  });

  await it('negative quantities are rejected', async () => {
    await expectErr(
      () =>
        db!.rpc('initial_import', '($1::jsonb, $2::text, $3::text, $4::date)', [
          JSON.stringify([{ location: 'CC10B02', sku: 'NEG', batch: 'B', expiry_date: '2030-05-01', quantity: -3 }]),
          ACTOR,
          'FAIL_ON_CONFLICT',
          TODAY,
        ]),
      'VALIDATION_ERROR',
      'negative quantity rejected',
    );
  });

  // ── 4. inbound ────────────────────────────────────────────────────────────
  describe('Inbound posting (PENDING → COMPLETED, +qty once)');
  await it('post_inbound adds stock once; double post is a no-op', async () => {
    const r = await db.one<{ id: string }>(
      `INSERT INTO inbound (inbound_date, reference_no, sku, description, location, batch, expiry_date, quantity, upp)
       VALUES ($1, 'GR-001', 'INB1', 'Inbound one', 'CC20A01', 'BI', '2030-08-01', 24, 48) RETURNING id`,
      [TODAY],
    );
    eq(await status('inbound', r.id), 'PENDING', 'created PENDING');
    eq(await qtyAt(db, 'CC20A01', 'INB1', 'BI', '2030-08-01'), 0, 'PENDING inbound does not touch stock');

    const res1 = await db.rpc<{ result: string }>('post_inbound', '($1::uuid, $2::text, $3::date)', [r.id, ACTOR, TODAY]);
    eq(res1.result, 'POSTED', 'first post POSTED');
    eq(await qtyAt(db, 'CC20A01', 'INB1', 'BI', '2030-08-01'), 24, 'stock +24');
    eq(await status('inbound', r.id), 'COMPLETED', 'status COMPLETED');

    const res2 = await db.rpc<{ result: string }>('post_inbound', '($1::uuid, $2::text, $3::date)', [r.id, ACTOR, TODAY]);
    eq(res2.result, 'ALREADY_POSTED', 'second post ALREADY_POSTED');
    eq(await qtyAt(db, 'CC20A01', 'INB1', 'BI', '2030-08-01'), 24, 'stock still 24 — posted twice, changed once');
    eq(await txCount('CC20A01|INB1|BI|2030-08-01', 'INBOUND'), 1, 'exactly one INBOUND ledger row');
  });

  await it('duplicate reference_no is rejected', async () => {
    await expectErr(
      () =>
        db!.q(
          `INSERT INTO inbound (reference_no, sku, location, expiry_date, quantity)
           VALUES ('GR-001', 'INB1', 'CC20A01', '2030-08-01', 5)`,
        ),
      'ux_inbound_reference',
      'duplicate reference rejected',
    );
  });

  // ── 5. outbound ───────────────────────────────────────────────────────────
  describe('Outbound posting (PLANNED → COMPLETED, −qty once)');
  await it('MANUAL outbound deducts stock once; double post is a no-op', async () => {
    const r = await db.one<{ id: string }>(
      `INSERT INTO outbound (outbound_date, shipment_number, sku, location, batch, expiry_date, quantity, origin)
       VALUES ($1, 'SHP-1', 'INB1', 'CC20A01', 'BI', '2030-08-01', 10, 'MANUAL') RETURNING id`,
      [TODAY],
    );
    eq(await qtyAt(db, 'CC20A01', 'INB1', 'BI', '2030-08-01'), 24, 'PLANNED outbound does not touch stock');
    const res1 = await db.rpc<{ result: string }>('post_outbound', '($1::uuid, $2::text, $3::date)', [r.id, ACTOR, TODAY]);
    eq(res1.result, 'POSTED', 'posted');
    eq(await qtyAt(db, 'CC20A01', 'INB1', 'BI', '2030-08-01'), 14, 'stock −10');
    const res2 = await db.rpc<{ result: string }>('post_outbound', '($1::uuid, $2::text, $3::date)', [r.id, ACTOR, TODAY]);
    eq(res2.result, 'ALREADY_POSTED', 'idempotent');
    eq(await qtyAt(db, 'CC20A01', 'INB1', 'BI', '2030-08-01'), 14, 'stock unchanged on second post');
  });

  await it('insufficient stock raises INSUFFICIENT_STOCK and changes nothing', async () => {
    const r = await db.one<{ id: string }>(
      `INSERT INTO outbound (shipment_number, sku, location, batch, expiry_date, quantity, origin)
       VALUES ('SHP-2', 'INB1', 'CC20A01', 'BI', '2030-08-01', 999, 'MANUAL') RETURNING id`,
    );
    const err = await expectErr(
      () => db!.rpc('post_outbound', '($1::uuid, $2::text, $3::date)', [r.id, ACTOR, TODAY]),
      'INSUFFICIENT_STOCK',
      'insufficient stock raises readable code',
    );
    ok(err.message.includes('available=14'), 'message carries the available quantity');
    eq(await qtyAt(db, 'CC20A01', 'INB1', 'BI', '2030-08-01'), 14, 'stock unchanged');
    eq(await status('outbound', r.id), 'PLANNED', 'still PLANNED');
  });

  await it('ALLOCATION-origin outbound can never be posted directly (no double deduction)', async () => {
    const r = await db.one<{ id: string }>(
      `INSERT INTO outbound (shipment_number, sku, location, batch, expiry_date, quantity, origin)
       VALUES ('SHP-3', 'INB1', 'CC20A01', 'BI', '2030-08-01', 2, 'ALLOCATION') RETURNING id`,
    );
    await expectErr(
      () => db!.rpc('post_outbound', '($1::uuid, $2::text, $3::date)', [r.id, ACTOR, TODAY]),
      'OUTBOUND_POSTED_VIA_MOVEMENTS',
      'allocation outbound rejected by post_outbound',
    );
    eq(await qtyAt(db, 'CC20A01', 'INB1', 'BI', '2030-08-01'), 14, 'stock unchanged');
  });

  await it('outbound without location/expiry raises OUTBOUND_IDENTITY_REQUIRED', async () => {
    const r = await db.one<{ id: string }>(
      `INSERT INTO outbound (shipment_number, sku, quantity, origin) VALUES ('SHP-4', 'INB1', 1, 'MANUAL') RETURNING id`,
    );
    await expectErr(
      () => db!.rpc('post_outbound', '($1::uuid, $2::text, $3::date)', [r.id, ACTOR, TODAY]),
      'OUTBOUND_IDENTITY_REQUIRED',
      'missing identity rejected',
    );
  });

  // ── 6. movements ──────────────────────────────────────────────────────────
  describe('Movement posting');
  await it('PICK deducts source once; double post is idempotent', async () => {
    await seedStock(db, { location: 'CC30C01', sku: 'PCK1', batch: 'BP', expiry: '2030-09-02', qty: 48 });
    const m = await insertMovement({ type: 'PICK', sku: 'PCK1', source: 'CC30C01', batch: 'BP', expiry: '2030-09-02', qty: 41 });
    const res1 = await db.rpc<{ result: string }>('post_movement', '($1::uuid, $2::text, $3::date)', [m, ACTOR, TODAY]);
    eq(res1.result, 'POSTED', 'posted');
    eq(await qtyAt(db, 'CC30C01', 'PCK1', 'BP', '2030-09-02'), 7, 'source 48 − 41 = 7');
    const res2 = await db.rpc<{ result: string }>('post_movement', '($1::uuid, $2::text, $3::date)', [m, ACTOR, TODAY]);
    eq(res2.result, 'ALREADY_POSTED', 'second post no-op');
    eq(await qtyAt(db, 'CC30C01', 'PCK1', 'BP', '2030-09-02'), 7, 'stock unchanged');
    eq(await txCount('CC30C01|PCK1|BP|2030-09-02', 'PICK'), 1, 'exactly one PICK ledger row');
    eq(await status('movements', m), 'COMPLETED', 'movement COMPLETED');
  });

  await it('REPLENISH moves stock atomically (source −qty, destination +qty, two ledger rows)', async () => {
    await seedStock(db, { location: 'CC30E01', sku: 'REP1', batch: 'BR', expiry: '2030-09-02', qty: 37 });
    const m = await insertMovement({
      type: 'REPLENISH', sku: 'REP1', source: 'CC30E01', destination: 'CC21A02',
      batch: 'BR', expiry: '2030-09-02', qty: 37,
    });
    const res = await db.rpc<{ result: string }>('post_movement', '($1::uuid, $2::text, $3::date)', [m, ACTOR, TODAY]);
    eq(res.result, 'POSTED', 'posted');
    eq(await qtyAt(db, 'CC30E01', 'REP1', 'BR', '2030-09-02'), 0, 'source drained');
    eq(await qtyAt(db, 'CC21A02', 'REP1', 'BR', '2030-09-02'), 37, 'destination received all 37');
    eq(await txCount('CC30E01|REP1|BR|2030-09-02', 'RELOC_OUT'), 1, 'RELOC_OUT ledger row');
    eq(await txCount('CC21A02|REP1|BR|2030-09-02', 'RELOC_IN'), 1, 'RELOC_IN ledger row');
  });

  await it('REPLENISH with insufficient source rolls back completely — destination untouched', async () => {
    await seedStock(db, { location: 'CC30F01', sku: 'REP2', batch: 'BX', expiry: '2030-09-02', qty: 5 });
    const m = await insertMovement({
      type: 'REPLENISH', sku: 'REP2', source: 'CC30F01', destination: 'CC21B02',
      batch: 'BX', expiry: '2030-09-02', qty: 9,
    });
    await expectErr(
      () => db!.rpc('post_movement', '($1::uuid, $2::text, $3::date)', [m, ACTOR, TODAY]),
      'INSUFFICIENT_STOCK',
      'insufficient source raises',
    );
    eq(await qtyAt(db, 'CC30F01', 'REP2', 'BX', '2030-09-02'), 5, 'source unchanged');
    eq(await qtyAt(db, 'CC21B02', 'REP2', 'BX', '2030-09-02'), 0, 'destination row never created');
    eq(await status('movements', m), 'PLANNED', 'movement still PLANNED');
    eq(await txCount('CC30F01|REP2|BX|2030-09-02', 'RELOC_OUT'), 0, 'no partial ledger rows');
  });

  // ── 7. status transitions ─────────────────────────────────────────────────
  describe('Status transitions never bypass stock posting');
  await it('RESCHEDULED movement cannot be posted; reactivated one can', async () => {
    await seedStock(db, { location: 'CC31A01', sku: 'SCH1', batch: 'BS', expiry: '2030-09-02', qty: 10 });
    const m = await insertMovement({ type: 'PICK', sku: 'SCH1', source: 'CC31A01', batch: 'BS', expiry: '2030-09-02', qty: 4 });
    await db.rpc('set_movement_status', '($1::uuid, $2::text, $3::text, $4::text)', [m, 'RESCHEDULED', ACTOR, 'truck late']);
    eq(await status('movements', m), 'RESCHEDULED', 'rescheduled');
    await expectErr(
      () => db!.rpc('post_movement', '($1::uuid, $2::text, $3::date)', [m, ACTOR, TODAY]),
      'MOVEMENT_NOT_EXECUTABLE',
      'rescheduled movement cannot post',
    );
    eq(await qtyAt(db, 'CC31A01', 'SCH1', 'BS', '2030-09-02'), 10, 'rescheduling did not touch stock');
    await db.rpc('set_movement_status', '($1::uuid, $2::text, $3::text, $4::text)', [m, 'PLANNED', ACTOR, 'reactivated']);
    const res = await db.rpc<{ result: string }>('post_movement', '($1::uuid, $2::text, $3::date)', [m, ACTOR, TODAY]);
    eq(res.result, 'POSTED', 'reactivated movement posts');
    eq(await qtyAt(db, 'CC31A01', 'SCH1', 'BS', '2030-09-02'), 6, 'stock deducted exactly once');

    const events = await db.q<{ from_status: string | null; to_status: string }>(
      `SELECT from_status, to_status FROM execution_events WHERE entity_id = $1 ORDER BY occurred_at`,
      [m],
    );
    eq(events.length, 3, 'every transition kept in the audit trail');
    eq(events[0].to_status, 'RESCHEDULED', 'PLANNED → RESCHEDULED');
    eq(events[1].to_status, 'PLANNED', 'RESCHEDULED → PLANNED');
    eq(events[2].to_status, 'COMPLETED', 'PLANNED → COMPLETED');
  });

  await it('set_movement_status refuses COMPLETED (must go through post_movement)', async () => {
    const m = await insertMovement({ type: 'PICK', sku: 'SCH1', source: 'CC31A01', batch: 'BS', expiry: '2030-09-02', qty: 1 });
    await expectErr(
      () => db!.rpc('set_movement_status', '($1::uuid, $2::text, $3::text, $4::text)', [m, 'COMPLETED', ACTOR, null]),
      'USE_POST_MOVEMENT',
      'COMPLETED via status change rejected',
    );
  });

  // ── 8. waves ──────────────────────────────────────────────────────────────
  describe('Wave execution');
  await it('complete_wave posts every movement, completes ALLOCATION outbound, is idempotent', async () => {
    await seedStock(db, { location: 'CC40A01', sku: 'WV1', batch: 'BW', expiry: '2030-09-02', qty: 20 });
    const w = await insertWave('W-100');
    const m1 = await insertMovement({ waveId: w, type: 'PICK', sku: 'WV1', source: 'CC40A01', batch: 'BW', expiry: '2030-09-02', qty: 6, seq: 1 });
    const m2 = await insertMovement({ waveId: w, type: 'PICK', sku: 'WV1', source: 'CC40A01', batch: 'BW', expiry: '2030-09-02', qty: 4, seq: 2 });
    const ob = await db.one<{ id: string }>(
      `INSERT INTO outbound (outbound_date, shipment_number, wave_id, wave_no, sku, quantity, origin)
       VALUES ($1, 'SHP-W1', $2, 'W-100', 'WV1', 10, 'ALLOCATION') RETURNING id`,
      [TODAY, w],
    );
    const res = await db.rpc<{ result: string; movements_posted: number; outbound_completed: number }>(
      'complete_wave', '($1::uuid, $2::text, $3::date)', [w, ACTOR, TODAY],
    );
    eq(res.result, 'POSTED', 'wave posted');
    eq(res.movements_posted, 2, 'both movements posted');
    eq(res.outbound_completed, 1, 'ALLOCATION outbound completed');
    eq(await qtyAt(db, 'CC40A01', 'WV1', 'BW', '2030-09-02'), 10, 'stock 20 − 6 − 4 = 10');
    eq(await status('movements', m1), 'COMPLETED', 'm1 completed');
    eq(await status('movements', m2), 'COMPLETED', 'm2 completed');
    eq(await status('outbound', ob.id), 'COMPLETED', 'outbound completed');
    eq(await status('waves', w), 'COMPLETED', 'wave completed');

    const res2 = await db.rpc<{ result: string }>('complete_wave', '($1::uuid, $2::text, $3::date)', [w, ACTOR, TODAY]);
    eq(res2.result, 'ALREADY_POSTED', 'second complete_wave is a no-op');
    eq(await qtyAt(db, 'CC40A01', 'WV1', 'BW', '2030-09-02'), 10, 'stock unchanged');
  });

  await it('partial execution: pre-posted + rescheduled movements complete the wave without corrupting stock', async () => {
    await seedStock(db, { location: 'CC41A01', sku: 'WV2', batch: 'BW', expiry: '2030-09-02', qty: 20 });
    const w = await insertWave('W-200');
    const a = await insertMovement({ waveId: w, type: 'PICK', sku: 'WV2', source: 'CC41A01', batch: 'BW', expiry: '2030-09-02', qty: 5, seq: 1 });
    const b = await insertMovement({ waveId: w, type: 'PICK', sku: 'WV2', source: 'CC41A01', batch: 'BW', expiry: '2030-09-02', qty: 7, seq: 2 });
    await db.rpc('post_movement', '($1::uuid, $2::text, $3::date)', [a, ACTOR, TODAY]);
    await db.rpc('set_movement_status', '($1::uuid, $2::text, $3::text, $4::text)', [b, 'RESCHEDULED', ACTOR, 'damaged cartons']);
    const res = await db.rpc<{ result: string; movements_posted: number }>(
      'complete_wave', '($1::uuid, $2::text, $3::date)', [w, ACTOR, TODAY],
    );
    eq(res.result, 'POSTED', 'wave completes');
    eq(res.movements_posted, 0, 'nothing left to post');
    eq(await qtyAt(db, 'CC41A01', 'WV2', 'BW', '2030-09-02'), 15, 'only movement A affected stock');
    eq(await status('movements', a), 'COMPLETED', 'A completed');
    eq(await status('movements', b), 'RESCHEDULED', 'B stays rescheduled');
    eq(await status('waves', w), 'COMPLETED', 'wave completed');
  });

  await it('rescheduled wave refuses completion until reactivated; cancel cascades to movements', async () => {
    await seedStock(db, { location: 'CC42A01', sku: 'WV3', batch: 'BW', expiry: '2030-09-02', qty: 9 });
    const w = await insertWave('W-300');
    const m = await insertMovement({ waveId: w, type: 'PICK', sku: 'WV3', source: 'CC42A01', batch: 'BW', expiry: '2030-09-02', qty: 3 });
    await db.rpc('set_wave_status', '($1::uuid, $2::text, $3::text, $4::text, $5::text, $6::date)', [w, 'RESCHEDULED', ACTOR, 'truck moved', '14:00', null]);
    await expectErr(
      () => db!.rpc('complete_wave', '($1::uuid, $2::text, $3::date)', [w, ACTOR, TODAY]),
      'WAVE_RESCHEDULED',
      'rescheduled wave cannot complete',
    );
    const slot = await db.one<{ planned_slot: string }>(`SELECT planned_slot FROM waves WHERE id = $1`, [w]);
    eq(slot.planned_slot, '14:00', 'new slot recorded');
    await db.rpc('set_wave_status', '($1::uuid, $2::text, $3::text, $4::text, $5::text, $6::date)', [w, 'PENDING', ACTOR, 'reactivated', null, null]);
    const res = await db.rpc<{ result: string }>('complete_wave', '($1::uuid, $2::text, $3::date)', [w, ACTOR, TODAY]);
    eq(res.result, 'POSTED', 'reactivated wave completes');
    eq(await qtyAt(db, 'CC42A01', 'WV3', 'BW', '2030-09-02'), 6, 'stock deducted once');

    const w2 = await insertWave('W-301');
    const m2 = await insertMovement({ waveId: w2, type: 'PICK', sku: 'WV3', source: 'CC42A01', batch: 'BW', expiry: '2030-09-02', qty: 2 });
    const cancel = await db.rpc<{ movements_cancelled: number }>(
      'set_wave_status', '($1::uuid, $2::text, $3::text, $4::text, $5::text, $6::date)', [w2, 'CANCELLED', ACTOR, 'order dropped', null, null],
    );
    eq(cancel.movements_cancelled, 1, 'planned movement cancelled with the wave');
    eq(await status('movements', m2), 'CANCELLED', 'movement CANCELLED');
    await expectErr(
      () => db!.rpc('post_movement', '($1::uuid, $2::text, $3::date)', [m2, ACTOR, TODAY]),
      'MOVEMENT_NOT_EXECUTABLE',
      'cancelled movement can never post',
    );
    eq(await qtyAt(db, 'CC42A01', 'WV3', 'BW', '2030-09-02'), 6, 'cancellation did not touch stock');
  });

  // ── 9. adjustments ────────────────────────────────────────────────────────
  describe('Controlled adjustments');
  await it('adjust_stock requires reason and actor, refuses zero and negative results', async () => {
    await seedStock(db, { location: 'CC50A01', sku: 'ADJ1', batch: 'BA', expiry: '2030-09-02', qty: 10 });
    const sig = '($1::text, $2::text, $3::text, $4::date, $5::int, $6::text, $7::text, $8::date)';
    await expectErr(
      () => db!.rpc('adjust_stock', sig, ['CC50A01', 'ADJ1', 'BA', '2030-09-02', -2, '', ACTOR, TODAY]),
      'REASON_REQUIRED',
      'reason required',
    );
    await expectErr(
      () => db!.rpc('adjust_stock', sig, ['CC50A01', 'ADJ1', 'BA', '2030-09-02', -2, 'cycle count', '', TODAY]),
      'ACTOR_REQUIRED',
      'actor required',
    );
    await expectErr(
      () => db!.rpc('adjust_stock', sig, ['CC50A01', 'ADJ1', 'BA', '2030-09-02', 0, 'noop', ACTOR, TODAY]),
      'ZERO_ADJUSTMENT',
      'zero delta rejected',
    );
    await expectErr(
      () => db!.rpc('adjust_stock', sig, ['CC50A01', 'ADJ1', 'BA', '2030-09-02', -11, 'too much', ACTOR, TODAY]),
      'INSUFFICIENT_STOCK',
      'negative result rejected',
    );
    eq(await qtyAt(db, 'CC50A01', 'ADJ1', 'BA', '2030-09-02'), 10, 'stock untouched by rejected adjustments');

    const res = await db.rpc<{ result: string; new_quantity: number }>(
      'adjust_stock', sig, ['CC50A01', 'ADJ1', 'BA', '2030-09-02', -3, 'cycle count', ACTOR, TODAY],
    );
    eq(res.result, 'ADJUSTED', 'valid adjustment applied');
    eq(res.new_quantity, 7, 'new quantity 7');
    eq(await txCount('CC50A01|ADJ1|BA|2030-09-02', 'ADJUSTMENT'), 1, 'ADJUSTMENT ledger row written');
  });

  await it('direct negative quantity is impossible (CHECK constraint)', async () => {
    await expectErr(
      () => db!.q(`UPDATE stock SET quantity = -1 WHERE sku = 'ADJ1'`),
      '23514',
      'CHECK (quantity >= 0) blocks negative stock even for superusers',
    );
  });

  // ── 10. reconciliation ────────────────────────────────────────────────────
  describe('Reconciliation');
  await it('stock_vs_ledger shows zero mismatch on every identity', async () => {
    const bad = await db.q<{ identity_key: string; mismatch: number }>(
      `SELECT identity_key, mismatch FROM stock_vs_ledger WHERE mismatch <> 0`,
    );
    eq(bad.length, 0, `no mismatches (found ${JSON.stringify(bad)})`);
  });

  await it('daily_summary closing quantity equals current stock', async () => {
    const rows = await db.q<{ identity_key: string; closing_qty: string }>(`SELECT * FROM daily_summary($1::date)`, [TODAY]);
    gt(rows.length, 0, 'summary has rows');
    for (const r of rows) {
      const s = await db.one<{ quantity: number }>(`SELECT quantity FROM stock WHERE identity_key = $1`, [r.identity_key]);
      eq(Number(r.closing_qty), s.quantity, `closing qty for ${r.identity_key}`);
    }
  });

  // ── 11. RLS ───────────────────────────────────────────────────────────────
  describe('Row Level Security as anon (publishable-key client)');
  await it('anon can read stock and ledger', async () => {
    await db.asRole('anon', async (anon) => {
      const s = await anon.q(`SELECT id FROM stock LIMIT 1`);
      gt(s.length, 0, 'stock readable');
      const t = await anon.q(`SELECT id FROM stock_transactions LIMIT 1`);
      gt(t.length, 0, 'ledger readable');
    });
  });

  await it('anon cannot delete or alter ledger rows', async () => {
    await db.asRole('anon', async (anon) => {
      await expectErr(() => anon.q(`DELETE FROM stock_transactions`), '42501', 'DELETE on ledger denied');
      // GRANT UPDATE exists, but RLS has no UPDATE policy on the ledger:
      // the statement sees zero rows and changes nothing.
      const upd = await anon.q(`UPDATE stock_transactions SET quantity_delta = 999999 RETURNING id`);
      eq(upd.length, 0, 'UPDATE on ledger matches no rows under RLS');
    });
    const intact = await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM stock_transactions WHERE quantity_delta = 999999`);
    eq(intact.n, 0, 'ledger untouched');
  });

  await it('anon cannot write stock directly — only RPCs move quantities', async () => {
    await db.asRole('anon', async (anon) => {
      await expectErr(
        () =>
          anon.q(
            `INSERT INTO stock (location, sku, expiry_date, quantity, identity_key)
             VALUES ('HACK01', 'EVIL', '2030-01-01', 999, 'x')`,
          ),
        '42501',
        'INSERT into stock denied',
      );
      const upd = await anon.q(`UPDATE stock SET quantity = 999999 WHERE sku = 'ADJ1' RETURNING id`);
      eq(upd.length, 0, 'UPDATE on stock matches no rows under RLS');
    });
    eq(await qtyAt(db, 'CC50A01', 'ADJ1', 'BA', '2030-09-02'), 7, 'stock unchanged');
  });

  await it('anon can insert PLANNED movements but never COMPLETED ones', async () => {
    await db.asRole('anon', async (anon) => {
      await anon.q(
        `INSERT INTO movements (movement_type, sku, source_location, batch, expiry_date, quantity, status)
         VALUES ('PICK', 'ADJ1', 'CC50A01', 'BA', '2030-09-02', 1, 'PLANNED')`,
      );
      await expectErr(
        () =>
          anon.q(
            `INSERT INTO movements (movement_type, sku, source_location, batch, expiry_date, quantity, status)
             VALUES ('PICK', 'ADJ1', 'CC50A01', 'BA', '2030-09-02', 1, 'COMPLETED')`,
          ),
        '42501',
        'inserting a COMPLETED movement is denied — completion requires post_movement',
      );
      await expectErr(
        () => anon.q(`UPDATE movements SET status = 'COMPLETED' WHERE status = 'PLANNED'`),
        '42501',
        'flipping status to COMPLETED directly is denied',
      );
    });
  });

  await it('anon can execute posting RPCs (the only sanctioned path to move stock)', async () => {
    const before = await qtyAt(db, 'CC50A01', 'ADJ1', 'BA', '2030-09-02');
    await db.asRole('anon', async (anon) => {
      const m = await anon.one<{ id: string }>(
        `INSERT INTO movements (movement_type, sku, source_location, batch, expiry_date, quantity, status)
         VALUES ('PICK', 'ADJ1', 'CC50A01', 'BA', '2030-09-02', 2, 'PLANNED') RETURNING id`,
      );
      const res = await anon.rpc<{ result: string }>('post_movement', '($1::uuid, $2::text, $3::date)', [m.id, 'anon-user', TODAY]);
      eq(res.result, 'POSTED', 'posted through the SECURITY DEFINER RPC');
    });
    eq(await qtyAt(db, 'CC50A01', 'ADJ1', 'BA', '2030-09-02'), before - 2, 'RPC moved stock exactly once');
  });
} finally {
  await db.close();
}

process.exit(summary('db-integration'));
