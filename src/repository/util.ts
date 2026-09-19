/**
 * Shared helpers for repositories: unwrap PostgREST responses into domain
 * values or readable WmsErrors.
 */

import { WmsError, toWmsError } from '../lib/errors.js';

export interface PostgrestLike<T> {
  data: T | null;
  error: { message: string; code?: string; details?: string } | null;
}

export function unwrap<T>(res: PostgrestLike<T>, ctx: string): T {
  if (res.error) throw toWmsError(new Error(res.error.message));
  if (res.data === null) {
    throw new WmsError('DATABASE_ERROR', `${ctx}: database returned no data.`);
  }
  return res.data;
}

export function unwrapNullable<T>(res: PostgrestLike<T>): T | null {
  if (res.error) {
    // PGRST116 = "no rows returned" for single()
    if (res.error.code === 'PGRST116' || res.error.message.includes('0 rows')) return null;
    throw toWmsError(new Error(res.error.message));
  }
  return res.data;
}
