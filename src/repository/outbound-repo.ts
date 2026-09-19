/**
 * outboundRepository — shipment demand/execution rows.
 *
 * origin = ALLOCATION rows come from the planner: their stock is deducted by
 * posting their movements (or completing the wave) — post() rejects them so
 * the same physical pick can never be deducted twice.
 * origin = MANUAL/IMPORT rows are actual outbound entries confirmed by the
 * warehouse: post() deducts stock exactly once.
 */

import type { DbClient } from '../lib/supabase.js';
import type { OutboundOrigin, OutboundStatus, RpcResult } from '../lib/database.types.js';
import { toWmsError } from '../lib/errors.js';
import { formatDbDate, outboundRowToDomain, type OutboundRecord } from './types.js';
import { unwrap, unwrapNullable } from './util.js';

export interface NewOutbound {
  outboundDate: Date | string;
  shipmentNumber: string;
  waveId?: string | null;
  waveNo?: string | null;
  truck?: string | null;
  destination?: string;
  sku: string;
  description?: string;
  location?: string | null;
  batch?: string | null;
  expiryDate?: Date | string | null;
  quantity: number;
  origin?: OutboundOrigin;
}

export class OutboundRepository {
  constructor(private readonly db: DbClient) {}

  async create(records: NewOutbound[]): Promise<OutboundRecord[]> {
    if (records.length === 0) return [];
    const rows = records.map((r) => ({
      outbound_date: typeof r.outboundDate === 'string' ? r.outboundDate : formatDbDate(r.outboundDate),
      shipment_number: r.shipmentNumber,
      wave_id: r.waveId ?? null,
      wave_no: r.waveNo ?? null,
      truck: r.truck ?? null,
      destination: r.destination ?? '',
      sku: r.sku,
      description: r.description ?? '',
      location: r.location ?? null,
      batch: r.batch ?? null,
      expiry_date:
        r.expiryDate === undefined || r.expiryDate === null
          ? null
          : typeof r.expiryDate === 'string'
            ? r.expiryDate
            : formatDbDate(r.expiryDate),
      quantity: r.quantity,
      origin: r.origin ?? 'MANUAL',
      status: 'PLANNED' as const,
    }));
    const res = await this.db.from('outbound').insert(rows).select();
    return unwrap(res, 'outbound.create').map(outboundRowToDomain);
  }

  async list(
    opts: { status?: OutboundStatus; date?: Date | string; waveId?: string; origin?: OutboundOrigin } = {},
  ): Promise<OutboundRecord[]> {
    let q = this.db.from('outbound').select('*').order('outbound_date').order('shipment_number').order('sku');
    if (opts.status) q = q.eq('status', opts.status);
    if (opts.date) q = q.eq('outbound_date', typeof opts.date === 'string' ? opts.date : formatDbDate(opts.date));
    if (opts.waveId) q = q.eq('wave_id', opts.waveId);
    if (opts.origin) q = q.eq('origin', opts.origin);
    return unwrap(await q, 'outbound.list').map(outboundRowToDomain);
  }

  async get(id: string): Promise<OutboundRecord | null> {
    const res = await this.db.from('outbound').select('*').eq('id', id).maybeSingle();
    const row = unwrapNullable(res);
    return row ? outboundRowToDomain(row) : null;
  }

  /** PLANNED → COMPLETED, -qty exactly once (MANUAL/IMPORT origins only). */
  async post(id: string, actor: string, postDate?: Date | string): Promise<RpcResult> {
    const { data, error } = await this.db.rpc('post_outbound', {
      p_outbound_id: id,
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

  /** RESCHEDULED / CANCELLED / back to PLANNED. Never touches stock. */
  async setStatus(
    id: string,
    status: Exclude<OutboundStatus, 'COMPLETED'>,
    actor: string,
    reason?: string,
  ): Promise<RpcResult> {
    const { data, error } = await this.db.rpc('set_outbound_status', {
      p_outbound_id: id,
      p_status: status,
      p_actor: actor,
      p_reason: reason ?? null,
    });
    if (error) throw toWmsError(new Error(error.message));
    return data as RpcResult;
  }
}
