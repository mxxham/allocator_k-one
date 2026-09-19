/**
 * Domain types for the FEFO allocator / picklist generator.
 *
 * Unit convention: every quantity is in CARTONS (CAR), matching SAP's
 * "Delivery quantity" and the WMS "Qty" column. UPP = cartons per pallet.
 */

export type PickType = 'PALLET' | 'CASE';

/** One physical pallet position holding stock. */
export interface StockBin {
  /** Stable key: location + sku + batch */
  binId: string;
  location: string;
  aisle: string;
  bay: number;
  level: string;
  position: number;
  sku: string;
  description: string;
  batch: string | null;
  expiryDate: Date;
  grDate: Date | null;
  qtyCartons: number;
  /** Cartons per full pallet for this SKU */
  upp: number;
  uom: string | null;
  /** true when the bin holds an untouched full pallet (qty === upp) */
  isFullPallet: boolean;
}

/** Demand for one SKU on one shipment (orders already merged). */
export interface DemandLine {
  shipmentNumber: string;
  /**
   * The "NO" column on Schedule of the day — groups one or more shipments
   * into a single outbound run/wave. Forward-filled: a blank NO cell belongs
   * to the same wave as the nearest NO above it. Falls back to the shipment
   * number when the sheet has no NO column, so grouping never breaks.
   */
  waveNo: string;
  orderNos: string[];
  sku: string;
  description: string;
  qtyCartons: number;
  upp: number;
  destination: string;
  shipToLocation: string;
  transport: string | null;
  truckType: string | null;
  slotTime: string | null;
  deliveryDate: Date | null;
}

/** One instruction: go to this bin, take this many cartons. */
export interface AllocationLine {
  shipmentNumber: string;
  waveNo: string;
  orderNos: string[];
  sku: string;
  description: string;
  location: string;
  binId: string;
  batch: string | null;
  expiryDate: Date;
  /** cartons to pick from this bin */
  qtyPick: number;
  /** full-pallet move vs loose-carton pick */
  pickType: PickType;
  upp: number;
  uom: string | null;
  /** cartons left in the bin after this pick */
  qtyRemainingInBin: number;
  /** days of shelf life left at the allocation date */
  daysToExpiry: number;
  /** travel-order sequence within its picklist (1-based) */
  seq: number;
  /** set when this pick opens a previously untouched full pallet */
  breaksPallet: boolean;
}

export interface Shortage {
  shipmentNumber: string;
  orderNos: string[];
  sku: string;
  description: string;
  qtyRequested: number;
  qtyAllocated: number;
  qtyShort: number;
  reason: 'NO_STOCK' | 'BLOCKED_SHELF_LIFE' | 'ALREADY_STAGED';
  /** stock that exists but was refused by the shelf-life rule */
  qtyRejectedByShelfLife: number;
  /** same SKU already sitting in a staging lane — usually picked earlier today */
  qtyInStaging: number;
}

export interface Warning {
  level: 'INFO' | 'WARN' | 'ERROR';
  code: string;
  message: string;
  context?: Record<string, unknown>;
}

/**
 * One pick task: one wave (the "NO" grouping on Schedule of the day — one or
 * more shipments run together), one equipment type, travel-sorted. Grouping
 * by wave rather than by shipment means a multi-shipment run comes out as a
 * single picklist to download, exactly as it's dispatched on the floor.
 */
export interface Picklist {
  picklistId: string;
  waveNo: string;
  /** every shipment folded into this wave */
  shipmentNumbers: string[];
  destination: string;
  shipToLocation: string;
  transport: string | null;
  truckType: string | null;
  slotTime: string | null;
  /** PALLET tasks are forklift work, CASE tasks are ground/handpick */
  taskType: PickType | 'MIXED';
  orderNos: string[];
  lines: AllocationLine[];
  totalCartons: number;
  totalPallets: number;
  distinctLocations: number;
  distinctSkus: number;
}

export interface AllocationStats {
  demandLines: number;
  cartonsRequested: number;
  cartonsAllocated: number;
  fillRatePct: number;
  palletPicks: number;
  casePicks: number;
  palletsBroken: number;
  binsTouched: number;
  shipments: number;
}

export interface AllocationResult {
  generatedAt: Date;
  picklists: Picklist[];
  lines: AllocationLine[];
  shortages: Shortage[];
  warnings: Warning[];
  stats: AllocationStats;
}

// ---- Pickface & replenishment ---------------------------------------------

/** The one dedicated pick-from bin for a SKU (outbound face). */
export interface PickfaceAssignment {
  sku: string;
  description: string;
  location: string;
  /** target level to keep the pickface topped up to, in cartons */
  targetQtyCartons: number;
  /** true when this was derived automatically rather than set by an admin */
  isAuto: boolean;
}

/** One bin-to-bin move: top up a pickface from reserve stock, FEFO-first. */
export interface ReplenishmentTask {
  sku: string;
  description: string;
  fromLocation: string;
  fromBinId: string;
  toLocation: string;
  batch: string | null;
  expiryDate: Date;
  qtyMove: number;
  pickType: PickType;
  upp: number;
  uom: string | null;
  qtyRemainingAtSource: number;
  qtyAtPickfaceAfter: number;
  daysToExpiry: number;
  seq: number;
  breaksPallet: boolean;
  reason: 'BELOW_TARGET' | 'PENDING_DEMAND' | 'BROKEN_PALLET';
}

export interface ReplenishmentShortage {
  sku: string;
  description: string;
  toLocation: string;
  qtyNeeded: number;
  qtyMoved: number;
  qtyShort: number;
}

export type PickfaceLedger = Map<string, { location: string; finalQty: number }>;

export interface ReplenishmentResult {
  generatedAt: Date;
  tasks: ReplenishmentTask[];
  shortages: ReplenishmentShortage[];
  warnings: Warning[];
  stats: {
    pickfacesEvaluated: number;
    pickfacesReplenished: number;
    cartonsMoved: number;
    palletMoves: number;
    caseMoves: number;
    palletsBroken: number;
  };
}

// ---- Physical inventory event model -------------------------------------

/** One physical stock movement event at a specific identity. */
export type PhysicalEvent =
  | {
      type: 'PICK';
      waveNum: number;
      qty: number;
      line: AllocationLine;
    }
  | {
      type: 'RELOC_OUT';
      waveNum: number;
      qty: number;
      sourceKey: string;
      destinationKey: string;
      sourceLine: AllocationLine;
    }
  | {
      type: 'RELOC_IN';
      waveNum: number;
      qty: number;
      sourceKey: string;
      destinationKey: string;
      sourceLine: AllocationLine;
    };

// ---- Movement / audit report ------------------------------------------------

export type MovementType = 'PICK' | 'REPLEN';

/** One row of "what moved, from where, to where" — the audit trail. */
export interface MovementRow {
  seq: number;
  type: MovementType;
  sku: string;
  description: string;
  batch: string | null;
  expiryDate: Date;
  qty: number;
  pickType: PickType;
  uom: string | null;
  fromLocation: string;
  toLocation: string;
  /** shipment number for a PICK row, blank for REPLEN */
  shipmentNumber: string | null;
  qtyRemainingAtFrom: number;
  breaksPallet: boolean;
}
