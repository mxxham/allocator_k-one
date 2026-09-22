/**
 * Daily allocation workflow — orchestrator that runs the full allocation
 * pipeline entirely from database sources.
 *
 * Flow:
 *   1. Load stock from DB (loadStockFromDatabase)
 *   2. Load demand from outbound table (origin=IMPORT, status=PLANNED)
 *   3. Derive pickfaces (derivePickfaces)
 *   4. Run FEFO allocation (allocate)
 *   5. Relocate by wave order (relocateByWaveOrder)
 *   6. Compute stock after movements (computeStockAfterMovements)
 *   7. Persist the plan (persistPlan)
 *
 * The allocator is a pure function — same stock + same demand = same result,
 * whether sourced from the WMS workbook or from this DB pipeline.
 */

import type { DbClient } from '../lib/supabase.js';
import type {
  AllocationResult,
  DemandLine,
  PickfaceAssignment,
  StockBin,
  Warning,
} from '../types.js';
import { withConfig, type AllocatorConfig } from '../config.js';
import { allocate, relocateByWaveOrder } from '../allocator.js';
import { derivePickfaces } from '../pickface.js';
import { computeStockAfterMovements } from '../ledger.js';
import { loadStockFromDatabase } from '../adapters/database-stock.js';
import { createRepositories, type Repositories } from '../repository/index.js';
import type { OutboundRecord, WaveRecord } from '../repository/types.js';
import { persistPlan, type PersistPlanResult } from './planning.js';

// ---- Public API ------------------------------------------------------------

export interface WorkflowResult {
  waves: WaveRecord[];
  movementCount: number;
  outboundCount: number;
  stats: AllocationResult['stats'];
}

/**
 * Run the full FEFO allocation pipeline from DB-sourced stock and demand.
 *
 * @param db    Supabase (or any PostgREST-compatible) client
 * @param opts  { asOf } — the allocation date (shelf-life, expiry, etc.)
 */
export async function runAllocationFromDB(
  db: DbClient,
  opts: { asOf: Date },
): Promise<WorkflowResult> {
  const repos = createRepositories(db);
  const config = withConfig({ asOf: opts.asOf });

  // ---- 1. Load stock from DB ------------------------------------------------
  const { stock, warnings: stockWarnings } = await loadStockFromDatabase(
    repos.stock,
  );

  // ---- 2. Load demand from outbound table (IMPORT, PLANNED) ------------------
  const outboundRecords = await repos.outbound.list({
    status: 'PLANNED',
    origin: 'IMPORT',
  });

  // ---- 3. Convert outbound records → DemandLine[] ----------------------------
  const demand = outboundToDemandLines(outboundRecords, stock);

  // ---- 4. Early exit: nothing to allocate ------------------------------------
  if (stock.length === 0 || demand.length === 0) {
    return emptyResult(stock.length === 0 && demand.length === 0);
  }

  // ---- 5. Derive pickfaces ---------------------------------------------------
  const pickfaces = derivePickfaces(stock, config);

  // ---- 6. Run FEFO allocation ------------------------------------------------
  // stagedBySku is a workbook-only concept (staging lane detection);
  // in DB mode we pass an empty map — stock in staging lanes is already
  // excluded by loadStockFromDatabase (non-rack locations are skipped).
  const result = allocate(stock, demand, config, new Map());
  result.warnings.unshift(...stockWarnings);

  // ---- 7. Relocate by wave order (mutates result.lines) ----------------------
  const pickfaceLedger = relocateByWaveOrder(
    result.lines,
    pickfaces,
    config,
    stock,
  );

  // ---- 8. Compute stock after movements --------------------------------------
  const stockAfterMovements = computeStockAfterMovements(
    stock,
    result.lines,
    pickfaces,
  );

  // ---- 9. Persist the plan --------------------------------------------------
  const persisted = await persistPlan(db, {
    allocation: result,
    demand,
    pickfaces,
    asOf: opts.asOf,
  });

  return {
    waves: persisted.waves,
    movementCount: persisted.movementCount,
    outboundCount: persisted.outboundCount,
    stats: result.stats,
  };
}

// ---- Internal helpers ------------------------------------------------------

/**
 * Empty result when there is nothing to allocate (no stock or no demand).
 * Returns zeros so callers never get undefined fields.
 */
function emptyResult(_bothEmpty: boolean): WorkflowResult {
  return {
    waves: [],
    movementCount: 0,
    outboundCount: 0,
    stats: {
      demandLines: 0,
      cartonsRequested: 0,
      cartonsAllocated: 0,
      fillRatePct: 0,
      palletPicks: 0,
      casePicks: 0,
      palletsBroken: 0,
      binsTouched: 0,
      shipments: 0,
    },
  };
}

/**
 * Parse order numbers and slot time back out of the packed description field.
 *
 * outbound-import.ts packs them as:
 *   "raw description | Orders: NO1, NO2 | Slot: HH:MM"
 *
 * This reverses that encoding so we can reconstruct the original DemandLine.
 */
function parsePackedDescription(
  rawDescription: string,
): { cleanDescription: string; orderNos: string[]; slotTime: string | null } {
  const parts = rawDescription.split(' | ');
  const orderNos: string[] = [];
  let slotTime: string | null = null;
  const descParts: string[] = [];

  for (const part of parts) {
    if (part.startsWith('Orders: ')) {
      orderNos.push(
        ...part
          .slice(8)
          .split(', ')
          .map((s) => s.trim())
          .filter(Boolean),
      );
    } else if (part.startsWith('Slot: ')) {
      slotTime = part.slice(6);
    } else {
      descParts.push(part);
    }
  }

  return {
    cleanDescription: descParts.join(' | '),
    orderNos,
    slotTime,
  };
}

