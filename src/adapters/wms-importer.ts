/**
 * WMS Excel → database importer (Node/CLI side).
 *
 * Reuses loadWorkbook() (src/adapters/excel-input.ts) as the single parser so
 * the timezone-safe date handling stays canonical. Import is two explicit
 * steps — previewImportFile() produces the validation report, executeImport()
 * posts the snapshot through the initial_import RPC in one transaction.
 * The original workbook is never modified.
 *
 * The preview/validation/execute logic lives in ./import-preview.ts so the
 * browser bundle can reuse it without pulling in ExcelJS.
 */

import type { AllocatorConfig } from '../config.js';
import { withConfig } from '../config.js';
import { loadWorkbook } from './excel-input.js';
import { validateImport, type ImportPreview } from './import-preview.js';

export {
  validateImport,
  executeImport,
  formatPreview,
  stockBinToImportRow,
  type ImportPreview,
  type ImportCheck,
  type ImportCheckLevel,
  type ExecuteImportOptions,
} from './import-preview.js';

/** Parse the workbook and build the preview in one step. */
export async function previewImportFile(
  path: string,
  config: AllocatorConfig = withConfig(),
): Promise<ImportPreview> {
  const loaded = await loadWorkbook(path, config);
  return validateImport(path, loaded);
}
