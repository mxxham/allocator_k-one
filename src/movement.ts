import type { AllocationResult, MovementRow, ReplenishmentResult } from './types.js';

/**
 * One chronological ledger of every bin quantity change this run made:
 * outbound picks (bin → shipment/staging) and pickface replenishment
 * (reserve bin → pickface bin). This is the "what moved, from what item to
 * where" report — the paper trail for what the picklist did to the WMS sheet.
 *
 * Order: replenishment runs first operationally (topping up pickfaces ahead
 * of the wave), then picks, but both are timestamped by seq so either can be
 * sorted by shipment/location afterwards in the sheet.
 */
export function buildMovementReport(
  allocation: AllocationResult,
  replenishment: ReplenishmentResult,
): MovementRow[] {
  const rows: MovementRow[] = [];
  let seq = 1;

  for (const t of replenishment.tasks) {
    rows.push({
      seq: seq++,
      type: 'REPLEN',
      sku: t.sku,
      description: t.description,
      batch: t.batch,
      expiryDate: t.expiryDate,
      qty: t.qtyMove,
      pickType: t.pickType,
      uom: t.uom,
      fromLocation: t.fromLocation,
      toLocation: t.toLocation,
      shipmentNumber: null,
      qtyRemainingAtFrom: t.qtyRemainingAtSource,
      breaksPallet: t.breaksPallet,
    });
  }

  for (const l of allocation.lines) {
    rows.push({
      seq: seq++,
      type: 'PICK',
      sku: l.sku,
      description: l.description,
      batch: l.batch,
      expiryDate: l.expiryDate,
      qty: l.qtyPick,
      pickType: l.pickType,
      uom: l.uom,
      fromLocation: l.location,
      toLocation: `STAGING → ${l.shipmentNumber}`,
      shipmentNumber: l.shipmentNumber,
      qtyRemainingAtFrom: l.qtyRemainingInBin,
      breaksPallet: l.breaksPallet,
    });
  }

  return rows;
}
