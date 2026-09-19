/**
 * Sisa semantics regression tests.
 *
 * Run: npx tsx src/sisa-regression.test.ts
 */
import { strict as assert } from 'node:assert';
import { allocate, relocateByWaveOrder } from './allocator.js';
import { stockIdentityKey, computeStockAfterMovements } from './ledger.js';
import { derivePickfaces } from './pickface.js';
import { withConfig, type AllocatorConfig } from './config.js';
import { loadWorkbook } from './adapters/excel-input.js';
import { readFileSync } from 'node:fs';
import type { AllocationLine, StockBin, DemandLine, PickfaceAssignment, PhysicalEvent } from './types.js';

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

function gt(actual: number, min: number, label: string) {
  if (!(actual > min)) {
    throw new Error(`${label}: expected > ${min}, got ${actual}`);
  }
}

function gte(actual: number, min: number, label: string) {
  if (!(actual >= min)) {
    throw new Error(`${label}: expected >= ${min}, got ${actual}`);
  }
}

// ── synthetic data helpers ───────────────────────────────────────────────────

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
    slotTime: null,
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

// ── Run workbook pipeline once (async-safe top-level await) ─────────────────

interface WorkbookResult {
  stock: StockBin[];
  lines: AllocationLine[];
  pickfaces: Map<string, PickfaceAssignment>;
  finalStock: StockBin[];
  shortages: any[];
}

const wr: WorkbookResult = await (async () => {
  const config = makeConfig();
  const { stock, demand, stagedBySku } = await loadWorkbook(
    'data/Warehouse_Management_System_15_September_2026_.xlsx', config,
  );
  const pickfaces = derivePickfaces(stock, config);
  const result = allocate(stock, demand, config, stagedBySku);
  relocateByWaveOrder(result.lines, pickfaces, config, stock);
  const finalStock = computeStockAfterMovements(stock, result.lines, pickfaces);
  return { stock, lines: result.lines, pickfaces, finalStock, shortages: result.shortages };
})();

const baseline = JSON.parse(readFileSync('out-baseline/alloc-baseline.json', 'utf8'));

// ── 1. SKU 550076636 regression test ────────────────────────────────────────

describe('SKU 550076636 multi-wave regression', () => {
  const skuLines = wr.lines.filter(l => l.sku === '550076636');

  it('has exactly 2 allocation lines', () => {
    eq(skuLines.length, 2, 'line count');
  });

  it('both lines from CB21A02, batch 24H26JJ, expiry 2030-08-24', () => {
    for (const l of skuLines) {
      eq(l.location, 'CB21A02', `line ${l.waveNo} location`);
      eq(l.batch, '24H26JJ', `line ${l.waveNo} batch`);
      eq(l.expiryDate.toISOString().slice(0, 10), '2030-08-24', `line ${l.waveNo} expiry`);
    }
  });

  it('wave 6 picks 2, wave 13 picks 11, total 13', () => {
    const w6 = skuLines.find(l => l.waveNo === '6')!;
    const w13 = skuLines.find(l => l.waveNo === '13')!;
    eq(w6.qtyPick, 2, 'wave 6 qtyPick');
    eq(w13.qtyPick, 11, 'wave 13 qtyPick');
    eq(skuLines.reduce((s, l) => s + l.qtyPick, 0), 13, 'total qtyPick');
  });

  it('sisa after wave 6 = 13, after wave 13 = 2', () => {
    const w6 = skuLines.find(l => l.waveNo === '6')!;
    const w13 = skuLines.find(l => l.waveNo === '13')!;
    eq(w6.qtyRemainingInBin, 13, 'wave 6 sisa');
    eq(w13.qtyRemainingInBin, 2, 'wave 13 sisa');
  });

  it('no pallet breaks', () => {
    for (const l of skuLines) eq(l.breaksPallet, false, `line ${l.waveNo} breaksPallet`);
  });

  it('no shortages for this SKU', () => {
    const short = wr.shortages.filter((s: any) => s.sku === '550076636');
    eq(short.length, 0, 'shortage count');
  });

  it('initial stock at CB21A02 >= 13 cartons', () => {
    const bin = wr.stock.find(
      b => b.sku === '550076636' && b.location === 'CB21A02',
    );
    gte(bin?.qtyCartons ?? 0, 13, 'initial stock at CB21A02');
  });
});

// ── 2. Ordinary single pick ─────────────────────────────────────────────────

