/**
 * Planning writer — persists an allocation run as PLANNED records only.
 *
 * PLANNED ≠ EXECUTED: nothing here touches the stock table. Waves are written
 * PENDING, movements PLANNED, outbound rows PLANNED (origin=ALLOCATION so
 * their stock is deducted by posting movements, never twice).
 *
 * The AllocationResult must be the FINAL one — i.e. after
 * relocateByWaveOrder() has run — because pallet-break relocations and
 * post-break pick locations are read from the mutated lines, mirroring
 * computeStockAfterMovements() in src/ledger.ts.
 */

import type { DbClient } from '../lib/supabase.js';
import type {
  AllocationLine,
  AllocationResult,
  DemandLine,
  PickfaceAssignment,
} from '../types.js';
import { createRepositories } from '../repository/index.js';
import type { NewMovement } from '../repository/movement-repo.js';
import type { NewWave } from '../repository/wave-repo.js';
import type { NewOutbound } from '../repository/outbound-repo.js';
import type { WaveRecord } from '../repository/types.js';

export interface PersistPlanInput {
  allocation: AllocationResult;
  demand: DemandLine[];
  pickfaces: Map<string, PickfaceAssignment>;
  asOf: Date;
}

export interface PersistPlanResult {
  waves: WaveRecord[];
  movementCount: number;
  outboundCount: number;
  /** PICK / REPLENISH (pallet-break relocations) */
  counts: { picks: number; breakRelocations: number };
}

/**
 * Every record the plan would write, derived purely (no database).
 * Movements/outbound carry waveNo but no waveId yet — ids only exist after
 * the waves are inserted.
 */
export interface PlanRecords {
  waves: NewWave[];
  movements: NewMovement[];
  outbound: NewOutbound[];
  counts: { picks: number; breakRelocations: number };
}

interface WaveDemandGroup {
  waveNo: string;
  shipmentNumbers: string[];
  truck: string | null;
  destination: string;
  plannedSlot: string | null;
}

function groupWaves(demand: DemandLine[]): WaveDemandGroup[] {
  const byWave = new Map<string, WaveDemandGroup>();
  for (const d of demand) {
    let g = byWave.get(d.waveNo);
    if (!g) {
      g = {
        waveNo: d.waveNo,
        shipmentNumbers: [],
        truck: d.truckType,
        destination: d.destination,
        plannedSlot: d.slotTime,
      };
      byWave.set(d.waveNo, g);
    }
    if (!g.shipmentNumbers.includes(d.shipmentNumber)) g.shipmentNumbers.push(d.shipmentNumber);
    g.truck ??= d.truckType;
    g.destination ||= d.destination;
    g.plannedSlot ??= d.slotTime;
  }
  return [...byWave.values()];
}

/**
 * The pallet-break relocation for a pick line, mirroring ledger.ts:
 * when a pick opens a sealed pallet away from the SKU's pickface, the loose
 * remainder moves to the pickface. Null when no relocation applies.
 */
function breakRelocationFor(
  line: AllocationLine,
  pickfaces: Map<string, PickfaceAssignment>,
): { source: string; destination: string; qty: number } | null {
  if (!line.breaksPallet) return null;
  const pf = pickfaces.get(line.sku);
  if (!pf) return null;
  if (line.location === pf.location) return null;
  if (line.qtyRemainingInBin <= 0) return null;
  return { source: line.location, destination: pf.location, qty: line.qtyRemainingInBin };
}

