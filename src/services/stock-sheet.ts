/**
 * WMS sheet builder — no Node dependencies, safe for the browser bundle.
 * Column names must match SHEETS.stock expectations in excel-input.ts so an
 * exported workbook can be re-imported or fed to the allocator unchanged.
 * Dates are written as YYYY-MM-DD strings (the timezone-safe form both Excel
 * adapters parse).
 */

import * as XLSX from 'xlsx';
import { formatDbDate, type StockRecord } from '../repository/types.js';

export const WMS_COLUMNS = [
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

export function buildStockWorkbook(records: StockRecord[]): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, buildStockSheet(records), 'WMS');
  // a WMS workbook must carry all three sheets for the parsers to accept it
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[]]), 'Schedule of the day');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[]]), 'MASTER DATA');
  return wb;
}
