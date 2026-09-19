/**
 * Domain models for the database layer + row↔domain mappers.
 *
 * DATE columns (expiry_date, gr_date, planned_date, ...) are plain
 * 'YYYY-MM-DD' strings over the wire and are parsed as UTC midnight so a
 * date never shifts by one day through timezone conversion — the same rule
 * the Excel adapters already enforce.
 */

import type {
  DailySummaryRow,
  ExecutionEventRow,
  InboundRow,
  InboundStatus,
  MovementRowDB,
  MovementStatus,
  MovementType,
  OutboundOrigin,
  OutboundRow,
  OutboundStatus,
  StockRow,
  StockTransactionRow,
  TransactionType,
  WaveRow,
  WaveStatus,
} from '../lib/database.types.js';

/** Parse a DATE-column string as UTC midnight (no timezone shift). */
export function parseDbDate(value: string): Date {
  return new Date(`${value}T00:00:00Z`);
}

/** Format a Date for a DATE column: the UTC calendar date, YYYY-MM-DD. */
export function formatDbDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

// ---- Domain models ----------------------------------------------------------

export interface StockRecord {
  id: string;
  location: string;
  sku: string;
  description: string;
  batch: string | null;
  expiryDate: Date;
  quantity: number;
  upp: number;
  uom: string | null;
  aisle: string;
  bay: number | null;
  level: string | null;
  position: number | null;
  isFullPallet: boolean;
  grDate: Date | null;
  identityKey: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface StockTransactionRecord {
  id: string;
  transactionType: TransactionType;
  transactionDate: Date;
  sku: string;
  location: string;
  batch: string | null;
  expiryDate: Date;
  quantityDelta: number;
  referenceType: string | null;
  referenceId: string | null;
  waveId: string | null;
  movementId: string | null;
  notes: string | null;
  createdAt: Date;
  createdBy: string;
  identityKey: string;
}

export interface WaveRecord {
  id: string;
  waveNo: string;
  plannedDate: Date;
  shipmentNumbers: string[];
  truck: string | null;
  destination: string;
  plannedSlot: string | null;
  status: WaveStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface InboundRecord {
  id: string;
  inboundDate: Date;
  referenceNo: string;
  sku: string;
  description: string;
  location: string;
  batch: string | null;
  expiryDate: Date;
  quantity: number;
  upp: number;
  uom: string | null;
  status: InboundStatus;
  notes: string | null;
  createdAt: Date;
  completedAt: Date | null;
  completedBy: string | null;
}

export interface OutboundRecord {
  id: string;
  outboundDate: Date;
  shipmentNumber: string;
  waveId: string | null;
  waveNo: string | null;
  truck: string | null;
  destination: string;
  sku: string;
  description: string;
  location: string | null;
  batch: string | null;
  expiryDate: Date | null;
  quantity: number;
  origin: OutboundOrigin;
  status: OutboundStatus;
  createdAt: Date;
  completedAt: Date | null;
  completedBy: string | null;
}

export interface MovementRecord {
  id: string;
  waveId: string | null;
  waveNo: string | null;
  shipmentNumber: string | null;
  movementType: MovementType;
  sku: string;
  description: string;
  sourceLocation: string;
  destinationLocation: string | null;
  batch: string | null;
  expiryDate: Date;
  quantity: number;
  pickType: 'PALLET' | 'CASE' | null;
  breaksPallet: boolean;
  seq: number | null;
  status: MovementStatus;
  referenceId: string | null;
  createdAt: Date;
  completedAt: Date | null;
  completedBy: string | null;
}

export interface ExecutionEventRecord {
  id: string;
  entityType: 'WAVE' | 'MOVEMENT' | 'INBOUND' | 'OUTBOUND';
  entityId: string;
  fromStatus: string | null;
  toStatus: string;
  reason: string | null;
  actor: string;
  occurredAt: Date;
}

export interface DailySummaryRecord {
  identityKey: string;
  location: string;
  sku: string;
  batch: string | null;
  expiryDate: Date;
  openingQty: number;
  initialImport: number;
  inboundQty: number;
  pickQty: number;
  outboundQty: number;
  relocInQty: number;
  relocOutQty: number;
  adjustmentQty: number;
  closingQty: number;
}

export interface LedgerBalanceRecord {
  identityKey: string;
  stockQuantity: number;
  ledgerQuantity: number;
  mismatch: number;
}

// ---- Row → domain mappers ---------------------------------------------------

export function stockRowToDomain(row: StockRow): StockRecord {
  return {
    id: row.id,
    location: row.location,
    sku: row.sku,
    description: row.description,
    batch: row.batch,
    expiryDate: parseDbDate(row.expiry_date),
    quantity: row.quantity,
    upp: row.upp,
    uom: row.uom,
    aisle: row.aisle,
    bay: row.bay,
    level: row.level,
    position: row.position,
    isFullPallet: row.is_full_pallet,
    grDate: row.gr_date ? parseDbDate(row.gr_date) : null,
    identityKey: row.identity_key,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export function stockTxRowToDomain(row: StockTransactionRow): StockTransactionRecord {
  return {
    id: row.id,
    transactionType: row.transaction_type,
    transactionDate: parseDbDate(row.transaction_date),
    sku: row.sku,
    location: row.location,
    batch: row.batch,
    expiryDate: parseDbDate(row.expiry_date),
    quantityDelta: row.quantity_delta,
    referenceType: row.reference_type,
    referenceId: row.reference_id,
    waveId: row.wave_id,
    movementId: row.movement_id,
    notes: row.notes,
    createdAt: new Date(row.created_at),
    createdBy: row.created_by,
    identityKey: row.identity_key,
  };
}

export function waveRowToDomain(row: WaveRow): WaveRecord {
  return {
    id: row.id,
    waveNo: row.wave_no,
    plannedDate: parseDbDate(row.planned_date),
    shipmentNumbers: row.shipment_numbers ?? [],
    truck: row.truck,
    destination: row.destination,
    plannedSlot: row.planned_slot,
    status: row.status,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export function inboundRowToDomain(row: InboundRow): InboundRecord {
  return {
    id: row.id,
    inboundDate: parseDbDate(row.inbound_date),
    referenceNo: row.reference_no,
    sku: row.sku,
    description: row.description,
    location: row.location,
    batch: row.batch,
    expiryDate: parseDbDate(row.expiry_date),
    quantity: row.quantity,
    upp: row.upp,
    uom: row.uom,
    status: row.status,
    notes: row.notes,
    createdAt: new Date(row.created_at),
    completedAt: row.completed_at ? new Date(row.completed_at) : null,
    completedBy: row.completed_by,
  };
}

export function outboundRowToDomain(row: OutboundRow): OutboundRecord {
  return {
    id: row.id,
    outboundDate: parseDbDate(row.outbound_date),
    shipmentNumber: row.shipment_number,
    waveId: row.wave_id,
    waveNo: row.wave_no,
    truck: row.truck,
    destination: row.destination,
    sku: row.sku,
    description: row.description,
    location: row.location,
    batch: row.batch,
    expiryDate: row.expiry_date ? parseDbDate(row.expiry_date) : null,
    quantity: row.quantity,
    origin: row.origin,
    status: row.status,
    createdAt: new Date(row.created_at),
    completedAt: row.completed_at ? new Date(row.completed_at) : null,
    completedBy: row.completed_by,
  };
}

export function movementRowToDomain(row: MovementRowDB): MovementRecord {
  return {
    id: row.id,
    waveId: row.wave_id,
    waveNo: row.wave_no,
    shipmentNumber: row.shipment_number,
    movementType: row.movement_type,
    sku: row.sku,
    description: row.description,
    sourceLocation: row.source_location,
    destinationLocation: row.destination_location,
    batch: row.batch,
    expiryDate: parseDbDate(row.expiry_date),
    quantity: row.quantity,
    pickType: row.pick_type,
    breaksPallet: row.breaks_pallet,
    seq: row.seq,
    status: row.status,
    referenceId: row.reference_id,
    createdAt: new Date(row.created_at),
    completedAt: row.completed_at ? new Date(row.completed_at) : null,
    completedBy: row.completed_by,
  };
}

export function execEventRowToDomain(row: ExecutionEventRow): ExecutionEventRecord {
  return {
    id: row.id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    reason: row.reason,
    actor: row.actor,
    occurredAt: new Date(row.occurred_at),
  };
}

export function dailySummaryRowToDomain(row: DailySummaryRow): DailySummaryRecord {
  return {
    identityKey: row.identity_key,
    location: row.location,
    sku: row.sku,
    batch: row.batch,
    expiryDate: parseDbDate(row.expiry_date),
    openingQty: Number(row.opening_qty),
    initialImport: Number(row.initial_import),
    inboundQty: Number(row.inbound_qty),
    pickQty: Number(row.pick_qty),
    outboundQty: Number(row.outbound_qty),
    relocInQty: Number(row.reloc_in_qty),
    relocOutQty: Number(row.reloc_out_qty),
    adjustmentQty: Number(row.adjustment_qty),
    closingQty: Number(row.closing_qty),
  };
}

/** The physical stock identity used across the whole application. */
export function identityOf(location: string, sku: string, batch: string | null, expiry: Date | string): string {
  const expiryStr = typeof expiry === 'string' ? expiry : formatDbDate(expiry);
  return `${location}|${sku}|${batch ?? ''}|${expiryStr}`;
}
