/**
 * Bug reproduction: order of 35 cartons, pickface doesn't exist (no Level A stock),
 * falls through to bin-to-bin reserve — but only allocates 9 instead of 35.
 *
 * Run: npx tsx src/pickface-missing-bug.test.ts
 */
import { strict as assert } from 'node:assert';
import { allocate } from './allocator.js';
import { derivePickfaces } from './pickface.js';
import { withConfig, type AllocatorConfig } from './config.js';
import type { StockBin, DemandLine } from './types.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function describe(name: string, fn: () => void) {
  console.log(`\n  ${name}`);
  fn();
}

function it(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`    ✓ ${name}`);
  } catch (e: any) {
    failed++;
    const msg = `    ✗ ${name}\n      ${e.message}`;
    console.log(msg);
    failures.push(msg);
  }
}

function eq<T>(actual: T, expected: T, label: string) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function makeBin(
  location: string, sku: string, batch: string, expiry: string,
  qty: number, upp: number,
): StockBin {
  return {
    binId: `${location}|${sku}|${batch}`,
    location,
    aisle: location.slice(0, 2),
    bay: parseInt(location.slice(2, 4)),
    level: location.slice(4, 5),
    position: parseInt(location.slice(5, 7)),
    sku,
    description: `SKU ${sku}`,
    batch,
    expiryDate: new Date(expiry),
    grDate: null,
    qtyCartons: qty,
    upp,
    uom: 'CAR',
    isFullPallet: qty >= upp,
  };
}

function makeDemand(
  shipment: string, wave: string, sku: string, qty: number, upp: number,
  slotTime: string | null = null,
): DemandLine {
  return {
    shipmentNumber: shipment,
    waveNo: wave,
    orderNos: [`ORD-${shipment}`],
    sku,
    description: `SKU ${sku}`,
    qtyCartons: qty,
    upp,
    destination: 'STAGING',
    shipToLocation: 'STAGING',
    transport: null,
    truckType: null,
    slotTime,
    deliveryDate: null,
  };
}

function makeConfig(): AllocatorConfig {
  return withConfig({
    asOf: new Date('2026-09-15'),
    minRemainingShelfLifeDays: 1,
    nearExpiryWarningDays: 365,
  });
}

// ── The exact bug scenario ───────────────────────────────────────────────────

