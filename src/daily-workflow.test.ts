/**
 * Daily workflow integration test.
 *
 * Covers the full lifecycle:
 *   Phase 1 — Initial stock in warehouse (pickface + reserve bins)
 *   Phase 2 — Inbound receipt adds stock
 *   Phase 3 — FEFO allocation generates picklists (SKU grouped)
 *   Phase 4 — Pick execution reduces stock
 *
 * Run: npx tsx src/daily-workflow.test.ts
 */
import { strict as assert } from 'node:assert';
import { allocate, relocateByWaveOrder } from './allocator.js';
import { computeStockAfterMovements } from './ledger.js';
import { derivePickfaces } from './pickface.js';
import { buildPicklists } from './picklist.js';
import { withConfig } from './config.js';
import type { StockBin, DemandLine, Picklist } from './types.js';

// ── tiny test runner ─────────────────────────────────────────────────────────

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

function gte(actual: number, min: number, label: string) {
  if (!(actual >= min)) throw new Error(`${label}: expected >= ${min}, got ${actual}`);
}

function lte(actual: number, max: number, label: string) {
  if (!(actual <= max)) throw new Error(`${label}: expected <= ${max}, got ${actual}`);
}

// ── synthetic data helpers ───────────────────────────────────────────────────

function makeBin(location: string, sku: string, batch: string, expiry: string, qty: number, upp: number): StockBin {
  return {
    binId: `${location}|${sku}|${batch}`,
    location,
    aisle: location.slice(0, 2),
    bay: parseInt(location.slice(2, 4)),
    level: location.slice(4, 5),
    position: parseInt(location.slice(5, 7)),
    sku, description: `SKU ${sku}`, batch,
    expiryDate: new Date(expiry), grDate: null,
    qtyCartons: qty, upp, uom: 'CAR', isFullPallet: qty >= upp,
  };
}

function makeDemand(shipment: string, waveNo: string, sku: string, qty: number, upp: number, slot: string | null = null, orderNos: string[] = []): DemandLine {
  return {
    shipmentNumber: shipment, waveNo, orderNos, sku,
    description: `Product ${sku}`, qtyCartons: qty, upp,
    destination: 'CV MAJU JAYA', shipToLocation: 'CV MAJU JAYA',
    transport: 'LF', truckType: 'LF', slotTime: slot,
    deliveryDate: new Date('2026-09-21'),
  };
}

function stockQty(stock: StockBin[], location: string, sku: string, batch: string): number {
  return stock.find((b) => b.location === location && b.sku === sku && b.batch === batch)?.qtyCartons ?? 0;
}

function totalStock(stock: StockBin[]): number {
  return stock.reduce((s, b) => s + b.qtyCartons, 0);
}

function runAllocate(stock: StockBin[], demand: DemandLine[]) {
  const config = withConfig({ asOf: new Date('2026-09-21') });
  const pickfaces = derivePickfaces(stock, config);
  const result = allocate(stock, demand, config, new Map());
  relocateByWaveOrder(result.lines, pickfaces, config, stock);
  const picklists = buildPicklists(result, demand, config);
  return { result, picklists, pickfaces, config };
}

// ── test data ────────────────────────────────────────────────────────────────

const SKU_A = '550044709';
const SKU_B = '550058592';

// ── Phase 1: Initial stock ──────────────────────────────────────────────────

describe('Phase 1 — Initial stock in warehouse', () => {
  const stock: StockBin[] = [
    makeBin('CB02A01', SKU_A, '03I26JJ', '2030-09-03', 48, 48),
    makeBin('CB02D01', SKU_A, '03I26JJ', '2030-09-03', 48, 48),
    makeBin('CC36A01', SKU_B, '04I26JJ', '2030-09-04', 44, 44),
    makeBin('CB05D01', SKU_B, '04I26JJ', '2030-09-04', 44, 44),
  ];
  const config = withConfig({ asOf: new Date('2026-09-21') });

  it('SKU A pickface has 48 cartons', () => { eq(stockQty(stock, 'CB02A01', SKU_A, '03I26JJ'), 48, 'pickface'); });
  it('SKU A reserve has 48 cartons', () => { eq(stockQty(stock, 'CB02D01', SKU_A, '03I26JJ'), 48, 'reserve'); });
  it('SKU B pickface has 44 cartons', () => { eq(stockQty(stock, 'CC36A01', SKU_B, '04I26JJ'), 44, 'pickface'); });
  it('SKU B reserve has 44 cartons', () => { eq(stockQty(stock, 'CB05D01', SKU_B, '04I26JJ'), 44, 'reserve'); });
  it('Total stock = 184', () => { eq(totalStock(stock), 184, 'total'); });
  it('Pickface derivation correct', () => {
    const pf = derivePickfaces(stock, config);
    eq(pf.get(SKU_A)?.location, 'CB02A01', 'SKU A');
    eq(pf.get(SKU_B)?.location, 'CC36A01', 'SKU B');
  });
});

