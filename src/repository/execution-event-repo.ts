/**
 * executionEventRepository — read access to the append-only status-transition
 * audit trail (who moved what to which status, when, and why). History is
 * never erased: a rescheduled wave keeps its full transition chain.
 */

import type { DbClient } from '../lib/supabase.js';
import { execEventRowToDomain, type ExecutionEventRecord } from './types.js';
import { unwrap } from './util.js';

export class ExecutionEventRepository {
  constructor(private readonly db: DbClient) {}

  async list(
    opts: { entityType?: 'WAVE' | 'MOVEMENT' | 'INBOUND' | 'OUTBOUND'; entityId?: string; since?: Date } = {},
  ): Promise<ExecutionEventRecord[]> {
    let q = this.db.from('execution_events').select('*').order('occurred_at', { ascending: false }).limit(500);
    if (opts.entityType) q = q.eq('entity_type', opts.entityType);
    if (opts.entityId) q = q.eq('entity_id', opts.entityId);
    if (opts.since) q = q.gte('occurred_at', opts.since.toISOString());
    return unwrap(await q, 'execution_events.list').map(execEventRowToDomain);
  }
}
