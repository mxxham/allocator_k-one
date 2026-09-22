/**
 * Web build — esbuild with the browser Supabase config injected at BUILD time.
 *
 * Reads .env.local / .env for VITE_SUPABASE_URL and the publishable key
 * (VITE_SUPABASE_PUBLISHABLE_KEY, legacy VITE_SUPABASE_ANON_KEY). The
 * service-role key is NEVER read here and can never enter the bundle.
 * When no config is found the defines are omitted: getBrowserConfig()
 * returns null at runtime and the Ops area shows "database not configured".
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as esbuild from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function readEnv() {
  const env = {};
  for (const f of ['.env.local', '.env']) {
    const p = join(root, f);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!m) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!(m[1] in env)) env[m[1]] = v;
    }
  }
  return env;
}

const env = readEnv();
// Vercel and other platforms inject env vars into process.env, not .env files
if (!env.VITE_SUPABASE_URL && process.env.VITE_SUPABASE_URL) env.VITE_SUPABASE_URL = process.env.VITE_SUPABASE_URL;
if (!env.VITE_SUPABASE_PUBLISHABLE_KEY && process.env.VITE_SUPABASE_PUBLISHABLE_KEY) env.VITE_SUPABASE_PUBLISHABLE_KEY = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
if (!env.VITE_SUPABASE_ANON_KEY && process.env.VITE_SUPABASE_ANON_KEY) env.VITE_SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;
if (!env.SUPABASE_URL && process.env.SUPABASE_URL) env.SUPABASE_URL = process.env.SUPABASE_URL;
if (!env.SUPABASE_PUBLISHABLE_KEY && process.env.SUPABASE_PUBLISHABLE_KEY) env.SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const url = env.VITE_SUPABASE_URL ?? env.SUPABASE_URL;
const key = env.VITE_SUPABASE_PUBLISHABLE_KEY ?? env.VITE_SUPABASE_ANON_KEY ?? env.SUPABASE_PUBLISHABLE_KEY;

const defines = {};
if (url && key) {
  defines.__SUPABASE_URL__ = JSON.stringify(url);
  defines.__SUPABASE_KEY__ = JSON.stringify(key);
  console.log('build-web: browser Supabase config injected (publishable key only)');
} else {
  console.log('build-web: no browser Supabase config found — Ops area will show "database not configured"');
}

const common = {
  bundle: true,
  format: 'iife',
  target: 'es2020',
  minify: true,
  define: defines,
  absWorkingDir: root,
};

await esbuild.build({ ...common, entryPoints: [join(root, 'src/web/main.ts')], outfile: join(root, 'web/bundle.js') });
await esbuild.build({ ...common, entryPoints: [join(root, 'src/web/ops.ts')], outfile: join(root, 'web/ops-bundle.js') });
