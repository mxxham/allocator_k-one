import { daysBetween, type AllocatorConfig } from './config.js';
import { selectNextBin, toLedger, type Ledger } from './binselect.js';
import { derivePickfaces } from './pickface.js';
import type {
  AllocationLine,
  AllocationResult,
  DemandLine,
  PickfaceAssignment,
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
 * replenishment.ts, so a pickface top-up picks stock the exact same way an
 * outbound order does.
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
 * Physical inventory identity: location + SKU + batch + expiry date.
 *
 * Two stock records at the same location/SKU/batch but different expiry
 * dates are distinct inventory records and must be tracked separately.
 */
function stockIdentityKey(location: string, sku: string, batch: string | null, expiry: Date): string {
  return `${location}|${sku}|${batch ?? ''}|${expiry.toISOString().slice(0, 10)}`;
}

/**
 * Post-allocation processing with two goals:
 *
 * 1. **Sisa (remaining stock)** must describe the physical stock flow
 *    correctly, including stock relocated INTO a pickface bin.  For each
 *    physical inventory identity (location + SKU + batch + expiry) the
 *    ledger is:
 *
 *        initial stock            (from original stock records)
 *      + inbound relocations      (pallet breaks that feed this bin)
 *      − outbound picks           (consumers picking from this bin)
 *      ─────────────────────────────────────────────────
 *      = current Sisa             (written to qtyRemainingInBin)
 *
 *    Events are processed chronologically by wave number; at the same
 *    wave, relocations are applied before picks (the stock arrives
 *    before it is consumed).
 *
 * 2. **Break-event re-anchoring**: when a bulk bin (Level B–E) is split
 *    across multiple waves, the first wave (by picklist number) owns the
 *    break event and shows the original bulk bin.  Subsequent waves show
 *    the pickface bin (since by wave order the stock has already been
 *    relocated there).
 *
 * Allocation quantities (qtyPick), source bin identity, SKU, batch,
 * demand, and FEFO selection are NEVER modified — only Sisa,
 * location (for post-break picks), and the breaksPallet flag are
 * updated.
 */
export function relocateByWaveOrder(
  lines: AllocationLine[],
  pickfaces: Map<string, PickfaceAssignment>,
  config: AllocatorConfig,
  stock: StockBin[],
): void {
  if (config.relocationOrderBasis !== 'picklistNumber') return;

  // ── Phase 1: read initial stock from original records ──────────────
  const initialStock = new Map<string, number>();
  for (const bin of stock) {
    const key = stockIdentityKey(bin.location, bin.sku, bin.batch, bin.expiryDate);
    initialStock.set(key, (initialStock.get(key) ?? 0) + bin.qtyCartons);
  }

  // ── Phase 2: identify relocation events ────────────────────────────
  // A relocation is a pick from a NON-pickface bin where breaksPallet
  // is true.  Stock physically moves from the bulk bin into the pickface.
  //
  // This scan uses the ORIGINAL breaksPallet flags — before the
  // re-anchoring in Phase 4 changes them.
  type RelocEvent = { targetKey: string; qty: number; waveNo: string };
  const relocationEvents: RelocEvent[] = [];

  for (const line of lines) {
    const pf = pickfaces.get(line.sku);
    if (!pf) continue;
    if (line.location === pf.location) continue; // already at pickface
    if (!line.breaksPallet) continue;

    const targetKey = stockIdentityKey(
      pf.location, line.sku, line.batch, line.expiryDate,
    );
    relocationEvents.push({
      targetKey,
      qty: line.qtyRemainingInBin,
      waveNo: line.waveNo,
    });
  }

  // ── Phase 3: compute Sisa per physical identity ────────────────────
  // Group picks by physical identity (location + SKU + batch + expiry).
  const picksByIdentity = new Map<string, AllocationLine[]>();
  for (const line of lines) {
    const key = stockIdentityKey(
      line.location, line.sku, line.batch, line.expiryDate,
    );
    const group = picksByIdentity.get(key);
    if (group) group.push(line);
    else picksByIdentity.set(key, [line]);
  }

  // Group relocations by target identity.
  const relocsByIdentity = new Map<string, RelocEvent[]>();
  for (const event of relocationEvents) {
    const group = relocsByIdentity.get(event.targetKey);
    if (group) group.push(event);
    else relocsByIdentity.set(event.targetKey, [event]);
  }

  // Process every identity that has picks or inbound relocations.
  const allIdentities = new Set([
    ...picksByIdentity.keys(),
    ...relocsByIdentity.keys(),
  ]);

  for (const identity of allIdentities) {
    const picks = picksByIdentity.get(identity);
    const relocs = relocsByIdentity.get(identity);
    if (!picks || picks.length === 0) continue;

    // Start balance from the original stock record.
    let balance = initialStock.get(identity) ?? 0;

    // Build a combined timeline: relocations + picks.
    type TimelineEvent = {
      type: 'relocation' | 'pick';
      qty: number;
      waveNo: string;
      line?: AllocationLine;
    };

    const timeline: TimelineEvent[] = [
      ...(relocs ?? []).map((r) => ({
        type: 'relocation' as const,
        qty: r.qty,
        waveNo: r.waveNo,
      })),
      ...picks.map((p) => ({
        type: 'pick' as const,
        qty: p.qtyPick,
        waveNo: p.waveNo,
        line: p,
      })),
    ];

    // Sort chronologically by wave number; relocations before picks at
    // the same wave (stock arrives before it is consumed).
    timeline.sort((a, b) => {
      const wa = waveSortKey(a.waveNo);
      const wb = waveSortKey(b.waveNo);
      if (wa !== wb) return wa - wb;
      if (a.type === 'relocation' && b.type !== 'relocation') return -1;
      if (a.type !== 'relocation' && b.type === 'relocation') return 1;
      return 0;
    });

    // Walk the timeline: relocations add to balance, picks subtract and
    // record the resulting Sisa.
    for (const event of timeline) {
      if (event.type === 'relocation') {
        balance += event.qty;
      } else {
        balance -= event.qty;
        if (event.line) {
          event.line.qtyRemainingInBin = balance;
        }
      }
    }
  }

  // ── Phase 4: re-anchor break events to wave order ──────────────────
  // For bulk bins split across multiple waves the first wave (by wave
  // number) owns the break flag; subsequent waves point to the pickface
  // bin location.  This is purely a presentation change.
  //
  const byBin = new Map<string, AllocationLine[]>();
  for (const line of lines) {
    const group = byBin.get(line.binId);
    if (group) group.push(line);
    else byBin.set(line.binId, [line]);
  }

  for (const [, picks] of byBin) {
    if (picks.length < 2) continue;

    const sku = picks[0].sku;
    const pf = pickfaces.get(sku);
    if (!pf) continue;

    const hasBreak = picks.some((p) => p.breaksPallet);

    const waveSorted = [...picks].sort(
      (a, b) => waveSortKey(a.waveNo) - waveSortKey(b.waveNo),
    );

    for (let i = 0; i < waveSorted.length; i++) {
      const pick = waveSorted[i];
      if (i === 0) {
        pick.location = picks[0].location;
        pick.breaksPallet = hasBreak;
      } else {
        pick.location = pf.location;
        pick.breaksPallet = false;
      }
    }
  }

}
