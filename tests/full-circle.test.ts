/**
 * Full-circle end-to-end test (§FullCircle) — import → allocate → post →
 * inbound → verify continuity → ledger reconciles.
 *
 *   TEST_DATABASE_URL=postgres://postgres:test@localhost:54329/postgres \
 *     npx tsx tests/full-circle.test.ts
 *
 * Flow:
 *   1. Seed opening stock into the database
 *   2. Load demand from workbook, allocate (same engine as parity test)
 *   3. Persist plan → waves + movements + outbound as PLANNED
 *   4. Complete every wave → stock deducted via post_movement
 *   5. Verify pickface trace and final stock matches ledger
 *   6. Record inbound → stock replenished
 *   7. Verify stock is now available again (continuity)
 *  8. stock_vs_ledger reconciles to zero
 */

import { setupTestDatabase, seedStock, type TestDb } from './db-helpers.js';
import { describe, it, eq, ok, deepEq, summary } from './harness.js';
import { loadWorkbook, type LoadedData } from '../src/adapters/excel-input.js';
import { withConfig } from '../src/config.js';
import { allocate, relocateByWaveOrder } from '../src/allocator.js';
import { derivePickfaces } from '../src/pickface.js';
import { buildPlan } from '../src/services/planning.js';
import type { AllocationResult, PickfaceAssignment } from '../src/types.js';

const ACTOR = 'full-circle-test';
const TODAY = '2026-09-18';
const TOMORROW = '2026-09-19';
const WORKBOOK = 'data/Warehouse_Management_System_18_September_2026_.xlsx';
const SKU = '550076636';
const PICKFACE_LOC = 'CB20D01';

const config = withConfig({
  asOf: new Date(TODAY),
  minRemainingShelfLifeDays: 1,
  nearExpiryWarningDays: 365,
});

const db: TestDb | null = await setupTestDatabase('full-circle');
if (!db) process.exit(0);

let loaded: LoadedData | null = null;
let A: { allocation: AllocationResult; pickfaces: Map<string, PickfaceAssignment> } | null = null;
let trace: number[] = [];

