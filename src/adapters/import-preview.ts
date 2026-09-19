/**
 * Import preview + execution — deliberately free of ExcelJS so the browser
 * bundle (Ops UI) can validate a workbook parsed by SheetJS and post it
 * through the same executeImport path as the CLI.
 */

import type { DemandLine, StockBin, Warning } from '../types.js';
import type { DbClient } from '../lib/supabase.js';
import type { InitialImportRow, RpcResult } from '../lib/database.types.js';
import { StockRepository } from '../repository/stock-repo.js';
import { formatDbDate } from '../repository/types.js';
import { stockIdentityKey } from '../ledger.js';

export type ImportCheckLevel = 'ERROR' | 'WARN' | 'INFO';

export interface ImportCheck {
  level: ImportCheckLevel;
  code: string;
  message: string;
}

export interface ImportPreview {
  sourceFile: string;
  /** physical stock records that would be written */
  stockRowCount: number;
  totalCartons: number;
  distinctSkus: number;
  /** rows whose batch is null (identity uses empty string for them) */
  nullBatchCount: number;
  /** demand lines in the workbook — informational, not imported here */
  demandRowCount: number;
  /** identities appearing more than once inside the file itself */
  duplicateIdentities: { identityKey: string; count: number; totalQty: number }[];
  checks: ImportCheck[];
  /** true when nothing blocks executeImport() */
  canImport: boolean;
  rows: InitialImportRow[];
}

/** The subset of LoadedData the preview needs — matches both the ExcelJS and SheetJS parsers. */
export interface PreviewInput {
  stock: StockBin[];
  demand: DemandLine[];
  warnings: Warning[];
}

export function stockBinToImportRow(bin: StockBin): InitialImportRow {
  return {
    location: bin.location,
    sku: bin.sku,
    description: bin.description,
    batch: bin.batch,
    expiry_date: formatDbDate(bin.expiryDate),
    quantity: bin.qtyCartons,
    upp: bin.upp,
    uom: bin.uom,
    aisle: bin.aisle,
    bay: bin.bay,
    level: bin.level,
    position: bin.position,
    gr_date: bin.grDate ? formatDbDate(bin.grDate) : null,
  };
}

/** Build the preview report from an already-parsed workbook. */
export function validateImport(sourceFile: string, loaded: PreviewInput): ImportPreview {
  const checks: ImportCheck[] = [];
  const rows = loaded.stock.map(stockBinToImportRow);

  const byIdentity = new Map<string, { count: number; totalQty: number }>();
  for (const bin of loaded.stock) {
    const key = stockIdentityKey(bin.location, bin.sku, bin.batch, bin.expiryDate);
    const e = byIdentity.get(key);
    if (e) {
      e.count += 1;
      e.totalQty += bin.qtyCartons;
    } else {
      byIdentity.set(key, { count: 1, totalQty: bin.qtyCartons });
    }
  }
  const duplicateIdentities = [...byIdentity.entries()]
    .filter(([, e]) => e.count > 1)
    .map(([identityKey, e]) => ({ identityKey, ...e }));

  for (const dup of duplicateIdentities) {
    checks.push({
      level: 'ERROR',
      code: 'DUPLICATE_IDENTITY',
      message: `${dup.identityKey} appears ${dup.count}× in the file (${dup.totalQty} cartons total) — merge or fix the source rows`,
    });
  }

  // Row-level sanity (the parsers already dropped qty<=0 and missing
  // sku/expiry rows into warnings — surface anything flagged as ERROR).
  for (const w of loaded.warnings) {
    checks.push({ level: w.level, code: w.code, message: w.message });
  }

  const invalidQty = rows.filter((r) => !Number.isInteger(r.quantity) || r.quantity < 0);
  if (invalidQty.length) {
    checks.push({
      level: 'ERROR',
      code: 'INVALID_QUANTITY',
      message: `${invalidQty.length} row(s) have a negative or fractional quantity`,
    });
  }

  const distinctSkus = new Set(rows.map((r) => r.sku));
  const nullBatchCount = rows.filter((r) => r.batch === null || r.batch === '').length;

  const errorCount = checks.filter((c) => c.level === 'ERROR').length;
  return {
    sourceFile,
    stockRowCount: rows.length,
    totalCartons: rows.reduce((s, r) => s + r.quantity, 0),
    distinctSkus: distinctSkus.size,
    nullBatchCount,
    demandRowCount: loaded.demand.length,
    duplicateIdentities,
    checks,
    canImport: errorCount === 0 && rows.length > 0,
    rows,
  };
}

export interface ExecuteImportOptions {
  actor: string;
  mode?: 'FAIL_ON_CONFLICT' | 'REPLACE';
  date?: Date | string;
}

/**
 * Post a validated preview to the database via the initial_import RPC.
 * Refuses to run when the preview is blocked; the RPC itself re-validates
 * inside the transaction, so this is defence in depth, not the only gate.
 */
export async function executeImport(
  db: DbClient,
  preview: ImportPreview,
  opts: ExecuteImportOptions,
): Promise<RpcResult> {
  if (!preview.canImport) {
    const errors = preview.checks.filter((c) => c.level === 'ERROR').map((c) => c.message);
    throw new Error(`Import blocked by ${errors.length} validation error(s):\n  - ${errors.join('\n  - ')}`);
  }
  const repo = new StockRepository(db);
  return repo.initialImport(preview.rows, opts.actor, opts.mode ?? 'FAIL_ON_CONFLICT', opts.date);
}

/** Human-readable preview for the CLI / Ops UI log. */
export function formatPreview(preview: ImportPreview): string {
  const lines: string[] = [];
  lines.push(`Import preview — ${preview.sourceFile}`);
  lines.push(`  stock rows to import : ${preview.stockRowCount}`);
  lines.push(`  total cartons        : ${preview.totalCartons}`);
  lines.push(`  distinct SKUs        : ${preview.distinctSkus}`);
  lines.push(`  rows without batch   : ${preview.nullBatchCount}`);
  lines.push(`  demand lines (info)  : ${preview.demandRowCount}`);
  if (preview.duplicateIdentities.length) {
    lines.push(`  duplicate identities : ${preview.duplicateIdentities.length}`);
  }
  if (preview.checks.length) {
    lines.push(`  checks:`);
    for (const c of preview.checks) {
      lines.push(`    [${c.level}] ${c.code}: ${c.message}`);
    }
  } else {
    lines.push(`  checks               : none`);
  }
  lines.push(preview.canImport ? '  status               : READY TO IMPORT' : '  status               : BLOCKED');
  return lines.join('\n');
}
