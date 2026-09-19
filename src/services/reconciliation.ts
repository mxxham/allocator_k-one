/**
 * Reconciliation (§22) — the ledger must always explain the balance.
 *
 *   stockHistory  : every transaction of one physical identity
 *   dailySummary  : opening + activity = closing for one day
 *   mismatchReport: stock.quantity vs SUM(quantity_delta) — healthy = empty
 */

import type { DbClient } from '../lib/supabase.js';
import { createRepositories, type Repositories } from '../repository/index.js';
import type {
  DailySummaryRecord,
  LedgerBalanceRecord,
  StockTransactionRecord,
} from '../repository/types.js';

export class ReconciliationService {
  private readonly repos: Repositories;

  constructor(db: DbClient) {
    this.repos = createRepositories(db);
  }

  /** Full audit trail of one identity (location|sku|batch|expiry), oldest first. */
  async stockHistory(identityKey: string): Promise<StockTransactionRecord[]> {
    return this.repos.stock.history(identityKey);
  }

  /** Every transaction on a date (optionally filtered to one SKU). */
  async transactions(opts: { date?: Date | string; sku?: string; limit?: number } = {}): Promise<
    StockTransactionRecord[]
  > {
    return this.repos.stock.transactions(opts);
  }

  /** Opening / initial import / inbound / picks / outbound / relocations / adjustments / closing. */
  async dailySummary(date: Date | string): Promise<DailySummaryRecord[]> {
    return this.repos.stock.dailySummary(date);
  }

  /** Identities where the stock table and the ledger disagree. Empty = healthy. */
  async mismatchReport(): Promise<LedgerBalanceRecord[]> {
    return this.repos.stock.ledgerBalances({ mismatchesOnly: true });
  }
}
