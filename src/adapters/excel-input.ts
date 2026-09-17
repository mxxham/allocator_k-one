import ExcelJS from 'exceljs';
import type { AllocatorConfig } from '../config.js';
import { parseLocation } from '../pickpath.js';
import type { DemandLine, StockBin, Warning } from '../types.js';

/**
 * Reads the operational workbook "Warehouse Management System <date>.xlsx".
 *
 *   sheet "WMS"               → stock on hand, one row per pallet position
 *                               (header is on row 4, not row 1)
 *   sheet "Schedule of the day" → today's outbound demand
 *   sheet "MASTER DATA"        → SKU master, used to fill UPP gaps
 *
 * Column names are declared here and nowhere else, so a renamed column in the
 * spreadsheet is a one-line fix.
 */
export const SHEETS = {
  stock: 'WMS',
  stockHeaderRow: 4,
  demand: 'Schedule of the day',
  demandHeaderRow: 1,
  master: 'MASTER DATA',
  masterHeaderRow: 1,
} as const;

export interface LoadedData {
  stock: StockBin[];
  demand: DemandLine[];
  /** cartons per SKU already in an outbound staging lane */
  stagedBySku: Map<string, number>;
  master: Map<string, { description: string; upp: number }>;
  warnings: Warning[];
}

export async function loadWorkbook(path: string, config: AllocatorConfig): Promise<LoadedData> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const warnings: Warning[] = [];

  // ---- SKU master ---------------------------------------------------------
  const master = new Map<string, { description: string; upp: number }>();
  for (const row of readRows(wb, SHEETS.master, SHEETS.masterHeaderRow)) {
    const sku = asSku(row['Material']);
    if (!sku) continue;
    master.set(sku, {
      description: asString(row['Material Description']),
      upp: asNumber(row['UPP']) || 1,
    });
  }

  // ---- stock on hand ------------------------------------------------------
  const stock: StockBin[] = [];
  const seenBins = new Map<string, number>();
  const stagedBySku = new Map<string, number>();

  for (const row of readRows(wb, SHEETS.stock, SHEETS.stockHeaderRow)) {
    const location = asString(row['Lokasi']).toUpperCase();
    if (!location) continue;

    const qty = asNumber(row['Qty']);
    if (qty <= 0) continue; // empty bin

    if (config.stagingLocations.some((x) => location === x.toUpperCase())) {
      const stagedSku = asSku(row['item']);
      if (stagedSku) stagedBySku.set(stagedSku, (stagedBySku.get(stagedSku) ?? 0) + qty);
      continue;
    }
    if (config.excludedLocations.some((x) => location === x.toUpperCase())) continue;

    const parsed = parseLocation(location);
    if (!parsed || !config.rackLocationPattern.test(location)) {
      warnings.push({
        level: 'INFO',
        code: 'NON_RACK_LOCATION',
        message: `${location} is not a rack bin — excluded from allocation`,
        context: { location, qty },
      });
      continue;
    }

    const status = asString(row['status']);
    if (status && !config.pickableStatuses.includes(status)) {
      warnings.push({
        level: 'WARN',
        code: 'BIN_NOT_ACTIVE',
        message: `${location} has status "${status}" — excluded`,
        context: { location, sku: asSku(row['item']) },
      });
      continue;
    }

    const sku = asSku(row['item']);
    if (!sku) {
      warnings.push({
        level: 'ERROR',
        code: 'MISSING_SKU',
        message: `${location} holds ${qty} cartons with no item code`,
        context: { location },
      });
      continue;
    }

    const expiryDate = asDate(row['Expired Date']);
    if (!expiryDate) {
      warnings.push({
        level: 'ERROR',
        code: 'MISSING_EXPIRY',
        message: `${location} ${sku} has no expiry date — cannot be allocated under FEFO`,
        context: { location, sku, qty },
      });
      continue;
    }

    const upp = asNumber(row['UPP']) || master.get(sku)?.upp || 1;
    const batch = asString(row['Batch']) || null;
    const binId = `${location}|${sku}|${batch ?? 'NOBATCH'}`;

    seenBins.set(location, (seenBins.get(location) ?? 0) + 1);

    stock.push({
      binId,
      location,
      aisle: parsed.aisle,
      bay: parsed.bay,
      level: parsed.level,
      position: parsed.position,
      sku,
      description: asString(row['Description']) || master.get(sku)?.description || '',
      batch,
      expiryDate,
      grDate: asDate(row['GR date']),
      qtyCartons: qty,
      upp,
      uom: asString(row['uom']) || null,
      isFullPallet: qty >= upp,
    });
  }

  for (const [location, count] of seenBins) {
    if (count > 1) {
      warnings.push({
        level: 'WARN',
        code: 'DUPLICATE_BIN',
        message: `${location} appears ${count} times in the stock sheet — verify physically before picking`,
        context: { location, count },
      });
    }
  }

  // ---- demand -------------------------------------------------------------
  // Several SAP orders can share one shipment + material; they are merged into
  // a single pick instruction and the order numbers are kept for traceability.
  //
  // The "NO" column groups one or more shipments into a single outbound run
  // and is only populated on the first row of each group — forward-fill it so
  // every row (and therefore every shipment) knows which wave it belongs to.
  const merged = new Map<string, DemandLine>();
  let currentWave = '';
  const waveByShipment = new Map<string, string>();

  for (const row of readRows(wb, SHEETS.demand, SHEETS.demandHeaderRow)) {
    const sku = asSku(row['Material']);
    const shipmentNumber = asString(row['Shipment Number']);
    const qty = asNumber(row['Delivery quantity']);

    const noCell = asString(row['NO']);
    if (noCell) currentWave = noCell;

    if (!sku || !shipmentNumber || qty <= 0) continue;

    if (!waveByShipment.has(shipmentNumber)) {
      waveByShipment.set(shipmentNumber, currentWave || shipmentNumber);
    }
    const waveNo = waveByShipment.get(shipmentNumber)!;

    const key = `${shipmentNumber}|${sku}`;
    const existing = merged.get(key);
    if (existing) {
      existing.qtyCartons += qty;
      existing.orderNos.push(asString(row['Order No']));
      continue;
    }

    merged.set(key, {
      shipmentNumber,
      waveNo,
      orderNos: [asString(row['Order No'])],
      sku,
      description: asString(row['Description']) || master.get(sku)?.description || '',
      qtyCartons: qty,
      upp: asNumber(row['upp']) || master.get(sku)?.upp || 1,
      destination: asString(row['Destination']),
      shipToLocation: asString(row['Location of the ship-to party']),
      transport: asString(row['TRANSPORT']) || null,
      truckType: asString(row['Type Truck']) || null,
      slotTime: asTime(row['Arrival Slot Time']),
      deliveryDate: asDate(row['First Delivery Date']),
    });
  }

  // a shipment's header fields sit only on its first row — backfill the rest
  const byShipment = new Map<string, DemandLine[]>();
  for (const d of merged.values()) {
    const list = byShipment.get(d.shipmentNumber);
    if (list) list.push(d);
    else byShipment.set(d.shipmentNumber, [d]);
  }
  for (const list of byShipment.values()) {
    const slot = list.find((d) => d.slotTime)?.slotTime ?? null;
    const truck = list.find((d) => d.truckType)?.truckType ?? null;
    const transport = list.find((d) => d.transport)?.transport ?? null;
    for (const d of list) {
      d.slotTime ??= slot;
      d.truckType ??= truck;
      d.transport ??= transport;
    }
  }

  return { stock, demand: [...merged.values()], stagedBySku, master, warnings };
}

