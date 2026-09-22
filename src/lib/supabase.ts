/**
 * Supabase client factory — one place, two contexts.
 *
 *   getServerClient()  — Node/CLI. Uses SUPABASE_SERVICE_ROLE_KEY when present
 *                        (bypasses RLS for administrative operations).
 *   getBrowserClient() — esbuild bundle. The publishable key is injected at
 *                        BUILD time by scripts/build-web.mjs via --define;
 *                        the service-role key is never referenced here and
 *                        can never end up in the browser bundle.
 *
 * No credentials are invented: when configuration is missing the server client
 * throws a readable DATABASE_UNAVAILABLE error and the browser client returns
 * null so the UI can show "database not configured".
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { WmsError } from './errors.js';

/**
 * The client is deliberately loosely typed at the wire boundary: supabase-js
 * strict generics require CLI-generated schema types (see database.types.ts
 * for the hand-written shapes). Every repository maps raw rows through the
 * typed Row interfaces and domain mappers in src/repository/types.ts, so
 * application code never touches `any`.
 */
export type DbClient = SupabaseClient;

// Injected by scripts/build-web.mjs (esbuild --define). In Node builds these
// identifiers do not exist at runtime, hence the typeof guards.
declare const __SUPABASE_URL__: string | undefined;
declare const __SUPABASE_KEY__: string | undefined;

export interface DatabaseConfig {
  url: string;
  key: string;
}

function nodeEnv(name: string): string | undefined {
  return typeof process !== 'undefined' && process.env ? process.env[name] || undefined : undefined;
}

/** Server-side config. Prefers the secret key, then service-role, then publishable. */
export function getServerConfig(): DatabaseConfig {
  const url = nodeEnv('VITE_SUPABASE_URL') ?? nodeEnv('SUPABASE_URL');
  const key =
    nodeEnv('SUPABASE_SECRET_KEY') ??
    nodeEnv('SUPABASE_SERVICE_ROLE_KEY') ??
    nodeEnv('SUPABASE_PUBLISHABLE_KEY') ??
    nodeEnv('VITE_SUPABASE_PUBLISHABLE_KEY') ??
    nodeEnv('VITE_SUPABASE_ANON_KEY') ??
    nodeEnv('SUPABASE_ANON_KEY');
  if (!url || !key) {
    throw new WmsError(
      'DATABASE_UNAVAILABLE',
      'Database unavailable — set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY (and optionally SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY for server-side admin operations). See .env.example.',
    );
  }
  return { url, key };
}

/** Browser config from build-time defines, or null when not configured. */
export function getBrowserConfig(): DatabaseConfig | null {
  const url = typeof __SUPABASE_URL__ !== 'undefined' ? __SUPABASE_URL__ : undefined;
  const key = typeof __SUPABASE_KEY__ !== 'undefined' ? __SUPABASE_KEY__ : undefined;
  if (!url || !key) return null;
  return { url, key };
}

let serverClient: DbClient | null = null;
let browserClient: DbClient | null = null;
let browserChecked = false;

export function getServerClient(): DbClient {
  if (!serverClient) {
    const { url, key } = getServerConfig();
    serverClient = createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return serverClient;
}

export function getBrowserClient(): DbClient | null {
  if (!browserChecked) {
    browserChecked = true;
    const cfg = getBrowserConfig();
    if (cfg) {
      browserClient = createClient(cfg.url, cfg.key, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
    }
  }
  return browserClient;
}

/** True when the current context has usable database configuration. */
export function isDatabaseConfigured(): boolean {
  if (typeof process !== 'undefined' && process.env && process.env.VITE_SUPABASE_URL) return true;
  return getBrowserConfig() !== null;
}