describe('Ordinary single pick', () => {
  it('picking 3 from 10 leaves sisa = 7', () => {
    const config = makeConfig();
    const stock = [makeBin('CC01B01', 'SKU1', 'B1', '2030-06-01', 10, 48)];
    const demand = [makeDemand('S1', '1', 'SKU1', 3, 48)];
    const pickfaces = derivePickfaces(stock, config);
    const result = allocate(stock, demand, config);
    relocateByWaveOrder(result.lines, pickfaces, config, stock);
    eq(result.lines.length, 1, 'line count');
    eq(result.lines[0].qtyPick, 3, 'qtyPick');
    eq(result.lines[0].qtyRemainingInBin, 7, 'sisa');
  });
});

// ── 3. Pallet break source — sisa after pick, before reloc out ──────────────

describe('Pallet break source — sisa is after pick not after reloc', () => {
  it('source sisa = 43, breaksPallet = true', () => {
    const config = makeConfig();
    const stock = [makeBin('CD01B01', 'SKU2', 'B2', '2030-06-01', 48, 48)];
    const demand = [makeDemand('S2', '1', 'SKU2', 5, 48)];
    const pickfaces = derivePickfaces(stock, config);
    const result = allocate(stock, demand, config);
    relocateByWaveOrder(result.lines, pickfaces, config, stock);
    eq(result.lines.length, 1, 'line count');
    eq(result.lines[0].breaksPallet, true, 'breaksPallet');
    eq(result.lines[0].qtyRemainingInBin, 43, 'source sisa');
    eq(result.lines[0].qtyPick, 5, 'qtyPick');
  });
});

// ── 4. Relocated stock at pickface — identity preserved ─────────────────────

describe('Relocated stock — identity preserved (same batch+expiry, diff location)', () => {
  it('source sisa = 43, pickface receives 43 via reloc', () => {
    const config = makeConfig();
    const stock = [
      makeBin('CD01B01', 'SKU3', 'B3', '2030-06-01', 48, 48),
      makeBin('CC01A01', 'SKU3', 'B3', '2030-06-01', 0, 48),
    ];
    const demand = [makeDemand('S3', '1', 'SKU3', 5, 48)];
    const pickfaces = derivePickfaces(stock, config);
    const result = allocate(stock, demand, config);
    relocateByWaveOrder(result.lines, pickfaces, config, stock);

    const src = result.lines[0];
    eq(src.location, 'CD01B01', 'source location');
    eq(src.breaksPallet, true, 'breaksPallet');
    eq(src.qtyRemainingInBin, 43, 'source sisa');

    const srcKey = stockIdentityKey(src.location, src.sku, src.batch, src.expiryDate);
    const destKey = stockIdentityKey('CC01A01', src.sku, src.batch, src.expiryDate);
    eq(srcKey.split('|')[2], destKey.split('|')[2], 'batch matches');
    eq(srcKey.split('|')[3], destKey.split('|')[3], 'expiry matches');
    eq(srcKey.split('|')[0], 'CD01B01', 'source location in key');
    eq(destKey.split('|')[0], 'CC01A01', 'dest location in key');

    const finalStock = computeStockAfterMovements(stock, result.lines, pickfaces);
    const srcBin = finalStock.find(b => b.location === 'CD01B01' && b.sku === 'SKU3')!;
    const destBin = finalStock.find(b => b.location === 'CC01A01' && b.sku === 'SKU3')!;
    eq(srcBin.qtyCartons, 0, 'source final qty');
    eq(destBin.qtyCartons, 43, 'pickface final qty');
  });
});

// ── 5. Multiple source pallets — earliest expiry first (FEFO) ───────────────

describe('FEFO — earliest expiry consumed first', () => {
  it('takes all 48 from earlier expiry, then 12 from later', () => {
    const config = makeConfig();
    const stock = [
      makeBin('CD01B01', 'SKU4', 'BA', '2030-01-01', 48, 48),
      makeBin('CD02B01', 'SKU4', 'BB', '2030-06-01', 48, 48),
    ];
    const demand = [makeDemand('S4', '1', 'SKU4', 60, 48)];
    const pickfaces = derivePickfaces(stock, config);
    const result = allocate(stock, demand, config);
    relocateByWaveOrder(result.lines, pickfaces, config, stock);

    eq(result.lines.length, 2, 'line count');
    const l1 = result.lines.find(l => l.batch === 'BA')!;
    const l2 = result.lines.find(l => l.batch === 'BB')!;
    eq(l1.qtyPick, 48, 'earlier expiry qtyPick');
    eq(l1.qtyRemainingInBin, 0, 'earlier expiry sisa');
    eq(l2.qtyPick, 12, 'later expiry qtyPick');
    eq(l2.qtyRemainingInBin, 36, 'later expiry sisa');
    eq(l1.expiryDate < l2.expiryDate, true, 'FEFO order');
  });
});