// ── Phase 2: Inbound adds stock ─────────────────────────────────────────────

describe('Phase 2 — Inbound receipt adds stock', () => {
  let stock: StockBin[] = [
    makeBin('CB02A01', SKU_A, '03I26JJ', '2030-09-03', 48, 48),
    makeBin('CB02D01', SKU_A, '03I26JJ', '2030-09-03', 48, 48),
    makeBin('CC36A01', SKU_B, '04I26JJ', '2030-09-04', 44, 44),
    makeBin('CB05D01', SKU_B, '04I26JJ', '2030-09-04', 44, 44),
  ];

  it('Before inbound: 184', () => { eq(totalStock(stock), 184, 'before'); });

  it('+24 SKU A at pickface → 72', () => {
    stock = stock.map((b) => b.location === 'CB02A01' && b.sku === SKU_A ? { ...b, qtyCartons: b.qtyCartons + 24 } : b);
    eq(stockQty(stock, 'CB02A01', SKU_A, '03I26JJ'), 72, 'pickface');
    eq(totalStock(stock), 208, 'total');
  });

  it('+20 SKU B at reserve → 64', () => {
    stock = stock.map((b) => b.location === 'CB05D01' && b.sku === SKU_B ? { ...b, qtyCartons: b.qtyCartons + 20 } : b);
    eq(stockQty(stock, 'CB05D01', SKU_B, '04I26JJ'), 64, 'reserve');
    eq(totalStock(stock), 228, 'total');
  });
});

// ── Phase 3: Allocation generates picklists ──────────────────────────────────

describe('Phase 3 — FEFO allocation generates picklists', () => {
  // SKU A: pickface has only5 cartons (open). Demand=15 exceeds pickface,
  // so allocator breaks a sealed pallet in reserve (Level D). The sisa (38)
  // relocates from CB02D01 → CB02A01 via bin-to-bin.
  // SKU B: pickface has enough stock (30, open). Demand=20 satisfied entirely
  // from pickface — no reserve pick needed.
  const stock: StockBin[] = [
    makeBin('CB02A01', SKU_A, '03I26JJ', '2030-09-03', 5, 48),   // open pickface
    makeBin('CB02D01', SKU_A, '03I26JJ', '2030-09-03', 48, 48),  // sealed reserve
    makeBin('CC36A01', SKU_B, '04I26JJ', '2030-09-04', 30, 44),  // open pickface
    makeBin('CB05D01', SKU_B, '04I26JJ', '2030-09-04', 64, 44),  // sealed reserve
  ];
  const demand: DemandLine[] = [
    makeDemand('SHP-001', '1', SKU_A, 15, 48, '01:17', ['ORD-001']),
    makeDemand('SHP-001', '1', SKU_B, 20, 44, '01:17', ['ORD-002']),
  ];
  const { result, picklists } = runAllocate(stock, demand);

  it('Allocates all 35 cartons', () => { eq(result.stats.cartonsAllocated, 35, 'allocated'); });
  it('No shortages', () => { eq(result.shortages.length, 0, 'shortages'); });
  it('1 pallet broken (SKU A reserve)', () => { eq(result.stats.palletsBroken, 1, 'broken'); });

  it('SKU A: 5 from pickface + 10 from reserve (break)', () => {
    const lines = result.lines.filter((l) => l.sku === SKU_A);
    eq(lines.length, 2, 'lines');
    const pf = lines.find((l) => l.location === 'CB02A01')!;
    const rv = lines.find((l) => l.location === 'CB02D01')!;
    eq(pf.qtyPick, 5, 'PF pick'); eq(pf.breaksPallet, false, 'PF no break');
    eq(rv.qtyPick, 10, 'RV pick'); eq(rv.breaksPallet, true, 'RV breaks');
    eq(rv.qtyRemainingInBin, 38, 'RV sisa');
  });

  it('SKU B: 20 from pickface (no break)', () => {
    const l = picklists[0].lines.find((x) => x.sku === SKU_B)!;
    eq(l.location, 'CC36A01', 'loc'); eq(l.qtyPick, 20, 'pick');
    eq(l.qtyRemainingInBin, 10, 'sisa'); eq(l.breaksPallet, false, 'no break');
  });

  it('Picklist grouped by SKU', () => {
    eq(picklists[0].lines[0].sku, SKU_A, 'first');
    eq(picklists[0].lines[1].sku === SKU_A || picklists[0].lines[2]?.sku === SKU_B, true, 'B after A');
  });
});

