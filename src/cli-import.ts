/**
 * WMS import CLI.
 *
 * Usage:
 *   npm run import:wms -- <workbook.xlsx> [--actor NAME] [--date YYYY-MM-DD]
 *                           [--mode FAIL_ON_CONFLICT|REPLACE] [--yes]
 *
 * Without --yes this only prints the validation preview (nothing is written).
 * With --yes the snapshot is posted through the initial_import RPC in one
 * database transaction. The source workbook is never modified.
 */

import { previewImportFile, executeImport, formatPreview } from './adapters/wms-importer.js';
import { getServerClient } from './lib/supabase.js';
import { WmsError } from './lib/errors.js';

function loadDotEnv(): void {
  const load = (process as unknown as { loadEnvFile?: (f: string) => void }).loadEnvFile;
  if (typeof load !== 'function') return;
  for (const f of ['.env.local', '.env']) {
    try {
      load(f);
    } catch {
      // file absent — fine
    }
  }
}

async function main(): Promise<void> {
  loadDotEnv();
  const argv = process.argv.slice(2);
  const input = argv.find((a) => !a.startsWith('--'));
  if (!input) {
    console.error(
      'usage: tsx src/cli-import.ts <workbook.xlsx> [--actor NAME] [--date YYYY-MM-DD] [--mode FAIL_ON_CONFLICT|REPLACE] [--yes]',
    );
    process.exit(1);
  }
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const preview = await previewImportFile(input);
  console.log(formatPreview(preview));

  if (!argv.includes('--yes')) {
    console.log('\nPreview only — re-run with --yes to write to the database.');
    process.exit(preview.canImport ? 0 : 2);
  }
  if (!preview.canImport) {
    console.error('\nImport blocked by validation errors — nothing was written.');
    process.exit(2);
  }

  const mode = flag('mode') ?? 'FAIL_ON_CONFLICT';
  if (mode !== 'FAIL_ON_CONFLICT' && mode !== 'REPLACE') {
    console.error(`invalid --mode "${mode}" (use FAIL_ON_CONFLICT or REPLACE)`);
    process.exit(1);
  }

  const db = getServerClient();
  const result = await executeImport(db, preview, {
    actor: flag('actor') ?? 'cli-import',
    mode,
    date: flag('date'),
  });
  console.log(
    `\nImport ${String(result.result).toLowerCase()}: imported=${String(result.imported ?? 0)}` +
      ` replaced=${String(result.replaced ?? 0)} skipped_zero_qty=${String(result.skipped_zero_qty ?? 0)}`,
  );
}

main().catch((err) => {
  if (err instanceof WmsError) console.error(`\n[${err.code}] ${err.message}`);
  else console.error(err);
  process.exit(1);
});