try {
  // ═══════════════════════════════════════════════════════════════════════
  // 1. LOAD WORKBOOK (source of truth for comparison)
  // ═══════════════════════════════════════════════════════════════════════
  loaded = await loadWorkbook(WORKBOOK, config);
  ok(loaded.stock.length > 0, 'workbook loaded with stock');
  ok(loaded.demand.length > 0, 'workbook loaded with demand');

  // ═══════════════════════════════════════════════════════════════════════
  // 2. ALLOCATE FROM WORKBOOK STOCK (source of truth)
  // ═══════════════════════════════════════════════════════════════════════
  describe('Step 1 — Allocate from workbook stock');
  const pickfaces = derivePickfaces(loaded.stock, config);
  const allocation = allocate(loaded.stock, loaded.demand, config, loaded.stagedBySku);
  relocateByWaveOrder(allocation.lines, pickfaces, config, loaded.stock);
  A = { allocation, pickfaces };

  ok(allocation.lines.length > 0, 'allocation produced lines');
  ok(allocation.stats.fillRatePct > 0, 'fill rate > 0');

  // ═══════════════════════════════════════════════════════════════════════
  // 3. SEED STOCK INTO DATABASE
  // ═══════════════════════════════════════════════════════════════════════
  describe('Step 2 — Seed stock into database');
  await it('seeds every physical row from the workbook', async () => {
    for (const b of loaded!.stock) {
      await seedStock(db, {
        location: b.location,
        sku: b.sku,
        batch: b.batch ?? null,
        expiry: b.expiryDate.toISOString().slice(0, 10),
        qty: b.qtyCartons,
        upp: b.upp,
      });
    }
    const count = await db.q<{ n: number }>(`SELECT count(*)::int AS n FROM stock`);
    eq(count[0].n, loaded!.stock.length, 'all stock rows seeded');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 4. BUILD PLAN → INSERT WAVES + MOVEMENTS + OUTBOUND (PLANNED)
  // ═══════════════════════════════════════════════════════════════════════
  describe('Step 3 — Build plan, persist as PLANNED');
  let planWaves: { waveNo: string; id: string }[] = [];
  await it('builds plan and persists waves/movements/outbound', async () => {
    const plan = buildPlan({
      allocation: A!.allocation,
      demand: loaded!.demand,
      pickfaces: A!.pickfaces,
      asOf: config.asOf,
    });

    const waveIdByNo = new Map<string, string>();
    for (const w of plan.waves) {
      const r = await db.one<{ id: string }>(
        `INSERT INTO waves (wave_no, planned_date, shipment_numbers, truck, destination, planned_slot)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [w.waveNo, TODAY, w.shipmentNumbers, w.truck, w.destination, w.plannedSlot],
      );
      waveIdByNo.set(w.waveNo, r.id);
    }

    for (const m of plan.movements) {
      await db.q(
        `INSERT INTO movements
         (wave_id, wave_no, shipment_number, movement_type, sku, description,
          source_location, destination_location, batch, expiry_date, quantity,
          pick_type, breaks_pallet, seq)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          m.waveNo ? waveIdByNo.get(m.waveNo) ?? null : null,
          m.waveNo, m.shipmentNumber, m.movementType, m.sku, m.description ?? '',
          m.sourceLocation, m.destinationLocation ?? null, m.batch ?? null,
          new Date(m.expiryDate).toISOString().slice(0, 10), m.quantity, m.pickType ?? null,
          m.breaksPallet ?? false, m.seq ?? null,
        ],
      );
    }

    for (const o of plan.outbound) {
      await db.q(
        `INSERT INTO outbound
         (outbound_date, shipment_number, wave_id, wave_no, truck, destination,
          sku, description, quantity, origin)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'ALLOCATION')`,
        [
          o.outboundDate, o.shipmentNumber,
          o.waveNo ? waveIdByNo.get(o.waveNo) ?? null : null,
          o.waveNo, o.truck, o.destination, o.sku, o.description ?? '', o.quantity,
        ],
      );
    }

    const before = await db.one<{ q: number }>(
      `SELECT coalesce(sum(quantity),0)::int AS q FROM stock WHERE location=$1 AND sku=$2`,
      [PICKFACE_LOC, SKU],
    );
    eq(before.q, 8, 'pickface starts at 8 cartons');

    planWaves = plan.waves.map((w) => ({ waveNo: w.waveNo, id: waveIdByNo.get(w.waveNo)! }));
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 5. COMPLETE WAVES → STOCK DEDUCTED
  // ═══════════════════════════════════════════════════════════════════════
  describe('Step 4 — Complete waves (stock deducted via post_movement)');
  await it('completes every wave in numeric order; pickface trace verified', async () => {
    const waves = planWaves.sort((a, b) => {
      const na = Number(a.waveNo);
      const nb = Number(b.waveNo);
      return Number.isFinite(na) && Number.isFinite(nb) ? na - nb : 0;
    });

    let last = (await db.one<{ q: number }>(
      `SELECT coalesce(sum(quantity),0)::int AS q FROM stock WHERE location=$1 AND sku=$2`,
      [PICKFACE_LOC, SKU],
    )).q;
    eq(last, 8, 'pre-execution pickface balance = 8');
    trace = [];

    for (const w of waves) {
      await db.rpc('complete_wave', '($1::uuid, $2::text, $3::date)', [w.id, ACTOR, TODAY]);
      const r = await db.one<{ q: number }>(
        `SELECT coalesce(sum(quantity),0)::int AS q FROM stock WHERE location=$1 AND sku=$2`,
        [PICKFACE_LOC, SKU],
      );
      if (r.q !== last) {
        trace.push(r.q);
        last = r.q;
      }
    }

    deepEq(trace, [7, 37, 51, 43], 'pickface trace after each wave');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 6. VERIFY LEDGER RECONCILES AFTER DEDUCTION
  // ═══════════════════════════════════════════════════════════════════════
  describe('Step 5 — Ledger reconciles after deduction');
  await it('stock_vs_ledger mismatch = 0 after waves complete', async () => {
    const bad = await db.q<{ identity_key: string; mismatch: string }>(
      `SELECT identity_key, mismatch FROM stock_vs_ledger WHERE mismatch <> 0`,
    );
    eq(bad.length, 0, 'zero mismatches after wave completion');
  });

  await it('final pickface identities verified', async () => {
    const rows = await db.q<{ identity_key: string; quantity: number }>(
      `SELECT identity_key, quantity FROM stock WHERE location=$1 AND sku=$2 ORDER BY expiry_date`,
      [PICKFACE_LOC, SKU],
    );
    const byKey = new Map(rows.map((r) => [r.identity_key, r.quantity]));
    eq(byKey.get(`${PICKFACE_LOC}|${SKU}|05I26JJ|2030-09-05`), 0, 'exp905 identity drained to 0');
    eq(byKey.get(`${PICKFACE_LOC}|${SKU}|05I26JJ|2030-09-02`), 43, 'exp902 identity ends at 43');
    eq(rows.length, 2, 'exactly two identities — never merged');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 7. RECORD INBOUND (REPLENISH DEPLETED BINS)
  // ═══════════════════════════════════════════════════════════════════════
  describe('Step 6 — Record inbound (replenish depleted stock)');
  await it('post_inbound adds stock once to the pickface', async () => {
    const r = await db.one<{ id: string }>(
      `INSERT INTO inbound (inbound_date, reference_no, sku, description, location, batch, expiry_date, quantity, upp)
       VALUES ($1, 'FULL-CIRCLE-IN', $2, 'Replenishment', $3, '05I26JJ', '2030-09-02', 48, 48)
       RETURNING id`,
      [TOMORROW, SKU, PICKFACE_LOC],
    );
    const statusRow = await db.one<{ status: string }>(`SELECT status FROM inbound WHERE id=$1`, [r.id]);
    eq(statusRow.status, 'PENDING', 'created PENDING');

    const qtyBefore = (await db.one<{ q: number }>(
      `SELECT coalesce(sum(quantity),0)::int AS q FROM stock WHERE location=$1 AND sku=$2`,
      [PICKFACE_LOC, SKU],
    )).q;
    eq(qtyBefore, 43, 'stock is 43 before inbound post');

    const res = await db.rpc<{ result: string }>('post_inbound', '($1::uuid, $2::text, $3::date)', [r.id, ACTOR, TOMORROW]);
    eq(res.result, 'POSTED', 'inbound POSTED');

    const qtyAfter = (await db.one<{ q: number }>(
      `SELECT coalesce(sum(quantity),0)::int AS q FROM stock WHERE location=$1 AND sku=$2`,
      [PICKFACE_LOC, SKU],
    )).q;
    eq(qtyAfter, 91, 'stock is now 43 + 48 = 91 after inbound post');
    const statusAfter = await db.one<{ status: string }>(`SELECT status FROM inbound WHERE id=$1`, [r.id]);
    eq(statusAfter.status, 'COMPLETED', 'inbound COMPLETED');
  });

  await it('double post is a no-op', async () => {
    const r = await db.one<{ id: string }>(`SELECT id FROM inbound WHERE reference_no='FULL-CIRCLE-IN'`);
    const res = await db.rpc<{ result: string }>('post_inbound', '($1::uuid, $2::text, $3::date)', [r.id, ACTOR, TOMORROW]);
    eq(res.result, 'ALREADY_POSTED', 'double post ALREADY_POSTED');
    const qty = (await db.one<{ q: number }>(
      `SELECT coalesce(sum(quantity),0)::int AS q FROM stock WHERE location=$1 AND sku=$2`,
      [PICKFACE_LOC, SKU],
    )).q;
    eq(qty, 91, 'stock unchanged at 91 after double post');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 8. VERIFY CONTINUITY — STOCK AVAILABLE AGAIN
  // ═══════════════════════════════════════════════════════════════════════
  describe('Step 7 — Verify continuity (stock replenished)');
  await it('pickface has 91 cartons available after inbound', async () => {
    const qty = (await db.one<{ q: number }>(
      `SELECT coalesce(sum(quantity),0)::int AS q FROM stock WHERE location=$1 AND sku=$2`,
      [PICKFACE_LOC, SKU],
    )).q;
    eq(qty, 91, 'pickface has 91 cartons');
  });

  await it('total stock for SKU exceeds post-deduction level', async () => {
    const totalStock = await db.one<{ q: number }>(
      `SELECT coalesce(sum(quantity),0)::int AS q FROM stock WHERE sku=$1 AND quantity > 0`,
      [SKU],
    );
    ok(totalStock.q > 43, 'total stock for SKU exceeds yesterday post-deduction level');
  });

  await it('inbound ledger row exists', async () => {
    const cnt = await db.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM stock_transactions WHERE identity_key=$1 AND transaction_type='INBOUND'`,
      [`${PICKFACE_LOC}|${SKU}|05I26JJ|2030-09-02`],
    );
    eq(cnt.n, 1, 'exactly one INBOUND ledger row');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 9. FINAL LEDGER RECONCILIATION
  // ═══════════════════════════════════════════════════════════════════════
  describe('Step 8 — Final ledger reconciliation');
  await it('stock_vs_ledger mismatch = 0 after full cycle', async () => {
    const bad = await db.q<{ identity_key: string; mismatch: string }>(
      `SELECT identity_key, mismatch FROM stock_vs_ledger WHERE mismatch <> 0`,
    );
    eq(bad.length, 0, 'zero mismatches after full cycle');
  });

  await it('all stock quantities non-negative', async () => {
    const bad = await db.q<{ identity_key: string; quantity: number }>(
      `SELECT identity_key, quantity FROM stock WHERE quantity < 0`,
    );
    eq(bad.length, 0, 'no negative stock');
  });

  await it('outbound completed by waves', async () => {
    const counts = await db.one<{ ob_done: number; ob_planned: number; picks: number }>(
      `SELECT
        (SELECT count(*)::int FROM outbound WHERE status='COMPLETED') AS ob_done,
        (SELECT count(*)::int FROM outbound WHERE status='PLANNED') AS ob_planned,
        (SELECT count(*)::int FROM movements WHERE movement_type='PICK' AND status='COMPLETED') AS picks`,
    );
    eq(counts.ob_planned, 0, 'no PLANNED outbound left');
    ok(counts.ob_done > 0, 'outbound rows completed');
    ok(counts.picks > 0, 'pick movements completed');
  });
} catch (err) {
  console.error('Full-circle test error:', err);
} finally {
  await db.close();
}

process.exit(summary('full-circle'));