// ── Phase 4: Stock reduction after pick execution ───────────────────────────

describe('Phase 4 — Stock reduction after pick execution', () => {
  const stock: StockBin[] = [
    makeBin('CB02A01', SKU_A, '03I26JJ', '2030-09-03', 5, 48),   // open pickface
    makeBin('CB02D01', SKU_A, '03I26JJ', '2030-09-03', 48, 48),  // sealed reserve
    makeBin('CC36A01', SKU_B, '04I26JJ', '2030-09-04', 30, 44),  // open pickface
    makeBin('CB05D01', SKU_B, '04I26JJ', '2030-09-04', 64, 44),  // sealed reserve
  ];
  const demand: DemandLine[] = [
    makeDemand('SHP-001', '1', SKU_A, 15, 48, '01:17', ['ORD-001']),
    makeDemand('SHP-001', '1', SKU_B, 20, 44, '01:17', ['ORD-002']),
  ];
  const { result, pickfaces } = runAllocate(stock, demand);
  const after = computeStockAfterMovements(stock, result.lines, pickfaces);

  it('SKU A pickface: 5→38 (picked 5, received 38 reloc from reserve)', () => {
    eq(stockQty(after, 'CB02A01', SKU_A, '03I26JJ'), 38, 'pickface');
  });
  it('SKU A reserve: 48→0 (picked 10, relocated out 38)', () => {
    eq(stockQty(after, 'CB02D01', SKU_A, '03I26JJ'), 0, 'reserve');
  });
  it('SKU B pickface: 30→10 (picked 20)', () => {
    eq(stockQty(after, 'CC36A01', SKU_B, '04I26JJ'), 10, 'pickface');
  });
  it('SKU B reserve: 64 unchanged (not touched)', () => {
    eq(stockQty(after, 'CB05D01', SKU_B, '04I26JJ'), 64, 'reserve');
  });
  it('Total: 147−35=112', () => { eq(totalStock(after), 112, 'total'); });
  it('Conservation: final=initial−picked', () => {
    const picked = result.lines.reduce((s, l) => s + l.qtyPick, 0);
    eq(totalStock(after), totalStock(stock) - picked, 'conservation');
  });
});

// ── Phase 5: Full cycle ─────────────────────────────────────────────────────

describe('Phase 5 — Full cycle: stock → inbound → allocate → pick', () => {
  let stock: StockBin[] = [
    makeBin('CB02A01', SKU_A, '03I26JJ', '2030-09-03', 48, 48),
    makeBin('CB02D01', SKU_A, '03I26JJ', '2030-09-03', 48, 48),
    makeBin('CC36A01', SKU_B, '04I26JJ', '2030-09-04', 44, 44),
    makeBin('CB05D01', SKU_B, '04I26JJ', '2030-09-04', 44, 44),
  ];

  it('Step 1: initial = 184', () => { eq(totalStock(stock), 184, 'initial'); });

  it('Step 2: inbound +24 A, +20 B → 228', () => {
    stock = stock.map((b) => {
      if (b.location === 'CB02A01' && b.sku === SKU_A) return { ...b, qtyCartons: b.qtyCartons + 24 };
      if (b.location === 'CB05D01' && b.sku === SKU_B) return { ...b, qtyCartons: b.qtyCartons + 20 };
      return b;
    });
    eq(totalStock(stock), 228, 'after inbound');
  });

  let result: ReturnType<typeof allocate>;
  let picklists: Picklist[];

  it('Step 3: allocate 15 A + 30 B', () => {
    const demand = [makeDemand('SHP-001', '1', SKU_A, 15, 48, '01:17', ['ORD-001']), makeDemand('SHP-001', '1', SKU_B, 30, 44, '01:17', ['ORD-002'])];
    const r = runAllocate(stock, demand);
    result = r.result; picklists = r.picklists;
    eq(result.stats.cartonsAllocated, 45, 'allocated');
  });

  it('Step 4: grouped by SKU', () => {
    eq(picklists![0].lines[0].sku, SKU_A, 'first');
    eq(picklists![0].lines[1].sku, SKU_B, 'second');
  });

  it('Step 5: stock after = 183', () => {
    const { pickfaces } = runAllocate(stock, [makeDemand('SHP-001', '1', SKU_A, 15, 48), makeDemand('SHP-001', '1', SKU_B, 30, 44)]);
    const after = computeStockAfterMovements(stock, result!.lines, pickfaces);
    eq(totalStock(after), 183, 'total');
    eq(stockQty(after, 'CB02A01', SKU_A, '03I26JJ'), 57, 'A pickface');
    eq(stockQty(after, 'CC36A01', SKU_B, '04I26JJ'), 14, 'B pickface');
  });
});

