import { daysBetween, type AllocatorConfig } from './config.js';
import { selectNextBin, toLedger, type Ledger } from './binselect.js';
import { derivePickfaces } from './pickface.js';
import { stockIdentityKey } from './ledger.js';
import type {
  AllocationLine,
  AllocationResult,
  DemandLine,
  PickfaceAssignment,
  PickfaceLedger,
  PickType,
  Shortage,
  StockBin,
  Warning,
} from './types.js';

/**
 * FEFO allocation with pickface preference.
 *
 * Rule order, applied per demand line:
 *   1. Eligibility  — rack bin, active, not blocked, qty > 0, enough shelf life left.
 *   2. Pickface first — the SKU's pickface bin is tried before any reserve bin.
 *                       Pickers always go to the pickface, never to reserve racks.
 *   3. FEFO         — the earliest expiry date available is always served first.
 *                     No later-expiry bin is touched while earlier stock remains.
 *   4. Within one expiry date (the tie-break layer, where handling cost lives):
 *        · need >= 1 pallet  → take sealed full pallets (forklift move)
 *        · need <  1 pallet  → take from an already-open pallet, best-fit,
 *                              so a sealed pallet is only broken as a last resort
 *        · equal otherwise   → the bin closest along the pick path
 *   5. Repeat until the line is filled, or flag the balance as a shortage.
 *
 * The bin-choice rule itself lives in binselect.ts and is shared with
 * the pickface relocation logic, so a pickface top-up picks stock the
 * exact same way an outbound order does.
 *
 * Deterministic: same inputs always produce the same picklist.
 */