/**
 * Reverse the outbound import mapping: convert OutboundRecord[] back to
 * DemandLine[] so the allocator can consume them.
 *
 * Each OutboundRecord (origin=IMPORT) corresponds to one shipment+SKU pair
 * that was originally parsed from the "Schedule of the day" sheet. Multiple
 * records for the same shipment+SKU are merged (matching the original import
 * merge logic in adapters/outbound-import.ts).
 */
function outboundToDemandLines(
  records: OutboundRecord[],
  stock: StockBin[],
): DemandLine[] {
  // Build a UPP lookup from stock for the outbound SKUs.
  // UPP is not stored on the outbound record, so we derive it from stock.
  const uppBySku = new Map<string, number>();
  for (const bin of stock) {
    if (!uppBySku.has(bin.sku)) uppBySku.set(bin.sku, bin.upp);
  }

  // Merge by shipment+sku — mirrors the merge in outbound-import.ts
  const merged = new Map<string, DemandLine>();

  for (const rec of records) {
    const key = `${rec.shipmentNumber}|${rec.sku}`;
    const parsed = parsePackedDescription(rec.description);

    const existing = merged.get(key);
    if (existing) {
      // Accumulate quantity (same shipment+sku from multiple rows)
      existing.qtyCartons += rec.quantity;

      // Merge order numbers (avoid duplicates)
      for (const o of parsed.orderNos) {
        if (!existing.orderNos.includes(o)) existing.orderNos.push(o);
      }
      continue;
    }

    merged.set(key, {
      shipmentNumber: rec.shipmentNumber,
      waveNo: rec.waveNo ?? rec.shipmentNumber,
      orderNos: parsed.orderNos,
      sku: rec.sku,
      description: parsed.cleanDescription,
      qtyCartons: rec.quantity,
      upp: uppBySku.get(rec.sku) ?? 1,
      destination: rec.destination,
      shipToLocation: rec.destination,
      transport: rec.truck,
      truckType: rec.truck,
      slotTime: parsed.slotTime,
      deliveryDate: rec.outboundDate,
    });
  }

  return [...merged.values()];
}

// ---- Picklist reconstruction from DB ----------------------------------------

import type { AllocationLine, Picklist, PickType } from '../types.js';
import type { MovementRecord } from '../repository/types.js';

/**
 * Reconstruct Picklist[] from wave + movement DB records for PDF/XLSX output.
 */
export function buildPicklistsFromDB(
  waves: WaveRecord[],
  movementsByWave: Map<string, MovementRecord[]>,
  outboundByWave: Map<string, OutboundRecord[]>,
): Picklist[] {
  const picklists: Picklist[] = [];

  for (const wave of waves) {
    const movements = movementsByWave.get(wave.id) ?? [];
    if (movements.length === 0) continue;

    const picks = movements
      .filter((m) => m.movementType === 'PICK')
      .sort((a, b) => a.sku.localeCompare(b.sku) || (a.seq ?? 0) - (b.seq ?? 0));

    const pickedSkus = new Set(picks.map((m) => m.sku));
    const outbound = (outboundByWave.get(wave.id) ?? []).filter((o) => pickedSkus.has(o.sku));
    const orderNos = [...new Set(
      outbound.flatMap((o) => parsePackedDescription(o.description).orderNos),
    )].sort();

    const lines: AllocationLine[] = picks.map((m, idx) => ({
      shipmentNumber: m.shipmentNumber ?? wave.shipmentNumbers[0] ?? '',
      waveNo: wave.waveNo,
      orderNos,
      sku: m.sku,
      description: m.description,
      location: m.sourceLocation,
      binId: m.sourceLocation,
      batch: m.batch,
      expiryDate: m.expiryDate,
      qtyPick: m.quantity,
      pickType: (m.pickType ?? 'CASE') as PickType,
      upp: 1,
      uom: null,
      qtyRemainingInBin: 0,
      daysToExpiry: 0,
      seq: idx + 1,
      breaksPallet: m.breaksPallet,
    }));

    const totalCartons = lines.reduce((s, l) => s + l.qtyPick, 0);
    const totalPallets = lines.filter((l) => l.pickType === 'PALLET').length;
    const distinctLocations = new Set(lines.map((l) => l.location)).size;
    const distinctSkus = new Set(lines.map((l) => l.sku)).size;

    const hasPallet = lines.some((l) => l.pickType === 'PALLET');
    const hasCase = lines.some((l) => l.pickType === 'CASE');
    const taskType: Picklist['taskType'] = hasPallet && hasCase ? 'MIXED' : hasPallet ? 'PALLET' : 'CASE';

    picklists.push({
      picklistId: `PL-${wave.waveNo}`,
      waveNo: wave.waveNo,
      shipmentNumbers: wave.shipmentNumbers,
      destination: wave.destination,
      shipToLocation: wave.destination,
      transport: wave.truck,
      truckType: wave.truck,
      slotTime: wave.plannedSlot,
      taskType,
      orderNos,
      lines,
      totalCartons,
      totalPallets,
      distinctLocations,
      distinctSkus,
    });
  }

  return picklists.sort(
    (a, b) =>
      (a.slotTime ?? '99:99').localeCompare(b.slotTime ?? '99:99') ||
      a.waveNo.localeCompare(b.waveNo),
  );
}
