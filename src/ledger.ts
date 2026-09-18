import type { AllocationLine, StockBin } from './types.js';

export interface PickfaceAssignment {
  location: string;
  sku: string;
  targetQtyCartons: number;
}

export function stockIdentityKey(location: string, sku: string, batch: string | null, expiry: Date): string {
  return `${location}|${sku}|${batch ?? ''}|${expiry.toISOString().slice(0, 10)}`;
}

function parseIdentityKey(key: string): { location: string; sku: string; batch: string; expiryStr: string } {
  const [location, sku, batch, expiryStr] = key.split('|');
  return { location, sku, batch, expiryStr };
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

  const uppBySku = new Map<string, number>();
  for (const bin of stock) {
    if (!uppBySku.has(bin.sku)) uppBySku.set(bin.sku, bin.upp);
  }

  const stockByKey = new Map<string, StockBin>();
  for (const bin of stock) {
    const key = stockIdentityKey(bin.location, bin.sku, bin.batch, bin.expiryDate);
    stockByKey.set(key, bin);
  }

  const result: StockBin[] = [];
  for (const [key, adj] of adjustments) {
    const existing = stockByKey.get(key);
    if (existing) {
      const newQty = existing.qtyCartons + adj;
      result.push({ ...existing, qtyCartons: newQty, isFullPallet: newQty >= existing.upp });
    } else if (adj > 0) {
      const { location, sku, batch, expiryStr } = parseIdentityKey(key);
      const upp = uppBySku.get(sku) ?? 1;
      result.push({
        binId: `${location}|${sku}|${batch}`,
        location,
        aisle: location.slice(0, 2),
        bay: parseInt(location.slice(2, 4)),
        level: location.slice(4, 5),
        position: parseInt(location.slice(5, 7)),
        sku,
        description: `SKU ${sku}`,
        batch,
        expiryDate: new Date(expiryStr),
        grDate: null,
        qtyCartons: adj,
        upp,
        uom: 'CAR',
        isFullPallet: adj >= upp,
      });
    }
  }

  for (const bin of stock) {
    const key = stockIdentityKey(bin.location, bin.sku, bin.batch, bin.expiryDate);
    if (!adjustments.has(key)) result.push(bin);
  }

  return result;
}