export function allocate(
  stock: StockBin[],
  demand: DemandLine[],
  config: AllocatorConfig,
  stagedBySku: Map<string, number> = new Map(),
): AllocationResult {
  const warnings: Warning[] = [];
  const lines: AllocationLine[] = [];
  const shortages: Shortage[] = [];

  // Derive pickface assignments so outbound picks prefer the pickface bin.
  const pickfaces = derivePickfaces(stock, config);
  const pickfaceBySku = new Map<string, string>();
  for (const [sku, pf] of pickfaces) {
    pickfaceBySku.set(sku, pf.location);
  }

  const bySku = new Map<string, Ledger[]>();
  const rejectedShelfLife = new Map<string, number>();

  for (const bin of stock) {
    if (bin.qtyCartons <= 0) continue;
    if (config.blockedBins.includes(bin.location)) {
      warnings.push({
        level: 'INFO',
        code: 'BIN_BLOCKED',
        message: `${bin.location} skipped: bin is blocked`,
        context: { sku: bin.sku, qty: bin.qtyCartons },
      });
      continue;
    }

    const life = daysBetween(config.asOf, bin.expiryDate);
    if (life < config.minRemainingShelfLifeDays) {
      rejectedShelfLife.set(bin.sku, (rejectedShelfLife.get(bin.sku) ?? 0) + bin.qtyCartons);
      warnings.push({
        level: 'WARN',
        code: life < 0 ? 'EXPIRED' : 'SHELF_LIFE_BLOCKED',
        message: `${bin.location} ${bin.sku} batch ${bin.batch ?? '-'} has ${life} days left — not allocatable`,
        context: { location: bin.location, sku: bin.sku, expiry: bin.expiryDate, qty: bin.qtyCartons },
      });
      continue;
    }
    if (life < config.nearExpiryWarningDays) {
      warnings.push({
        level: 'INFO',
        code: 'NEAR_EXPIRY',
        message: `${bin.location} ${bin.sku} expires in ${life} days — ship first`,
        context: { location: bin.location, sku: bin.sku, expiry: bin.expiryDate },
      });
    }

    const ledger = toLedger(bin, config);
    const list = bySku.get(bin.sku);
    if (list) list.push(ledger);
    else bySku.set(bin.sku, [ledger]);
  }

  const ordered = [...demand].sort((a, b) => {
    if (config.sequenceShipmentsBySlot) {
      const s = (a.slotTime ?? '99:99').localeCompare(b.slotTime ?? '99:99');
      if (s !== 0) return s;
    }
    return a.shipmentNumber.localeCompare(b.shipmentNumber) || a.sku.localeCompare(b.sku);
  });

  for (const line of ordered) {
    const pool = bySku.get(line.sku) ?? [];
    let remaining = line.qtyCartons;
    const upp = line.upp || pool[0]?.bin.upp || 1;
    const expiriesUsed = new Set<string>();
    let allocated = 0;

    // Split pool into pickface bins and reserve bins for pickface-first picking.
    const pickfaceLoc = pickfaceBySku.get(line.sku);
    const pickfacePool = pickfaceLoc ? pool.filter((l) => l.bin.location === pickfaceLoc) : [];
    const reservePool = pickfaceLoc ? pool.filter((l) => l.bin.location !== pickfaceLoc) : pool;

    // Phase 1: pick from the pickface bin first (picker goes to the pickface).
    while (remaining > 0) {
      const chosen = pickfacePool.length > 0
        ? selectNextBin(pickfacePool, remaining, upp, config)
        : undefined;
      if (!chosen) break;

      const take = Math.min(chosen.remaining, remaining);
      const wasSealed = !chosen.opened;
      const pickType: PickType = wasSealed && take === upp && chosen.remaining === upp ? 'PALLET' : 'CASE';

      chosen.remaining -= take;
      if (take < upp || !wasSealed) chosen.opened = true;
      remaining -= take;
      allocated += take;
      expiriesUsed.add(chosen.bin.expiryDate.toISOString().slice(0, 10));

      lines.push({
        shipmentNumber: line.shipmentNumber,
        waveNo: line.waveNo,
        orderNos: line.orderNos,
        sku: line.sku,
        description: line.description || chosen.bin.description,
        location: chosen.bin.location,
        binId: chosen.bin.binId,
        batch: chosen.bin.batch,
        expiryDate: chosen.bin.expiryDate,
        qtyPick: take,
        pickType,
        upp,
        uom: chosen.bin.uom,
        qtyRemainingInBin: chosen.remaining,
        daysToExpiry: daysBetween(config.asOf, chosen.bin.expiryDate),
        seq: 0,
        breaksPallet: wasSealed && take < upp,
      });
    }

    // Phase 2: fall back to reserve bins when the pickface is depleted.
    while (remaining > 0) {
      const chosen = selectNextBin(reservePool, remaining, upp, config);
      if (!chosen) break;

      const take = Math.min(chosen.remaining, remaining);
      const wasSealed = !chosen.opened;
      const pickType: PickType = wasSealed && take === upp && chosen.remaining === upp ? 'PALLET' : 'CASE';

      chosen.remaining -= take;
      if (take < upp || !wasSealed) chosen.opened = true;
      remaining -= take;
      allocated += take;
      expiriesUsed.add(chosen.bin.expiryDate.toISOString().slice(0, 10));

      lines.push({
        shipmentNumber: line.shipmentNumber,
        waveNo: line.waveNo,
        orderNos: line.orderNos,
        sku: line.sku,
        description: line.description || chosen.bin.description,
        location: chosen.bin.location,
        binId: chosen.bin.binId,
        batch: chosen.bin.batch,
        expiryDate: chosen.bin.expiryDate,
        qtyPick: take,
        pickType,
        upp,
        uom: chosen.bin.uom,
        qtyRemainingInBin: chosen.remaining,
        daysToExpiry: daysBetween(config.asOf, chosen.bin.expiryDate),
        seq: 0,
        breaksPallet: wasSealed && take < upp,
      });
    }

    if (remaining > 0) {
      const staged = stagedBySku.get(line.sku) ?? 0;
      shortages.push({
        shipmentNumber: line.shipmentNumber,
        orderNos: line.orderNos,
        sku: line.sku,
        description: line.description,
        qtyRequested: line.qtyCartons,
        qtyAllocated: allocated,
        qtyShort: remaining,
        reason: staged >= remaining
          ? 'ALREADY_STAGED'
          : (rejectedShelfLife.get(line.sku) ?? 0) >= remaining
            ? 'BLOCKED_SHELF_LIFE'
            : 'NO_STOCK',
        qtyRejectedByShelfLife: rejectedShelfLife.get(line.sku) ?? 0,
        qtyInStaging: staged,
      });
    }

    if (config.warnOnMixedExpiryPerLine && expiriesUsed.size > 1) {
      warnings.push({
        level: 'INFO',
        code: 'MIXED_EXPIRY',
        message: `Shipment ${line.shipmentNumber} / ${line.sku} picks ${expiriesUsed.size} expiry dates (FEFO consumed the oldest batch first)`,
        context: { expiries: [...expiriesUsed].sort() },
      });
    }
  }

  const palletPicks = lines.filter((l) => l.pickType === 'PALLET').length;
  const cartonsRequested = demand.reduce((s, d) => s + d.qtyCartons, 0);
  const cartonsAllocated = lines.reduce((s, l) => s + l.qtyPick, 0);

  return {
    generatedAt: new Date(),
    picklists: [],
    lines,
    shortages,
    warnings,
    stats: {
      demandLines: demand.length,
      cartonsRequested,
      cartonsAllocated,
      fillRatePct: cartonsRequested ? (cartonsAllocated / cartonsRequested) * 100 : 100,
      palletPicks,
      casePicks: lines.length - palletPicks,
      palletsBroken: lines.filter((l) => l.breaksPallet).length,
      binsTouched: new Set(lines.map((l) => l.binId)).size,
      shipments: new Set(demand.map((d) => d.shipmentNumber)).size,
    },
  };
}

