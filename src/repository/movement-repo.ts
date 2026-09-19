/**
 * movementRepository — planned and executed physical movements.
 * Execution is tracked at MOVEMENT level: a wave may be PENDING while one
 * movement is COMPLETED and another RESCHEDULED. Stock changes happen only
 * inside the post_movement RPC, exactly once per movement.
 */

import type { DbClient } from '../lib/supabase.js';
import type { MovementStatus, MovementType, RpcResult } from '../lib/database.types.js';
import { toWmsError } from '../lib/errors.js';
import { formatDbDate, movementRowToDomain, type MovementRecord } from './types.js';
import { unwrap, unwrapNullable } from './util.js';

export interface NewMovement {
  waveId?: string | null;
  waveNo?: string | null;
  shipmentNumber?: string | null;
  movementType: MovementType;
  sku: string;
  description?: string;
  sourceLocation: string;
  destinationLocation?: string | null;
  batch: string | null;
  expiryDate: Date | string;
  quantity: number;
  pickType?: 'PALLET' | 'CASE' | null;
  breaksPallet?: boolean;
  seq?: number | null;
  referenceId?: string | null;
}

export class MovementRepository {
  constructor(private readonly db: DbClient) {}

  /** Batch insert of PLANNED movements (planning never touches stock). */
  async create(movements: NewMovement[]): Promise<MovementRecord[]> {
    if (movements.length === 0) return [];
    const rows = movements.map((m) => ({
      wave_id: m.waveId ?? null,
      wave_no: m.waveNo ?? null,
      shipment_number: m.shipmentNumber ?? null,
      movement_type: m.movementType,
      sku: m.sku,
      description: m.description ?? '',
      source_location: m.sourceLocation,
      destination_location: m.destinationLocation ?? null,
      batch: m.batch,
      expiry_date: typeof m.expiryDate === 'string' ? m.expiryDate : formatDbDate(m.expiryDate),
      quantity: m.quantity,
      pick_type: m.pickType ?? null,
      breaks_pallet: m.breaksPallet ?? false,
      seq: m.seq ?? null,
      reference_id: m.referenceId ?? null,
      status: 'PLANNED' as const,
    }));
    const res = await this.db.from('movements').insert(rows).select();
    return unwrap(res, 'movements.create').map(movementRowToDomain);
  }

  async listByWave(waveId: string): Promise<MovementRecord[]> {
    const res = await this.db
      .from('movements')
      .select('*')
      .eq('wave_id', waveId)
      .order('seq', { ascending: true, nullsFirst: false })
      .order('created_at');
    return unwrap(res, 'movements.listByWave').map(movementRowToDomain);
  }

  async list(opts: { status?: MovementStatus; waveNo?: string; date?: Date | string } = {}): Promise<
    MovementRecord[]
  > {
    let q = this.db.from('movements').select('*').order('created_at');
    if (opts.status) q = q.eq('status', opts.status);
    if (opts.waveNo) q = q.eq('wave_no', opts.waveNo);
    if (opts.date) {
      const d = typeof opts.date === 'string' ? opts.date : formatDbDate(opts.date);
      q = q.gte('created_at', `${d}T00:00:00Z`).lt('created_at', `${d}T23:59:59.999Z`);
    }
    return unwrap(await q, 'movements.list').map(movementRowToDomain);
  }

  async get(id: string): Promise<MovementRecord | null> {
    const res = await this.db.from('movements').select('*').eq('id', id).maybeSingle();
    const row = unwrapNullable(res);
    return row ? movementRowToDomain(row) : null;
  }

  /**
   * Execute one movement against stock. Idempotent: returns
   * { result: 'ALREADY_POSTED' } when the movement is already COMPLETED.
   */
  async post(id: string, actor: string, postDate?: Date | string): Promise<RpcResult> {
    const { data, error } = await this.db.rpc('post_movement', {
      p_movement_id: id,
      p_actor: actor,
      ...(postDate
        ? { p_post_date: typeof postDate === 'string' ? postDate : formatDbDate(postDate) }
        : {}),
    });
    if (error) throw toWmsError(new Error(error.message));
    return data as RpcResult;
  }

  /** RESCHEDULED / CANCELLED / back to PLANNED. Never touches stock. */
  async setStatus(
    id: string,
    status: Exclude<MovementStatus, 'COMPLETED'>,
    actor: string,
    reason?: string,
  ): Promise<RpcResult> {
    const { data, error } = await this.db.rpc('set_movement_status', {
      p_movement_id: id,
      p_status: status,
      p_actor: actor,
      p_reason: reason ?? null,
    });
    if (error) throw toWmsError(new Error(error.message));
    return data as RpcResult;
  }
}
