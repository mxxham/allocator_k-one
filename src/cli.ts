import { writeFileSync } from 'node:fs';
import { allocate, relocateByWaveOrder } from './allocator.js';
import { withConfig } from './config.js';
import { buildPicklists } from './picklist.js';
import { derivePickfaces } from './pickface.js';
import { buildMovementReport } from './movement.js';
import { computeStockAfterMovements } from './ledger.js';
import { loadWorkbook } from './adapters/excel-input.js';
import { writePicklistWorkbook } from './adapters/excel-output.js';
import { renderPicklistHtml } from './adapters/html-output.js';
import { generatePicklistPdfs } from './adapters/pdf-output.js';

/**
 * Usage:
 *   npx tsx src/cli.ts <workbook.xlsx> [--out DIR] [--as-of YYYY-MM-DD]
 *                      [--min-shelf-life DAYS] [--no-split]
 *                      [--db]
 *
 * --db (or DATABASE_MODE=true) switches the STOCK source from the workbook
 * to the database; demand still comes from the workbook's schedule sheet.
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const input = argv.find((a) => !a.startsWith('--'));
  if (!input) {
    console.error('usage: tsx src/cli.ts <workbook.xlsx> [--out DIR] [--as-of YYYY-MM-DD] [--min-shelf-life DAYS] [--no-split] [--pdf]');
    process.exit(1);
  }
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const config = withConfig({
    asOf: flag('as-of') ? new Date(flag('as-of')!) : new Date(),
    minRemainingShelfLifeDays: flag('min-shelf-life') ? Number(flag('min-shelf-life')) : undefined,
    splitPalletAndCaseTasks: !argv.includes('--no-split'),
  } as never);

  const outDir = flag('out') ?? '.';
  const stamp = config.asOf.toISOString().slice(0, 10);

  const { stock: workbookStock, demand, stagedBySku, warnings } = await loadWorkbook(input, config);

  let stock = workbookStock;
  if (argv.includes('--db') || process.env.DATABASE_MODE === 'true') {
    const { getServerClient } = await import('./lib/supabase.js');
    const { StockRepository } = await import('./repository/stock-repo.js');
    const { loadStockFromDatabase } = await import('./adapters/database-stock.js');
    const dbStock = await loadStockFromDatabase(new StockRepository(getServerClient()));
    stock = dbStock.stock;
    warnings.unshift(...dbStock.warnings);
    console.log(`\nDATABASE_MODE: stock loaded from database (${stock.length} bins) — demand still from workbook.`);
  }

  const pickfaces = derivePickfaces(stock, config);

  // 1. outbound picking
  const result = allocate(stock, demand, config, stagedBySku);
  result.warnings.unshift(...warnings);
  const pickfaceLedger = relocateByWaveOrder(result.lines, pickfaces, config, stock);
  result.picklists = buildPicklists(result, demand, config);

  // 2. movement report
  const movement = buildMovementReport(result);

  const xlsxPath = `${outDir}/picklist_${stamp}.xlsx`;
  const htmlPath = `${outDir}/picklist_${stamp}.html`;
  await writePicklistWorkbook(result, xlsxPath, movement, pickfaces);
  writeFileSync(htmlPath, renderPicklistHtml(result, pickfaces), 'utf8');

  const outputPaths: string[] = [xlsxPath, htmlPath];

  if (argv.includes('--pdf')) {
    const pdfs = generatePicklistPdfs(result, config, pickfaces);
    for (const { name, data } of pdfs) {
      const pdfPath = `${outDir}/${name}`;
      writeFileSync(pdfPath, data);
      outputPaths.push(pdfPath);
    }
  }

  const s = result.stats;
  console.log(`\nFEFO allocation — as of ${stamp}`);
  console.log(`  stock bins eligible   : ${stock.length}`);
  console.log(`  demand lines          : ${s.demandLines} across ${s.shipments} shipments`);
  console.log(`  cartons requested     : ${s.cartonsRequested}`);
  console.log(`  cartons allocated     : ${s.cartonsAllocated}  (fill rate ${s.fillRatePct.toFixed(2)}%)`);
  console.log(`  pick instructions     : ${result.lines.length}  (${s.palletPicks} full pallet, ${s.casePicks} case)`);
  console.log(`  sealed pallets opened : ${s.palletsBroken}`);
  console.log(`  bins touched          : ${s.binsTouched}`);
  console.log(`  picklists             : ${result.picklists.length}`);
  console.log(`  shortages             : ${result.shortages.length}`);
  const errs = result.warnings.filter((w) => w.level === 'ERROR').length;
  const warns = result.warnings.filter((w) => w.level === 'WARN').length;
  console.log(`\n  exceptions            : ${errs} error, ${warns} warning`);
  console.log(`\n  → ${outputPaths.join('\n  → ')}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