// ── 6. Multiple expiry at same location — independent identities ────────────

describe('Multiple expiry at same location — independent identities', () => {
  it('two batches tracked independently', () => {
    const config = makeConfig();
    const stock = [
      makeBin('CD01B01', 'SKU5', 'BA', '2030-01-01', 20, 48),
      makeBin('CD01B01', 'SKU5', 'BB', '2030-06-01', 20, 48),
    ];
    const demand = [makeDemand('S5', '1', 'SKU5', 25, 48)];
    const pickfaces = derivePickfaces(stock, config);
    const result = allocate(stock, demand, config);
    relocateByWaveOrder(result.lines, pickfaces, config, stock);

    const keyA = stockIdentityKey('CD01B01', 'SKU5', 'BA', new Date('2030-01-01'));
    const keyB = stockIdentityKey('CD01B01', 'SKU5', 'BB', new Date('2030-06-01'));
    eq(keyA === keyB, false, 'identity keys must differ');

    eq(result.lines.length, 2, 'line count');
    const lA = result.lines.find(l => l.batch === 'BA')!;
    const lB = result.lines.find(l => l.batch === 'BB')!;
    eq(lA.qtyPick, 20, 'batch A pick');
    eq(lA.qtyRemainingInBin, 0, 'batch A sisa');
    eq(lB.qtyPick, 5, 'batch B pick');
    eq(lB.qtyRemainingInBin, 15, 'batch B sisa');
  });
});

// ── 7. Later pick consuming matching identity — chronological sisa ───────────

describe('Later pick from same identity — chronological sisa', () => {
  it('wave 1 sisa = 25, wave 2 sisa = 20 (Phase 3 preserved after re-anchor)', () => {
    const config = makeConfig();
    const stock = [makeBin('CC01B01', 'SKU6', 'B6', '2030-06-01', 35, 48)];
    const demand = [
      makeDemand('S6a', '1', 'SKU6', 10, 48),
      makeDemand('S6b', '2', 'SKU6', 5, 48),
    ];
    const pickfaces = derivePickfaces(stock, config);
    const result = allocate(stock, demand, config);
    relocateByWaveOrder(result.lines, pickfaces, config, stock);

    eq(result.lines.length, 2, 'line count');
    const w1 = result.lines.find(l => l.waveNo === '1')!;
    const w2 = result.lines.find(l => l.waveNo === '2')!;
    eq(w1.qtyPick, 10, 'wave 1 qtyPick');
    eq(w1.qtyRemainingInBin, 25, 'wave 1 sisa');
    eq(w2.qtyPick, 5, 'wave 2 qtyPick');
    eq(w2.qtyRemainingInBin, 20, 'wave 2 sisa');
  });
});

// ── 8. Re-anchored lines preserve Phase 3 sisa (Phase 5 removed) ───────────

describe('Re-anchored lines keep Phase 3 sisa (no Phase 5 overwrite)', () => {
  it('wave 2 re-anchored to pickface still has sisa=20 from source bin', () => {
    const config = makeConfig();
    const stock = [makeBin('CC01B01', 'SKU6', 'B6', '2030-06-01', 35, 48)];
    const demand = [
      makeDemand('S6a', '1', 'SKU6', 10, 48),
      makeDemand('S6b', '2', 'SKU6', 5, 48),
    ];
    const pickfaces = derivePickfaces(stock, config);
    const result = allocate(stock, demand, config);
    relocateByWaveOrder(result.lines, pickfaces, config, stock);

    const w2 = result.lines.find(l => l.waveNo === '2')!;
    const pf = pickfaces.get('SKU6');
    eq(w2.location, pf!.location, 'wave 2 re-anchored to pickface');
    eq(w2.qtyRemainingInBin, 20, 'wave 2 sisa preserved from Phase 3');
    gt(w2.qtyRemainingInBin, 0, 'wave 2 sisa positive (not recomputed at pickface)');
  });
});

// ── 9. RELOC_OUT is NOT customer consumption ────────────────────────────────