describe('BUG: pickface missing, demand 35, reserve should fill all 35', () => {
  // Scenario: No Level A stock → pickface auto-created but empty (doesn't exist physically).
  // Reserve has plenty of stock across multiple bins. Demand = 35.
  // Expected: allocate 35 from reserve (bin-to-bin).
  // Bug: only allocates 9.

  it('allocates all 35 from reserve when pickface does not exist', () => {
    const config = makeConfig();
    const sku = 'SKU-PF-MISSING';

    // No Level A bins — only Level D reserve bins (pickface will be auto-created but empty)
    const stock = [
      makeBin('CB01D01', sku, 'B1', '2030-06-01', 20, 48),  // 20 cartons
      makeBin('CB01D02', sku, 'B1', '2030-06-01', 15, 48),  // 15 cartons (same expiry)
      makeBin('CB02D01', sku, 'B2', '2030-07-01', 48, 48),  // 48 cartons (later expiry)
    ];

    const demand = [makeDemand('SHP-001', '1', sku, 35, 48, '01:00')];

    const pickfaces = derivePickfaces(stock, config);
    const pf = pickfaces.get(sku);
    console.log(`    [debug] pickface derived at: ${pf?.location ?? 'NONE'}`);

    const result = allocate(stock, demand, config);
    const allocated = result.stats.cartonsAllocated;
    const lines = result.lines;
    const totalStock = stock.reduce((s, b) => s + b.qtyCartons, 0);

    console.log(`    [debug] total stock: ${totalStock}, demand: 35, allocated: ${allocated}`);
    console.log(`    [debug] lines: ${lines.length}`);
    for (const l of lines) {
      console.log(`      ${l.location} ${l.batch} qty=${l.qtyPick} remaining=${l.qtyRemainingInBin}`);
    }
    if (result.shortages.length > 0) {
      for (const s of result.shortages) {
        console.log(`    [debug] SHORTAGE: ${s.sku} requested=${s.qtyRequested} allocated=${s.qtyAllocated} short=${s.qtyShort} reason=${s.reason}`);
      }
    }

    eq(allocated, 35, 'cartonsAllocated');
    eq(result.shortages.length, 0, 'shortages');
  });

  it('allocates all 35 when pickface bin exists but is empty (virtual pickface)', () => {
    const config = makeConfig();
    const sku = 'SKU-VIRTUAL-PF';

    // Level A bin exists but has 0 qty — it gets filtered out of pool (qty <= 0).
    // derivePickfaces will still see it in stock array? No — qty<=0 bins are still in stock array.
    // Actually loadWorkbook filters qty<=0. But we construct stock directly.
    // Let's simulate: no stock at pickface location, only reserve.
    const stock = [
      makeBin('CB01D01', sku, 'B1', '2030-06-01', 9, 48),   // only 9 here
      makeBin('CB02D01', sku, 'B1', '2030-06-01', 50, 48),  // 50 here (same expiry, should be picked too)
    ];

    const demand = [makeDemand('SHP-002', '1', sku, 35, 48, '02:00')];
    const pickfaces = derivePickfaces(stock, config);
    const pf = pickfaces.get(sku);
    console.log(`    [debug] pickface: ${pf?.location ?? 'NONE'}`);

    const result = allocate(stock, demand, config);
    const allocated = result.stats.cartonsAllocated;

    console.log(`    [debug] allocated: ${allocated}`);
    for (const l of result.lines) {
      console.log(`      ${l.location} batch=${l.batch} qty=${l.qtyPick}`);
    }

    eq(allocated, 35, 'cartonsAllocated');
  });

  it('multiple reserve bins same expiry — should drain earliest expiry bins fully before moving on', () => {
    const config = makeConfig();
    const sku = 'SKU-FEFO-DRAIN';

    const stock = [
      makeBin('CB01D01', sku, 'EARLY', '2030-06-01', 9, 48),   // earliest expiry, only 9
      makeBin('CB01D02', sku, 'EARLY', '2030-06-01', 30, 48),  // same expiry, 30 more
      makeBin('CB02D01', sku, 'LATE', '2031-01-01', 48, 48),   // later expiry
    ];

    const demand = [makeDemand('SHP-003', '1', sku, 35, 48, '03:00')];
    const pickfaces = derivePickfaces(stock, config);
    const result = allocate(stock, demand, config);
    const allocated = result.stats.cartonsAllocated;

    console.log(`    [debug] allocated: ${allocated}`);
    for (const l of result.lines) {
      console.log(`      ${l.location} batch=${l.batch} qty=${l.qtyPick}`);
    }

    // FEFO: should take 9+30=39 from EARLY (but demand is only 35), so 9 from first + 26 from second
    eq(allocated, 35, 'cartonsAllocated');
  });
});

// ── Root cause: shelf-life filter silently dropping stock ────────────────────

