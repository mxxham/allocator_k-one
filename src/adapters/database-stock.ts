/**
 * Database → StockBin adapter (§14).
 *
 * Converts persisted stock rows into the exact `StockBin` structure the
 * existing allocator consumes. The allocator itself is untouched: same stock
 * + same demand = same allocation, whether the bins came from the WMS
 * workbook or from the database.
 *
 * Date handling: DATE columns arrive as 'YYYY-MM-DD' and are parsed as UTC
 * midnight (parseDbDate), matching the Excel adapter's timezone-shift fix, so
 * an expiry of 2030-09-02 is 2030-09-02 everywhere.
 */

import type { StockBin, Warning } from '../types.js';
import { parseLocation } from '../pickpath.js';
import type { StockRecord } from '../repository/types.js';
import type { StockRepository } from '../repository/stock-repo.js';

/** One database stock row → one allocator StockBin. */
export function stockRecordToBin(rec: StockRecord): StockBin {
  const parsed = parseLocation(rec.location);
  return {
    // binId stays the legacy location|sku|batch key — it is NOT the physical
    // identity (that includes expiry) and is never used as a unique key.
    binId: `${rec.location}|${rec.sku}|${rec.batch ?? 'NOBATCH'}`,
    location: rec.location,
    aisle: rec.aisle || parsed?.aisle || rec.location.slice(0, 2),
    bay: rec.bay ?? parsed?.bay ?? 0,
    level: rec.level || parsed?.level || rec.location.slice(4, 5),
    position: rec.position ?? parsed?.position ?? 0,
    sku: rec.sku,
    description: rec.description,
    batch: rec.batch,
    expiryDate: rec.expiryDate,
    grDate: rec.grDate,
    qtyCartons: rec.quantity,
    upp: rec.upp,
    uom: rec.uom,
    // Recomputed exactly like the Excel adapter (qty >= upp) so Excel-fed and
    // database-fed allocations are bit-identical.
    isFullPallet: rec.quantity >= rec.upp,
  };
}

/**
 * Load the allocator's stock input from the database.
 * Zero-quantity rows are skipped (an empty bin is not stock), mirroring the
 * Excel adapter's `qty <= 0` filter.
 */
export async function loadStockFromDatabase(
  repo: StockRepository,
): Promise<{ stock: StockBin[]; warnings: Warning[] }> {
  const records = await repo.listAll();
  const warnings: Warning[] = [];
  const stock: StockBin[] = [];

  for (const rec of records) {
    if (rec.quantity <= 0) continue;
    if (!parseLocation(rec.location)) {
      warnings.push({
        level: 'WARN',
        code: 'NON_RACK_LOCATION',
        message: `${rec.location} is not a rack bin — excluded from allocation`,
        context: { location: rec.location, sku: rec.sku, quantity: rec.quantity },
      });
      continue;
    }
    stock.push(stockRecordToBin(rec));
  }

  return { stock, warnings };
}