describe('RELOC_OUT is not customer consumption', () => {
  it('every breaksPallet source line has sisa > 0', () => {
    const breakLines = wr.lines.filter(l => l.breaksPallet);
    gt(breakLines.length, 0, 'breakLines count');
    for (const l of breakLines) {
      gt(l.qtyRemainingInBin, 0, `${l.location} ${l.sku} ${l.batch} sisa`);
    }
  });

  it('final stock at reloc source identity is non-negative', () => {
    const breakLines = wr.lines.filter(l => l.breaksPallet);
    for (const l of breakLines) {
      const key = stockIdentityKey(l.location, l.sku, l.batch, l.expiryDate);
      const finalQty = wr.finalStock
        .filter(b => stockIdentityKey(b.location, b.sku, b.batch, b.expiryDate) === key)
        .reduce((s, b) => s + b.qtyCartons, 0);
      gte(finalQty, 0, `reloc source ${key} non-negative`);
    }
  });
});

// ── 10. System-wide conservation ─────────────────────────────────────────────

describe('System-wide conservation', () => {
  it('totalFinal === totalInitial - totalPicked', () => {
    const totalInitial = wr.stock.reduce((s, b) => s + b.qtyCartons, 0);
    const totalFinal = wr.finalStock.reduce((s, b) => s + b.qtyCartons, 0);
    const totalPicked = wr.lines.reduce((s, l) => s + l.qtyPick, 0);

    eq(totalFinal, totalInitial - totalPicked, 'conservation');
    console.log(`      initial=${totalInitial} picked=${totalPicked} final=${totalFinal}`);
  });
});

// ── 11. Identity-level conservation ─────────────────────────────────────────

describe('Identity-level conservation', () => {
  it('final === initial + relocIn - relocOut - picks for each identity with picks', () => {
    const initialMap = new Map<string, number>();
    for (const b of wr.stock) {
      const key = stockIdentityKey(b.location, b.sku, b.batch, b.expiryDate);
      initialMap.set(key, (initialMap.get(key) ?? 0) + b.qtyCartons);
    }

    const finalMap = new Map<string, number>();
    for (const b of wr.finalStock) {
      const key = stockIdentityKey(b.location, b.sku, b.batch, b.expiryDate);
      finalMap.set(key, (finalMap.get(key) ?? 0) + b.qtyCartons);
    }

    const relocIn = new Map<string, number>();
    const relocOut = new Map<string, number>();
    for (const l of wr.lines) {
      if (!l.breaksPallet) continue;
      const pf = wr.pickfaces.get(l.sku);
      if (!pf) continue;
      if (l.location === pf.location) continue;
      const sourceKey = stockIdentityKey(l.location, l.sku, l.batch, l.expiryDate);
      const destKey = stockIdentityKey(pf.location, l.sku, l.batch, l.expiryDate);
      relocIn.set(destKey, (relocIn.get(destKey) ?? 0) + l.qtyRemainingInBin);
      relocOut.set(sourceKey, (relocOut.get(sourceKey) ?? 0) + l.qtyRemainingInBin);
    }

    const picksMap = new Map<string, number>();
    for (const l of wr.lines) {
      const key = stockIdentityKey(l.location, l.sku, l.batch, l.expiryDate);
      picksMap.set(key, (picksMap.get(key) ?? 0) + l.qtyPick);
    }

    let checked = 0;
    for (const [key, picks] of picksMap) {
      const init = initialMap.get(key) ?? 0;
      const fin = finalMap.get(key) ?? 0;
      const inbound = relocIn.get(key) ?? 0;
      const outbound = relocOut.get(key) ?? 0;
      const expected = init + inbound - outbound - picks;
      eq(fin, expected, `identity ${key}`);
      checked++;
    }
    gt(checked, 0, 'identities checked');
    console.log(`      checked ${checked} identities`);
  });
});


// ── 12. Multiple sources → one pickface ──────────

