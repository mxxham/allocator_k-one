import type { AllocationResult, MovementRow } from './types.js';

/**
 * One chronological ledger of every bin quantity change this run made:
 * outbound picks (bin → shipment/staging) and pallet-break relocations
 * (reserve bin → pickface bin). This is the "what moved, from what item to
 * where" report — the paper trail for what the picklist did to the WMS sheet.
 */
export function buildMovementReport(
  allocation: AllocationResult,
): MovementRow[] {
  const rows: MovementRow[] = [];
  let seq = 1;

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
