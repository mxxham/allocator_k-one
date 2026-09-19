/**
 * Excel export (§34/§35) — current database stock written back to a
 * WMS-compatible workbook. The user's original workbook is NEVER overwritten:
 * exports always get a `_updated_<timestamp>` filename.
 *
 * The sheet mirrors the input layout (sheet "WMS", header on row 4, same
 * column names) so an export can be re-imported or fed to the allocator
 * without touching the parsers. Dates are written as YYYY-MM-DD strings —
 * the timezone-safe form both Excel adapters already parse.
 */

import { existsSync, mkdirSync } from 'node:fs';
import * as XLSX from 'xlsx';
import type { DbClient } from '../lib/supabase.js';
import { StockRepository } from '../repository/stock-repo.js';
import { formatDbDate, type StockRecord } from '../repository/types.js';

/** Column names must match SHEETS.stock expectations in excel-input.ts. */
const WMS_COLUMNS = [
  'Lokasi',
  'item',
  'Description',
  'Batch',
  'Expired Date',
  'GR date',
  'on hand',
  'UPP',
  'uom',
  'status',
] as const;

export function buildStockSheet(records: StockRecord[]): XLSX.WorkSheet {
  const aoa: (string | number | null)[][] = [];
  // rows 1-3 stay empty — the WMS sheet carries its header on row 4
  aoa.push([], [], []);
  aoa.push([...WMS_COLUMNS]);
  for (const r of records) {
    aoa.push([
      r.location,
      r.sku,
      r.description,
      r.batch,
      formatDbDate(r.expiryDate),
      r.grDate ? formatDbDate(r.grDate) : null,
      r.quantity,
      r.upp,
      r.uom,
      'Aktif',
    ]);
  }
  return XLSX.utils.aoa_to_sheet(aoa);
}

export interface ExportOptions {
  outDir?: string;
  /** override the generated filename (still refused if it already exists) */
  fileName?: string;
}

export interface ExportResult {
  path: string;
  rowCount: number;
  totalCartons: number;
}

/** Read current stock from the database and write the updated workbook. */
export async function exportStockToExcel(db: DbClient, opts: ExportOptions = {}): Promise<ExportResult> {
  const repo = new StockRepository(db);
  const records = (await repo.listAll()).filter((r) => r.quantity > 0);
  return writeStockWorkbook(records, opts);
}

/** Write an already-loaded stock list (used by tests and the browser flow). */
export function writeStockWorkbook(records: StockRecord[], opts: ExportOptions = {}): ExportResult {
  const outDir = opts.outDir ?? '.';
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const fileName = opts.fileName ?? `WMS_updated_${stamp}.xlsx`;
  const path = `${outDir}/${fileName}`;
  if (existsSync(path)) {
    throw new Error(`Refusing to overwrite ${path} — exports never replace an existing workbook.`);
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, buildStockSheet(records), 'WMS');
  // a WMS workbook must carry all three sheets for the parsers to accept it
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[]]), 'Schedule of the day');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[]]), 'MASTER DATA');
  XLSX.writeFile(wb, path);

  return {
    path,
    rowCount: records.length,
    totalCartons: records.reduce((s, r) => s + r.quantity, 0),
  };
}
