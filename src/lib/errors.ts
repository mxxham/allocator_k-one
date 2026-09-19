/**
 * User-readable error mapping for database operations.
 *
 * The SQL posting functions raise pipe-delimited codes
 * (e.g. `INSUFFICIENT_STOCK|CC21A02|550076636|05I26JJ|2030-09-04|available=5|requested=10`).
 * This module turns them — and PostgREST errors — into messages warehouse
 * users can act on, without hiding the original text (kept in `rawMessage`).
 */

export type WmsErrorCode =
  | 'DATABASE_UNAVAILABLE'
  | 'INSUFFICIENT_STOCK'
  | 'STOCK_NOT_FOUND'
  | 'PHYSICAL_IDENTITY_CONFLICT'
  | 'DUPLICATE_IDENTITY'
  | 'DUPLICATE_INBOUND_REFERENCE'
  | 'VALIDATION_ERROR'
  | 'INVALID_EXPIRY_DATE'
  | 'MOVEMENT_NOT_FOUND'
  | 'MOVEMENT_ALREADY_COMPLETED'
  | 'MOVEMENT_NOT_EXECUTABLE'
  | 'MOVEMENT_ALREADY_POSTED'
  | 'WAVE_NOT_FOUND'
  | 'WAVE_RESCHEDULED'
  | 'WAVE_ALREADY_COMPLETED'
  | 'WAVE_CANCELLED'
  | 'INBOUND_NOT_FOUND'
  | 'INBOUND_CANCELLED'
  | 'INBOUND_ALREADY_COMPLETED'
  | 'OUTBOUND_NOT_FOUND'
  | 'OUTBOUND_ALREADY_COMPLETED'
  | 'OUTBOUND_NOT_EXECUTABLE'
  | 'OUTBOUND_POSTED_VIA_MOVEMENTS'
  | 'OUTBOUND_IDENTITY_REQUIRED'
  | 'REASON_REQUIRED'
  | 'ACTOR_REQUIRED'
  | 'ZERO_ADJUSTMENT'
  | 'DESTINATION_REQUIRED'
  | 'INVALID_STATUS'
  | 'DATABASE_ERROR';

export class WmsError extends Error {
  constructor(
    readonly code: WmsErrorCode,
    message: string,
    readonly rawMessage?: string,
  ) {
    super(message);
    this.name = 'WmsError';
  }
}

