/**
 * Controlled stock adjustment (§23) — the only way stock changes outside a
 * posting RPC. Reason and actor are mandatory (enforced here AND in SQL);
 * the ADJUSTMENT transaction makes every correction permanently visible.
 */

import type { DbClient } from '../lib/supabase.js';
import type { RpcResult } from '../lib/database.types.js';
import { StockRepository } from '../repository/stock-repo.js';
import { WmsError } from '../lib/errors.js';

export interface AdjustmentRequest {
  location: string;
  sku: string;
  batch: string | null;
  expiry: Date | string;
  /** signed carton delta; a negative result is rejected by the database */
  delta: number;
  reason: string;
  actor: string;
  date?: Date | string;
}

export async function adjustStock(db: DbClient, req: AdjustmentRequest): Promise<RpcResult> {
  if (!req.reason.trim()) {
    throw new WmsError('REASON_REQUIRED', 'An adjustment reason is required — silent corrections are not allowed.');
  }
  if (!req.actor.trim()) {
    throw new WmsError('ACTOR_REQUIRED', 'An actor is required for every adjustment.');
  }
  if (!Number.isInteger(req.delta) || req.delta === 0) {
    throw new WmsError('ZERO_ADJUSTMENT', 'Adjustment delta must be a non-zero integer number of cartons.');
  }
  const repo = new StockRepository(db);
  return repo.adjust(
    req.location,
    req.sku,
    req.batch,
    req.expiry,
    req.delta,
    req.reason.trim(),
    req.actor.trim(),
    req.date,
  );
}
