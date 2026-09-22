/**
 * waveRepository — outbound run groupings.
 * Wave numbers are NOT chronological order; planned_slot/planned_date are.
 * Status transitions go through RPCs; COMPLETED only via completeWave, which
 * posts the wave's planned movements (that is what deducts stock).
 */

import type { DbClient } from '../lib/supabase.js';
import type { RpcResult, WaveStatus } from '../lib/database.types.js';
import { toWmsError } from '../lib/errors.js';
import { formatDbDate, waveRowToDomain, type WaveRecord } from './types.js';
import { unwrap, unwrapNullable } from './util.js';

export interface NewWave {
  waveNo: string;
  plannedDate: Date | string;
  shipmentNumbers?: string[];
  truck?: string | null;
  destination?: string;
  plannedSlot?: string | null;
}

export class WaveRepository {
  constructor(private readonly db: DbClient) {}

  async create(waves: NewWave[]): Promise<WaveRecord[]> {
    if (waves.length === 0) return [];
    const rows = waves.map((w) => ({
      wave_no: w.waveNo,
      planned_date: typeof w.plannedDate === 'string' ? w.plannedDate : formatDbDate(w.plannedDate),
      shipment_numbers: w.shipmentNumbers ?? [],
      truck: w.truck ?? null,
      destination: w.destination ?? '',
      planned_slot: w.plannedSlot ?? null,
    }));
    const res = await this.db.from('waves').insert(rows).select();
    return unwrap(res, 'waves.create').map(waveRowToDomain);
  }

  async list(opts: { date?: Date | string; status?: WaveStatus } = {}): Promise<WaveRecord[]> {
    let q = this.db.from('waves').select('*').order('planned_slot', { ascending: true, nullsFirst: false }).order('wave_no');
    if (opts.date) q = q.eq('planned_date', typeof opts.date === 'string' ? opts.date : formatDbDate(opts.date));
    if (opts.status) q = q.eq('status', opts.status);
    return unwrap(await q, 'waves.list').map(waveRowToDomain);
  }

  async get(id: string): Promise<WaveRecord | null> {
    const res = await this.db.from('waves').select('*').eq('id', id).maybeSingle();
    const row = unwrapNullable(res);
    return row ? waveRowToDomain(row) : null;
  }

  /** RESCHEDULED / CANCELLED / back to PENDING. Never touches stock. */
  async setStatus(
    id: string,
    status: Exclude<WaveStatus, 'COMPLETED'>,
    actor: string,
    opts: { reason?: string; newSlot?: string | null; newDate?: Date | string | null } = {},
  ): Promise<RpcResult> {
    const { data, error } = await this.db.rpc('set_wave_status', {
      p_wave_id: id,
      p_status: status,
      p_actor: actor,
      p_reason: opts.reason ?? null,
      p_new_slot: opts.newSlot ?? null,
      p_new_date:
        opts.newDate === undefined || opts.newDate === null
          ? null
          : typeof opts.newDate === 'string'
            ? opts.newDate
            : formatDbDate(opts.newDate),
    });
    if (error) throw toWmsError(new Error(error.message));
    return data as RpcResult;
  }

  /** The truck shipped: posts every remaining PLANNED movement exactly once. */
  async complete(id: string, actor: string, postDate?: Date | string): Promise<RpcResult> {
    const { data, error } = await this.db.rpc('complete_wave', {
      p_wave_id: id,
      p_actor: actor,
      ...(postDate
        ? { p_post_date: typeof postDate === 'string' ? postDate : formatDbDate(postDate) }
        : {}),
    });
    if (error) throw toWmsError(new Error(error.message));
    return data as RpcResult;
  }

  async deletePendingByDate(date: Date | string): Promise<number> {
    const d = typeof date === 'string' ? date : formatDbDate(date);
    const { data: waves, error: selErr } = await this.db
      .from('waves')
      .select('id')
      .eq('planned_date', d)
      .eq('status', 'PENDING');
    if (selErr) throw toWmsError(new Error(selErr.message));
    if (!waves || waves.length === 0) return 0;
    const ids = waves.map((w) => w.id);
    const { error: delMovErr } = await this.db.from('movements').delete().in('wave_id', ids);
    if (delMovErr) throw toWmsError(new Error(delMovErr.message));
    const { error: delOutErr } = await this.db.from('outbound').delete().in('wave_id', ids);
    if (delOutErr) throw toWmsError(new Error(delOutErr.message));
    const { error: delWavErr } = await this.db.from('waves').delete().in('id', ids);
    if (delWavErr) throw toWmsError(new Error(delWavErr.message));
    return ids.length;
  }
}
