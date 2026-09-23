import ExcelJS from 'exceljs';
import { checkDigit, parseLocation } from '../pickpath.js';
import { uomLabel } from '../picklist.js';
import { withConfig, type AllocatorConfig } from '../config.js';
import type { AllocationResult, MovementRow, PickfaceAssignment } from '../types.js';

const FONT = { name: 'Arial', size: 10 };
const HEAD = { name: 'Arial', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
const HEAD_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3864' } };

/**
 * Writes the picklist workbook. The "Picklist" sheet keeps the column names the
 * warehouse already uses on "picking of the day" (SHIPMENT / Lokasi / Material /
 * Description / Qty Pick) so the floor sees a familiar sheet, with the FEFO
 * evidence columns added to its right. Bin-to-bin replenishment moves are
 * included as rows on the picklist so warehouse staff see the full picture.
 */
export async function writePicklistWorkbook(
  result: AllocationResult,
  outPath: string,
  movement?: MovementRow[],
  pickfaces?: Map<string, PickfaceAssignment>,
  config?: AllocatorConfig,
): Promise<void> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'K-one Allocator';
  wb.created = result.generatedAt;
  const cfg = config ?? withConfig();

  // ---- Picklist -----------------------------------------------------------
  const ws = wb.addWorksheet('Picklist', { views: [{ state: 'frozen', ySplit: 1 }] });
  addHeader(ws, [
    ['Picklist', 16],
    ['NO (Wave)', 10],
    ['Shipments', 16],
    ['Task', 10],
    ['Seq', 6],
    ['Lokasi', 10],
    ['Chk', 6],
    ['Material', 12],
    ['Description', 34],
    ['Ke Lokasi', 10],
    ['Batch', 12],
    ['Exp Date', 12],
    ['Qty Pick', 10],
    ['UOM', 10],
    ['Pick Type', 10],
    ['Sisa di Bin', 11],
    ['Order No', 26],
    ['Print Date', 14],
  ]);

  for (const pl of result.picklists) {
    for (const l of pl.lines) {
      const pfLoc = pickfaces?.get(l.sku)?.location ?? '';
      const srcLevel = parseLocation(l.location)?.level ?? '';
      const keLokasi = srcLevel !== 'A' && l.qtyRemainingInBin > 0 && pfLoc && l.location !== pfLoc ? pfLoc : '';
      const row = ws.addRow([
        pl.picklistId,
        pl.waveNo,
        pl.shipmentNumbers.join(', '),
        `DO Number: ${pl.orderNos.join(', ')}`,
        l.seq,
        l.location,
        checkDigit(l.location),
        l.sku,
        l.description,
        keLokasi,
        l.batch ?? '',
        l.expiryDate,
        l.qtyPick,
        uomLabel(l.uom),
        l.pickType,
        l.qtyRemainingInBin,
        l.orderNos.join(', '),
        new Date().toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }),
      ]);
      row.font = FONT;
      row.getCell(12).numFmt = 'yyyy-mm-dd';
      if (keLokasi) {
        row.getCell(10).font = { ...FONT, color: { argb: 'FF1F3864' }, bold: true };
      }
      if (l.breaksPallet) {
        row.getCell(15).font = { ...FONT, color: { argb: 'FFC00000' } };
        row.getCell(15).value = 'CASE*';
      }
    }
  }

  ws.autoFilter = { from: 'A1', to: 'Q1' };

  ws.autoFilter = { from: 'A1', to: 'P1' };

  // ---- Summary ------------------------------------------------------------
  const sum = wb.addWorksheet('Summary');
  addHeader(sum, [
    ['Picklist', 16],
    ['NO (Wave)', 10],
    ['Shipments', 16],
    ['Destination', 28],
    ['Kota', 16],
    ['Slot', 8],
    ['Truck', 8],
    ['Task', 10],
    ['Lines', 8],
    ['Locations', 10],
    ['SKUs', 8],
    ['Full Pallets', 12],
    ['Total Ctn', 10],
  ]);
  for (const pl of result.picklists) {
    sum.addRow([
      pl.picklistId,
      pl.waveNo,
      pl.shipmentNumbers.join(', '),
      pl.destination,
      pl.shipToLocation,
      pl.slotTime ?? '',
      pl.truckType ?? '',
      pl.taskType,
      pl.lines.length,
      pl.distinctLocations,
      pl.distinctSkus,
      pl.totalPallets,
      pl.totalCartons,
    ]).font = FONT;
  }

  // ---- Shortage -----------------------------------------------------------
  const sh = wb.addWorksheet('Shortage');
  addHeader(sh, [
    ['SHIPMENT', 14],
    ['Material', 12],
    ['Description', 34],
    ['Requested', 11],
    ['Allocated', 11],
    ['Short', 9],
    ['Reason', 22],
    ['Blocked by shelf life', 20],
    ['Already in staging', 18],
    ['Order No', 26],
  ]);
  for (const s of result.shortages) {
    sh.addRow([
      s.shipmentNumber,
      s.sku,
      s.description,
      s.qtyRequested,
      s.qtyAllocated,
      s.qtyShort,
      s.reason,
      s.qtyRejectedByShelfLife,
      s.qtyInStaging,
      s.orderNos.join(', '),
    ]).font = FONT;
  }
  if (result.shortages.length === 0) sh.addRow(['No shortage — every line fully allocated']).font = FONT;

  // ---- Exceptions ---------------------------------------------------------
  const ex = wb.addWorksheet('Exceptions');
  addHeader(ex, [
    ['Level', 8],
    ['Code', 22],
    ['Message', 90],
  ]);
  for (const w of result.warnings) {
    const row = ex.addRow([w.level, w.code, w.message]);
    row.font = FONT;
    if (w.level === 'ERROR') row.getCell(1).font = { ...FONT, bold: true, color: { argb: 'FFC00000' } };
  }

  // ---- Movement report --------------------------------------------------------
  if (movement) {
    const mv = wb.addWorksheet('Movement Report', { views: [{ state: 'frozen', ySplit: 1 }] });
    addHeader(mv, [
      ['Seq', 6],
      ['Type', 9],
      ['Material', 12],
      ['Description', 34],
      ['Batch', 12],
      ['Exp Date', 12],
      ['Qty', 8],
      ['UOM', 10],
      ['From', 10],
      ['To', 20],
      ['Shipment', 12],
      ['Sisa di From', 12],
    ]);
    for (const m of movement) {
      const row = mv.addRow([
        m.seq,
        m.type,
        m.sku,
        m.description,
        m.batch ?? '',
        m.expiryDate,
        m.qty,
        uomLabel(m.uom),
        m.fromLocation,
        m.toLocation,
        m.shipmentNumber ?? '',
        m.qtyRemainingAtFrom,
      ]);
      row.font = FONT;
      row.getCell(6).numFmt = 'yyyy-mm-dd';
      row.getCell(2).font = { ...FONT, bold: true, color: { argb: m.type === 'REPLEN' ? 'FF1F3864' : 'FF375623' } };
    }
    mv.autoFilter = { from: 'A1', to: 'L1' };
  }

  // ---- Pickfaces --------------------------------------------------------------
  if (pickfaces) {
    const pf = wb.addWorksheet('Pickfaces');
    addHeader(pf, [
      ['Material', 12],
      ['Description', 34],
      ['Pickface Bin', 12],
      ['Target Qty', 11],
      ['Source', 20],
    ]);
    for (const p of [...pickfaces.values()].sort((a, b) => a.sku.localeCompare(b.sku))) {
      pf.addRow([p.sku, p.description, p.location, p.targetQtyCartons, p.isAuto ? 'Auto (nearest bin)' : 'Assigned']).font = FONT;
    }
    pf.autoFilter = { from: 'A1', to: 'E1' };
  }

  await wb.xlsx.writeFile(outPath);
}

function addHeader(ws: ExcelJS.Worksheet, cols: [string, number][]): void {
  ws.columns = cols.map(([header, width]) => ({ header, width }));
  const row = ws.getRow(1);
  row.font = HEAD;
  row.eachCell((c) => (c.fill = HEAD_FILL));
  row.alignment = { vertical: 'middle' };
}