// ── Phase 6: Multi-wave with SKU grouping ───────────────────────────────────

describe('Phase 6 — Multi-wave with SKU grouping', () => {
  const stock: StockBin[] = [
    makeBin('CB02A01', SKU_A, '03I26JJ', '2030-09-03', 72, 48),
    makeBin('CB02D01', SKU_A, '03I26JJ', '2030-09-03', 48, 48),
    makeBin('CC36A01', SKU_B, '04I26JJ', '2030-09-04', 44, 44),
    makeBin('CB05D01', SKU_B, '04I26JJ', '2030-09-04', 64, 44),
  ];
  const demand: DemandLine[] = [
    makeDemand('SHP-001', '1', SKU_A, 10, 48, '01:17', ['ORD-001']),
    makeDemand('SHP-001', '1', SKU_B, 20, 44, '01:17', ['ORD-002']),
    makeDemand('SHP-002', '2', SKU_A, 8, 48, '02:17', ['ORD-003']),
    makeDemand('SHP-002', '2', SKU_B, 15, 44, '02:17', ['ORD-004']),
  ];
  const { result, picklists } = runAllocate(stock, demand);

  it('2 picklists', () => { eq(picklists.length, 2, 'count'); });

  it('Wave 1 grouped by SKU', () => {
    const w1 = picklists.find((p) => p.waveNo === '1')!;
    const skus = w1.lines.map((l) => l.sku);
    const lastA = skus.lastIndexOf(SKU_A);
    const firstB = skus.indexOf(SKU_B);
    if (lastA >= 0 && firstB >= 0) gte(firstB, lastA + 1, 'A before B');
  });

  it('Wave 2 grouped by SKU', () => {
    const w2 = picklists.find((p) => p.waveNo === '2')!;
    const skus = w2.lines.map((l) => l.sku);
    const lastA = skus.lastIndexOf(SKU_A);
    const firstB = skus.indexOf(SKU_B);
    if (lastA >= 0 && firstB >= 0) gte(firstB, lastA + 1, 'A before B');
  });

  it('Total = 53', () => { eq(result.stats.cartonsAllocated, 53, 'total'); });
  it('Stock after = 175', () => {
    const after = computeStockAfterMovements(stock, result.lines, derivePickfaces(stock, withConfig({ asOf: new Date('2026-09-21') })));
    eq(totalStock(after), 175, 'after');
  });
});

// ── Phase 7: Pallet break with relocation ────────────────────────────────────

describe('Phase 7 — Pallet break with relocation', () => {
  const UPP = 48;
  const stock: StockBin[] = [
    makeBin('CB02D01', SKU_A, '03I26JJ', '2030-09-03', UPP, UPP),
    makeBin('CB02D02', SKU_A, '03I26JJ', '2030-09-03', UPP, UPP),
  ];
  const demand = [makeDemand('SHP-001', '1', SKU_A, 15, UPP, '01:17', ['ORD-001'])];
  const { result, pickfaces } = runAllocate(stock, demand);

  it('Allocates 15, breaks 1 pallet', () => {
    eq(result.stats.cartonsAllocated, 15, 'allocated');
    eq(result.stats.palletsBroken, 1, 'broken');
  });
  it('CASE pick from reserve', () => {
    eq(result.lines[0].pickType, 'CASE', 'type');
    eq(result.lines[0].breaksPallet, true, 'breaks');
  });
  it('Source sisa = 33', () => { eq(result.lines[0].qtyRemainingInBin, 33, 'sisa'); });
  it('Stock conserved: 96−15=81', () => {
    const after = computeStockAfterMovements(stock, result.lines, pickfaces);
    eq(totalStock(after), 81, 'total');
  });
});

// ── Phase 8: Shortage ────────────────────────────────────────────────────────

