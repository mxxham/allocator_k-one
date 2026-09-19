/**
 * inboundRepository — receipts. Only COMPLETED inbound affects stock, via the
 * post_inbound RPC (idempotent; duplicate reference_no rejected by constraint).
 */

import type { DbClient } from '../lib/supabase.js';
import type { InboundStatus, RpcResult } from '../lib/database.types.js';
import { toWmsError } from '../lib/errors.js';
import { formatDbDate, inboundRowToDomain, type InboundRecord } from './types.js';
import { unwrap, unwrapNullable } from './util.js';

export interface NewInbound {
  inboundDate: Date | string;
  referenceNo: string;
  sku: string;
  description?: string;
  location: string;
  batch: string | null;
  expiryDate: Date | string;
  quantity: number;
  upp?: number;
  uom?: string | null;
  notes?: string | null;
}

export class InboundRepository {
  constructor(private readonly db: DbClient) {}

  async create(records: NewInbound[]): Promise<InboundRecord[]> {
    if (records.length === 0) return [];
    const rows = records.map((r) => ({
      inbound_date: typeof r.inboundDate === 'string' ? r.inboundDate : formatDbDate(r.inboundDate),
      reference_no: r.referenceNo,
      sku: r.sku,
      description: r.description ?? '',
      location: r.location,
      batch: r.batch,
      expiry_date: typeof r.expiryDate === 'string' ? r.expiryDate : formatDbDate(r.expiryDate),
      quantity: r.quantity,
      upp: r.upp ?? 1,
      uom: r.uom ?? null,
      notes: r.notes ?? null,
      status: 'PENDING' as const,
    }));
    const res = await this.db.from('inbound').insert(rows).select();
    return unwrap(res, 'inbound.create').map(inboundRowToDomain);
  }

  async list(opts: { status?: InboundStatus; date?: Date | string } = {}): Promise<InboundRecord[]> {
    let q = this.db.from('inbound').select('*').order('inbound_date').order('reference_no');
    if (opts.status) q = q.eq('status', opts.status);
    if (opts.date) q = q.eq('inbound_date', typeof opts.date === 'string' ? opts.date : formatDbDate(opts.date));
    return unwrap(await q, 'inbound.list').map(inboundRowToDomain);
  }

  async get(id: string): Promise<InboundRecord | null> {
    const res = await this.db.from('inbound').select('*').eq('id', id).maybeSingle();
    const row = unwrapNullable(res);
    return row ? inboundRowToDomain(row) : null;
  }

  /** PENDING → COMPLETED, +qty exactly once. */
  async post(id: string, actor: string, postDate?: Date | string): Promise<RpcResult> {
    const { data, error } = await this.db.rpc('post_inbound', {
      p_inbound_id: id,
      p_actor: actor,
      p_post_date: postDate
        ? typeof postDate === 'string'
          ? postDate
          : formatDbDate(postDate)
        : null,
    });
    if (error) throw toWmsError(new Error(error.message));
    return data as RpcResult;
  }

  /** CANCELLED / back to PENDING. Never touches stock. */
  async setStatus(
    id: string,
    status: Exclude<InboundStatus, 'COMPLETED'>,
    actor: string,
    reason?: string,
  ): Promise<RpcResult> {
    const { data, error } = await this.db.rpc('set_inbound_status', {
      p_inbound_id: id,
      p_status: status,
      p_actor: actor,
      p_reason: reason ?? null,
    });
    if (error) throw toWmsError(new Error(error.message));
    return data as RpcResult;
  }
}
