import { writeFileSync } from 'node:fs';
import { allocate, relocateByWaveOrder } from './allocator.js';
import { withConfig } from './config.js';
import { buildPicklists } from './picklist.js';
import { derivePickfaces } from './pickface.js';
import { replenish, sequenceReplenishment } from './replenishment.js';
import { buildMovementReport } from './movement.js';
import { applyMovements } from './binselect.js';
import { loadWorkbook } from './adapters/excel-input.js';
import { writePicklistWorkbook } from './adapters/excel-output.js';
import { renderPicklistHtml } from './adapters/html-output.js';

/**
 * Usage:
 *   npx tsx src/cli.ts <workbook.xlsx> [--out DIR] [--as-of YYYY-MM-DD]
 *                      [--min-shelf-life DAYS] [--no-split] [--no-replenish]
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const input = argv.find((a) => !a.startsWith('--'));
  if (!input) {
    console.error('usage: tsx src/cli.ts <workbook.xlsx> [--out DIR] [--as-of YYYY-MM-DD] [--min-shelf-life DAYS] [--no-split] [--no-replenish]');
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

  const { stock, demand, stagedBySku, warnings } = await loadWorkbook(input, config);

  const pickfaces = derivePickfaces(stock, config);

  // 1. outbound picking
  const result = allocate(stock, demand, config, stagedBySku);
  result.warnings.unshift(...warnings);
  relocateByWaveOrder(result.lines, pickfaces, config);
  result.picklists = buildPicklists(result, demand, config);

  // 2. pickface replenishment, against what's left after today's picks
  const pickedByBin = new Map<string, number>();
  for (const l of result.lines) pickedByBin.set(l.binId, (pickedByBin.get(l.binId) ?? 0) + l.qtyPick);
  const stockAfterPicks = applyMovements(stock, pickedByBin);

  const replenishment = argv.includes('--no-replenish')
    ? undefined
    : replenish(stockAfterPicks, pickfaces, config, demand, result.lines);
  if (replenishment) replenishment.tasks = sequenceReplenishment(replenishment.tasks);

  // 3. movement report
  const movement = replenishment ? buildMovementReport(result, replenishment) : undefined;

  const xlsxPath = `${outDir}/picklist_${stamp}.xlsx`;
  const htmlPath = `${outDir}/picklist_${stamp}.html`;
  await writePicklistWorkbook(result, xlsxPath, replenishment, movement, pickfaces);
  writeFileSync(htmlPath, renderPicklistHtml(result, replenishment, config, pickfaces), 'utf8');

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
  if (replenishment) {
    const r = replenishment.stats;
    console.log(`\nPickface replenishment`);
    console.log(`  pickfaces evaluated   : ${r.pickfacesEvaluated}`);
    console.log(`  pickfaces replenished : ${r.pickfacesReplenished}`);
    console.log(`  cartons moved         : ${r.cartonsMoved}  (${r.palletMoves} pallet, ${r.caseMoves} case)`);
    console.log(`  sealed pallets opened : ${r.palletsBroken}`);
    console.log(`  replenishment tasks   : ${replenishment.tasks.length}`);
    console.log(`  shortages             : ${replenishment.shortages.length}`);
  }
  const errs = result.warnings.filter((w) => w.level === 'ERROR').length;
  const warns = result.warnings.filter((w) => w.level === 'WARN').length;
  console.log(`\n  exceptions            : ${errs} error, ${warns} warning`);
  console.log(`\n  → ${xlsxPath}\n  → ${htmlPath}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
