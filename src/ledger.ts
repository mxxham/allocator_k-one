import type { AllocationLine, StockBin } from './types.js';

export interface PickfaceAssignment {
  location: string;
  sku: string;
  targetQtyCartons: number;
}

export function stockIdentityKey(location: string, sku: string, batch: string | null, expiry: Date): string {
  return `${location}|${sku}|${batch ?? ''}|${expiry.toISOString().slice(0, 10)}`;
}

export function computeStockAfterMovements(
  stock: StockBin[],
  lines: AllocationLine[],
  pickfaces: Map<string, PickfaceAssignment>,
): StockBin[] {
  const adjustments = new Map<string, number>();

  for (const line of lines) {
    const key = stockIdentityKey(line.location, line.sku, line.batch, line.expiryDate);
    adjustments.set(key, (adjustments.get(key) ?? 0) - line.qtyPick);
  }

  for (const line of lines) {
    if (!line.breaksPallet) continue;
    const pf = pickfaces.get(line.sku);
    if (!pf) continue;
    if (line.location === pf.location) continue;

    const sourceKey = stockIdentityKey(line.location, line.sku, line.batch, line.expiryDate);
    adjustments.set(sourceKey, (adjustments.get(sourceKey) ?? 0) - line.qtyRemainingInBin);

    const destKey = stockIdentityKey(pf.location, line.sku, line.batch, line.expiryDate);
    adjustments.set(destKey, (adjustments.get(destKey) ?? 0) + line.qtyRemainingInBin);
  }

  return stock.map((bin) => {
    const key = stockIdentityKey(bin.location, bin.sku, bin.batch, bin.expiryDate);
    const adj = adjustments.get(key) ?? 0;
    const newQty = Math.max(0, bin.qtyCartons + adj);
    return { ...bin, qtyCartons: newQty, isFullPallet: newQty >= bin.upp };
  });
}