describe('ROOT CAUSE: shelf-life filter drops stock when asOf is far from expiry', () => {
  it('bins with < minRemainingShelfLifeDays are excluded — can cause under-allocation', () => {
    // Default minRemainingShelfLifeDays = 180.
    // If asOf = 2026-09-15 and expiry = 2027-01-01 (~108 days), bin is REJECTED.
    const config = withConfig({
      asOf: new Date('2026-09-15'),
      minRemainingShelfLifeDays: 180,  // default
      nearExpiryWarningDays: 365,
    });

    const sku = 'SKU-SHELF-LIFE';

    // Stock that would cover 35, but most bins fail shelf-life check
    const stock = [
      makeBin('CB01D01', sku, 'B1', '2026-12-01', 9, 48),   // ~77 days — REJECTED (<180)
      makeBin('CB01D02', sku, 'B1', '2027-06-01', 40, 48),  // ~258 days — OK
      makeBin('CB02D01', sku, 'B1', '2027-03-01', 30, 48),  // ~167 days — REJECTED (<180)
    ];

    const demand = [makeDemand('SHP-004', '1', sku, 35, 48, '04:00')];
    const result = allocate(stock, demand, config);
    const allocated = result.stats.cartonsAllocated;
    const rejected = stock.reduce((s, b) => {
      const life = Math.floor((new Date('2027-01-01').getTime() - new Date('2026-09-15').getTime()) / 86400000);
      return s;
    }, 0);

    console.log(`    [debug] allocated: ${allocated}`);
    console.log(`    [debug] warnings: ${result.warnings.filter(w => w.code === 'SHELF_LIFE_BLOCKED' || w.code === 'EXPIRED').length}`);
    for (const w of result.warnings.filter(w => w.code === 'SHELF_LIFE_BLOCKED' || w.code === 'EXPIRED')) {
      console.log(`      ${w.code}: ${w.message}`);
    }

    // With default 180-day shelf life, only the 40-carton bin is eligible.
    // Demand=35, available=40 → should allocate 35 from that one bin.
    // But if the eligible stock were only 9, it would allocate 9.
    eq(allocated, 35, 'allocated from eligible stock');
  });

  it('BUG PATTERN: only 9 cartons eligible after shelf-life filter', () => {
    const config = withConfig({
      asOf: new Date('2026-09-15'),
      minRemainingShelfLifeDays: 180,  // default
      nearExpiryWarningDays: 365,
    });

    const sku = 'SKU-ONLY-9-ELIGIBLE';

    // Total stock = 35, but only 9 cartons pass the 180-day shelf-life gate
    const stock = [
      makeBin('CB01D01', sku, 'B1', '2027-06-01', 9, 48),    // ~259 days — OK
      makeBin('CB01D02', sku, 'B1', '2026-12-15', 26, 48),   // ~91 days — REJECTED
    ];

    const demand = [makeDemand('SHP-005', '1', sku, 35, 48, '05:00')];
    const result = allocate(stock, demand, config);
    const allocated = result.stats.cartonsAllocated;

    console.log(`    [debug] allocated: ${allocated} (expected by user: 35, actual bug: 9)`);

    const shelfLifeWarnings = result.warnings.filter(w => w.code === 'SHELF_LIFE_BLOCKED');
    console.log(`    [debug] shelf-life rejected bins: ${shelfLifeWarnings.length}`);

    // THIS IS THE BUG: allocated is 9, not 35, because 26 cartons were silently
    // excluded by the shelf-life filter. User sees "only 9 taken".
    eq(allocated, 9, 'allocated (buggy: only eligible stock)');
    // When fixed or when minRemainingShelfLifeDays is lowered, this becomes 35.
  });

  it('FIXED: default config (minRemainingShelfLifeDays=0) allocates all 35', () => {
    const config = withConfig({
      asOf: new Date('2026-09-15'),
    });

    const sku = 'SKU-FIXED-DEFAULT';
    const stock = [
      makeBin('CB01D01', sku, 'B1', '2027-06-01', 9, 48),
      makeBin('CB01D02', sku, 'B1', '2026-12-15', 26, 48),
    ];

    const demand = [makeDemand('SHP-007', '1', sku, 35, 48, '07:00')];
    const result = allocate(stock, demand, config);
    const allocated = result.stats.cartonsAllocated;

    console.log(`    [debug] allocated with default config: ${allocated}`);
    eq(allocated, 35, 'allocated with default config');
    eq(result.shortages.length, 0, 'no shortages');
  });
});

