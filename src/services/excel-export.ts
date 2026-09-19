/**
 * Excel export (§34/§35) — current database stock written back to a
 * WMS-compatible workbook. The user's original workbook is NEVER overwritten:
 * exports always get a `_updated_<timestamp>` filename, and an existing
 * target file is refused rather than replaced.
 *
 * The sheet layout lives in ./stock-sheet.ts (Node-free) so the browser
 * Ops UI can build the same workbook client-side.
 */

import { existsSync, mkdirSync } from 'node:fs';
import * as XLSX from 'xlsx';
import type { DbClient } from '../lib/supabase.js';
import { StockRepository } from '../repository/stock-repo.js';
import type { StockRecord } from '../repository/types.js';
import { buildStockWorkbook } from './stock-sheet.js';

export { buildStockSheet, buildStockWorkbook, WMS_COLUMNS } from './stock-sheet.js';

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

/** Write an already-loaded stock list (used by tests and the CLI). */
export function writeStockWorkbook(records: StockRecord[], opts: ExportOptions = {}): ExportResult {
  const outDir = opts.outDir ?? '.';
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const fileName = opts.fileName ?? `WMS_updated_${stamp}.xlsx`;
  const path = `${outDir}/${fileName}`;
  if (existsSync(path)) {
    throw new Error(`Refusing to overwrite ${path} — exports never replace an existing workbook.`);
  }

  XLSX.writeFile(buildStockWorkbook(records), path);

  return {
    path,
    rowCount: records.length,
    totalCartons: records.reduce((s, r) => s + r.quantity, 0),
  };
}
