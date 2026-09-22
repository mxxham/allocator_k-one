/**
 * Parse the "Schedule of the day" sheet from a workbook (browser, SheetJS)
 * into NewOutbound[] ready for OutboundRepository.create().
 *
 * Mirrors the demand-parsing logic in adapters/excel-input.ts and
 * web/browser-input.ts but produces database-ready outbound records
 * instead of DemandLine[].
 *
 * Uses SheetJS (xlsx) — no ExcelJS dependency, safe for the browser bundle.
 */

import * as XLSX from 'xlsx';
import type { NewOutbound } from '../repository/outbound-repo.js';

const SHEET_NAME = 'Schedule of the day';
const HEADER_ROW = 1; // 1-based

// ─── public API ───────────────────────────────────────────────────────────────

export interface ParseResult {
  records: NewOutbound[];
  warnings: string[];
}

/**
 * Read the "Schedule of the day" sheet from an ArrayBuffer and return
 * NewOutbound[] grouped by shipment+sku (same merge logic as excel-input.ts).
 *
 * @param buffer   raw workbook bytes (ArrayBuffer)
 * @param opts     { outboundDate } — the date string (YYYY-MM-DD) assigned to
 *                 every record; overridden per-row when "First Delivery Date" is present.
 */
export function parseOutboundFromWorkbook(
  buffer: ArrayBuffer,
  opts: { outboundDate: string },
): ParseResult {
  const wb = XLSX.read(buffer, { type: 'array', cellDates: true });
  const warnings: string[] = [];

  const ws = wb.Sheets[SHEET_NAME];
  if (!ws) {
    return { records: [], warnings: [`Sheet "${SHEET_NAME}" not found in workbook`] };
  }

  const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: null });
  const headers = (aoa[HEADER_ROW - 1] ?? []).map((h) => String(h ?? '').trim());

  const rows = toObjects(aoa, headers, HEADER_ROW);

  // ---- merge by shipment+sku (identical to excel-input.ts) --------------------
  const merged = new Map<string, MergedRow>();
  let currentWave = '';
  const waveByShipment = new Map<string, string>();

  for (const row of rows) {
    const sku = asSku(row['Material']);
    const shipmentNumber = asString(row['Shipment Number']);
    const qty = asNumber(row['Delivery quantity']);

    const noCell = asString(row['NO']);
    if (noCell) currentWave = noCell;

    // ---- validation: reject incomplete rows -----------------------------------
    if (!sku) {
      warnings.push(`Row skipped: missing Material (sku) — shipment "${shipmentNumber}"`);
      continue;
    }
    if (!shipmentNumber) {
      warnings.push(`Row skipped: missing Shipment Number — sku "${sku}"`);
      continue;
    }
    if (qty <= 0) {
      warnings.push(`Row skipped: quantity ${qty} ≤ 0 — sku "${sku}", shipment "${shipmentNumber}"`);
      continue;
    }

    if (!waveByShipment.has(shipmentNumber)) {
      waveByShipment.set(shipmentNumber, currentWave || shipmentNumber);
    }
    const waveNo = waveByShipment.get(shipmentNumber)!;

    const key = `${shipmentNumber}|${sku}`;
    const existing = merged.get(key);
    if (existing) {
      existing.qtyCartons += qty;
      const orderNo = asString(row['Order No']);
      if (orderNo) existing.orderNos.push(orderNo);
      // keep the first description we got (or upgrade if empty)
      if (!existing.description) {
        existing.description = asString(row['Description']);
      }
      // backfill destination / truck / slot if still empty
      existing.destination ??= asString(row['Destination']);
      existing.truck ??= asString(row['TRANSPORT']) || asString(row['Type Truck']) || null;
      existing.slotTime ??= asTime(row['Arrival Slot Time']);
      // prefer a non-default outboundDate if "First Delivery Date" is present
      const deliveryDate = asDbDate(row['First Delivery Date']);
      if (deliveryDate) existing.outboundDate = deliveryDate;
      continue;
    }

    merged.set(key, {
      shipmentNumber,
      waveNo,
      orderNos: [asString(row['Order No'])].filter(Boolean),
      sku,
      description: asString(row['Description']),
      qtyCartons: qty,
      destination: asString(row['Destination']),
      truck: asString(row['TRANSPORT']) || asString(row['Type Truck']) || null,
      slotTime: asTime(row['Arrival Slot Time']),
      outboundDate: asDbDate(row['First Delivery Date']) ?? opts.outboundDate,
    });
  }

  // ---- backfill header fields across all rows of the same shipment -----------
  const byShipment = new Map<string, MergedRow[]>();
  for (const m of merged.values()) {
    const list = byShipment.get(m.shipmentNumber);
    if (list) list.push(m);
    else byShipment.set(m.shipmentNumber, [m]);
  }
  for (const list of byShipment.values()) {
    const truck = list.find((m) => m.truck)?.truck ?? null;
    const slot = list.find((m) => m.slotTime)?.slotTime ?? null;
    for (const m of list) {
      m.truck ??= truck;
      m.slotTime ??= slot;
    }
  }

  // ---- build NewOutbound[] ---------------------------------------------------
  const records: NewOutbound[] = [];
  for (const m of merged.values()) {
    // Pack orderNo + slot info into description since NewOutbound has no "notes"
    const desc = buildDescription(m.description, m.orderNos, m.slotTime);

    records.push({
      outboundDate: m.outboundDate,
      shipmentNumber: m.shipmentNumber,
      waveNo: m.waveNo,
      truck: m.truck,
      destination: m.destination,
      sku: m.sku,
      description: desc,
      quantity: m.qtyCartons,
      origin: 'IMPORT',
    });
  }

  return { records, warnings };
}