// ---- cell helpers ---------------------------------------------------------

type Row = Record<string, unknown>;

function readRows(wb: ExcelJS.Workbook, sheetName: string, headerRow: number): Row[] {
  const ws = wb.getWorksheet(sheetName);
  if (!ws) throw new Error(`Sheet "${sheetName}" not found in workbook`);

  const headers: string[] = [];
  ws.getRow(headerRow).eachCell({ includeEmpty: true }, (cell, col) => {
    headers[col] = String(unwrap(cell.value) ?? '').trim();
  });

  const rows: Row[] = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber <= headerRow) return;
    const obj: Row = {};
    let empty = true;
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      const key = headers[col];
      if (!key) return;
      const v = unwrap(cell.value);
      if (v !== null && v !== undefined && v !== '') empty = false;
      obj[key] = v;
    });
    if (!empty) rows.push(obj);
  });
  return rows;
}

/** ExcelJS returns formulas/rich text as objects — reduce to a primitive. */
function unwrap(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if ('result' in v) return unwrap(v.result);
    if ('text' in v) return v.text;
    if ('richText' in v) return (v.richText as { text: string }[]).map((t) => t.text).join('');
    if ('hyperlink' in v) return v.text ?? null;
  }
  return value;
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

/** SAP material numbers arrive as floats (550044709.0) — normalise to digits. */
function asSku(v: unknown): string {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number') return String(Math.round(v));
  const s = String(v).trim();
  return /^\d+(\.0+)?$/.test(s) ? String(Math.round(Number(s))) : s;
}

function asDate(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === 'number' && v > 20000) {
    // Excel serial date
    return new Date(Math.round((v - 25569) * 86_400_000));
  }
  const s = asString(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function asTime(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString().slice(11, 16);
  const s = asString(v);
  if (!s) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(s);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
}