/** Pure derivation of the plan records (used by persistPlan and by tests). */
export function buildPlan(input: PersistPlanInput): PlanRecords {
  const { allocation, demand, pickfaces, asOf } = input;

  // 1. waves (PENDING) — wave_no is a label, not chronological order
  const groups = groupWaves(demand);
  const waves: NewWave[] = groups.map((g) => ({
    waveNo: g.waveNo,
    plannedDate: asOf,
    shipmentNumbers: g.shipmentNumbers,
    truck: g.truck,
    destination: g.destination,
    plannedSlot: g.plannedSlot,
  }));

  // 2. movements (PLANNED)
  const movements: NewMovement[] = [];

  // 2a. picks per wave, in travel order; a pallet-break relocation is emitted
  // immediately BEFORE its pick so later picks from the pickface find stock.
  let pickCount = 0;
  let breakCount = 0;
  const linesByWave = new Map<string, AllocationLine[]>();
  for (const l of allocation.lines) {
    const list = linesByWave.get(l.waveNo);
    if (list) list.push(l);
    else linesByWave.set(l.waveNo, [l]);
  }
  for (const [waveNo, lines] of linesByWave) {
    const sorted = [...lines].sort((a, b) => a.seq - b.seq);
    let seq = 1;
    for (const l of sorted) {
      const reloc = breakRelocationFor(l, pickfaces);
      if (reloc) {
        movements.push({
          waveId: null,
          waveNo,
          shipmentNumber: null,
          movementType: 'REPLENISH',
          sku: l.sku,
          description: l.description,
          sourceLocation: reloc.source,
          destinationLocation: reloc.destination,
          batch: l.batch,
          expiryDate: l.expiryDate,
          quantity: reloc.qty,
          pickType: 'CASE',
          breaksPallet: true,
          seq: seq++,
        });
        breakCount++;
      }
      movements.push({
        waveId: null,
        waveNo,
        shipmentNumber: l.shipmentNumber,
        movementType: 'PICK',
        sku: l.sku,
        description: l.description,
        sourceLocation: l.location,
        destinationLocation: null,
        batch: l.batch,
        expiryDate: l.expiryDate,
        quantity: l.qtyPick,
        pickType: l.pickType,
        breaksPallet: l.breaksPallet,
        seq: seq++,
      });
      pickCount++;
    }
  }

  // 3. outbound rows (PLANNED, origin=ALLOCATION) — one per shipment+SKU,
  // quantity = what was actually allocated (shortages are not shipments).
  const outboundByKey = new Map<string, NewOutbound>();
  for (const l of allocation.lines) {
    const key = `${l.shipmentNumber}|${l.sku}`;
    const existing = outboundByKey.get(key);
    if (existing) {
      existing.quantity += l.qtyPick;
      continue;
    }
    const d = demand.find((x) => x.shipmentNumber === l.shipmentNumber && x.sku === l.sku);
    outboundByKey.set(key, {
      outboundDate: asOf,
      shipmentNumber: l.shipmentNumber,
      waveId: null,
      waveNo: l.waveNo,
      truck: d?.truckType ?? null,
      destination: d?.destination ?? '',
      sku: l.sku,
      description: l.description,
      quantity: l.qtyPick,
      origin: 'ALLOCATION',
    });
  }

  return {
    waves,
    movements,
    outbound: [...outboundByKey.values()],
    counts: { picks: pickCount, breakRelocations: breakCount },
  };
}

export async function persistPlan(db: DbClient, input: PersistPlanInput): Promise<PersistPlanResult> {
  const repos = createRepositories(db);
  const plan = buildPlan(input);

  await repos.waves.deletePendingByDate(input.asOf);
  const waves = await repos.waves.create(plan.waves);
  const waveIdByNo = new Map(waves.map((w) => [w.waveNo, w.id]));

  // link movements/outbound to their freshly-created wave ids
  for (const m of plan.movements) {
    if (m.waveNo) m.waveId = waveIdByNo.get(m.waveNo) ?? null;
  }
  for (const o of plan.outbound) {
    if (o.waveNo) o.waveId = waveIdByNo.get(o.waveNo) ?? null;
  }

  await repos.movements.create(plan.movements);
  const outbound = await repos.outbound.create(plan.outbound);

  return {
    waves,
    movementCount: plan.movements.length,
    outboundCount: outbound.length,
    counts: plan.counts,
  };
}