describe('Phase 8 — Shortage detection', () => {
  const stock = [makeBin('CB02A01', SKU_A, '03I26JJ', '2030-09-03', 10, 48)];
  const demand = [makeDemand('SHP-001', '1', SKU_A, 20, 48, '01:17', ['ORD-001'])];
  const { result } = runAllocate(stock, demand);

  it('10 allocated, short 10', () => {
    eq(result.stats.cartonsAllocated, 10, 'allocated');
    eq(result.shortages.length, 1, 'count');
    eq(result.shortages[0].qtyShort, 10, 'short');
    eq(result.shortages[0].reason, 'NO_STOCK', 'reason');
  });
});

// ── Phase 9: FEFO ────────────────────────────────────────────────────────────

describe('Phase 9 — FEFO earliest expiry first', () => {
  // Both batches in reserve (Level D). No Level A stock → pickface auto-created
  // at Level A but empty. Allocator falls through to reserve pool where FEFO
  // picks BATCH-EARLY (24) before BATCH-LATE (6).
  const stock = [
    makeBin('CB02D01', SKU_A, 'BATCH-EARLY', '2030-06-01', 24, 48),
    makeBin('CB02D02', SKU_A, 'BATCH-LATE', '2031-01-01', 48, 48),
  ];
  const demand = [makeDemand('SHP-001', '1', SKU_A, 30, 48, '01:17', ['ORD-001'])];
  const { result } = runAllocate(stock, demand);

  it('Takes 24 from early expiry', () => {
    const l = result.lines.find((x) => x.batch === 'BATCH-EARLY');
    assert.ok(l, 'exists'); eq(l!.qtyPick, 24, 'qty');
  });
  it('Takes 6 from late expiry', () => {
    const l = result.lines.find((x) => x.batch === 'BATCH-LATE');
    assert.ok(l, 'exists'); eq(l!.qtyPick, 6, 'qty');
  });
  it('Early before late', () => {
    const es = result.lines.find((x) => x.batch === 'BATCH-EARLY')!.seq;
    const ls = result.lines.find((x) => x.batch === 'BATCH-LATE')!.seq;
    lte(es, ls, 'order');
  });
});

// ── Phase 10: Shipment-keyed picklists ───────────────────────────────────────

describe('Phase 10 — picklists are generated per shipment, not per NO wave', () => {
  const stock: StockBin[] = [
    makeBin('CB02A01', SKU_A, '03I26JJ', '2030-09-03', 72, 48),
    makeBin('CB02D01', SKU_A, '03I26JJ', '2030-09-03', 48, 48),
    makeBin('CC36A01', SKU_B, '04I26JJ', '2030-09-04', 44, 44),
    makeBin('CB05D01', SKU_B, '04I26JJ', '2030-09-04', 64, 44),
  ];
  // Two shipments share the SAME NO wave "7" — they must still split into
  // two picklists because grouping is by shipment number (column D).
  const demand: DemandLine[] = [
    makeDemand('SHP-100', '7', SKU_A, 10, 48, '03:17', ['ORD-100']),
    makeDemand('SHP-200', '7', SKU_B, 10, 44, '03:17', ['ORD-200']),
  ];
  const { result, picklists } = runAllocate(stock, demand);

  it('Allocates all 20 cartons, no shortages', () => {
    eq(result.stats.cartonsAllocated, 20, 'allocated');
    eq(result.shortages.length, 0, 'shortages');
  });

  it('2 picklists — one per shipment despite sharing NO wave 7', () => {
    eq(picklists.length, 2, 'count');
    for (const p of picklists) eq(p.waveNo, '7', 'wave label');
  });

  it('Picklist IDs keyed by shipment number', () => {
    const ids = picklists.map((p) => p.picklistId).sort();
    eq(ids[0], 'PL-SHP-100', 'first');
    eq(ids[1], 'PL-SHP-200', 'second');
  });

  it('Each picklist holds only its own shipment lines', () => {
    for (const p of picklists) {
      const shp = p.shipmentNumbers[0];
      eq(p.lines.every((l) => l.shipmentNumber === shp), true, `${p.picklistId} lines match`);
      eq(p.lines.some((l) => l.shipmentNumber !== shp), false, `${p.picklistId} no foreign lines`);
    }
  });
});

// ── print results ────────────────────────────────────────────────────────────

console.log('\n' + '─'.repeat(60));
console.log(`  ${passed} passed, ${failed} failed`);
if (failures.length > 0) { console.log('\n  Failures:'); for (const f of failures) console.log(f); }
console.log('─'.repeat(60));
process.exit(failed > 0 ? 1 : 0);
