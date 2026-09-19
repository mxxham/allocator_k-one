/**
 * Parity test (§37) — the database must not change the allocation.
 *
 *   TEST_DATABASE_URL=postgres://postgres:test@localhost:54329/postgres \
 *     npx tsx tests/parity.test.ts
 *
 * 1. Sep 18 workbook: Excel-fed allocation vs database-fed allocation are
 *    compared line by line (sku, location, batch, expiry, qtyPick, Sisa,
 *    wave, shipment, seq, breaksPallet) plus stats, shortages and pickfaces.
 * 2. The 550076636 scenario (§18) is replayed through the real database:
 *    buildPlan → insert waves/movements/outbound → complete_wave per wave in
 *    numeric order. The pickface balance must trace 8 → 7 → 37 → 51 → 43
 *    (relocations +7/+37/+43, picks −8/−7/−29/−8) ending at 43, matching
 *    relocateByWaveOrder's ledger finalQty asserted in src/sisa-regression.
 * 3. The final DB stock per physical identity must equal
 *    computeStockAfterMovements(), and stock_vs_ledger must reconcile to zero.
 */

import { setupTestDatabase, type TestDb } from './db-helpers.js';
import { describe, it, eq, ok, deepEq, summary } from './harness.js';
import { loadWorkbook, type LoadedData } from '../src/adapters/excel-input.js';
import { withConfig } from '../src/config.js';
import { allocate, relocateByWaveOrder } from '../src/allocator.js';
import { derivePickfaces } from '../src/pickface.js';
import { computeStockAfterMovements } from '../src/ledger.js';
import { validateImport } from '../src/adapters/import-preview.js';
import { buildPlan } from '../src/services/planning.js';
import { stockRecordToBin } from '../src/adapters/database-stock.js';
import { stockRowToDomain, formatDbDate } from '../src/repository/types.js';
import type { StockRow } from '../src/lib/database.types.js';
import { parseLocation } from '../src/pickpath.js';
import type { AllocationResult, PickfaceAssignment, StockBin } from '../src/types.js';

const db: TestDb | null = await setupTestDatabase('parity');
if (!db) process.exit(0);

const WORKBOOK = 'data/Warehouse_Management_System_18_September_2026_.xlsx';
const SKU = '550076636';
const config = withConfig({
  asOf: new Date('2026-09-18'),
  minRemainingShelfLifeDays: 1,
  nearExpiryWarningDays: 365,
});
const AS_OF = '2026-09-18';
const ACTOR = 'parity-test';

function runPipeline(stock: StockBin[], loaded: LoadedData): {
  pickfaces: Map<string, PickfaceAssignment>;
  allocation: AllocationResult;
} {
  const pickfaces = derivePickfaces(stock, config);
  const allocation = allocate(stock, loaded.demand, config, loaded.stagedBySku);
  relocateByWaveOrder(allocation.lines, pickfaces, config, stock);
  return { pickfaces, allocation };
}

const waveOrder = (waveNo: string): number => {
  const n = Number(waveNo);
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
};

/** NewWave/NewMovement/NewOutbound carry Date | string — normalize for DATE columns. */
const dbDate = (v: string | Date): string => (typeof v === 'string' ? v : formatDbDate(v));

