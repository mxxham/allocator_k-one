/**
 * Daily operations — record yesterday's receipts (§20) and confirm actual
 * outbound (§21). Every completion is idempotent: the RPCs are
 * compare-and-set, so a double-click changes stock exactly once.
 */

import type { DbClient } from '../lib/supabase.js';
import type { RpcResult } from '../lib/database.types.js';
import { createRepositories, type Repositories } from '../repository/index.js';
import type { InboundRecord, OutboundRecord } from '../repository/types.js';
import type { NewInbound } from '../repository/inbound-repo.js';
import type { NewOutbound } from '../repository/outbound-repo.js';

export interface PostSummary {
  posted: number;
  alreadyPosted: number;
  results: { id: string; result: string }[];
}

function summarize(results: { id: string; result: RpcResult }[]): PostSummary {
  return {
    posted: results.filter((r) => r.result.result === 'POSTED').length,
    alreadyPosted: results.filter((r) => r.result.result === 'ALREADY_POSTED').length,
    results: results.map((r) => ({ id: r.id, result: String(r.result.result) })),
  };
}

export class DailyService {
  private readonly repos: Repositories;

  constructor(private readonly db: DbClient) {
    this.repos = createRepositories(db);
  }

  // ---- inbound -------------------------------------------------------------

  /** Record receipts as PENDING — no stock change yet. */
  async recordInbound(records: NewInbound[]): Promise<InboundRecord[]> {
    return this.repos.inbound.create(records);
  }

  async pendingInbound(date?: Date | string): Promise<InboundRecord[]> {
    return this.repos.inbound.list({ status: 'PENDING', date });
  }

  /** Goods actually put away: PENDING → COMPLETED, +qty once. */
  async completeInbound(id: string, actor: string, postDate?: Date | string): Promise<RpcResult> {
    return this.repos.inbound.post(id, actor, postDate);
  }

  /** Complete every pending receipt of a day (idempotent per row). */
  async completeAllPendingInbound(actor: string, date?: Date | string): Promise<PostSummary> {
    const pending = await this.pendingInbound(date);
    const results: { id: string; result: RpcResult }[] = [];
    for (const r of pending) {
      results.push({ id: r.id, result: await this.repos.inbound.post(r.id, actor, date) });
    }
    return summarize(results);
  }

  async cancelInbound(id: string, actor: string, reason: string): Promise<RpcResult> {
    return this.repos.inbound.setStatus(id, 'CANCELLED', actor, reason);
  }

  // ---- outbound ------------------------------------------------------------

  /**
   * Record an actual outbound entry (MANUAL/IMPORT origin). Requires the full
   * physical identity (location + sku + batch + expiry) — post_outbound
   * rejects rows without it.
   */
  async recordOutbound(records: NewOutbound[]): Promise<OutboundRecord[]> {
    return this.repos.outbound.create(records);
  }

  /** Confirm the truck left: PLANNED → COMPLETED, −qty once. */
  async confirmOutbound(id: string, actor: string, postDate?: Date | string): Promise<RpcResult> {
    return this.repos.outbound.post(id, actor, postDate);
  }

  async pendingOutbound(date?: Date | string): Promise<OutboundRecord[]> {
    return this.repos.outbound.list({ status: 'PLANNED', date });
  }

  async cancelOutbound(id: string, actor: string, reason: string): Promise<RpcResult> {
    return this.repos.outbound.setStatus(id, 'CANCELLED', actor, reason);
  }
}