describe('BUG 2: order 35 split across bins — should take 35 from one sealed pallet', () => {
  it('takes all 35 from sealed reserve pallet instead of splitting 9+26', () => {
    const config = makeConfig();
    const sku = 'SKU-SPLIT-BUG';

    const stock = [
      makeBin('CB01D01', sku, 'B1', '2030-06-01', 48, 48),  // sealed full pallet
      makeBin('CB02D01', sku, 'B1', '2030-06-01', 26, 48),  // open bin (fragment)
    ];

    const demand = [makeDemand('SHP-008', '1', sku, 35, 48, '08:00')];
    const result = allocate(stock, demand, config);
    const allocated = result.stats.cartonsAllocated;
    const lines = result.lines;

    console.log(`    [debug] allocated: ${allocated}, lines: ${lines.length}`);
    for (const l of lines) {
      console.log(`      ${l.location} qty=${l.qtyPick} breaksPallet=${l.breaksPallet}`);
    }

    eq(allocated, 35, 'cartonsAllocated');
    eq(lines.length, 1, 'single line (no bin-to-bin split)');
    eq(lines[0].qtyPick, 35, 'all 35 from one bin');
    eq(lines[0].location, 'CB01D01', 'from sealed reserve pallet');
  });

  it('still prefers open pallet when it can fully cover the need', () => {
    const config = makeConfig();
    const sku = 'SKU-OPEN-PREF';

    const stock = [
      makeBin('CB01D01', sku, 'B1', '2030-06-01', 48, 48),  // sealed
      makeBin('CB02D01', sku, 'B1', '2030-06-01', 40, 48),  // open, can cover 35
    ];

    const demand = [makeDemand('SHP-009', '1', sku, 35, 48, '09:00')];
    const result = allocate(stock, demand, config);
    const lines = result.lines;

    console.log(`    [debug] lines: ${lines.length}`);
    for (const l of lines) {
      console.log(`      ${l.location} qty=${l.qtyPick}`);
    }

    eq(lines.length, 1, 'single line');
    eq(lines[0].location, 'CB02D01', 'prefers open pallet that covers need');
    eq(lines[0].qtyPick, 35, 'takes 35');
  });

  it('spans bins only when no single bin can cover the need', () => {
    const config = makeConfig();
    const sku = 'SKU-LEGIT-SPAN';

    const stock = [
      makeBin('CB01D01', sku, 'B1', '2030-06-01', 20, 48),  // open, only 20
      makeBin('CB02D01', sku, 'B1', '2030-06-01', 20, 48),  // open, only 20
    ];

    const demand = [makeDemand('SHP-010', '1', sku, 35, 48, '10:00')];
    const result = allocate(stock, demand, config);
    const allocated = result.stats.cartonsAllocated;

    console.log(`    [debug] allocated: ${allocated}, lines: ${result.lines.length}`);
    for (const l of result.lines) {
      console.log(`      ${l.location} qty=${l.qtyPick}`);
    }

    eq(allocated, 35, 'allocated');
    eq(result.lines.length, 2, 'must span two bins (neither can cover alone)');
  });
});

// ── Root cause: pickface pool split drops reserve stock ──────────────────────

describe('ROOT CAUSE: pickface pool split — what happens when pickfaceLoc is set but bin is empty', () => {
  it('pickfaceLoc set, pickface bin has qty=0 — reservePool should contain ALL other bins', () => {
    const config = makeConfig();
    const sku = 'SKU-POOL-SPLIT';

    // Level A bin exists with qty=0 (would be filtered by loadWorkbook, but we bypass it)
    // Actually makeBin with qty=0: isFullPallet = 0 >= 48 = false
    const pickfaceBin = makeBin('CB01A01', sku, 'B1', '2030-06-01', 0, 48);  // empty pickface
    const reserve1 = makeBin('CB01D01', sku, 'B1', '2030-06-01', 9, 48);
    const reserve2 = makeBin('CB02D01', sku, 'B1', '2030-06-01', 50, 48);

    // Note: allocate() filters qty<=0 at pool build time (line 60: if bin.qtyCartons <= 0 continue)
    const stock = [pickfaceBin, reserve1, reserve2];

    const demand = [makeDemand('SHP-006', '1', sku, 35, 48, '06:00')];
    const pickfaces = derivePickfaces(stock, config);
    const pf = pickfaces.get(sku);
    console.log(`    [debug] pickface: ${pf?.location ?? 'NONE'}`);

    const result = allocate(stock, demand, config);
    const allocated = result.stats.cartonsAllocated;

    console.log(`    [debug] allocated: ${allocated}`);
    for (const l of result.lines) {
      console.log(`      ${l.location} qty=${l.qtyPick}`);
    }

    // reserve1 (9) + reserve2 (50) = 59 eligible. Should fill 35.
    eq(allocated, 35, 'cartonsAllocated');
  });
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log('\n' + '─'.repeat(60));
console.log(`  ${passed} passed, ${failed} failed`);
if (failures.length > 0) { console.log('\n  Failures:'); for (const f of failures) console.log(f); }
console.log('─'.repeat(60));
process.exit(failed > 0 ? 1 : 0);