function waveSortKey(waveNo: string): number {
  const n = Number(waveNo);
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

/**
 * Physical accounting event type.
 *
 * Every stock movement at a physical identity is one of:
 *   - PICK: a customer order consumed cartons from this identity
 *   - RELOC_IN: stock physically arrived here from a bulk source
 *   - RELOC_OUT: the leftover stock physically left this identity for a pickface
 */
export type PhysicalEvent =
  | { type: 'PICK'; waveNum: number; qty: number; line: AllocationLine }
  | { type: 'RELOC_OUT'; waveNum: number; qty: number; sourceKey: string; destinationKey: string; sourceLine: AllocationLine }
  | { type: 'RELOC_IN'; waveNum: number; qty: number; sourceKey: string; destinationKey: string; sourceLine: AllocationLine };

/**
 * Physical accounting using an event-driven model.
 *
 * For every physical identity (location + SKU + batch + expiry), builds a
 * chronological timeline of PICK / RELOC_IN / RELOC_OUT events and walks
 * the balance in wave order. At the same wave the ordering is:
 *
 *   RELOC_IN -> PICK -> RELOC_OUT
 *
 * This ensures:
 *   - Destination pickface: inbound arrives before same-wave picks consume it.
 *   - Source bulk bin: customer picks before the leftover physically leaves.
 *
 * Allocation quantities (qtyPick), source-bin selection, SKU, batch, expiry,
 * wave numbers, and picklist numbering are NEVER modified. Only Sisa
 * (qtyRemainingInBin) and location presentation (re-anchoring) are updated.
 */
export function relocateByWaveOrder(
  lines: AllocationLine[],
  pickfaces: Map<string, PickfaceAssignment>,
  config: AllocatorConfig,
  stock: StockBin[],
): PickfaceLedger {
  if (config.relocationOrderBasis !== 'picklistNumber') return new Map();

  // Phase 1: initial stock per physical identity
  const initialStock = new Map<string, number>();
  for (const bin of stock) {
    const key = stockIdentityKey(bin.location, bin.sku, bin.batch, bin.expiryDate);
    initialStock.set(key, (initialStock.get(key) ?? 0) + bin.qtyCartons);
  }

  // Phase 2: capture original values BEFORE any re-anchoring
  // Keyed by physical identity (location + SKU + batch + expiry), NOT binId.
  const origQtyRemaining = new Map<string, number>();
  for (const line of lines) {
    const key = stockIdentityKey(line.location, line.sku, line.batch, line.expiryDate);
    origQtyRemaining.set(key, line.qtyRemainingInBin);
  }

  // Phase 3: build relocation events using pre-anchor values
  type RelocEvent = {
    sourceKey: string;
    destinationKey: string;
    sourceQty: number;
    sku: string;
    batch: string | null;
    expiryDate: Date;
    waveNo: string;
    line: AllocationLine;
  };
  const relocationEvents: RelocEvent[] = [];

  const totalDemandBySku = new Map<string, number>();
  for (const line of lines) {
    totalDemandBySku.set(line.sku, (totalDemandBySku.get(line.sku) ?? 0) + line.qtyPick);
  }

  const pickfaceStockBySku = new Map<string, number>();
  for (const bin of stock) {
    const pf = pickfaces.get(bin.sku);
    if (pf && bin.location === pf.location) {
      pickfaceStockBySku.set(bin.sku, (pickfaceStockBySku.get(bin.sku) ?? 0) + bin.qtyCartons);
    }
  }

  // Track which source identities already have a relocation event to avoid
  // double-counting when multiple waves pick from the same bin.
  const relocatedSrcKeys = new Set<string>();

  for (const line of lines) {
    const pf = pickfaces.get(line.sku);
    if (!pf) continue;
    if (line.location !== pf.location && line.qtyRemainingInBin > 0) {
      const currentPickfaceQty = pickfaceStockBySku.get(line.sku) ?? 0;
      const totalDemand = totalDemandBySku.get(line.sku) ?? 0;
      const pickfaceHasRoom = currentPickfaceQty < pf.targetQtyCartons;
      const demandExceedsPallet = totalDemand > pf.targetQtyCartons;

      if (!pickfaceHasRoom && !demandExceedsPallet) continue;

      const srcKey = stockIdentityKey(line.location, line.sku, line.batch, line.expiryDate);
      // Only ONE relocation event per physical identity — the last wave that
      // touches this identity carries the correct final remaining stock.
      if (relocatedSrcKeys.has(srcKey)) continue;
      relocatedSrcKeys.add(srcKey);

      const destKey = stockIdentityKey(pf.location, line.sku, line.batch, line.expiryDate);
      relocationEvents.push({
        sourceKey: srcKey,
        destinationKey: destKey,
        sourceQty: origQtyRemaining.get(srcKey) ?? 0,
        sku: line.sku,
        batch: line.batch,
        expiryDate: line.expiryDate,
        waveNo: line.waveNo,
        line,
      });
    }
  }

  // Phase 4: compute Sisa per physical identity via event-driven model
  type TimelineEvent = {
    type: 'RELOC_IN' | 'PICK' | 'RELOC_OUT';
    waveNum: number;
    qty: number;
    line?: AllocationLine;
  };

  const picksByIdentity = new Map<string, AllocationLine[]>();
  for (const line of lines) {
    const key = stockIdentityKey(line.location, line.sku, line.batch, line.expiryDate);
    const group = picksByIdentity.get(key);
    if (group) group.push(line);
    else picksByIdentity.set(key, [line]);
  }

  const relocOutByIdentity = new Map<string, RelocEvent[]>();
  const relocInByIdentity = new Map<string, RelocEvent[]>();
  for (const event of relocationEvents) {
    const srcGroup = relocOutByIdentity.get(event.sourceKey);
    if (srcGroup) srcGroup.push(event);
    else relocOutByIdentity.set(event.sourceKey, [event]);

    const destGroup = relocInByIdentity.get(event.destinationKey);
    if (destGroup) destGroup.push(event);
    else relocInByIdentity.set(event.destinationKey, [event]);
  }

  const allIdentities = new Set([
    ...picksByIdentity.keys(),
    ...relocOutByIdentity.keys(),
    ...relocInByIdentity.keys(),
  ]);

  const priority = { RELOC_IN: 0, PICK: 1, RELOC_OUT: 2 };

  for (const identity of allIdentities) {
    const picks = picksByIdentity.get(identity) ?? [];
    const relocOut = relocOutByIdentity.get(identity) ?? [];
    const relocIn = relocInByIdentity.get(identity) ?? [];

    let balance = initialStock.get(identity) ?? 0;

    const timeline: TimelineEvent[] = [
      ...relocIn.map((e) => ({ type: 'RELOC_IN' as const, waveNum: waveSortKey(e.waveNo), qty: e.sourceQty })),
      ...picks.map((p) => ({ type: 'PICK' as const, waveNum: waveSortKey(p.waveNo), qty: p.qtyPick, line: p })),
      ...relocOut.map((e) => ({ type: 'RELOC_OUT' as const, waveNum: waveSortKey(e.waveNo), qty: e.sourceQty })),
    ];

    timeline.sort((a, b) => {
      if (a.waveNum !== b.waveNum) return a.waveNum - b.waveNum;
      return priority[a.type] - priority[b.type];
    });

    for (const ev of timeline) {
      if (ev.type === 'RELOC_IN') {
        balance += ev.qty;
      } else if (ev.type === 'PICK') {
        balance -= ev.qty;
        if (ev.line) ev.line.qtyRemainingInBin = balance;
      } else {
        balance -= ev.qty;
      }
    }
  }

  // Phase 5: re-anchor break events to wave order.
  // A source identity with multiple waves and NO relocation event
  // must stay at the source location — multiple waves ≠ relocation.
  const byIdentity = new Map<string, AllocationLine[]>();
  for (const line of lines) {
    const key = stockIdentityKey(line.location, line.sku, line.batch, line.expiryDate);
    const group = byIdentity.get(key);
    if (group) group.push(line);
    else byIdentity.set(key, [line]);
  }

  const reAnchoredLines = new Set<AllocationLine>();
  const breakPalletLines = new Set<AllocationLine>();

  for (const [identity, picks] of byIdentity) {
    if (picks.length < 2) continue;
    const relocOutEvents = relocOutByIdentity.get(identity);
    if (!relocOutEvents || relocOutEvents.length === 0) continue;

    const sku = picks[0].sku;
    const pf = pickfaces.get(sku);
    if (!pf) continue;
    const hasRemainder = picks.some((p) => p.qtyRemainingInBin > 0);
    const waveSorted = [...picks].sort(
      (a, b) => waveSortKey(a.waveNo) - waveSortKey(b.waveNo),
    );
    for (let i = 0; i < waveSorted.length; i++) {
      const pick = waveSorted[i];
      if (i === 0) {
        pick.location = picks[0].location;
        pick.breaksPallet = picks[0].breaksPallet;
        if (picks[0].breaksPallet) breakPalletLines.add(pick);
      } else {
        pick.location = pf.location;
        pick.breaksPallet = false;
        reAnchoredLines.add(pick);
      }
    }
  }

  // Save original Sisa for re-anchored lines before recomputing
  const originalSisa = new Map<AllocationLine, number>();
  for (const line of reAnchoredLines) {
    originalSisa.set(line, line.qtyRemainingInBin);
  }

  // Recompute Sisa with new locations; restore original for non-break re-anchored lines
  const picksByIdentityAfterReanchor = new Map<string, AllocationLine[]>();
  for (const line of lines) {
    const key = stockIdentityKey(line.location, line.sku, line.batch, line.expiryDate);
    const group = picksByIdentityAfterReanchor.get(key);
    if (group) group.push(line);
    else picksByIdentityAfterReanchor.set(key, [line]);
  }

  const allIdentitiesAfter = new Set([
    ...picksByIdentityAfterReanchor.keys(),
    ...relocOutByIdentity.keys(),
    ...relocInByIdentity.keys(),
  ]);

  for (const identity of allIdentitiesAfter) {
    const picks = picksByIdentityAfterReanchor.get(identity) ?? [];
    const relocOut = relocOutByIdentity.get(identity) ?? [];
    const relocIn = relocInByIdentity.get(identity) ?? [];
    let balance = initialStock.get(identity) ?? 0;

    const timeline: TimelineEvent[] = [
      ...relocIn.map((e) => ({ type: 'RELOC_IN' as const, waveNum: waveSortKey(e.waveNo), qty: e.sourceQty })),
      ...picks.map((p) => ({ type: 'PICK' as const, waveNum: waveSortKey(p.waveNo), qty: p.qtyPick, line: p })),
      ...relocOut.map((e) => ({ type: 'RELOC_OUT' as const, waveNum: waveSortKey(e.waveNo), qty: e.sourceQty })),
    ];

    timeline.sort((a, b) => {
      if (a.waveNum !== b.waveNum) return a.waveNum - b.waveNum;
      return priority[a.type] - priority[b.type];
    });

    for (const ev of timeline) {
      if (ev.type === 'RELOC_IN') {
        balance += ev.qty;
      } else if (ev.type === 'PICK') {
        balance -= ev.qty;
        if (ev.line) ev.line.qtyRemainingInBin = balance;
      } else {
        balance -= ev.qty;
      }
    }
  }

  // Restore original Sisa for re-anchored lines without relocation events
  for (const line of reAnchoredLines) {
    if (!breakPalletLines.has(line)) {
      line.qtyRemainingInBin = originalSisa.get(line) ?? line.qtyRemainingInBin;
    }
  }

  // Phase 6: build pickface ledger from event timelines
  // Aggregate ALL physical identities at the pickface, no early break
  const ledger: PickfaceLedger = new Map();

  for (const [sku, pf] of pickfaces) {
    const pfLines = lines.filter((l) => l.sku === sku);
    if (pfLines.length === 0) continue;

    const inboundEvents: { qty: number; waveNo: string }[] = [];
    for (const event of relocationEvents) {
      if (event.destinationKey === stockIdentityKey(pf.location, sku, event.batch, event.expiryDate)) {
        inboundEvents.push({ qty: event.sourceQty, waveNo: event.waveNo });
      }
    }

    const outboundPicks: { qty: number; waveNo: string }[] = [];
    for (const line of pfLines) {
      if (line.location === pf.location) {
        outboundPicks.push({ qty: line.qtyPick, waveNo: line.waveNo });
      }
    }

    // Aggregate ALL physical identities at the pickface location for this SKU
    let balance = 0;
    for (const bin of stock) {
      if (bin.location === pf.location && bin.sku === sku) {
        const key = stockIdentityKey(bin.location, bin.sku, bin.batch, bin.expiryDate);
        const existing = initialStock.get(key);
        if (existing !== undefined) {
          balance += existing;
        }
      }
    }

    type Ev = { type: 'reloc' | 'pick'; qty: number; waveNo: string };
    const timeline: Ev[] = [
      ...inboundEvents.map((e) => ({ type: 'reloc' as const, qty: e.qty, waveNo: e.waveNo })),
      ...outboundPicks.map((e) => ({ type: 'pick' as const, qty: e.qty, waveNo: e.waveNo })),
    ];
    timeline.sort((a, b) => {
      const wa = waveSortKey(a.waveNo);
      const wb = waveSortKey(b.waveNo);
      if (wa !== wb) return wa - wb;
      if (a.type === 'reloc' && b.type === 'pick') return -1;
      if (a.type === 'pick' && b.type === 'reloc') return 1;
      return 0;
    });

    for (const ev of timeline) {
      if (ev.type === 'reloc') {
        balance += ev.qty;
      } else {
        balance -= ev.qty;
      }
    }

    ledger.set(sku, { location: pf.location, finalQty: balance });
  }

  return ledger;
}
