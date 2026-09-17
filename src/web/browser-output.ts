import * as XLSX from 'xlsx';
import { checkDigit, parseLocation, pickSequenceKey } from '../pickpath.js';
import { uomLabel } from '../picklist.js';
import { withConfig, type AllocatorConfig } from '../config.js';
import type { AllocationResult, MovementRow, PickfaceAssignment, ReplenishmentResult } from '../types.js';

const dateStr = (d: Date) => d.toISOString().slice(0, 10);

export function buildWorkbook(
  result: AllocationResult,
  replenishment?: ReplenishmentResult,
  movement?: MovementRow[],
  pickfaces?: Map<string, PickfaceAssignment>,
  config?: AllocatorConfig,
): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  const cfg = config ?? withConfig();

  const plRows: Record<string, unknown>[] = [];
  for (const pl of result.picklists) {
    for (const l of pl.lines) {
      const keLokasi = l.breaksPallet ? (pickfaces?.get(l.sku)?.location ?? '') : '';
      plRows.push({
        Picklist: pl.picklistId,
        'NO (Wave)': pl.waveNo,
        Shipments: pl.shipmentNumbers.join(', '),
        'DO Number': pl.orderNos.join(', '),
        Seq: l.seq,
        Lokasi: l.location,
        Chk: checkDigit(l.location),
        Material: l.sku,
        Description: l.description,
        'Ke Lokasi': keLokasi,
        Batch: l.batch ?? '',
        'Exp Date': dateStr(l.expiryDate),
        'Qty Pick': l.qtyPick,
        'UOM': uomLabel(l.uom),
        'Pick Type': l.breaksPallet ? 'CASE*' : l.pickType,
        'Sisa di Bin': l.qtyRemainingInBin,
        'Order No': l.orderNos.join(', '),
      });
    }
  }

  if (replenishment && replenishment.tasks.length > 0) {
    const sorted = [...replenishment.tasks].sort((a, b) => {
      const pa = parseLocation(a.fromLocation);
      const pb = parseLocation(b.fromLocation);
      const ka = pa ? pickSequenceKey(pa, cfg) : Number.MAX_SAFE_INTEGER;
      const kb = pb ? pickSequenceKey(pb, cfg) : Number.MAX_SAFE_INTEGER;
      return ka - kb;
    });
    for (const t of sorted) {
      plRows.push({
        Picklist: 'REPLENISH',
        'NO (Wave)': '',
        Shipments: '',
        Task: 'REPLEN',
        Seq: '',
        Lokasi: t.fromLocation,
        Chk: checkDigit(t.fromLocation),
        Material: t.sku,
        Description: t.description,
        'Ke Lokasi': t.toLocation,
        Batch: t.batch ?? '',
        'Exp Date': dateStr(t.expiryDate),
        'Qty Pick': t.qtyMove,
        'UOM': uomLabel(t.uom),
        'Pick Type': t.breaksPallet ? 'CASE*' : t.pickType,
        'Sisa di Bin': t.qtyRemainingAtSource,
        'Order No': '',
      });
    }
  }

  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(plRows), 'Picklist');

  const sumRows = result.picklists.map((pl) => ({
    Picklist: pl.picklistId,
    'NO (Wave)': pl.waveNo,
    Shipments: pl.shipmentNumbers.join(', '),
    Destination: pl.destination,
    Kota: pl.shipToLocation,
    Slot: pl.slotTime ?? '',
    Truck: pl.truckType ?? '',
    'DO Number': pl.orderNos.join(', '),
    Lines: pl.lines.length,
    Locations: pl.distinctLocations,
    SKUs: pl.distinctSkus,
    'Full Pallets': pl.totalPallets,
    'Total Ctn': pl.totalCartons,
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sumRows), 'Summary');

  const shRows = result.shortages.length
    ? result.shortages.map((s) => ({
        SHIPMENT: s.shipmentNumber,
        Material: s.sku,
        Description: s.description,
        Requested: s.qtyRequested,
        Allocated: s.qtyAllocated,
        Short: s.qtyShort,
        Reason: s.reason,
        'Blocked by shelf life': s.qtyRejectedByShelfLife,
        'Already in staging': s.qtyInStaging,
        'Order No': s.orderNos.join(', '),
      }))
    : [{ Note: 'No shortage — every line fully allocated' }];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(shRows), 'Shortage');

  const exRows = result.warnings.map((w) => ({ Level: w.level, Code: w.code, Message: w.message }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(exRows), 'Exceptions');

  if (replenishment) {
    const rpRows = replenishment.tasks.map((t) => ({
      Seq: t.seq,
      Material: t.sku,
      Description: t.description,
      'From Bin': t.fromLocation,
      'To Pickface': t.toLocation,
      Batch: t.batch ?? '',
      'Exp Date': dateStr(t.expiryDate),
      'Qty Move': t.qtyMove,
      'UOM': uomLabel(t.uom),
      Type: t.breaksPallet ? 'CASE*' : t.pickType,
      'Sisa Sumber': t.qtyRemainingAtSource,
      'Pickface After': t.qtyAtPickfaceAfter,
      Reason: t.reason,
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rpRows), 'Replenishment');

    if (replenishment.shortages.length) {
      const rsRows = replenishment.shortages.map((s) => ({
        Material: s.sku,
        Description: s.description,
        Pickface: s.toLocation,
        Needed: s.qtyNeeded,
        Moved: s.qtyMoved,
        Short: s.qtyShort,
      }));
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rsRows), 'Replenishment Shortage');
    }
  }

  if (movement) {
    const mvRows = movement.map((m) => ({
      Seq: m.seq,
      Type: m.type,
      Material: m.sku,
      Description: m.description,
      Batch: m.batch ?? '',
      'Exp Date': dateStr(m.expiryDate),
      Qty: m.qty,
      'UOM': uomLabel(m.uom),
      From: m.fromLocation,
      To: m.toLocation,
      Shipment: m.shipmentNumber ?? '',
      'Sisa di From': m.qtyRemainingAtFrom,
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(mvRows), 'Movement Report');
  }

  if (pickfaces) {
    const pfRows = [...pickfaces.values()]
      .sort((a, b) => a.sku.localeCompare(b.sku))
      .map((p) => ({
        Material: p.sku,
        Description: p.description,
        'Pickface Bin': p.location,
        'Target Qty': p.targetQtyCartons,
        Source: p.isAuto ? 'Auto (nearest bin)' : 'Assigned',
      }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(pfRows), 'Pickfaces');
  }

  return wb;
}

export function downloadWorkbook(wb: XLSX.WorkBook, filename: string): void {
  XLSX.writeFile(wb, filename);
}