export function toWmsError(err: unknown): WmsError {
  if (err instanceof WmsError) return err;
  const raw =
    typeof err === 'string'
      ? err
      : err instanceof Error
        ? err.message
        : String(err);

  const code = raw.split('|')[0].trim();
  const parts = raw.split('|');

  switch (code) {
    case 'INSUFFICIENT_STOCK': {
      const available = parts.find((p) => p.startsWith('available='))?.slice('available='.length) ?? '?';
      const requested = parts.find((p) => p.startsWith('requested='))?.slice('requested='.length) ?? '?';
      return new WmsError(
        'INSUFFICIENT_STOCK',
        `Insufficient physical stock for ${parts[1] ?? 'unknown identity'} (available ${available}, requested ${requested}).`,
        raw,
      );
    }
    case 'STOCK_NOT_FOUND':
      return new WmsError('STOCK_NOT_FOUND', `Stock identity not found: ${parts[1] ?? '?'}.`, raw);
    case 'PHYSICAL_IDENTITY_CONFLICT':
      return new WmsError(
        'PHYSICAL_IDENTITY_CONFLICT',
        `Physical identity conflict: ${parts[1] ?? '?'} already exists in the database.`,
        raw,
      );
    case 'DUPLICATE_IDENTITY':
      return new WmsError('DUPLICATE_IDENTITY', 'Duplicate physical identity in the import payload.', raw);
    case 'DUPLICATE_INBOUND_REFERENCE':
      return new WmsError('DUPLICATE_INBOUND_REFERENCE', 'Duplicate inbound reference.', raw);
    case 'VALIDATION_ERROR':
      return new WmsError('VALIDATION_ERROR', `Import validation failed: ${parts.slice(1).join(' — ')}`, raw);
    case 'MOVEMENT_NOT_FOUND':
      return new WmsError('MOVEMENT_NOT_FOUND', 'Movement not found.', raw);
    case 'MOVEMENT_ALREADY_COMPLETED':
      return new WmsError('MOVEMENT_ALREADY_COMPLETED', 'Movement already completed.', raw);
    case 'MOVEMENT_NOT_EXECUTABLE':
      return new WmsError('MOVEMENT_NOT_EXECUTABLE', `Movement cannot be executed (status ${parts[2] ?? '?'}).`, raw);
    case 'WAVE_NOT_FOUND':
      return new WmsError('WAVE_NOT_FOUND', 'Wave not found.', raw);
    case 'WAVE_RESCHEDULED':
      return new WmsError('WAVE_RESCHEDULED', 'Wave is rescheduled — it cannot be completed until it is back in PENDING.', raw);
    case 'WAVE_ALREADY_COMPLETED':
      return new WmsError('WAVE_ALREADY_COMPLETED', 'Wave already completed.', raw);
    case 'WAVE_CANCELLED':
      return new WmsError('WAVE_CANCELLED', 'Wave is cancelled.', raw);
    case 'INBOUND_NOT_FOUND':
      return new WmsError('INBOUND_NOT_FOUND', 'Inbound record not found.', raw);
    case 'INBOUND_CANCELLED':
      return new WmsError('INBOUND_CANCELLED', 'Inbound record is cancelled.', raw);
    case 'INBOUND_ALREADY_COMPLETED':
      return new WmsError('INBOUND_ALREADY_COMPLETED', 'Inbound already completed.', raw);
    case 'OUTBOUND_NOT_FOUND':
      return new WmsError('OUTBOUND_NOT_FOUND', 'Outbound record not found.', raw);
    case 'OUTBOUND_ALREADY_COMPLETED':
      return new WmsError('OUTBOUND_ALREADY_COMPLETED', 'Outbound already completed.', raw);
    case 'OUTBOUND_NOT_EXECUTABLE':
      return new WmsError('OUTBOUND_NOT_EXECUTABLE', `Outbound cannot be executed (status ${parts[2] ?? '?'}).`, raw);
    case 'OUTBOUND_POSTED_VIA_MOVEMENTS':
      return new WmsError(
        'OUTBOUND_POSTED_VIA_MOVEMENTS',
        'This outbound comes from an allocation plan — its stock is deducted by posting its movements (or completing the wave), not here.',
        raw,
      );
    case 'OUTBOUND_IDENTITY_REQUIRED':
      return new WmsError('OUTBOUND_IDENTITY_REQUIRED', 'Outbound needs location and expiry date before it can be posted.', raw);
    case 'REASON_REQUIRED':
      return new WmsError('REASON_REQUIRED', 'A reason is required for stock adjustments.', raw);
    case 'ACTOR_REQUIRED':
      return new WmsError('ACTOR_REQUIRED', 'An actor (user) is required for stock adjustments.', raw);
    case 'ZERO_ADJUSTMENT':
      return new WmsError('ZERO_ADJUSTMENT', 'Adjustment delta must be a non-zero integer number of cartons.', raw);
    case 'DESTINATION_REQUIRED':
      return new WmsError('DESTINATION_REQUIRED', 'Movement has no destination location.', raw);
    case 'INVALID_STATUS':
      return new WmsError('INVALID_STATUS', `Invalid status: ${parts[1] ?? '?'}.`, raw);
    case 'USE_POST_MOVEMENT':
      return new WmsError('INVALID_STATUS', 'Movements are completed through the post/execute action, not a status change.', raw);
    case 'USE_COMPLETE_WAVE':
      return new WmsError('INVALID_STATUS', 'Waves are completed through the complete-wave action.', raw);
    case 'USE_POST_INBOUND':
      return new WmsError('INVALID_STATUS', 'Inbound records are completed through the post action.', raw);
    case 'USE_POST_OUTBOUND_OR_COMPLETE_WAVE':
      return new WmsError('INVALID_STATUS', 'Outbound records are completed through the post action or by completing their wave.', raw);
    case 'ZERO_ADJUSTMENT':
      return new WmsError('VALIDATION_ERROR', 'Adjustment quantity cannot be zero.', raw);
    case 'INVALID_IMPORT_MODE':
      return new WmsError('VALIDATION_ERROR', `Invalid import mode: ${parts[1] ?? '?'}.`, raw);
  }

  // Postgres unique-violation on the inbound reference constraint.
  if (raw.includes('ux_inbound_reference') || raw.includes('duplicate key value violates unique constraint "ux_inbound_reference"')) {
    return new WmsError('DUPLICATE_INBOUND_REFERENCE', 'Duplicate inbound reference.', raw);
  }
  if (raw.includes('ux_stock_identity')) {
    return new WmsError('PHYSICAL_IDENTITY_CONFLICT', 'Physical identity conflict — record already exists.', raw);
  }
  if (raw.includes('ux_stx_reference')) {
    return new WmsError('MOVEMENT_ALREADY_POSTED', 'Movement has already been posted.', raw);
  }

  return new WmsError('DATABASE_ERROR', `Database error: ${raw}`, raw);
}
