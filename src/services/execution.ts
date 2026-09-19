/**
 * Execution services — complete / reschedule / cancel at wave AND movement
 * level. Partial execution is a first-class state: a wave can be PENDING
 * while one movement is COMPLETED and another RESCHEDULED.
 *
 * Every stock-affecting action goes through the SQL RPCs (post_movement /
 * complete_wave), which are compare-and-set idempotent: posting twice changes
 * stock exactly once. Status-only transitions (RESCHEDULED / CANCELLED /
 * back to PLANNED-PENDING) never touch stock; history is kept in
 * execution_events.
 */

import type { DbClient } from '../lib/supabase.js';
import type { RpcResult } from '../lib/database.types.js';
import { createRepositories, type Repositories } from '../repository/index.js';
import type { MovementRecord, WaveRecord } from '../repository/types.js';
import { WmsError } from '../lib/errors.js';

export interface WaveSnapshot {
  wave: WaveRecord;
  movements: MovementRecord[];
  counts: Record<string, number>;
}

function countBy<T>(items: T[], key: (x: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of items) {
    const k = key(i);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

export class ExecutionService {
  private readonly repos: Repositories;

  constructor(private readonly db: DbClient) {
    this.repos = createRepositories(db);
  }

  /** Wave + its movements + status counts, in one read. */
  async waveSnapshot(waveId: string): Promise<WaveSnapshot> {
    const wave = await this.repos.waves.get(waveId);
    if (!wave) throw new WmsError('WAVE_NOT_FOUND', `Wave ${waveId} does not exist.`);
    const movements = await this.repos.movements.listByWave(waveId);
    return { wave, movements, counts: countBy(movements, (m) => m.status) };
  }

  /**
   * The truck shipped: posts every remaining PLANNED movement of the wave
   * (stock changes exactly once each) and marks its ALLOCATION outbound rows
   * COMPLETED. Idempotent — a completed wave returns ALREADY_POSTED.
   */
  async completeWave(waveId: string, actor: string, postDate?: Date | string): Promise<RpcResult> {
    return this.repos.waves.complete(waveId, actor, postDate);
  }

  /** Execute a single movement against stock (partial wave execution). */
  async completeMovement(movementId: string, actor: string, postDate?: Date | string): Promise<RpcResult> {
    return this.repos.movements.post(movementId, actor, postDate);
  }

  /** Reschedule one movement — never touches stock. */
  async rescheduleMovement(movementId: string, actor: string, reason: string): Promise<RpcResult> {
    return this.repos.movements.setStatus(movementId, 'RESCHEDULED', actor, reason);
  }

  /** Cancel one movement — never touches stock. */
  async cancelMovement(movementId: string, actor: string, reason: string): Promise<RpcResult> {
    return this.repos.movements.setStatus(movementId, 'CANCELLED', actor, reason);
  }

  /** Put a RESCHEDULED movement back into the plan. */
  async reactivateMovement(movementId: string, actor: string, reason?: string): Promise<RpcResult> {
    return this.repos.movements.setStatus(movementId, 'PLANNED', actor, reason);
  }

  /** Reschedule a whole wave (e.g. truck moved to another slot). */
  async rescheduleWave(
    waveId: string,
    actor: string,
    reason: string,
    opts: { newSlot?: string | null; newDate?: Date | string | null } = {},
  ): Promise<RpcResult> {
    return this.repos.waves.setStatus(waveId, 'RESCHEDULED', actor, {
      reason,
      newSlot: opts.newSlot,
      newDate: opts.newDate,
    });
  }

  /** Cancel a wave — SQL cascades to its still-PLANNED movements/outbound. */
  async cancelWave(waveId: string, actor: string, reason: string): Promise<RpcResult> {
    return this.repos.waves.setStatus(waveId, 'CANCELLED', actor, { reason });
  }

  /** Bring a RESCHEDULED wave back to PENDING. */
  async reopenWave(waveId: string, actor: string, reason?: string): Promise<RpcResult> {
    return this.repos.waves.setStatus(waveId, 'PENDING', actor, { reason });
  }
}
