/**
 * Hand-written Supabase Database types matching supabase/migrations/*.
 *
 * Once a real Supabase project is linked, regenerate with:
 *   supabase gen types typescript --linked > src/lib/database.types.ts
 * and diff against this file (the shapes must stay compatible).
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type StockStatus = never; // stock has no status column; kept for symmetry

export type WaveStatus = 'PENDING' | 'COMPLETED' | 'RESCHEDULED' | 'CANCELLED';
export type InboundStatus = 'PENDING' | 'COMPLETED' | 'CANCELLED';
export type OutboundStatus = 'PLANNED' | 'COMPLETED' | 'RESCHEDULED' | 'CANCELLED';
export type MovementStatus = 'PLANNED' | 'COMPLETED' | 'RESCHEDULED' | 'CANCELLED';
export type MovementType = 'PICK' | 'RELOC_OUT' | 'RELOC_IN' | 'REPLENISH';
export type TransactionType =
  | 'INITIAL_IMPORT'
  | 'INBOUND'
  | 'OUTBOUND'
  | 'PICK'
  | 'RELOC_IN'
  | 'RELOC_OUT'
  | 'ADJUSTMENT';
export type OutboundOrigin = 'ALLOCATION' | 'MANUAL' | 'IMPORT';

export interface StockRow {
  id: string;
  location: string;
  sku: string;
  description: string;
  batch: string | null;
  expiry_date: string; // YYYY-MM-DD (DATE column)
  quantity: number;
  upp: number;
  uom: string | null;
  aisle: string;
  bay: number | null;
  level: string | null;
  position: number | null;
  is_full_pallet: boolean;
  gr_date: string | null;
  identity_key: string;
  created_at: string;
  updated_at: string;
}

export interface StockTransactionRow {
  id: string;
  transaction_type: TransactionType;
  transaction_date: string;
  sku: string;
  location: string;
  batch: string | null;
  expiry_date: string;
  quantity_delta: number;
  reference_type: 'INITIAL_IMPORT' | 'INBOUND' | 'OUTBOUND' | 'MOVEMENT' | 'ADJUSTMENT' | null;
  reference_id: string | null;
  wave_id: string | null;
  movement_id: string | null;
  notes: string | null;
  created_at: string;
  created_by: string;
  identity_key: string;
}

export interface WaveRow {
  id: string;
  wave_no: string;
  planned_date: string;
  shipment_numbers: string[];
  truck: string | null;
  destination: string;
  planned_slot: string | null;
  status: WaveStatus;
  created_at: string;
  updated_at: string;
}

export interface InboundRow {
  id: string;
  inbound_date: string;
  reference_no: string;
  sku: string;
  description: string;
  location: string;
  batch: string | null;
  expiry_date: string;
  quantity: number;
  upp: number;
  uom: string | null;
  status: InboundStatus;
  notes: string | null;
  created_at: string;
  completed_at: string | null;
  completed_by: string | null;
}

export interface OutboundRow {
  id: string;
  outbound_date: string;
  shipment_number: string;
  wave_id: string | null;
  wave_no: string | null;
  truck: string | null;
  destination: string;
  sku: string;
  description: string;
  location: string | null;
  batch: string | null;
  expiry_date: string | null;
  quantity: number;
  origin: OutboundOrigin;
  status: OutboundStatus;
  created_at: string;
  completed_at: string | null;
  completed_by: string | null;
}

export interface MovementRowDB {
  id: string;
  wave_id: string | null;
  wave_no: string | null;
  shipment_number: string | null;
  movement_type: MovementType;
  sku: string;
  description: string;
  source_location: string;
  destination_location: string | null;
  batch: string | null;
  expiry_date: string;
  quantity: number;
  pick_type: 'PALLET' | 'CASE' | null;
  breaks_pallet: boolean;
  seq: number | null;
  status: MovementStatus;
  reference_id: string | null;
  created_at: string;
  completed_at: string | null;
  completed_by: string | null;
}

export interface ExecutionEventRow {
  id: string;
  entity_type: 'WAVE' | 'MOVEMENT' | 'INBOUND' | 'OUTBOUND';
  entity_id: string;
  from_status: string | null;
  to_status: string;
  reason: string | null;
  actor: string;
  occurred_at: string;
}

export interface StockVsLedgerRow {
  identity_key: string;
  stock_quantity: number;
  ledger_quantity: number;
  mismatch: number;
}

export interface DailySummaryRow {
  identity_key: string;
  location: string;
  sku: string;
  batch: string | null;
  expiry_date: string;
  opening_qty: number;
  initial_import: number;
  inbound_qty: number;
  pick_qty: number;
  outbound_qty: number;
  reloc_in_qty: number;
  reloc_out_qty: number;
  adjustment_qty: number;
  closing_qty: number;
}

/** Shape accepted by the `initial_import` RPC. */
export interface InitialImportRow {
  location: string;
  sku: string;
  description?: string;
  batch?: string | null;
  expiry_date: string; // YYYY-MM-DD
  quantity: number;
  upp?: number;
  uom?: string | null;
  aisle?: string;
  bay?: number | null;
  level?: string | null;
  position?: number | null;
  gr_date?: string | null;
}