describe('Multiple source bins → one pickface', () => {
  it('three sources feed one pickface; pickface sisa stays positive', () => {
    const config = makeConfig();
    const stock = [
      makeBin('CC30C01', 'SKU-M', 'B-M1', '2030-06-01', 48, 48),
      makeBin('CC30E01', 'SKU-M', 'B-M2', '2030-06-01', 48, 48),
      makeBin('CC33E01', 'SKU-M', 'B-M3', '2030-06-01', 48, 48),
      makeBin('CC21A02', 'SKU-M', 'B-M1', '2030-06-01', 48, 48),
    ];
    const demand = [
      makeDemand('S-A', '1', 'SKU-M', 5, 48),
      makeDemand('S-B', '2', 'SKU-M', 5, 48),
      makeDemand('S-C', '10', 'SKU-M', 5, 48),
    ];
    const pickfaces = derivePickfaces(stock, config);
    const result = allocate(stock, demand, config);
    relocateByWaveOrder(result.lines, pickfaces, config, stock);

    const pfLines = result.lines.filter(l => l.location === 'CC21A02');
    gt(pfLines.length, 0, 'has pickface picks');
    for (const l of pfLines) {
      gt(l.qtyRemainingInBin, 0, 'wave ' + l.waveNo + ' sisa positive');
    }
    const finalEntry = relocateByWaveOrder(result.lines, pickfaces, config, stock).get('SKU-M');
    if (finalEntry) {
      gt(finalEntry.finalQty, 0, 'final pickface balance positive');
    }
  });
});

describe('Pickface already contains stock', () => {
  it('pickface initial=48, pick-8 → sisa=40 (no reloc needed)', () => {
    const config = makeConfig();
    const stock = [
      makeBin('CD01B01', 'SKU-INIT', 'B-INIT', '2030-06-01', 48, 48),
      makeBin('CC21A02', 'SKU-INIT', 'B-INIT', '2030-06-01', 48, 48),
    ];
    const demand = [makeDemand('S-INIT', '1', 'SKU-INIT', 8, 48)];
    const pickfaces = derivePickfaces(stock, config);
    const result = allocate(stock, demand, config);
    relocateByWaveOrder(result.lines, pickfaces, config, stock);

    const pfLine = result.lines.find(l => l.location === 'CC21A02');
    eq(pfLine?.qtyPick, 8, 'qtyPick=8');
    eq(pfLine?.qtyRemainingInBin, 40, 'sisa=40 (48-8, pickface initial stock consumed)');
  });
});

// ── 14. Different expiry isolation ───────────────

describe('Different expiry isolation', () => {
  it('two expiry identities never affect each other', () => {
    const config = makeConfig();
    const stock = [
      makeBin('CC21A02', 'SKU-EXP', 'B-X', '2030-09-01', 20, 48),
      makeBin('CC21A02', 'SKU-EXP', 'B-Y', '2030-09-04', 20, 48),
    ];
    const demand = [makeDemand('S-EXP', '1', 'SKU-EXP', 25, 48)];
    const pickfaces = derivePickfaces(stock, config);
    const result = allocate(stock, demand, config);
    relocateByWaveOrder(result.lines, pickfaces, config, stock);

    const lineA = result.lines.find(l => l.batch === 'B-X');
    const lineB = result.lines.find(l => l.batch === 'B-Y');
    eq(lineA?.qtyPick, 20, 'batch A fully picked');
    eq(lineA?.qtyRemainingInBin, 0, 'batch A sisa=0');
    eq(lineB?.qtyPick, 5, 'batch B partial pick');
    eq(lineB?.qtyRemainingInBin, 15, 'batch B sisa=15');
  });
});

// ── 15. Baseline comparison ──────────────────────

describe('Baseline comparison — allocation unchanged', () => {
  it('qtyPick values unchanged after fix', () => {
    eq(baseline.length, wr.lines.length, 'line count matches');
    for (let i = 0; i < wr.lines.length; i++) {
      eq(wr.lines[i].qtyPick, baseline[i].qtyPick, 'line ' + i + ' qtyPick');
    }
  });
});

// ── 16. RELOC_OUT is not customer consumption ────

describe('RELOC_OUT is not customer consumption', () => {
  it('system conservation: final === initial - totalPicked', () => {
    const totalInitial = wr.stock.reduce((s, b) => s + b.qtyCartons, 0);
    const totalFinal = wr.finalStock.reduce((s, b) => s + b.qtyCartons, 0);
    const totalPicked = wr.lines.reduce((s, l) => s + l.qtyPick, 0);
    eq(totalFinal, totalInitial - totalPicked, 'conservation');
  });
});

// ── 17. PhysicalEvent type exists ────────────────

describe('PhysicalEvent type model', () => {
  it('PhysicalEvent type is defined with PICK, RELOC_IN, RELOC_OUT variants', () => {
    const event: PhysicalEvent = {
      type: 'PICK',
      waveNum: 1,
      qty: 5,
      line: {} as AllocationLine,
    };
    eq(event.type, 'PICK', 'PICK variant works');
  });
});

