import * as XLSX from 'xlsx';
import type { AllocatorConfig } from '../config.js';
import { parseLocation } from '../pickpath.js';
import type { DemandLine, StockBin, Warning } from '../types.js';
import { lookupUom } from '../uom-master.js';

export const SHEETS = {
  stock: 'WMS',
  stockHeaderRow: 4, // 1-based row holding the column names
  demand: 'Schedule of the day',
  master: 'MASTER DATA',
} as const;

export interface LoadedData {
  stock: StockBin[];
  demand: DemandLine[];
  stagedBySku: Map<string, number>;
  master: Map<string, { description: string; upp: number; uom: string }>;
  warnings: Warning[];
}

/** Same field mapping and rules as adapters/excel-input.ts, for the in-browser workbook. */
export function loadWorkbookFromBuffer(buffer: ArrayBuffer, config: AllocatorConfig): LoadedData {
  const wb = XLSX.read(buffer, { type: 'array', cellDates: true });
  const warnings: Warning[] = [];

  const master = new Map<string, { description: string; upp: number; uom: string }>();
  for (const row of sheetRows(wb, SHEETS.master, 1)) {
    const sku = asSku(row['Material']);
    if (!sku) continue;
    master.set(sku, { description: asString(row['Material Description']), upp: asNumber(row['UPP']) || 1, uom: asString(row['UOM']) || 'CAR' });
  }

  const stock: StockBin[] = [];
  const stagedBySku = new Map<string, number>();
  const seenBins = new Map<string, number>();

  for (const row of sheetRows(wb, SHEETS.stock, SHEETS.stockHeaderRow)) {
    const location = asString(row['Lokasi']).toUpperCase();
    if (!location) continue;

    const qty = asNumber(row['on hand']);
    if (qty <= 0) continue;

    if (config.stagingLocations.some((x) => location === x.toUpperCase())) {
      const stagedSku = asSku(row['item']);
      if (stagedSku) stagedBySku.set(stagedSku, (stagedBySku.get(stagedSku) ?? 0) + qty);
      continue;
    }
    if (config.excludedLocations.some((x) => location === x.toUpperCase())) continue;

    const parsed = parseLocation(location);
    if (!parsed || !config.rackLocationPattern.test(location)) {
      warnings.push({ level: 'INFO', code: 'NON_RACK_LOCATION', message: `${location} is not a rack bin — excluded`, context: { location, qty } });
      continue;
    }

    const status = asString(row['status']);
    if (status && !config.pickableStatuses.includes(status)) {
      warnings.push({ level: 'WARN', code: 'BIN_NOT_ACTIVE', message: `${location} has status "${status}" — excluded`, context: { location } });
      continue;
    }

    const sku = asSku(row['item']);
    if (!sku) {
      warnings.push({ level: 'ERROR', code: 'MISSING_SKU', message: `${location} holds ${qty} cartons with no item code`, context: { location } });
      continue;
    }

    const expiryDate = asDate(row['Expired Date']);
    if (!expiryDate) {
      warnings.push({ level: 'ERROR', code: 'MISSING_EXPIRY', message: `${location} ${sku} has no expiry date — cannot be allocated under FEFO`, context: { location, sku } });
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
      uom: lookupUom(sku) || asString(row['uom']) || master.get(sku)?.uom || null,
      isFullPallet: qty >= upp,
    });
  }

  for (const [location, count] of seenBins) {
    if (count > 1) {
      warnings.push({ level: 'WARN', code: 'DUPLICATE_BIN', message: `${location} appears ${count} times in the stock sheet`, context: { location, count } });
    }
  }

  const merged = new Map<string, DemandLine>();
  let currentWave = '';
  const waveByShipment = new Map<string, string>();

  for (const row of sheetRows(wb, SHEETS.demand, 1)) {
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

type Row = Record<string, unknown>;

function sheetRows(wb: XLSX.WorkBook, sheetName: string, headerRow: number): Row[] {
  const ws = wb.Sheets[sheetName];
  if (!ws) throw new Error(`Sheet "${sheetName}" not found in workbook`);
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: null });
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
  if (typeof v === 'number' && v > 20000) return new Date(Math.round((v - 25569) * 86_400_000));
  const s = asString(v);
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
}

function asTime(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString().slice(11, 16);
  const s = asString(v);
  if (!s) return null;
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)?/i.exec(s);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const min = m[2];
  const suffix = m[3]?.toUpperCase();
  if (suffix === 'PM' && hour < 12) hour += 12;
  if (suffix === 'AM' && hour === 12) hour = 0;
  return `${String(hour).padStart(2, '0')}:${min}`;
}