export type RpcResult = { result: string } & Record<string, unknown>;

export interface Database {
  public: {
    Tables: {
      stock: {
        Row: StockRow;
        Insert: Partial<Omit<StockRow, 'id' | 'identity_key' | 'created_at' | 'updated_at'>> &
          Pick<StockRow, 'location' | 'sku' | 'expiry_date'>;
        Update: Partial<StockRow>;
      };
      stock_transactions: {
        Row: StockTransactionRow;
        Insert: Partial<Omit<StockTransactionRow, 'id' | 'identity_key' | 'created_at'>> &
          Pick<StockTransactionRow, 'transaction_type' | 'sku' | 'location' | 'expiry_date' | 'quantity_delta'>;
        Update: never;
      };
      waves: {
        Row: WaveRow;
        Insert: Partial<Omit<WaveRow, 'id' | 'created_at' | 'updated_at'>> & Pick<WaveRow, 'wave_no'>;
        Update: Partial<WaveRow>;
      };
      inbound: {
        Row: InboundRow;
        Insert: Partial<Omit<InboundRow, 'id' | 'created_at' | 'completed_at' | 'completed_by'>> &
          Pick<InboundRow, 'reference_no' | 'sku' | 'location' | 'expiry_date' | 'quantity'>;
        Update: Partial<InboundRow>;
      };
      outbound: {
        Row: OutboundRow;
        Insert: Partial<Omit<OutboundRow, 'id' | 'created_at' | 'completed_at' | 'completed_by'>> &
          Pick<OutboundRow, 'shipment_number' | 'sku' | 'quantity'>;
        Update: Partial<OutboundRow>;
      };
      movements: {
        Row: MovementRowDB;
        Insert: Partial<Omit<MovementRowDB, 'id' | 'created_at' | 'completed_at' | 'completed_by'>> &
          Pick<MovementRowDB, 'movement_type' | 'sku' | 'source_location' | 'expiry_date' | 'quantity'>;
        Update: Partial<MovementRowDB>;
      };
      execution_events: {
        Row: ExecutionEventRow;
        Insert: Partial<Omit<ExecutionEventRow, 'id' | 'occurred_at'>> &
          Pick<ExecutionEventRow, 'entity_type' | 'entity_id' | 'to_status'>;
        Update: never;
      };
    };
    Views: {
      stock_vs_ledger: { Row: StockVsLedgerRow };
    };
    Functions: {
      post_movement: { Args: { p_movement_id: string; p_actor?: string; p_post_date?: string }; Returns: RpcResult };
      set_movement_status: { Args: { p_movement_id: string; p_status: string; p_actor?: string; p_reason?: string | null }; Returns: RpcResult };
      set_wave_status: { Args: { p_wave_id: string; p_status: string; p_actor?: string; p_reason?: string | null; p_new_slot?: string | null; p_new_date?: string | null }; Returns: RpcResult };
      complete_wave: { Args: { p_wave_id: string; p_actor?: string; p_post_date?: string }; Returns: RpcResult };
      post_inbound: { Args: { p_inbound_id: string; p_actor?: string; p_post_date?: string | null }; Returns: RpcResult };
      post_outbound: { Args: { p_outbound_id: string; p_actor?: string; p_post_date?: string | null }; Returns: RpcResult };
      set_outbound_status: { Args: { p_outbound_id: string; p_status: string; p_actor?: string; p_reason?: string | null }; Returns: RpcResult };
      set_inbound_status: { Args: { p_inbound_id: string; p_status: string; p_actor?: string; p_reason?: string | null }; Returns: RpcResult };
      adjust_stock: { Args: { p_location: string; p_sku: string; p_batch: string | null; p_expiry: string; p_delta: number; p_reason: string; p_actor: string; p_date?: string }; Returns: RpcResult };
      initial_import: { Args: { p_rows: InitialImportRow[]; p_actor?: string; p_mode?: 'FAIL_ON_CONFLICT' | 'REPLACE'; p_date?: string }; Returns: RpcResult };
      daily_summary: { Args: { p_date: string }; Returns: DailySummaryRow[] };
    };
  };
}
