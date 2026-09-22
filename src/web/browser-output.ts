import * as XLSX from 'xlsx';
import { checkDigit } from '../pickpath.js';
import { uomLabel } from '../picklist.js';
import type { AllocationResult, MovementRow, PickfaceAssignment } from '../types.js';

const dateStr = (d: Date) => d.toISOString().slice(0, 10);

export function buildWorkbook(
  result: AllocationResult,
  movement?: MovementRow[],
  pickfaces?: Map<string, PickfaceAssignment>,
): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();

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
