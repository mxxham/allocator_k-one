import type {
  AllocationLine,
  AllocationResult,
  MovementRow,
} from './types.js';

/**
 * Detected double — one instance where the same physical identity
 * (location + SKU + batch + expiry) was touched more than once.
 */
export interface DoubleEntry {
  /** 'PICK' | 'REPLEN' | 'CROSS' */
  type: 'PICK' | 'REPLEN' | 'CROSS';
  sku: string;
  description: string;
  location: string;
  batch: string | null;
  expiryDate: Date;
  /** all movement rows that share this identity */
  movements: MovementRow[];
  /** total cartons across all touches */
  totalQty: number;
}

/**
 * Identity key for a physical stock position.
 * Two movements touching the same key = a double.
 */
function identityKey(
  location: string,
  sku: string,
  batch: string | null,
  expiry: Date,
): string {
  const exp = expiry.toISOString().slice(0, 10);
  return `${location}|${sku}|${batch ?? ''}|${exp}`;
}

function isLevelA(location: string): boolean {
  return location.length >= 5 && location[4] === 'A';
}

/**
 * Detect double picks: same SKU picked from the same location+batch+expiry
 * more than once in the same allocation run. Only detects B-E level (reserve)
 * bins — level A (pickface/staging) bins are excluded.
 */
function detectDoublePicks(lines: AllocationLine[]): DoubleEntry[] {
  const byKey = new Map<string, AllocationLine[]>();
  for (const l of lines) {
    if (isLevelA(l.location)) continue;
    const key = identityKey(l.location, l.sku, l.batch, l.expiryDate);
    const arr = byKey.get(key) ?? [];
    arr.push(l);
    byKey.set(key, arr);
  }

  const doubles: DoubleEntry[] = [];
  for (const [key, picks] of byKey) {
    if (picks.length < 2) continue;
    const first = picks[0];
    const totalQty = picks.reduce((s, p) => s + p.qtyPick, 0);
    doubles.push({
      type: 'PICK',
      sku: first.sku,
      description: first.description,
      location: first.location,
      batch: first.batch,
      expiryDate: first.expiryDate,
      totalQty,
      movements: picks.map((p) => ({
        seq: p.seq,
        type: 'PICK' as const,
        sku: p.sku,
        description: p.description,
        batch: p.batch,
        expiryDate: p.expiryDate,
        qty: p.qtyPick,
        pickType: p.pickType,
        uom: p.uom,
        fromLocation: p.location,
        toLocation: `STAGING → ${p.shipmentNumber}`,
        shipmentNumber: p.shipmentNumber,
        qtyRemainingAtFrom: p.qtyRemainingInBin,
        breaksPallet: p.breaksPallet,
      })),
    });
  }

  return doubles;
}

/**
 * Detect all double movements in a single allocation run.
 */
export function detectDoubles(
  allocation: AllocationResult,
): {
  pickDoubles: DoubleEntry[];
  total: number;
} {
  const pickDoubles = detectDoublePicks(allocation.lines);

  return {
    pickDoubles,
    total: pickDoubles.length,
  };
}
