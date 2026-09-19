/**
 * stockRepository — current physical stock + its immutable ledger.
 *
 * Reads are plain batched selects. Every mutation goes through the SQL RPCs
 * (initial_import / adjust_stock) so status checks, sufficiency, idempotency
 * and audit rows are enforced inside one database transaction.
 */

import type { DbClient } from '../lib/supabase.js';
import type { InitialImportRow, RpcResult, StockVsLedgerRow } from '../lib/database.types.js';
import { toWmsError } from '../lib/errors.js';
import {
  formatDbDate,
  identityOf,
  stockRowToDomain,
  stockTxRowToDomain,
  dailySummaryRowToDomain,
  type DailySummaryRecord,
  type LedgerBalanceRecord,
  type StockRecord,
  type StockTransactionRecord,
} from './types.js';
import { unwrap, unwrapNullable } from './util.js';

export interface StockFilter {
  sku?: string;
  location?: string;
  batch?: string | null;
  expiryDate?: Date | string;
}

export class StockRepository {
  constructor(private readonly db: DbClient) {}

  /** All current stock, ordered for deterministic allocator input. */
  async listAll(): Promise<StockRecord[]> {
    const res = await this.db
      .from('stock')
      .select('*')
      .order('location')
      .order('sku')
      .order('expiry_date');
    return unwrap(res, 'stock.listAll').map(stockRowToDomain);
  }

  async find(filter: StockFilter): Promise<StockRecord[]> {
    let q = this.db.from('stock').select('*').order('location').order('expiry_date');
    if (filter.sku !== undefined) q = q.eq('sku', filter.sku);
    if (filter.location !== undefined) q = q.eq('location', filter.location);
    if (filter.batch !== undefined) {
      q = filter.batch === null ? q.is('batch', null) : q.eq('batch', filter.batch);
    }
    if (filter.expiryDate !== undefined) {
      q = q.eq('expiry_date', typeof filter.expiryDate === 'string' ? filter.expiryDate : formatDbDate(filter.expiryDate));
    }
    return unwrap(await q, 'stock.find').map(stockRowToDomain);
  }

  /** One physical identity: location + sku + batch + expiry. */
  async getByIdentity(
    location: string,
    sku: string,
    batch: string | null,
    expiry: Date | string,
  ): Promise<StockRecord | null> {
    const key = identityOf(location, sku, batch, expiry);
    const res = await this.db.from('stock').select('*').eq('identity_key', key).maybeSingle();
    const row = unwrapNullable(res);
    return row ? stockRowToDomain(row) : null;
  }

  /** Full transaction history of one physical identity, oldest first. */
  async history(identityKey: string): Promise<StockTransactionRecord[]> {
    const res = await this.db
      .from('stock_transactions')
      .select('*')
      .eq('identity_key', identityKey)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true });
    return unwrap(res, 'stock.history').map(stockTxRowToDomain);
  }

  /** Every transaction on a date (or all), oldest first — reconciliation. */
  async transactions(opts: { date?: Date | string; sku?: string; limit?: number } = {}): Promise<
    StockTransactionRecord[]
  > {
    let q = this.db
      .from('stock_transactions')
      .select('*')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true });
    if (opts.date) q = q.eq('transaction_date', typeof opts.date === 'string' ? opts.date : formatDbDate(opts.date));
    if (opts.sku) q = q.eq('sku', opts.sku);
    if (opts.limit) q = q.limit(opts.limit);
    return unwrap(await q, 'stock.transactions').map(stockTxRowToDomain);
  }

  /** stock.quantity vs SUM(quantity_delta) per identity. Healthy = all zeros. */
  async ledgerBalances(opts: { mismatchesOnly?: boolean } = {}): Promise<LedgerBalanceRecord[]> {
    let q = this.db.from('stock_vs_ledger').select('*');
    if (opts.mismatchesOnly) q = q.neq('mismatch', 0);
    const rows: StockVsLedgerRow[] = unwrap(await q, 'stock.ledgerBalances');
    return rows.map((r) => ({
      identityKey: r.identity_key,
      stockQuantity: Number(r.stock_quantity),
      ledgerQuantity: Number(r.ledger_quantity),
      mismatch: Number(r.mismatch),
    }));
  }

  /** Opening / activity / closing per identity for one day. */
  async dailySummary(date: Date | string): Promise<DailySummaryRecord[]> {
    const d = typeof date === 'string' ? date : formatDbDate(date);
    const { data, error } = await this.db.rpc('daily_summary', { p_date: d });
    if (error) throw toWmsError(new Error(error.message));
    return (data ?? []).map(dailySummaryRowToDomain);
  }

  /**
   * Initial WMS import — one database transaction for the whole snapshot.
   * FAIL_ON_CONFLICT aborts when any identity already exists; REPLACE writes
   * the difference to the ledger so history always explains the balance.
   */
  async initialImport(
    rows: InitialImportRow[],
    actor: string,
    mode: 'FAIL_ON_CONFLICT' | 'REPLACE' = 'FAIL_ON_CONFLICT',
    date?: Date | string,
  ): Promise<RpcResult> {
    const { data, error } = await this.db.rpc('initial_import', {
      p_rows: rows,
      p_actor: actor,
      p_mode: mode,
      ...(date ? { p_date: typeof date === 'string' ? date : formatDbDate(date) } : {}),
    });
    if (error) throw toWmsError(new Error(error.message));
    return data as RpcResult;
  }

  /** Controlled manual correction (reason + actor mandatory, never silent). */
  async adjust(
    location: string,
    sku: string,
    batch: string | null,
    expiry: Date | string,
    delta: number,
    reason: string,
    actor: string,
    date?: Date | string,
  ): Promise<RpcResult> {
    const { data, error } = await this.db.rpc('adjust_stock', {
      p_location: location,
      p_sku: sku,
      p_batch: batch,
      p_expiry: typeof expiry === 'string' ? expiry : formatDbDate(expiry),
      p_delta: delta,
      p_reason: reason,
      p_actor: actor,
      ...(date ? { p_date: typeof date === 'string' ? date : formatDbDate(date) } : {}),
    });
    if (error) throw toWmsError(new Error(error.message));
    return data as RpcResult;
  }
}
