import { daysBetween, type AllocatorConfig } from './config.js';
import { selectNextBin, toLedger, type Ledger } from './binselect.js';
import { parseLocation } from './pickpath.js';
import type {
  AllocationLine,
  DemandLine,
  PickfaceAssignment,
  PickfaceLedger,
  PickType,
  ReplenishmentResult,
  ReplenishmentShortage,
  ReplenishmentTask,
  StockBin,
  Warning,
} from './types.js';

/**
 * Tops up every SKU's dedicated pickface bin from reserve stock, using the
 * exact same FEFO + tie-break rule as outbound picking (see binselect.ts):
 * earliest expiry first, sealed pallets for whole-pallet moves, an
 * already-open pallet — best fit — for the loose remainder.
 *
 * Run this AFTER outbound allocation, against the stock that's left once
 * today's orders are reserved (`stockAfterPicks`), so replenishment never
 * takes cartons an order already needs.
 *
 * A pickface bin is never itself used as a replenishment *source* — it is
 * topped up, not drawn from — and reserve stock already sitting in a
 * pickface bin (another SKU's, or excess of its own) is excluded the same way.
 */
export function replenish(
  stockAfterPicks: StockBin[],
  pickfaces: Map<string, PickfaceAssignment>,
  config: AllocatorConfig,
  pendingDemand: DemandLine[] = [],
  allocationLines: AllocationLine[] = [],
  pickfaceLedger?: PickfaceLedger,
): ReplenishmentResult {
  const warnings: Warning[] = [];
  const tasks: ReplenishmentTask[] = [];
  const shortages: ReplenishmentShortage[] = [];

  const pickfaceLocations = new Set([...pickfaces.values()].map((p) => p.location));

  const pickfaceQty = new Map<string, number>();
  for (const bin of stockAfterPicks) {
    if (pickfaceLocations.has(bin.location)) {
      pickfaceQty.set(bin.sku, (pickfaceQty.get(bin.sku) ?? 0) + bin.qtyCartons);
    }
  }

  const bySku = new Map<string, Ledger[]>();
  for (const bin of stockAfterPicks) {
    if (bin.qtyCartons <= 0) continue;
    if (pickfaceLocations.has(bin.location)) continue;
    if (config.blockedBins.includes(bin.location)) continue;

    const life = daysBetween(config.asOf, bin.expiryDate);
    if (life < config.minRemainingShelfLifeDays) continue;

    const ledger = toLedger(bin, config);
    const list = bySku.get(bin.sku);
    if (list) list.push(ledger);
    else bySku.set(bin.sku, [ledger]);
  }

  const ordered = [...pickfaces.values()].sort((a, b) => a.sku.localeCompare(b.sku));

  for (const pf of ordered) {
    const currentQty = pickfaceLedger?.get(pf.sku)?.finalQty ?? pickfaceQty.get(pf.sku) ?? 0;
    const target = pf.targetQtyCartons;
    let need = target - currentQty;

    if (need < config.replenishmentMinTriggerQty) continue;

    const pool = bySku.get(pf.sku) ?? [];
    const upp = pool[0]?.bin.upp || 1;
    const reason: ReplenishmentTask['reason'] = 'BELOW_TARGET';
    let movedForThisSku = 0;

    while (need > 0) {
      const chosen = selectNextBin(pool, need, upp, config);
      if (!chosen) break;

      const take = Math.min(chosen.remaining, need);
      const wasSealed = !chosen.opened;
      const pickType: PickType = wasSealed && take === upp && chosen.remaining === upp ? 'PALLET' : 'CASE';

      chosen.remaining -= take;
      if (take < upp || !wasSealed) chosen.opened = true;
      need -= take;
      movedForThisSku += take;

      tasks.push({
        sku: pf.sku,
        description: pf.description,
        fromLocation: chosen.bin.location,
        fromBinId: chosen.bin.binId,
        toLocation: pf.location,
        batch: chosen.bin.batch,
        expiryDate: chosen.bin.expiryDate,
        qtyMove: take,
        pickType,
        upp,
        uom: chosen.bin.uom,
        qtyRemainingAtSource: chosen.remaining,
        qtyAtPickfaceAfter: currentQty + movedForThisSku,
        daysToExpiry: daysBetween(config.asOf, chosen.bin.expiryDate),
        seq: 0,
        breaksPallet: wasSealed && take < upp,
        reason,
      });
    }

    if (need > 0) {
      shortages.push({
        sku: pf.sku,
        description: pf.description,
        toLocation: pf.location,
        qtyNeeded: target - currentQty,
        qtyMoved: movedForThisSku,
        qtyShort: need,
      });
      warnings.push({
        level: 'WARN',
        code: 'REPLENISHMENT_SHORT',
        message: `${pf.location} (${pf.sku}) short ${need} cartons — no eligible reserve stock left`,
        context: { sku: pf.sku, location: pf.location },
      });
    }
  }

  const currentPickfaceQty = new Map<string, number>();
  for (const pf of ordered) {
    currentPickfaceQty.set(pf.sku, pickfaceLedger?.get(pf.sku)?.finalQty ?? pickfaceQty.get(pf.sku) ?? 0);
  }
  for (const t of tasks) {
    if (t.reason === 'BELOW_TARGET') {
      currentPickfaceQty.set(t.sku, (currentPickfaceQty.get(t.sku) ?? 0) + t.qtyMove);
    }
  }

  if (config.moveBrokenPalletToPickface) {
    const brokenLines = allocationLines.filter((l) => l.breaksPallet);
    const stockByBinId = new Map(stockAfterPicks.map((b) => [b.binId, b]));

    for (const line of brokenLines) {
      const srcBin = stockByBinId.get(line.binId);
      if (!srcBin || srcBin.qtyCartons <= 0) continue;

      const srcLoc = parseLocation(srcBin.location);
      if (!srcLoc || srcLoc.level === config.pickfaceLevels[0]) continue;

      const pf = pickfaces.get(line.sku);
      if (!pf) continue;

      const alreadyTasked = tasks.some(
        (t) => t.sku === line.sku && t.fromBinId === line.binId && t.toLocation === pf.location,
      );
      if (alreadyTasked) continue;

      const currentStock = currentPickfaceQty.get(line.sku) ?? 0;
      const availableSpace = Math.max(0, pf.targetQtyCartons - currentStock);
      if (availableSpace <= 0) continue;

      const upp = srcBin.upp || 1;
      const qtyMove = Math.min(srcBin.qtyCartons, availableSpace);
      const pickType: PickType = qtyMove >= upp ? 'PALLET' : 'CASE';

      tasks.push({
        sku: line.sku,
        description: line.description,
        fromLocation: srcBin.location,
        fromBinId: srcBin.binId,
        toLocation: pf.location,
        batch: srcBin.batch,
        expiryDate: srcBin.expiryDate,
        qtyMove,
        pickType,
        upp,
        uom: srcBin.uom,
        qtyRemainingAtSource: srcBin.qtyCartons - qtyMove,
        qtyAtPickfaceAfter: currentStock + qtyMove,
        daysToExpiry: daysBetween(config.asOf, srcBin.expiryDate),
        seq: 0,
        breaksPallet: false,
        reason: 'BROKEN_PALLET',
      });

      // Update the tracked qty so subsequent broken pallets for the same SKU see the new total.
      currentPickfaceQty.set(line.sku, currentStock + qtyMove);

      warnings.push({
        level: 'INFO',
        code: 'BROKEN_PALLET_RECOVERY',
        message: `${srcBin.location} (${line.sku}) ${qtyMove} loose cartons moved to pickface ${pf.location} — safety rule`,
        context: { sku: line.sku, from: srcBin.location, to: pf.location, qty: qtyMove },
      });
    }
  }

  const palletMoves = tasks.filter((t) => t.pickType === 'PALLET').length;

  return {
    generatedAt: new Date(),
    tasks,
    shortages,
    warnings,
    stats: {
      pickfacesEvaluated: pickfaces.size,
      pickfacesReplenished: new Set(tasks.map((t) => t.sku)).size,
      cartonsMoved: tasks.reduce((s, t) => s + t.qtyMove, 0),
      palletMoves,
      caseMoves: tasks.length - palletMoves,
      palletsBroken: tasks.filter((t) => t.breaksPallet).length,
    },
  };
}

/** Sequence replenishment tasks along the pick path, like a picklist. */
export function sequenceReplenishment(tasks: ReplenishmentTask[]): ReplenishmentTask[] {
  const sorted = [...tasks].sort((a, b) => a.fromLocation.localeCompare(b.fromLocation));
  sorted.forEach((t, i) => (t.seq = i + 1));
  return sorted;
}