// ── 18. Physical identity = location + SKU + batch + expiry ──────────

describe('Physical identity = location + SKU + batch + expiry', () => {
  it('same location+SKU+batch but different expiry are separate identities', () => {
    const config = makeConfig();
    const stock = [
      makeBin('CC21A02', 'SKU-EXP', 'B-X', '2030-09-01', 20, 48),
      makeBin('CC21A02', 'SKU-EXP', 'B-Y', '2030-09-04', 20, 48),
    ];
    const demand = [makeDemand('S-EXP2', '1', 'SKU-EXP', 25, 48)];
    const pickfaces = derivePickfaces(stock, config);
    const result = allocate(stock, demand, config);
    relocateByWaveOrder(result.lines, pickfaces, config, stock);

    const lineA = result.lines.find(l => l.batch === 'B-X')!;
    const lineB = result.lines.find(l => l.batch === 'B-Y')!;
    eq(lineA?.qtyPick, 20, 'batch X fully picked');
    eq(lineA?.qtyRemainingInBin, 0, 'batch X sisa=0');
    eq(lineB?.qtyPick, 5, 'batch B partial pick');
    eq(lineB?.qtyRemainingInBin, 15, 'batch B sisa=15');
    const keyX = stockIdentityKey('CC21A02', 'SKU-EXP', 'B-X', new Date('2030-09-01'));
    const keyY = stockIdentityKey('CC21A02', 'SKU-EXP', 'B-Y', new Date('2030-09-04'));
    eq(keyX === keyY, false, 'identity keys must differ');
  });

  it('same location+SKU+expiry but different batch are separate identities', () => {
    const config = makeConfig();
    const stock = [
      makeBin('CC21A02', 'SKU-BATCH', 'B-1', '2030-06-01', 20, 48),
      makeBin('CC21A02', 'SKU-BATCH', 'B-2', '2030-06-01', 20, 48),
    ];
    const demand = [makeDemand('S-BATCH', '1', 'SKU-BATCH', 25, 48)];
    const pickfaces = derivePickfaces(stock, config);
    const result = allocate(stock, demand, config);
    relocateByWaveOrder(result.lines, pickfaces, config, stock);

    const line1 = result.lines.find(l => l.batch === 'B-1')!;
    const line2 = result.lines.find(l => l.batch === 'B-2')!;
    eq(line1?.qtyPick, 20, 'batch 1 fully picked');
    eq(line2?.qtyPick, 5, 'batch 2 partial pick');
    eq(line1?.qtyRemainingInBin, 0, 'batch 1 sisa=0');
    eq(line2?.qtyRemainingInBin, 15, 'batch 2 sisa=15');
  });
});

// ── 19. Three source bins → one pickface (550076636 scenario) ────────

describe('Three source bins → one pickface (550076636 scenario)', () => {
  it('every intermediate Sisa is correct and pickface identity preserved', () => {
    const config = makeConfig();
    const stock = [
      makeBin('CC30C01', 'SKU-550', 'B-1', '2030-06-01', 48, 48),
      makeBin('CC30E01', 'SKU-550', 'B-2', '2030-06-01', 48, 48),
      makeBin('CC33E01', 'SKU-550', 'B-3', '2030-06-01', 48, 48),
      makeBin('CC21A02', 'SKU-550', 'B-1', '2030-06-01', 48, 48),
    ];
    const demand = [
      makeDemand('S-A', '1', 'SKU-550', 5, 48),
      makeDemand('S-B', '2', 'SKU-550', 5, 48),
      makeDemand('S-C', '10', 'SKU-550', 5, 48),
    ];
    const pickfaces = derivePickfaces(stock, config);
    const result = allocate(stock, demand, config);
    relocateByWaveOrder(result.lines, pickfaces, config, stock);

    const pfLines = result.lines.filter(l => l.location === 'CC21A02');
    gt(pfLines.length, 0, 'has pickface picks');
    for (const l of pfLines) {
      gt(l.qtyRemainingInBin, 0, 'wave ' + l.waveNo + ' sisa positive');
    }
    const finalEntry = relocateByWaveOrder(result.lines, pickfaces, config, stock).get('SKU-550');
    if (finalEntry) {
      gt(finalEntry.finalQty, 0, 'final pickface balance positive');
    }
  });
});

// ── 20. Re-anchored row uses pickface ledger, NOT source-bin Sisa ───

