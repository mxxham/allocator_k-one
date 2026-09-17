import type { AllocatorConfig } from './config.js';
import { parseLocation, pickSequenceKey } from './pickpath.js';
import type { PickfaceAssignment, StockBin } from './types.js';

/**
 * One dedicated pickface bin per SKU.
 *
 * An admin override (`config.pickfaceOverrides[sku]`) always wins — this is
 * the permanent CRUD-assigned bin. Without one, the SKU's own current stock
 * is used to pick a sensible default: whichever occupied bin with a pickface-
 * eligible level (default: Level A) sits earliest on the pick path becomes
 * the pickface, and everything else of that SKU is reserve stock that gets
 * moved in on replenishment. This mirrors what an admin would assign by hand,
 * and is only a starting point — override it once real pickface assignments
 * exist.
 *
 * Levels B-E are always bulk/reserve — never auto-derived as pickfaces.
 * This prevents bulk-to-bulk replenishment moves.
 */
export function derivePickfaces(stock: StockBin[], config: AllocatorConfig): Map<string, PickfaceAssignment> {
  const bySku = new Map<string, StockBin[]>();
  for (const bin of stock) {
    const list = bySku.get(bin.sku);
    if (list) list.push(bin);
    else bySku.set(bin.sku, [bin]);
  }

  const result = new Map<string, PickfaceAssignment>();

  for (const [sku, bins] of bySku) {
    const upp = bins.find((b) => b.upp)?.upp ?? 1;
    const description = bins[0]?.description ?? '';
    const target = config.pickfaceTargetQty === 'upp' ? upp : config.pickfaceTargetQty;

    const overrideLoc = config.pickfaceOverrides[sku];
    if (overrideLoc) {
      result.set(sku, {
        sku,
        description,
        location: overrideLoc.toUpperCase(),
        targetQtyCartons: target,
        isAuto: false,
      });
      continue;
    }

    // Enforce physical rule: only Level A bins are pickfaces (B-E = bulk)
    const pickfaceEligible = bins.filter((b) => {
      const parsed = parseLocation(b.location);
      return parsed !== null && config.pickfaceLevels.includes(parsed.level);
    });

    const ranked = [...pickfaceEligible].sort((a, b) => {
      const pa = parseLocation(a.location);
      const pb = parseLocation(b.location);
      const ka = pa ? pickSequenceKey(pa, config) : Number.MAX_SAFE_INTEGER;
      const kb = pb ? pickSequenceKey(pb, config) : Number.MAX_SAFE_INTEGER;
      return ka - kb;
    });

    if (ranked.length > 0) {
      result.set(sku, {
        sku,
        description,
        location: ranked[0].location,
        targetQtyCartons: target,
        isAuto: true,
      });
      continue;
    }

    // No Level A stock for this SKU — create pickface at the bay where bulk stock lives
    const bulkBins = bins.filter((b) => {
      const parsed = parseLocation(b.location);
      return parsed !== null && !config.pickfaceLevels.includes(parsed.level);
    });

    if (bulkBins.length > 0) {
      // Group bulk stock by bay, pick the bay with the most cartons
      const bayQty = new Map<string, { aisle: string; bay: number; qty: number }>();
      for (const bin of bulkBins) {
        const parsed = parseLocation(bin.location);
        if (!parsed) continue;
        const key = `${parsed.aisle}${parsed.bay}`;
        const existing = bayQty.get(key);
        if (existing) existing.qty += bin.qtyCartons;
        else bayQty.set(key, { aisle: parsed.aisle, bay: parsed.bay, qty: bin.qtyCartons });
      }

      let best: { aisle: string; bay: number; qty: number } | null = null;
      for (const info of bayQty.values()) {
        if (!best || info.qty > best.qty) best = info;
      }

      if (best) {
        // Find an unused Level A position at this bay (A01, A02, …)
        const usedLocations = new Set([...result.values()].map((p) => p.location));
        for (let pos = 1; pos <= 4; pos++) {
          const loc = `${best.aisle}${best.bay}A${String(pos).padStart(2, '0')}`;
          if (!usedLocations.has(loc)) {
            result.set(sku, {
              sku,
              description,
              location: loc.toUpperCase(),
              targetQtyCartons: target,
              isAuto: true,
            });
            break;
          }
        }
      }
    }
  }

  return result;
}
