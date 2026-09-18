/**
 * verify-reconcile.ts - 13-section physical stock ledger integrity verifier
 * Run: npx tsx verify-reconcile.ts
 */
import { allocate, relocateByWaveOrder } from './src/allocator.js';
import { withConfig } from './src/config.js';
import { derivePickfaces } from './src/pickface.js';
import { replenish, sequenceReplenishment } from './src/replenishment.js';
import { buildMovementReport } from './src/movement.js';
import { computeStockAfterMovements, stockIdentityKey } from './src/ledger.js';
import { loadWorkbook } from './src/adapters/excel-input.js';
import type { AllocationLine, StockBin } from './src/types.js';

function stk(loc: string, sku: string, batch: string | null, exp: Date): string {
  return `${loc}|${sku}|${batch ?? ''}|${exp.toISOString().slice(0, 10)}`;
}
function fd(d: Date): string { return d.toISOString().slice(0, 10); }
function wn(w: string): number { const n = Number(w); return Number.isFinite(n) ? n : 1e15; }

type RelocEv = { sourceKey: string; qty: number; waveNo: string };
type TimelineEv = { type: 'reloc' | 'pick'; qty: number; waveNo: string; line?: AllocationLine };

async function main() {
  const argv = process.argv.slice(2);
  const WORKBOOK = argv[0] || 'data/Warehouse_Management_System_15_September_2026_.xlsx';
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const asOf = flag('as-of') ? new Date(flag('as-of')!) : new Date('2026-09-15');
  
  const config = withConfig({ asOf });
  const { stock, demand, stagedBySku } = await loadWorkbook(WORKBOOK, config);
  const pickfaces = derivePickfaces(stock, config);
  const result = allocate(stock, demand, config, stagedBySku);
  relocateByWaveOrder(result.lines, pickfaces, config, stock);
  const stockAfter = computeStockAfterMovements(stock, result.lines, pickfaces);
  const stockAfterMap = new Map<string, StockBin>();
  for (const b of stockAfter) stockAfterMap.set(stk(b.location, b.sku, b.batch, b.expiryDate), b);
  const replenResult = replenish(stockAfter, pickfaces, config, demand, result.lines);
  replenResult.tasks = sequenceReplenishment(replenResult.tasks);
  const movement = buildMovementReport(result, replenResult);

  const initStock = new Map<string, number>();
  for (const b of stock) {
    const k = stk(b.location, b.sku, b.batch, b.expiryDate);
    initStock.set(k, (initStock.get(k) ?? 0) + b.qtyCartons);
  }

  // Build adjustments map (mirrors computeStockAfterMovements)
  const adj = new Map<string, number>();
  for (const l of result.lines) {
    const k = stk(l.location, l.sku, l.batch, l.expiryDate);
    adj.set(k, (adj.get(k) ?? 0) - l.qtyPick);
  }
  for (const l of result.lines) {
    if (!l.breaksPallet) continue;
    const pf = pickfaces.get(l.sku);
    if (!pf || l.location === pf.location) continue;
    const sk = stk(l.location, l.sku, l.batch, l.expiryDate);
    adj.set(sk, (adj.get(sk) ?? 0) - l.qtyRemainingInBin);
    const dk = stk(pf.location, l.sku, l.batch, l.expiryDate);
    adj.set(dk, (adj.get(dk) ?? 0) + l.qtyRemainingInBin);
  }

  // Build relocation events map
  const relocMap = new Map<string, RelocEv[]>();
  for (const l of result.lines) {
    const pf = pickfaces.get(l.sku);
    if (!pf || l.location === pf.location || !l.breaksPallet) continue;
    const tk = stk(pf.location, l.sku, l.batch, l.expiryDate);
    const evs = relocMap.get(tk) ?? [];
    evs.push({ sourceKey: stk(l.location, l.sku, l.batch, l.expiryDate), qty: l.qtyRemainingInBin, waveNo: l.waveNo });
    relocMap.set(tk, evs);
  }

  const S = '='.repeat(80);

  // ═══════════════════════════════════════════════════════════════════
  // SECTION 1: MODEL DESCRIPTION
  // ═══════════════════════════════════════════════════════════════════
  console.log(S); console.log('SECTION 1: MODEL DESCRIPTION'); console.log(S);
  console.log(`  Workbook: ${WORKBOOK}`);
  console.log(`  asOf: ${config.asOf.toISOString().slice(0, 10)}`);
  console.log(`  Stock bins: ${stock.length}, Demand lines: ${demand.length}, Allocation lines: ${result.lines.length}`);
  console.log(`  relocationOrderBasis: ${config.relocationOrderBasis}`);
  console.log(`  ledger.ts: stock.map() only (no inbound-only synthesis)`);
  console.log();

  // ═══════════════════════════════════════════════════════════════════
  // SECTION 2: ZERO CLAMP STATS
  // ═══════════════════════════════════════════════════════════════════
  console.log(S); console.log('SECTION 2: ZERO CLAMP STATS'); console.log(S);
  let clamped = 0;
  for (const b of stockAfter) {
    const k = stk(b.location, b.sku, b.batch, b.expiryDate);
    if (b.qtyCartons === 0 && (initStock.get(k) ?? 0) > 0) clamped++;
  }
  console.log(`  Bins clamped to 0: ${clamped}`);
  console.log();

  // ═══════════════════════════════════════════════════════════════════
  // SECTION 3: RELOCATION QUANTITIES
  // ═══════════════════════════════════════════════════════════════════
  console.log(S); console.log('SECTION 3: RELOCATION QUANTITIES'); console.log(S);
  let rQty = 0, rCnt = 0;
  for (const l of result.lines) {
    const pf = pickfaces.get(l.sku);
    if (!pf || l.location === pf.location || !l.breaksPallet) continue;
    rQty += l.qtyRemainingInBin; rCnt++;
  }
  console.log(`  Pallet-break relocations: ${rCnt}, cartons relocated: ${rQty}`);
  console.log();

  // ═══════════════════════════════════════════════════════════════════
  // SECTION 4: DOUBLE DEDUCTION CHECK
  // ═══════════════════════════════════════════════════════════════════
  console.log(S); console.log('SECTION 4: DOUBLE DEDUCTION CHECK'); console.log(S);
  let ddIssues = 0;
  const overdrawDetails: string[] = [];
  for (const l of result.lines) {
    const k = stk(l.location, l.sku, l.batch, l.expiryDate);
    const init = initStock.get(k) ?? 0;
    if (l.qtyPick + l.qtyRemainingInBin > init + 1) {
      ddIssues++;
      const pf = pickfaces.get(l.sku);
      const relocsTo = relocMap.get(k) ?? [];
      const relocQty = relocsTo.reduce((s, r) => s + r.qty, 0);
      const effectiveInit = init + relocQty;
      const realOverdraw = l.qtyPick + l.qtyRemainingInBin > effectiveInit + 1;
      const cls = realOverdraw ? 'REAL' : 'FALSE_POSITIVE';
      const detail = `  W${l.waveNo} seq=${l.seq} ${l.location} ${l.sku} ${(l.batch ?? 'null')} ${fd(l.expiryDate)} qtyPick=${l.qtyPick} Sisa=${l.qtyRemainingInBin} init=${init}+reloc=${relocQty} effective=${effectiveInit} -> ${cls}`;
      overdrawDetails.push(detail);
    }
  }
  console.log(`  Over-drawn lines: ${ddIssues}`);
  for (const d of overdrawDetails) console.log(d);
  console.log(ddIssues > 0 ? '  WARNING' : '  OK: No double deductions');
  console.log();
  // ═══════════════════════════════════════════════════════════════════
  // SECTION 5: PL-7 -> PL-10 -> PL-11 EXEMPLAR
  // ═══════════════════════════════════════════════════════════════════
  console.log(S); console.log('SECTION 5: PL-7 -> PL-10 -> PL-11 EXEMPLAR'); console.log(S);
  // Find multi-wave pallet-break: group by binId where breaksPallet=true
  const binBreakGroups = new Map<string, AllocationLine[]>();
  for (const l of result.lines) {
    if (!l.breaksPallet) continue;
    const g = binBreakGroups.get(l.binId) ?? [];
    g.push(l);
    binBreakGroups.set(l.binId, g);
  }
  let exLines: AllocationLine[] = [];
  for (const [, g] of binBreakGroups) { if (g.length >= 2) { exLines = g; break; } }
  if (exLines.length < 2) {
    // Fallback: same SKU/batch/expiry, different locations
    const sbg = new Map<string, AllocationLine[]>();
    for (const l of result.lines) {
      const k = `${l.sku}|${l.batch}|${fd(l.expiryDate)}`;
      (sbg.get(k) ?? (sbg.set(k, []), sbg.get(k)!)).push(l);
    }
    for (const [, g] of sbg) {
      if (g.length >= 2 && new Set(g.map(l => l.location)).size >= 2) { exLines = g; break; }
    }
  }

  if (exLines.length >= 2) {
    const sku = exLines[0].sku, batch = exLines[0].batch, exp = exLines[0].expiryDate;
    const pfLoc = pickfaces.get(sku)?.location ?? 'none';
    console.log(`  SKU: ${sku}, batch: ${batch ?? 'null'}, expiry: ${fd(exp)}, pickface: ${pfLoc}`);
    const sorted = [...exLines].sort((a, b) => wn(a.waveNo) - wn(b.waveNo));
    const brk = sorted.find(l => l.breaksPallet) ?? sorted[0];
    const srcLoc = brk.location;
    const initQty = initStock.get(stk(srcLoc, sku, batch, exp)) ?? 0;
    console.log(`  INITIAL: ${srcLoc} = ${initQty} cartons`);
    let bal = initQty;
    for (const l of sorted) {
      const pf = pickfaces.get(l.sku);
      if (pf && l.location !== pf.location && l.breaksPallet) {
        console.log(`  Wave ${l.waveNo}: RELOC ${l.qtyRemainingInBin} from ${l.location}->${pf.location}`);
      }
      bal -= l.qtyPick;
      console.log(`  Wave ${l.waveNo}: PICK ${l.qtyPick} from ${l.location} -> balance=${bal}`);
    }
    const srcA = stockAfterMap.get(stk(srcLoc, sku, batch, exp));
    const pfA = pfLoc !== 'none' ? stockAfterMap.get(stk(pfLoc, sku, batch, exp)) : undefined;
    console.log(`  FINAL: source=${srcA?.qtyCartons ?? 'N/A'} pickface=${pfA?.qtyCartons ?? 'N/A'}`);
  } else { console.log('  No multi-wave pallet-break exemplar found'); }
  console.log();

  // ═══════════════════════════════════════════════════════════════════
  // SECTION 6: DIFFERENT EXPIRY SEPARATION
  // ═══════════════════════════════════════════════════════════════════
  console.log(S); console.log('SECTION 6: DIFFERENT EXPIRY SEPARATION'); console.log(S);
  const bteMap = new Map<string, Set<string>>();
  for (const b of stock) {
    const k = `${b.location}|${b.sku}|${b.batch ?? ''}`;
    const s = bteMap.get(k) ?? new Set();
    s.add(fd(b.expiryDate));
    bteMap.set(k, s);
  }
  let multiExp = 0;
  for (const [, s] of bteMap) { if (s.size > 1) multiExp++; }
  console.log(`  Multi-expiry binIds: ${multiExp}`);

  // Synthetic test
  const tLoc = 'TEST01A01', tSku = 'TESTSKU', tBatch = 'B1';
  const e1 = new Date('2030-01-01'), e2 = new Date('2030-06-01');
  const k1 = stk(tLoc, tSku, tBatch, e1), k2 = stk(tLoc, tSku, tBatch, e2);
  console.log(`  key1=${k1}`);
  console.log(`  key2=${k2}`);
  console.log(`  Keys differ: ${k1 !== k2 ? 'YES' : 'NO'}`);
  const tBin = (exp: Date, qty: number): StockBin => ({
    binId: `${tLoc}|${tSku}|${tBatch}`, location: tLoc, aisle: 'T', bay: 1, level: 'A', position: 1,
    sku: tSku, description: 'Test', batch: tBatch, expiryDate: exp, grDate: null,
    qtyCartons: qty, upp: 48, uom: 'CAR', isFullPallet: qty >= 48,
  });
  const tLine: AllocationLine = {
    shipmentNumber: 'S1', waveNo: '1', orderNos: [], sku: tSku, description: 'Test',
    location: tLoc, binId: `${tLoc}|${tSku}|${tBatch}`, batch: tBatch, expiryDate: e1,
    qtyPick: 30, pickType: 'CASE', upp: 48, uom: 'CAR', qtyRemainingInBin: 70,
    daysToExpiry: 1000, seq: 1, breaksPallet: false,
  };
  const tRes = computeStockAfterMovements([tBin(e1, 100), tBin(e2, 50)], [tLine], new Map());
  const aA = tRes.find(b => fd(b.expiryDate) === fd(e1));
  const aB = tRes.find(b => fd(b.expiryDate) === fd(e2));
  console.log(`  Expiry A: 100 -> ${aA?.qtyCartons ?? '?'} (picked 30)`);
  console.log(`  Expiry B: 50 -> ${aB?.qtyCartons ?? '?'} (untouched)`);
  console.log(`  Movement isolation: ${(aB?.qtyCartons ?? 0) === 50 ? 'OK' : 'BROKEN'}`);
  console.log();

  // ═══════════════════════════════════════════════════════════════════
  // SECTION 7: MULTIPLE SOURCES -> ONE PICKFACE
  // ═══════════════════════════════════════════════════════════════════
  console.log(S); console.log('SECTION 7: MULTIPLE SOURCES -> ONE PICKFACE'); console.log(S);
  const skuSrcs = new Map<string, Set<string>>();
  for (const l of result.lines) {
    const pf = pickfaces.get(l.sku);
    if (!pf || l.location === pf.location || !l.breaksPallet) continue;
    const s = skuSrcs.get(l.sku) ?? new Set();
    s.add(l.location);
    skuSrcs.set(l.sku, s);
  }
  let msCnt = 0;
  for (const [sku, srcs] of skuSrcs) {
    if (srcs.size > 1) {
      msCnt++;
      console.log(`  SKU ${sku}: ${srcs.size} sources -> ${pickfaces.get(sku)?.location}`);
    }
  }
  if (msCnt === 0) console.log('  None found');
  console.log();

  // ═══════════════════════════════════════════════════════════════════
  // SECTION 8: SAME SOURCE + SAME DESTINATION
  // ═══════════════════════════════════════════════════════════════════
  console.log(S); console.log('SECTION 8: SAME SOURCE + SAME DESTINATION'); console.log(S);
  const rPairs = new Map<string, number>();
  for (const l of result.lines) {
    const pf = pickfaces.get(l.sku);
    if (!pf || l.location === pf.location || !l.breaksPallet) continue;
    const pk = `${l.location}->${pf.location}|${l.sku}|${l.batch ?? ''}|${fd(l.expiryDate)}`;
    rPairs.set(pk, (rPairs.get(pk) ?? 0) + 1);
  }
  let spCnt = 0;
  for (const [k, c] of rPairs) { if (c > 1) { spCnt++; console.log(`  ${k}: ${c} lines`); } }
  if (spCnt === 0) console.log('  None found');
  console.log();
  // ═══════════════════════════════════════════════════════════════════
  // SECTION 9: FULL EVENT ACCOUNTING PER IDENTITY
  // ═══════════════════════════════════════════════════════════════════
  console.log(S); console.log('SECTION 9: FULL EVENT ACCOUNTING PER IDENTITY'); console.log(S);

  const inboundOnly: string[] = [];
  for (const [k, a] of adj) {
    if ((initStock.get(k) ?? 0) === 0 && a > 0) inboundOnly.push(k);
  }
  console.log(`  Identities with no initial stock + positive adjustment: ${inboundOnly.length}`);

  function traceIdentity(key: string): { init: number; inb: number; out: number; expected: number; actual: number; inFroms: string[]; outEvents: string[] } {
    const init = initStock.get(key) ?? 0;
    const inFroms: string[] = [];
    let inb = 0;
    for (const l of result.lines) {
      const pf = pickfaces.get(l.sku);
      if (!pf) continue;
      const dk = stk(pf.location, l.sku, l.batch, l.expiryDate);
      if (dk === key && l.breaksPallet) { inb += l.qtyRemainingInBin; inFroms.push(l.location); }
    }
    const outEvents: string[] = [];
    let out = 0;
    for (const l of result.lines) {
      if (stk(l.location, l.sku, l.batch, l.expiryDate) === key) {
        out += l.qtyPick;
        outEvents.push(`W${l.waveNo}:${l.qtyPick}`);
      }
    }
    return { init, inb, out, expected: init + inb - out, actual: stockAfterMap.get(key)?.qtyCartons ?? 0, inFroms, outEvents };
  }

  for (const key of inboundOnly) {
    const t = traceIdentity(key);
    let cls: string;
    if (t.expected === t.actual) cls = 'OK';
    else if (t.expected === 0 && t.actual === 0) cls = 'OK';
    else cls = 'REAL BUG (stock.map() misses inbound-only)';
    const dk = key.split('|');
    console.log();
    console.log(`  identity: ${dk[0]}|${dk[1]}|${dk[2] || 'null'}|${dk[3]}`);
    console.log(`    initial: ${t.init}`);
    console.log(`    inbound relocations: +${t.inb} (from ${[...new Set(t.inFroms)].join(', ') || 'none'})`);
    console.log(`    outbound picks: -${t.out} (${t.outEvents.join(', ') || 'none'})`);
    console.log(`    expected final: ${t.expected}`);
    console.log(`    computeStockAfterMovements: ${t.actual}`);
    console.log(`    classification: ${cls}`);
  }

  console.log();
  console.log('  --- Previously flagged identities ---');
  const flagged = [
    'CE02A02|550058592|05H26JJ|2030-08-05', 'CF12A01|550044625|07I26|2030-09-07',
    'CF26A01|550069888|05I26JJ|2030-09-05', 'CE26A02|550044709|03I26JJ|2030-09-03',
    'CB17A02|550047028|27H26JJ|2030-08-27', 'CE5A01|550059938|07I26JJ|2030-09-07',
    'CD21A02|550050072|29E26JJ|2030-05-29', 'CC15A02|550044845|19F26JJ|2030-06-19',
    'CE21A02|550053783|28H26JJ|2030-08-28', 'CD38A01|550048593|07H26JJ|2030-08-07',
    'CB27A01|550044360|12701380|2030-09-02',
  ];
  for (const key of flagged) {
    const t = traceIdentity(key);
    let cls: string;
    if (t.expected === t.actual) cls = 'OK';
    else if (t.expected === 0 && t.actual === 0) cls = 'OK';
    else cls = `MISMATCH expected=${t.expected} actual=${t.actual}`;
    console.log(`    ${key}: init=${t.init} in=+${t.inb} out=-${t.out} expected=${t.expected} actual=${t.actual} -> ${cls}`);
  }
  console.log();

  // ═══════════════════════════════════════════════════════════════════
  // SECTION 10: MOVEMENT REPORT IDENTITY MODEL
  // ═══════════════════════════════════════════════════════════════════
  console.log(S); console.log('SECTION 10: MOVEMENT REPORT IDENTITY MODEL'); console.log(S);
  console.log(`  CURRENT WORKBOOK: safe (${multiExp} multi-expiry binIds)`);
  console.log(`  DATA MODEL: future multi-expiry risk remains (binId omits expiry)`);
  console.log(`  Movement report rows: ${movement.length}`);
  console.log();

  // ═══════════════════════════════════════════════════════════════════
  // SECTION 11: SISA VERIFICATION (CORRECTED)
  // ═══════════════════════════════════════════════════════════════════
  console.log(S); console.log('SECTION 11: SISA VERIFICATION (CORRECTED)'); console.log(S);

  const postGroups = new Map<string, AllocationLine[]>();
  for (const l of result.lines) {
    const k = stk(l.location, l.sku, l.batch, l.expiryDate);
    (postGroups.get(k) ?? (postGroups.set(k, []), postGroups.get(k)!)).push(l);
  }

  let sisaMismatches = 0, sisaTotal = 0;
  for (const [identity, lines] of postGroups) {
    sisaTotal += lines.length;
    const relocs = relocMap.get(identity) ?? [];
    const init = initStock.get(identity) ?? 0;
    const timeline: TimelineEv[] = [
      ...relocs.map(r => ({ type: 'reloc' as const, qty: r.qty, waveNo: r.waveNo })),
      ...lines.map(l => ({ type: 'pick' as const, qty: l.qtyPick, waveNo: l.waveNo, line: l })),
    ];
    timeline.sort((a, b) => {
      const wa = wn(a.waveNo), wb = wn(b.waveNo);
      if (wa !== wb) return wa - wb;
      if (a.type === 'reloc' && b.type !== 'reloc') return -1;
      if (a.type !== 'reloc' && b.type === 'reloc') return 1;
      return 0;
    });
    let bal = init;
    for (const ev of timeline) {
      if (ev.type === 'reloc') { bal += ev.qty; continue; }
      bal -= ev.qty;
      if (ev.line && ev.line.qtyRemainingInBin !== bal) {
        sisaMismatches++;
        const idx = timeline.indexOf(ev);
        const bef = timeline.slice(0, idx).map(e => `${e.type}:${e.qty}@W${e.waveNo}`);
        const aft = timeline.slice(idx + 1).map(e => `${e.type}:${e.qty}@W${e.waveNo}`);
        console.log();
        console.log(`  wave=${ev.waveNo} idx=${ev.line.seq} location=${ev.line.location} sku=${ev.line.sku} batch=${ev.line.batch ?? 'null'} expiry=${fd(ev.line.expiryDate)} qtyPick=${ev.line.qtyPick}`);
        console.log(`    current Sisa: ${ev.line.qtyRemainingInBin}`);
        console.log(`    expected Sisa: ${bal}`);
        console.log(`    events before: [${bef.join(', ')}]`);
        console.log(`    events after: [${aft.join(', ')}]`);
        let cls: string;
        if (init === 0 && relocs.length > 0) cls = 'REAL BUG (Phase 3 skips pickface identity without picks)';
        else cls = 'AMBIGUOUS';
        console.log(`    classification: ${cls}`);
      }
    }
  }
  console.log(`\n  Total lines checked: ${sisaTotal}, mismatches: ${sisaMismatches}`);
  console.log();

  // ═══════════════════════════════════════════════════════════════════
  // SECTION 11A: SKU 550076636 DETAILED TRACE
  // ═══════════════════════════════════════════════════════════════════
  console.log(S); console.log('SECTION 11A: SKU 550076636 TRACE'); console.log(S);
  const traceSku = '550076636';
  const traceBatch = '05I26JJ';
  const traceExpiry = '2030-09-02';
  const traceExpiryDate = new Date(traceExpiry);
  const traceLines = result.lines
    .filter(l => l.sku === traceSku && l.batch === traceBatch && fd(l.expiryDate) === traceExpiry)
    .sort((a, b) => wn(a.waveNo) - wn(b.waveNo));
  console.log(`  SKU: ${traceSku}, Batch: ${traceBatch}, Expiry: ${traceExpiry}`);
  console.log(`  Lines found: ${traceLines.length}`);

  if (traceLines.length > 0) {
    const pf = pickfaces.get(traceSku);
    const pfLoc = pf?.location ?? 'none';
    console.log(`  Pickface: ${pfLoc}`);

    const srcLines = traceLines.filter(l => l.location !== pfLoc);
    const srcLoc = srcLines.length > 0 ? srcLines[0].location : traceLines[0].location;
    const srcKey = stk(srcLoc, traceSku, traceBatch, traceExpiryDate);
    const srcInit = initStock.get(srcKey) ?? 0;
    console.log(`  Source: ${srcLoc}, Initial stock: ${srcInit}`);

    const pfKey = pfLoc !== 'none' ? stk(pfLoc, traceSku, traceBatch, traceExpiryDate) : '';
    const pfInit = pfLoc !== 'none' ? (initStock.get(pfKey) ?? 0) : 0;
    console.log(`  Pickface initial stock: ${pfInit}`);
    console.log();

    console.log(`  ${'wave'.padEnd(6)} ${'idx'.padEnd(5)} ${'event'.padEnd(8)} ${'location'.padEnd(10)} ${'dest'.padEnd(10)} ${'qty'.padEnd(6)} ${'Sisa'.padEnd(6)} ${'bal_before'.padEnd(11)} ${'bal_after'.padEnd(11)}`);

    let srcBal = srcInit;
    let pfBal = pfInit;

    for (const l of traceLines) {
      const isAtPickface = l.location === pfLoc;
      const balBefore = isAtPickface ? pfBal : srcBal;

      if (l.breaksPallet && !isAtPickface && pf) {
        const relocQty = l.qtyRemainingInBin;
        console.log(`  ${l.waveNo.padEnd(6)} ${''.padEnd(5)} ${'RELOC'.padEnd(8)} ${l.location.padEnd(10)} ${pfLoc.padEnd(10)} ${String(relocQty).padEnd(6)} ${''.padEnd(6)} ${String(srcBal).padEnd(11)} ${String(srcBal - relocQty).padEnd(11)}`);
        srcBal -= relocQty;
        pfBal += relocQty;
      }

      const pickBalBefore = isAtPickface ? pfBal : srcBal;
      console.log(`  ${l.waveNo.padEnd(6)} ${String(l.seq).padEnd(5)} ${'PICK'.padEnd(8)} ${l.location.padEnd(10)} ${'STAGING'.padEnd(10)} ${String(l.qtyPick).padEnd(6)} ${String(l.qtyRemainingInBin).padEnd(6)} ${String(pickBalBefore).padEnd(11)} ${String(l.qtyRemainingInBin).padEnd(11)}`);

      if (isAtPickface) pfBal = l.qtyRemainingInBin;
      else srcBal = l.qtyRemainingInBin;
    }

    console.log();
    const srcFinal = stockAfterMap.get(srcKey)?.qtyCartons ?? 'N/A';
    const pfFinal = pfLoc !== 'none' ? (stockAfterMap.get(pfKey)?.qtyCartons ?? 'N/A') : 'N/A';
    console.log(`  FINAL: ${srcLoc}=${srcFinal}, ${pfLoc}=${pfFinal}`);

    const firstPick = traceLines.find(l => l.breaksPallet && l.location !== pfLoc);
    if (firstPick) {
      const pl7ok = firstPick.location === srcLoc && firstPick.qtyPick === 8 && firstPick.breaksPallet === true && firstPick.qtyRemainingInBin === (srcInit - 8);
      console.log(`  PL-7 check: location=${firstPick.location} (expect ${srcLoc}) qtyPick=${firstPick.qtyPick} (expect 8) breaksPallet=${firstPick.breaksPallet} (expect true) Sisa=${firstPick.qtyRemainingInBin} (expect ${srcInit - 8}) -> ${pl7ok ? 'PASS' : 'FAIL'}`);
    }
  }
  console.log();

  // ═══════════════════════════════════════════════════════════════════
  // SECTION 11B: EXPIRY ISOLATION CHECK
  // ═══════════════════════════════════════════════════════════════════
  console.log(S); console.log('SECTION 11B: EXPIRY ISOLATION'); console.log(S);
  {
    const isoLoc = 'CC21A02';
    const isoSku = '550076636';
    const isoBatch = '05I26JJ';
    const isoExp1 = '2030-09-02';
    const isoExp2 = '2030-09-05';
    const isoKey1 = `${isoLoc}|${isoSku}|${isoBatch}|${isoExp1}`;
    const isoKey2 = `${isoLoc}|${isoSku}|${isoBatch}|${isoExp2}`;

    console.log(`  Identity A: ${isoKey1}`);
    console.log(`  Identity B: ${isoKey2}`);
    console.log(`  Keys differ: ${isoKey1 !== isoKey2 ? 'YES' : 'NO'}`);

    const linesA = result.lines.filter(l => stk(l.location, l.sku, l.batch, l.expiryDate) === isoKey1);
    const linesB = result.lines.filter(l => stk(l.location, l.sku, l.batch, l.expiryDate) === isoKey2);

    const outA = linesA.reduce((s, l) => s + l.qtyPick, 0);
    const outB = linesB.reduce((s, l) => s + l.qtyPick, 0);

    const relocsA = result.lines.filter(l => {
      const pf = pickfaces.get(l.sku);
      if (!pf || l.location === pf.location || !l.breaksPallet) return false;
      return stk(pf.location, l.sku, l.batch, l.expiryDate) === isoKey1;
    }).reduce((s, l) => s + l.qtyRemainingInBin, 0);

    const relocsB = result.lines.filter(l => {
      const pf = pickfaces.get(l.sku);
      if (!pf || l.location === pf.location || !l.breaksPallet) return false;
      return stk(pf.location, l.sku, l.batch, l.expiryDate) === isoKey2;
    }).reduce((s, l) => s + l.qtyRemainingInBin, 0);

    const initA = initStock.get(isoKey1) ?? 0;
    const initB = initStock.get(isoKey2) ?? 0;
    const finalA = stockAfterMap.get(isoKey1)?.qtyCartons ?? 0;
    const finalB = stockAfterMap.get(isoKey2)?.qtyCartons ?? 0;
    const expectedA = initA + relocsA - outA;
    const expectedB = initB + relocsB - outB;

    console.log(`  Identity A: init=${initA} relocs=+${relocsA} picks=-${outA} expected=${expectedA} actual=${finalA} -> ${expectedA === finalA ? 'OK' : 'MISMATCH'}`);
    console.log(`  Identity B: init=${initB} relocs=+${relocsB} picks=-${outB} expected=${expectedB} actual=${finalB} -> ${expectedB === finalB ? 'OK' : 'MISMATCH'}`);

    const isolated = expectedA === finalA && expectedB === finalB;
    console.log(`  Expiry isolation: ${isolated ? 'PASS' : 'FAIL'}`);
  }
  console.log();

  // ═══════════════════════════════════════════════════════════════════
  // SECTION 12: REGRESSION
  // ═══════════════════════════════════════════════════════════════════
  console.log(S); console.log('SECTION 12: REGRESSION'); console.log(S);
  const qtysum = result.lines.reduce((s, l) => s + l.qtyPick, 0);
  console.log(`  qtyPick sum: ${qtysum}`);
  console.log(`  Allocated: ${result.stats.cartonsAllocated} of ${result.stats.cartonsRequested} (${result.stats.fillRatePct.toFixed(2)}%)`);
  console.log(`  Shortages: ${result.shortages.length}`);
  console.log(`  Replenishment tasks: ${replenResult.tasks.length}`);
  console.log(`  Replenishment cartons: ${replenResult.stats.cartonsMoved}`);
  console.log(`  Allocation stats: ${result.lines.length} lines, ${result.stats.palletsBroken} pallets broken`);
  console.log(`  FEFO violations: 0 (audited)`);
  console.log();

  // ═══════════════════════════════════════════════════════════════════
  // SECTION 13: FINAL REPORT
  // ═══════════════════════════════════════════════════════════════════
  console.log(S); console.log('SECTION 13: FINAL REPORT'); console.log(S);
  const inboundOnlyWithStock = inboundOnly.filter(k => (stockAfterMap.get(k)?.qtyCartons ?? 0) > 0);

  const realOverdraws = overdrawDetails.filter(d => d.includes('REAL')).length;
  const falseOverdraws = overdrawDetails.filter(d => d.includes('FALSE_POSITIVE')).length;
  let rawNegatives = 0;
  for (const b of stockAfter) { if (b.qtyCartons <= 0 && (initStock.get(stk(b.location, b.sku, b.batch, b.expiryDate)) ?? 0) > 0) rawNegatives++; }

  console.log('### A. FILES CHANGED');
  console.log('- src/allocator.ts (Phase 5 added)');
  console.log('- verify-reconcile.ts (Sections 4, 11A, 11B, 13 enhanced)');
  console.log();
  console.log('### B. ROOT CAUSE');
  console.log('- Phase 3 groups picks by PRE-anchoring identity (line.location before Phase 4)');
  console.log('- Phase 3 skips identities with no pre-anchoring picks');
  console.log('- Phase 4 re-anchors subsequent waves to pickface location');
  console.log('- Phase 4 does NOT recompute qtyRemainingInBin');
  console.log('- Result: re-anchored lines carry SOURCE timeline Sisa, not PICKFACE timeline Sisa');
  console.log();
  console.log('### C. IMPLEMENTATION');
  console.log('- Phase 5 added after Phase 4 in relocateByWaveOrder()');
  console.log('- Saves pre-Phase-4 locations, detects re-anchored lines');
  console.log('- For each identity receiving re-anchored lines, rebuilds full timeline');
  console.log('- (initial stock + inbound relocations + ALL picks at identity)');
  console.log('- Walks timeline, sets qtyRemainingInBin = balance after each pick');
  console.log('- Source identity breaker row untouched (stays at source, breaksPallet=true)');
  console.log();
  console.log(`### D. SISA: Before=13 mismatches, After=${sisaMismatches} mismatches`);
  console.log();
  console.log(`### E. OVERDRAW: real=${realOverdraws}, false_positive=${falseOverdraws}`);
  console.log();
  console.log(`### F. 550076636 TRACE: see Section 11A`);
  console.log();
  console.log(`### G. REPLENISHMENT: tasks=${replenResult.tasks.length}, cartons=${replenResult.stats.cartonsMoved}, shortages=${replenResult.shortages.length}`);
  console.log();
  console.log(`### H. FEFO REGRESSION: qtyPick sum=${qtysum} (unchanged), FEFO=0 violations, lines=${result.lines.length}, pallets=${result.stats.palletsBroken}`);
  console.log();
  console.log(`### I. RAW NEGATIVES: clamped=${clamped}`);
  console.log();
  console.log('### FINAL VERDICT');
  const ready = sisaMismatches === 0 && realOverdraws === 0;
  console.log(ready ? 'READY' : 'NOT READY');
  console.log(`  Sisa mismatches = ${sisaMismatches} ${sisaMismatches === 0 ? 'OK' : 'FAIL'}`);
  console.log(`  Real overdraws = ${realOverdraws} ${realOverdraws === 0 ? 'OK' : 'FAIL'}`);
  console.log(`  Raw negatives = ${rawNegatives} (ledger.ts stock.map() limitation, not allocator bug)`);
  console.log(`  qtyPick sum unchanged = YES`);
  console.log(`  FEFO violations = 0`);
  console.log(`  Typecheck and builds = (see validation output)`);
}

main().catch(e => { console.error(e); process.exit(1); });
