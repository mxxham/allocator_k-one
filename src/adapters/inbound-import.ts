/**
 * Parse inbound receipt data from the WMS workbook into NewInbound[] for
 * database insert. Uses SheetJS (xlsx) for browser compatibility — same
 * column mapping as adapters/excel-input.ts and web/browser-input.ts but
 * produces NewInbound records instead of StockBin.
 *
 * The "WMS" sheet (header row 4) contains stock on hand. Rows with positive
 * quantity, a valid SKU, and a valid location are treated as yesterday's
 * inbound receipts that were already put away.
 */

import * as XLSX from 'xlsx';
import type { NewInbound } from '../repository/inbound-repo.js';

// ---- constants -----------------------------------------------------------

const SHEET_NAME = 'WMS';
const HEADER_ROW = 4; // 1-based

// ---- types ---------------------------------------------------------------

export interface InboundParseResult {
  records: NewInbound[];
  warnings: string[];
}

// ---- public API ----------------------------------------------------------

/**
 * Parse a WMS workbook ArrayBuffer and return NewInbound records ready for
 * `repos.inbound.create()`.
 *
 * @param buffer  Raw .xlsx file contents (ArrayBuffer)
 * @param opts    Must include `inboundDate` (YYYY-MM-DD string)
 */
export function parseInboundFromWorkbook(
  buffer: ArrayBuffer,
  opts: { inboundDate: string },
): InboundParseResult {
  const wb = XLSX.read(buffer, { type: 'array', cellDates: true });
  const warnings: string[] = [];
  const records: NewInbound[] = [];

  const rows = sheetRows(wb, SHEET_NAME, HEADER_ROW);

  for (const row of rows) {
    const location = asString(row['Lokasi']).toUpperCase();
    if (!location) continue;

    const sku = asSku(row['item']);
    if (!sku) {
      warnings.push(`Row skipped: missing SKU at location ${location}`);
      continue;
    }

    const qty = asNumber(row['Remain Qty']);
    if (qty <= 0) continue;

    const expiryDate = asDate(row['Expired Date']);
    if (!expiryDate) {
      warnings.push(`${location} ${sku}: missing expiry date — skipped`);
      continue;
    }

    const batch = asString(row['Batch']) || null;
    const description = asString(row['Description']);
    const upp = asNumber(row['UPP']) || 1;
    const uom = asString(row['uom']) || null;

    // GR date doubles as the goods-receipt reference number
    const grRaw = row['GR date'];
    const referenceNo = grRaw instanceof Date
      ? grRaw.toISOString().slice(0, 10)
      : asString(grRaw) || opts.inboundDate;

    records.push({
      inboundDate: opts.inboundDate,
      referenceNo,
      sku,
      description,
      location,
      batch,
      expiryDate,
      quantity: qty,
      upp,
      uom,
      notes: null,
    });
  }

  return { records, warnings };
}

// ---- SheetJS row reader --------------------------------------------------

type Row = Record<string, unknown>;

function sheetRows(wb: XLSX.WorkBook, sheetName: string, headerRow: number): Row[] {
  const ws = wb.Sheets[sheetName];
  if (!ws) throw new Error(`Sheet "${sheetName}" not found in workbook`);

  const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1,
    raw: true,
    defval: null,
  });

  const headers = (aoa[headerRow - 1] ?? []).map((h) => String(h ?? '').trim());

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

// ---- cell helpers (same as browser-input.ts) ----------------------------

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

/** SAP material numbers arrive as floats (550044709.0) — normalise to digits. */
function asSku(v: unknown): string {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number') return String(Math.round(v));
  const s = String(v).trim();
  return /^\d+(\.0+)?$/.test(s) ? String(Math.round(Number(s))) : s;
}

function asDate(v: unknown): Date | null {
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    return new Date(Date.UTC(v.getFullYear(), v.getMonth(), v.getDate()));
  }
  if (typeof v === 'number' && v > 20000) {
    // Excel serial date
    return new Date(Math.round((v - 25569) * 86_400_000));
  }
  const s = asString(v);
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
}