// ─── internal helpers ─────────────────────────────────────────────────────────

interface MergedRow {
  shipmentNumber: string;
  waveNo: string;
  orderNos: string[];
  sku: string;
  description: string;
  qtyCartons: number;
  destination: string;
  truck: string | null;
  slotTime: string | null;
  outboundDate: string;
}

type Row = Record<string, unknown>;

/** Convert 2D array to array-of-objects keyed by header names. */
function toObjects(aoa: unknown[][], headers: string[], headerRow: number): Row[] {
  const rows: Row[] = [];
  for (let i = headerRow; i < aoa.length; i++) {
    const line = aoa[i];
    if (!line || line.every((v) => v === null || v === '')) continue;
    const obj: Row = {};
    headers.forEach((h, idx) => {
      if (h) obj[h] = line[idx] ?? null;
    });
    rows.push(obj);
  }
  return rows;
}

function asString(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).trim();
}

function asNumber(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = Number(String(v ?? '').replace(/[, ]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function asSku(v: unknown): string {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number') return String(Math.round(v));
  const s = String(v).trim();
  return /^\d+(\.0+)?$/.test(s) ? String(Math.round(Number(s))) : s;
}

/** Return a YYYY-MM-DD string (for DB date columns) or null. */
function asDbDate(v: unknown): string | null {
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    return fmtDate(v);
  }
  if (typeof v === 'number' && v > 20000) {
    return fmtDate(new Date(Math.round((v - 25569) * 86_400_000)));
  }
  const s = asString(v);
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return fmtDate(d);
}

function fmtDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function asTime(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString().slice(11, 16);
  const s = asString(v);
  if (!s) return null;
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)?/i.exec(s);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const min = m[2];
  const suffix = m[3]?.toUpperCase();
  if (suffix === 'PM' && hour < 12) hour += 12;
  if (suffix === 'AM' && hour === 12) hour = 0;
  return `${String(hour).padStart(2, '0')}:${min}`;
}

/** Combine description, order numbers, and slot into a single description field. */
function buildDescription(raw: string, orderNos: string[], slotTime: string | null): string {
  const parts: string[] = [];
  if (raw) parts.push(raw);
  if (orderNos.length) parts.push(`Orders: ${orderNos.join(', ')}`);
  if (slotTime) parts.push(`Slot: ${slotTime}`);
  return parts.join(' | ');
}