try {
  const loaded = await loadWorkbook(WORKBOOK, config);

  // ── 1. Excel-fed allocation ──────────────────────────────────────────────
  describe('Excel-fed pipeline (source of truth for comparison)');
  let A: ReturnType<typeof runPipeline> = null!;
  await it('allocates from the workbook stock', () => {
    A = runPipeline(loaded.stock, loaded);
    ok(A.allocation.lines.length > 0, 'allocation produced lines');
    ok(A.allocation.stats.fillRatePct > 0, 'fill rate > 0');
  });

  // ── 2. import into the database ──────────────────────────────────────────
  describe('WMS workbook → database (initial_import RPC)');
  let dbStock: StockBin[] = [];
  await it('preview validates and imports every physical row', async () => {
    const preview = validateImport(WORKBOOK, loaded);
    ok(preview.canImport, `preview canImport (checks: ${JSON.stringify(preview.checks.filter((c) => c.level === 'ERROR'))})`);
    eq(preview.duplicateIdentities.length, 0, 'no duplicate physical identities in the workbook');
    const res = await db.rpc<{ result: string; imported: number }>(
      'initial_import', '($1::jsonb, $2::text, $3::text, $4::date)',
      [JSON.stringify(preview.rows), ACTOR, 'FAIL_ON_CONFLICT', AS_OF],
    );
    eq(res.result, 'IMPORTED', 'import succeeded');
    eq(res.imported, preview.stockRowCount, `imported ${res.imported} physical rows`);
  });

  await it('stock read back from the database equals the workbook stock', async () => {
    const rows = await db.q<StockRow>(`SELECT * FROM stock ORDER BY location, sku, expiry_date`);
    dbStock = rows
      .map((r) => stockRecordToBin(stockRowToDomain(r)))
      .filter((b) => b.qtyCartons > 0 && parseLocation(b.location));
    const key = (b: StockBin) => `${b.location}|${b.sku}|${b.batch ?? ''}|${formatDbDate(b.expiryDate)}`;
    const excelMap = new Map(loaded.stock.map((b) => [key(b), b]));
    const dbMap = new Map(dbStock.map((b) => [key(b), b]));
    eq(dbMap.size, excelMap.size, 'same number of physical identities');
    for (const [k, ex] of excelMap) {
      const d = dbMap.get(k);
      ok(d, `identity ${k} present in DB`);
      eq(d!.qtyCartons, ex.qtyCartons, `qty for ${k}`);
      eq(d!.upp, ex.upp, `upp for ${k}`);
      eq(d!.description, ex.description, `description for ${k}`);
      eq(d!.uom ?? null, ex.uom ?? null, `uom for ${k}`);
      eq(d!.isFullPallet, ex.isFullPallet, `isFullPallet for ${k}`);
    }
  });

  // ── 3. DB-fed allocation parity ──────────────────────────────────────────
  describe('Database-fed allocation is identical (allocator untouched)');
  let B: ReturnType<typeof runPipeline> = null!;
  await it('same lines, same quantities, same Sisa, same order', () => {
    B = runPipeline(dbStock, loaded);
    const la = A.allocation.lines;
    const lb = B.allocation.lines;
    eq(lb.length, la.length, 'line count');
    for (let i = 0; i < la.length; i++) {
      const a = la[i];
      const b = lb[i];
      const ctx = `line ${i} (${a.sku}@${a.waveNo})`;
      eq(b.sku, a.sku, `${ctx} sku`);
      eq(b.location, a.location, `${ctx} location`);
      eq(b.batch ?? null, a.batch ?? null, `${ctx} batch`);
      eq(b.expiryDate.getTime(), a.expiryDate.getTime(), `${ctx} expiry (no timezone shift)`);
      eq(b.qtyPick, a.qtyPick, `${ctx} qtyPick`);
      eq(b.qtyRemainingInBin, a.qtyRemainingInBin, `${ctx} Sisa`);
      eq(b.waveNo, a.waveNo, `${ctx} waveNo`);
      eq(b.shipmentNumber, a.shipmentNumber, `${ctx} shipmentNumber`);
      eq(b.seq, a.seq, `${ctx} seq`);
      eq(b.breaksPallet, a.breaksPallet, `${ctx} breaksPallet`);
      eq(b.pickType, a.pickType, `${ctx} pickType`);
    }
  });

  await it('same stats, shortages and pickfaces', () => {
    const sa = A.allocation.stats;
    const sb = B.allocation.stats;
    for (const f of ['fillRatePct', 'cartonsAllocated', 'cartonsRequested', 'palletPicks', 'casePicks', 'palletsBroken'] as const) {
      eq(sb[f], sa[f], `stats.${f}`);
    }
    const sh = (s: { shipmentNumber: string; sku: string; qtyShort: number; reason: string }) =>
      `${s.shipmentNumber}|${s.sku}|${s.qtyShort}|${s.reason}`;
    deepEq(B.allocation.shortages.map(sh), A.allocation.shortages.map(sh), 'shortages');
    eq(B.pickfaces.size, A.pickfaces.size, 'pickface count');
    for (const [sku, pa] of A.pickfaces) {
      const pb = B.pickfaces.get(sku);
      ok(pb, `pickface for ${sku} exists`);
      eq(pb!.location, pa.location, `pickface location for ${sku}`);
      eq(pb!.targetQtyCartons, pa.targetQtyCartons, `pickface target for ${sku}`);
    }
  });

  // ── 4. plan → execute replay in the database ─────────────────────────────
  describe('550076636 replay: plan persisted, waves executed against real stock');
  const pf = A.pickfaces.get(SKU)!;
  let trace: number[] = [];
  await it('pickface balance traces 8 → 7 → 37 → 51 → 43 through complete_wave', async () => {
    const plan = buildPlan({
      allocation: A.allocation,
      demand: loaded.demand,
      pickfaces: A.pickfaces,
      asOf: config.asOf,
    });
    eq(plan.counts.picks, A.allocation.lines.length, 'one PICK movement per allocation line');

    // waves
    const waveIdByNo = new Map<string, string>();
    for (const w of plan.waves) {
      const r = await db.one<{ id: string }>(
        `INSERT INTO waves (wave_no, planned_date, shipment_numbers, truck, destination, planned_slot)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [w.waveNo, dbDate(w.plannedDate), w.shipmentNumbers, w.truck, w.destination, w.plannedSlot],
      );
      waveIdByNo.set(w.waveNo, r.id);
    }
    // movements (PLANNED — no stock touched yet)
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
          dbDate(m.expiryDate), m.quantity, m.pickType ?? null,
          m.breaksPallet ?? false, m.seq ?? null,
        ],
      );
    }
    // outbound (PLANNED, origin=ALLOCATION)
    for (const o of plan.outbound) {
      await db.q(
        `INSERT INTO outbound
           (outbound_date, shipment_number, wave_id, wave_no, truck, destination,
            sku, description, quantity, origin)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'ALLOCATION')`,
        [
          dbDate(o.outboundDate), o.shipmentNumber,
          o.waveNo ? waveIdByNo.get(o.waveNo) ?? null : null,
          o.waveNo, o.truck, o.destination, o.sku, o.description ?? '', o.quantity,
        ],
      );
    }

    const planned = await db.one<{ n: number; q: number }>(
      `SELECT (SELECT count(*)::int FROM movements WHERE status='PLANNED') AS n,
              (SELECT coalesce(sum(quantity),0)::int FROM stock WHERE location=$1 AND sku=$2) AS q`,
      [pf.location, SKU],
    );
    eq(planned.n, plan.movements.length, 'every movement persisted PLANNED');
    eq(planned.q, 8, 'pickface starts at 8 cartons (exp905 identity)');

    // execute wave by wave in numeric order; track the pickface total
    let last = planned.q;
    trace = [];
    const waves = [...plan.waves].sort((a, b) => waveOrder(a.waveNo) - waveOrder(b.waveNo));
    for (const w of waves) {
      await db.rpc('complete_wave', '($1::uuid, $2::text, $3::date)', [waveIdByNo.get(w.waveNo)!, ACTOR, AS_OF]);
      const r = await db.one<{ q: number }>(
        `SELECT coalesce(sum(quantity),0)::int AS q FROM stock WHERE location=$1 AND sku=$2`,
        [pf.location, SKU],
      );
      if (r.q !== last) {
        trace.push(r.q);
        last = r.q;
      }
    }
    deepEq(trace, [7, 37, 51, 43], 'pickface trace after waves 2/10/11/12 (reloc before pick, same wave)');
  });

  await it('final pickface identities: exp905 = 0, exp902 = 43 — two expiries never merged', async () => {
    const rows = await db.q<{ identity_key: string; quantity: number }>(
      `SELECT identity_key, quantity FROM stock WHERE location = $1 AND sku = $2 ORDER BY expiry_date`,
      [pf.location, SKU],
    );
    const byKey = new Map(rows.map((r) => [r.identity_key, r.quantity]));
    eq(byKey.get(`${pf.location}|${SKU}|05I26JJ|2030-09-05`), 0, 'exp905 identity drained to 0');
    eq(byKey.get(`${pf.location}|${SKU}|05I26JJ|2030-09-02`), 43, 'exp902 identity ends at 43 (§18)');
    eq(rows.length, 2, 'exactly two identities at the pickface — never merged');
  });

  // ── 5. whole-warehouse end state ─────────────────────────────────────────
  describe('Database end state == in-memory ledger (computeStockAfterMovements)');
  await it('every physical identity matches', async () => {
    const expected = new Map<string, number>();
    for (const b of dbStock) {
      const k = `${b.location}|${b.sku}|${b.batch ?? ''}|${formatDbDate(b.expiryDate)}`;
      expected.set(k, b.qtyCartons);
    }
    for (const b of computeStockAfterMovements(loaded.stock, A.allocation.lines, A.pickfaces)) {
      const k = `${b.location}|${b.sku}|${b.batch ?? ''}|${formatDbDate(b.expiryDate)}`;
      expected.set(k, b.qtyCartons);
    }
    const rows = await db.q<{ identity_key: string; quantity: number }>(
      `SELECT identity_key, quantity FROM stock`,
    );
    eq(rows.length, expected.size, 'same identity count (nothing created or lost)');
    for (const r of rows) {
      ok(r.quantity >= 0, `${r.identity_key} not negative`);
      eq(r.quantity, expected.get(r.identity_key) ?? -1, `quantity for ${r.identity_key}`);
    }
  });

  await it('stock reconciles with the ledger (stock_vs_ledger mismatch = 0)', async () => {
    const bad = await db.q<{ identity_key: string; mismatch: string }>(
      `SELECT identity_key, mismatch FROM stock_vs_ledger WHERE mismatch <> 0`,
    );
    eq(bad.length, 0, `zero mismatches (found ${JSON.stringify(bad)})`);
  });

  await it('outbound rows completed by their waves, one PICK ledger row per PICK movement', async () => {
    const counts = await db.one<{ ob_done: number; ob_planned: number; picks: number; mv_picks: number }>(
      `SELECT
         (SELECT count(*)::int FROM outbound WHERE status='COMPLETED') AS ob_done,
         (SELECT count(*)::int FROM outbound WHERE status='PLANNED') AS ob_planned,
         (SELECT count(*)::int FROM stock_transactions WHERE transaction_type='PICK') AS picks,
         (SELECT count(*)::int FROM movements WHERE movement_type='PICK' AND status='COMPLETED') AS mv_picks`,
    );
    eq(counts.ob_planned, 0, 'no PLANNED outbound left after all waves completed');
    ok(counts.ob_done > 0, 'outbound rows completed');
    eq(counts.picks, counts.mv_picks, 'one PICK ledger row per completed PICK movement');
  });
} finally {
  await db.close();
}

process.exit(summary('parity'));
