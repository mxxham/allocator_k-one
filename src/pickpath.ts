import type { AllocatorConfig } from './config.js';

export interface ParsedLocation {
  location: string;
  aisle: string;
  bay: number;
  level: string;
  position: number;
}

/** CA01A01 → { aisle: 'CA', bay: 1, level: 'A', position: 1 } */
export function parseLocation(raw: string): ParsedLocation | null {
  const location = String(raw ?? '').trim().toUpperCase();
  const m = /^([A-Z]{2})(\d{2})([A-Z])(\d{2})$/.exec(location);
  if (!m) return null;
  return {
    location,
    aisle: m[1],
    bay: Number(m[2]),
    level: m[3],
    position: Number(m[4]),
  };
}

/**
 * Travel cost key. Walk the aisles in configured order; on a serpentine route
 * every second aisle is walked back-to-front so the picker never returns empty.
 * Inside a bay, ground level comes first (heaviest picks lowest).
 */
export function pickSequenceKey(loc: ParsedLocation, config: AllocatorConfig): number {
  const aisleIdx = config.aisleSequence.indexOf(loc.aisle);
  const aisleRank = aisleIdx === -1 ? config.aisleSequence.length : aisleIdx;

  const reverse = config.serpentine && aisleRank % 2 === 1;
  const bayRank = reverse ? 99 - loc.bay : loc.bay;

  const levelIdx = config.levelSequence.indexOf(loc.level);
  const levelRank = levelIdx === -1 ? config.levelSequence.length : levelIdx;

  // aisle > bay > level > position, packed into one sortable integer
  return aisleRank * 1_000_000 + bayRank * 10_000 + levelRank * 100 + loc.position;
}

/** 2-digit scan-verification digit derived from the location code. */
export function checkDigit(location: string): string {
  let sum = 0;
  for (let i = 0; i < location.length; i++) {
    sum = (sum * 31 + location.charCodeAt(i)) % 97;
  }
  return String(sum).padStart(2, '0');
}
