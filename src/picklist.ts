import type { AllocatorConfig } from './config.js';
import { parseLocation, pickSequenceKey } from './pickpath.js';
import type { AllocationLine, AllocationResult, DemandLine, Picklist, PickType } from './types.js';

/**
 * Turn raw allocations into printable pick tasks.
 *
 * Grouped by SHIPMENT — column D ("Shipment Number") on Schedule of the day —
 * so every shipment is its own picklist, `PL-<shipment number>`. The NO wave
 * (column R) is kept only as a label: some warehouses run several shipments
 * together, and the printable header still shows which NO run the shipment
 * belongs to.
 *
 *   · one picklist per shipment (optionally split forklift work from handpicks)
 *   · lines sorted along the serpentine pick path, not by SKU
 *   · sequence numbers assigned last so they match the walking order
 */
export function buildPicklists(
  result: AllocationResult,
  demand: DemandLine[],
  config: AllocatorConfig,
): Picklist[] {
  const header = new Map<string, DemandLine>();
  for (const d of demand) {
    const key = d.shipmentNumber || d.waveNo;
    if (!header.has(key)) header.set(key, d);
  }

  const waveByShipment = new Map<string, string>();
  for (const d of demand) {
    const key = d.shipmentNumber || d.waveNo;
    if (!waveByShipment.has(key)) waveByShipment.set(key, d.waveNo);
  }

  const groups = new Map<string, AllocationLine[]>();
  for (const line of result.lines) {
    const key = line.shipmentNumber || line.waveNo;
    const bucket = groups.get(key);
    if (bucket) bucket.push(line);
    else groups.set(key, [line]);
  }

  const picklists: Picklist[] = [];

  for (const [key, rawLines] of groups) {
    const h = header.get(key);
    const waveNo = waveByShipment.get(key) ?? key;
    const shipmentNumbers = rawLines[0]?.shipmentNumber ? [rawLines[0].shipmentNumber] : [];

    const handpick = rawLines
      .filter((l) => l.pickType === 'CASE')
      .sort((a, b) => a.sku.localeCompare(b.sku) || seqOf(a, config) - seqOf(b, config));
    const forklift = rawLines
      .filter((l) => l.pickType !== 'CASE')
      .sort((a, b) => a.sku.localeCompare(b.sku) || seqOf(a, config) - seqOf(b, config));
    const sorted = [...handpick, ...forklift];

    const chunks = config.maxLinesPerPicklist > 0 ? chunk(sorted, config.maxLinesPerPicklist) : [sorted];

    chunks.forEach((lines, idx) => {
      lines.forEach((l, i) => (l.seq = i + 1));
      const suffix = chunks.length > 1 ? `-${idx + 1}` : '';
      const allOrderNos = [...new Set(rawLines.flatMap((l) => l.orderNos))].sort();

      picklists.push({
        picklistId: `PL-${key}${suffix}`,
        waveNo,
        shipmentNumbers,
        destination: h?.destination ?? '',
        shipToLocation: h?.shipToLocation ?? '',
        transport: h?.transport ?? null,
        truckType: h?.truckType ?? null,
        slotTime: h?.slotTime ?? null,
        taskType: 'MIXED',
        orderNos: allOrderNos,
        lines,
        totalCartons: lines.reduce((s, l) => s + l.qtyPick, 0),
        totalPallets: lines.filter((l) => l.pickType === 'PALLET').length,
        distinctLocations: new Set(lines.map((l) => l.location)).size,
        distinctSkus: new Set(lines.map((l) => l.sku)).size,
      });
    });
  }

  return picklists.sort(
    (a, b) =>
      (a.slotTime ?? '99:99').localeCompare(b.slotTime ?? '99:99') ||
      waveSortKey(a.waveNo) - waveSortKey(b.waveNo) ||
      a.shipmentNumbers[0]!.localeCompare(b.shipmentNumbers[0]!) ||
      a.taskType.localeCompare(b.taskType),
  );
}

function waveSortKey(waveNo: string): number {
  const n = Number(waveNo);
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

function seqOf(line: AllocationLine, config: AllocatorConfig): number {
  const parsed = parseLocation(line.location);
  return parsed ? pickSequenceKey(parsed, config) : Number.MAX_SAFE_INTEGER;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** cartons → "2 plt + 14 ctn" */
export function formatQty(cartons: number, upp: number, uom?: string | null): string {
  if (!upp || upp <= 1) return `${cartons} ${uomLabel(uom ?? null)}`;
  const plt = Math.floor(cartons / upp);
  const loose = cartons % upp;
  const unit = uomLabel(uom ?? null);
  if (plt && loose) return `${plt} plt + ${loose} ${unit}`;
  if (plt) return `${plt} plt`;
  return `${loose} ${unit}`;
}

export function uomLabel(uom: string | null): string {
  if (!uom) return 'Carton';
  const lower = uom.toLowerCase();
  if (lower === 'ctn' || lower === 'car') return 'Carton';
  if (lower === 'plt' || lower === 'pal') return 'Pallet';
  if (lower === 'drum' || lower === 'drm') return 'Drum';
  if (lower === 'fluidbag' || lower === 'flb') return 'Fluidbag';
  if (lower === 'ibc' || lower === 'ibm') return 'IBC';
  return uom;
}
