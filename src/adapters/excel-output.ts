import ExcelJS from 'exceljs';
import { checkDigit, parseLocation, pickSequenceKey } from '../pickpath.js';
import { uomLabel } from '../picklist.js';
import { withConfig, type AllocatorConfig } from '../config.js';
import type { AllocationResult, MovementRow, PickfaceAssignment, ReplenishmentResult, ReplenishmentTask } from '../types.js';

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
  replenishment?: ReplenishmentResult,
  movement?: MovementRow[],
  pickfaces?: Map<string, PickfaceAssignment>,
  config?: AllocatorConfig,
): Promise<void> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'FEFO Allocator';
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
  ]);

  for (const pl of result.picklists) {
    for (const l of pl.lines) {
      const keLokasi = l.breaksPallet ? (pickfaces?.get(l.sku)?.location ?? '') : '';
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

  // ---- Replenishment rows on picklist (bin-to-bin moves) ------------------
  if (replenishment && replenishment.tasks.length > 0) {
    const sorted = [...replenishment.tasks].sort((a, b) => {
      const pa = parseLocation(a.fromLocation);
      const pb = parseLocation(b.fromLocation);
      const ka = pa ? pickSequenceKey(pa, cfg) : Number.MAX_SAFE_INTEGER;
      const kb = pb ? pickSequenceKey(pb, cfg) : Number.MAX_SAFE_INTEGER;
      return ka - kb;
    });
    for (const t of sorted) {
      const row = ws.addRow([
        'REPLENISH',
        '',
        '',
        'REPLEN',
        '',
        t.fromLocation,
        checkDigit(t.fromLocation),
        t.sku,
        t.description,
        t.toLocation,
        t.batch ?? '',
        t.expiryDate,
        t.qtyMove,
        uomLabel(t.uom),
        t.breaksPallet ? 'CASE*' : t.pickType,
        t.qtyRemainingAtSource,
        '',
      ]);
      row.font = { ...FONT, color: { argb: 'FF1F3864' } };
      row.getCell(12).numFmt = 'yyyy-mm-dd';
      row.getCell(6).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F0FE' } };
      row.getCell(10).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F0FE' } };
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

  // ---- Replenishment --------------------------------------------------------
  if (replenishment) {
    const rp = wb.addWorksheet('Replenishment', { views: [{ state: 'frozen', ySplit: 1 }] });
    addHeader(rp, [
      ['Seq', 6],
      ['Material', 12],
      ['Description', 34],
      ['From Bin', 10],
      ['To Pickface', 12],
      ['Batch', 12],
      ['Exp Date', 12],
      ['Qty Move', 10],
      ['UOM', 10],
      ['Type', 8],
      ['Sisa Sumber', 12],
      ['Pickface After', 14],
      ['Reason', 16],
    ]);
    for (const t of replenishment.tasks) {
      const row = rp.addRow([
        t.seq,
        t.sku,
        t.description,
        t.fromLocation,
        t.toLocation,
        t.batch ?? '',
        t.expiryDate,
        t.qtyMove,
        uomLabel(t.uom),
        t.pickType,
        t.qtyRemainingAtSource,
        t.qtyAtPickfaceAfter,
        t.reason,
      ]);
      row.font = FONT;
      row.getCell(7).numFmt = 'yyyy-mm-dd';
      if (t.breaksPallet) row.getCell(10).font = { ...FONT, color: { argb: 'FFC00000' } };
    }
    rp.autoFilter = { from: 'A1', to: 'M1' };

    if (replenishment.shortages.length) {
      const rs = wb.addWorksheet('Replenishment Shortage');
      addHeader(rs, [
        ['Material', 12],
        ['Description', 34],
        ['Pickface', 12],
        ['Needed', 10],
        ['Moved', 10],
        ['Short', 9],
      ]);
      for (const s of replenishment.shortages) {
        rs.addRow([s.sku, s.description, s.toLocation, s.qtyNeeded, s.qtyMoved, s.qtyShort]).font = FONT;
      }
    }
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