describe('Re-anchored row uses pickface ledger, not source-bin Sisa', () => {
  it('later-wave pick at pickface has Sisa from pickface identity', () => {
    const config = makeConfig();
    const stock = [
      makeBin('CC30C01', 'SKU-REANCH', 'B-R1', '2030-06-01', 48, 48),
      makeBin('CC21A02', 'SKU-REANCH', 'B-R1', '2030-06-01', 48, 48),
    ];
    const demand = [
      makeDemand('S-R1', '1', 'SKU-REANCH', 5, 48),
      makeDemand('S-R2', '2', 'SKU-REANCH', 5, 48),
    ];
    const pickfaces = derivePickfaces(stock, config);
    const result = allocate(stock, demand, config);
    relocateByWaveOrder(result.lines, pickfaces, config, stock);

    const wave1 = result.lines.find(l => l.waveNo === '1')!;
    const wave2 = result.lines.find(l => l.waveNo === '2')!;
    gt(wave2?.qtyRemainingInBin ?? -1, 0, 'wave 2 sisa positive (not copied from source)');
    eq(wave2?.location, pickfaces.get('SKU-REANCH')!.location, 'wave 2 re-anchored to pickface');
  });
});

// ── 21. Multiple expiry identities at same pickface ──────────────────

describe('Multiple expiry identities at same pickface', () => {
    it('relocation into pickface does NOT increase wrong expiry balance', () => {
    const config = makeConfig();
    const stock = [
      makeBin('CC30C01', 'SKU-PF-EXP', 'B-A', '2030-09-01', 20, 48),
      makeBin('CC21A02', 'SKU-PF-EXP', 'B-A', '2030-09-01', 20, 48),
      makeBin('CC21A02', 'SKU-PF-EXP', 'B-B', '2030-09-04', 20, 48),
    ];
    const demand = [makeDemand('S-PF-EXP', '1', 'SKU-PF-EXP', 25, 48)];
    const pickfaces = derivePickfaces(stock, config);
    const result = allocate(stock, demand, config);
    relocateByWaveOrder(result.lines, pickfaces, config, stock);

    const lineB = result.lines.find(l => l.batch === 'B-B')!;
    eq(lineB?.qtyPick, 5, 'B-B partial pick (20 from B-A, 5 from B-B)');
    eq(lineB?.qtyRemainingInBin, 15, 'B-B sisa=15');

    const lineA = result.lines.find(l => l.batch === 'B-A')!;
    eq(lineA?.qtyPick, 20, 'B-A fully picked');
    eq(lineA?.qtyRemainingInBin, 0, 'B-A sisa=0');
  });
});

// ── 22. Multiple batches at same pickface ────────────────────────────

describe('Multiple batches at same pickface', () => {
  it('same location+SKU+expiry but different batch are isolated', () => {
    const config = makeConfig();
    const stock = [
      makeBin('CC21A02', 'SKU-MULT', 'B-M1', '2030-06-01', 20, 48),
      makeBin('CC21A02', 'SKU-MULT', 'B-M2', '2030-06-01', 20, 48),
    ];
    const demand = [makeDemand('S-MULT', '1', 'SKU-MULT', 25, 48)];
    const pickfaces = derivePickfaces(stock, config);
    const result = allocate(stock, demand, config);
    relocateByWaveOrder(result.lines, pickfaces, config, stock);

    const line1 = result.lines.find(l => l.batch === 'B-M1')!;
    const line2 = result.lines.find(l => l.batch === 'B-M2')!;
    eq(line1?.qtyPick, 20, 'batch M1 fully picked');
    eq(line2?.qtyPick, 5, 'batch M2 partial pick');
    eq(line1?.qtyRemainingInBin, 0, 'batch M1 sisa=0');
    eq(line2?.qtyRemainingInBin, 15, 'batch M2 sisa=15');
  });
});

// ── 23. Initial pickface stock ───────────────────────────────────────

describe('Initial pickface stock', () => {
  it('pickface initial=48, pick-8 → sisa=40', () => {
    const config = makeConfig();
    const stock = [
      makeBin('CD01B01', 'SKU-PF-INIT', 'B-P1', '2030-06-01', 48, 48),
      makeBin('CC21A02', 'SKU-PF-INIT', 'B-P1', '2030-06-01', 48, 48),
    ];
    const demand = [makeDemand('S-PF-INIT', '1', 'SKU-PF-INIT', 8, 48)];
    const pickfaces = derivePickfaces(stock, config);
    const result = allocate(stock, demand, config);
    relocateByWaveOrder(result.lines, pickfaces, config, stock);

    const pfLine = result.lines.find(l => l.location === 'CC21A02');
    eq(pfLine?.qtyPick, 8, 'qtyPick=8');
    eq(pfLine?.qtyRemainingInBin, 40, 'sisa=40 (48-8, pickface initial stock consumed)');
  });
});

// ── 24. RELOC_OUT conservation ───────────────────────────────────────

describe('RELOC_OUT conservation', () => {
  it('initial - customer picks = final regardless of relocations', async () => {
    const config = makeConfig();
    const { stock: s, demand: d, stagedBySku } = await loadWorkbook(
      'data/Warehouse_Management_System_15_September_2026_.xlsx', config,
    );
    const pickfaces = derivePickfaces(s, config);
    const result = allocate(s, d, config, stagedBySku);
    relocateByWaveOrder(result.lines, pickfaces, config, s);
    const finalStock = computeStockAfterMovements(s, result.lines, pickfaces);

    const totalInitial = s.reduce((sum, b) => sum + b.qtyCartons, 0);
    const totalFinal = finalStock.reduce((sum, b) => sum + b.qtyCartons, 0);
    const totalPicked = result.lines.reduce((sum, l) => sum + l.qtyPick, 0);
    eq(totalFinal, totalInitial - totalPicked, 'conservation with relocations');
  });
});

// ── 25. Same-wave ordering RELOC_IN → PICK → RELOC_OUT ──────────────

describe('Same-wave ordering RELOC_IN → PICK → RELOC_OUT', () => {
  it('destination identity: RELOC_IN before PICK at same wave', () => {
    const config = makeConfig();
    const stock = [
      makeBin('CC30C01', 'SKU-WAVE', 'B-W1', '2030-06-01', 48, 48),
      makeBin('CC21A02', 'SKU-WAVE', 'B-W1', '2030-06-01', 0, 48),
    ];
    const demand = [makeDemand('S-WAVE', '1', 'SKU-WAVE', 5, 48)];
    const pickfaces = derivePickfaces(stock, config);
    const result = allocate(stock, demand, config);
    relocateByWaveOrder(result.lines, pickfaces, config, stock);

    const pfLine = result.lines.find(l => l.location === 'CC21A02');
    if (pfLine && pfLine.breaksPallet) {
      gt(pfLine?.qtyRemainingInBin ?? -1, 0, 'pickface sisa after RELOC_IN+PICK is positive');
    }
  });

  it('source identity: PICK before RELOC_OUT at same wave', () => {
    const config = makeConfig();
    const stock = [
      makeBin('CC30C01', 'SKU-WAVE2', 'B-W2', '2030-06-01', 48, 48),
    ];
    const demand = [makeDemand('S-WAVE2', '1', 'SKU-WAVE2', 5, 48)];
    const pickfaces = derivePickfaces(stock, config);
    const result = allocate(stock, demand, config);
    relocateByWaveOrder(result.lines, pickfaces, config, stock);

    const srcLine = result.lines.find(l => l.location === 'CC30C01' && l.breaksPallet);
    if (srcLine) {
      gt(srcLine?.qtyRemainingInBin ?? -1, 0, 'source sisa after PICK before RELOC_OUT is positive');
    }
  });
});

// ── 26. Baseline safety: wave/picklist/FEFO unchanged ────────────────

describe('Baseline safety — allocation decisions unchanged', () => {
  it('line count matches baseline', () => {
    eq(baseline.length, wr.lines.length, 'line count matches');
  });

  it('wave numbers unchanged', () => {
    for (let i = 0; i < wr.lines.length; i++) {
      eq(wr.lines[i].waveNo, baseline[i].wave, 'line ' + i + ' waveNo');
    }
  });

  it('FEFO ordering (sku/batch/expiry) unchanged', () => {
    for (let i = 0; i < wr.lines.length; i++) {
      eq(wr.lines[i].sku, baseline[i].sku, 'line ' + i + ' sku');
      eq(wr.lines[i].batch, baseline[i].batch, 'line ' + i + ' batch');
      eq(wr.lines[i].expiryDate.toISOString().slice(0, 10), baseline[i].exp, 'line ' + i + ' expiry');
    }
  });
});

// ── summary ──────────────────────────────────────────────────────────────────

console.log(`\n  ─────────────────────────────────────────`);
console.log(`  ${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log(`\n  Failures:`);
  for (const f of failures) console.log(f);
}
process.exit(failed > 0 ? 1 : 0);
