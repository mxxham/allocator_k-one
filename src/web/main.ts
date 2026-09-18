import { zipSync } from 'fflate';
import * as XLSX from 'xlsx';
import jsPDF from 'jspdf';
import { allocate } from '../allocator.js';
import { applyMovements } from '../binselect.js';
import { withConfig, type AllocatorConfig } from '../config.js';
import { renderPicklistHtml } from '../adapters/html-output.js';
import { renderPicklistPdfPage, renderReplenPdfPage, stampPageNumbers, type PdfPageRange } from '../adapters/pdf-output.js';
import { buildMovementReport } from '../movement.js';
import { derivePickfaces } from '../pickface.js';
import { buildPicklists, formatQty, uomLabel } from '../picklist.js';
import { replenish, sequenceReplenishment } from '../replenishment.js';
import type {
  AllocationResult,
  MovementRow,
  PickfaceAssignment,
  ReplenishmentResult,
  StockBin,
} from '../types.js';
import { loadWorkbookFromBuffer, type LoadedData } from './browser-input.js';
import { buildWorkbook, downloadWorkbook } from './browser-output.js';

// ---- state ------------------------------------------------------------------

let loaded: LoadedData | null = null;
let stock: StockBin[] = [];
let pickfaces: Map<string, PickfaceAssignment> = new Map();
let allocation: AllocationResult | null = null;
let replenishment: ReplenishmentResult | null = null;
let movement: MovementRow[] = [];
let config: AllocatorConfig | null = null;
let fileName = '';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

const el = {
  dropzone: $('#dropzone'),
  fileInput: $<HTMLInputElement>('#fileInput'),
  fileLabel: $('#fileLabel'),
  uomZone: $('#uomZone'),
  uomFileInput: $<HTMLInputElement>('#uomFileInput'),
  uomFileLabel: $('#uomFileLabel'),
  asOf: $<HTMLInputElement>('#asOf'),
  minShelfLife: $<HTMLInputElement>('#minShelfLife'),
  targetQty: $<HTMLSelectElement>('#targetQty'),
  splitTasks: $<HTMLInputElement>('#splitTasks'),
  coverPending: $<HTMLInputElement>('#coverPending'),
  runBtn: $<HTMLButtonElement>('#runBtn'),
  status: $('#status'),
  results: $('#results'),
  tabs: $('#tabs'),
  panels: $('#panels'),
  kpis: $('#kpis'),
  downloadXlsx: $<HTMLButtonElement>('#downloadXlsx'),
  downloadHtml: $<HTMLButtonElement>('#downloadHtml'),
  downloadCsv: $<HTMLButtonElement>('#downloadCsv'),
  downloadAll: $<HTMLButtonElement>('#downloadAll'),
  pickfaceTable: $('#pickfaceTable'),
  pickfaceSearch: $<HTMLInputElement>('#pickfaceSearch'),
};

el.asOf.valueAsDate = new Date();

// ---- file intake --------------------------------------------------------

['dragenter', 'dragover'].forEach((evt) =>
  el.dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    el.dropzone.classList.add('drag');
  }),
);
['dragleave', 'drop'].forEach((evt) =>
  el.dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    el.dropzone.classList.remove('drag');
  }),
);
el.dropzone.addEventListener('drop', (e) => {
  const f = e.dataTransfer?.files?.[0];
  if (f) handleFile(f);
});
el.dropzone.addEventListener('click', () => el.fileInput.click());
el.fileInput.addEventListener('change', () => {
  const f = el.fileInput.files?.[0];
  if (f) handleFile(f);
});

async function handleFile(f: File): Promise<void> {
  fileName = f.name;
  el.fileLabel.textContent = f.name;
  setStatus(`Reading ${f.name}…`, 'busy');
  try {
    const buf = await f.arrayBuffer();
    (window as unknown as { __buf: ArrayBuffer }).__buf = buf;
    el.runBtn.disabled = false;
    setStatus(`Loaded ${f.name} — set the options and run.`, 'ok');
  } catch (err) {
    setStatus(`Could not read ${f.name}: ${(err as Error).message}`, 'error');
  }
}

// ---- optional UOM master (corrects a wrong per-bin Carton/Drum/Pail label) --

el.uomZone.addEventListener('click', () => el.uomFileInput.click());
el.uomFileInput.addEventListener('change', () => {
  const f = el.uomFileInput.files?.[0];
  if (f) handleUomFile(f);
});

async function handleUomFile(f: File): Promise<void> {
  el.uomFileLabel.textContent = `Reading ${f.name}…`;
  try {
    const buf = await f.arrayBuffer();
    (window as unknown as { __uomBuf: ArrayBuffer }).__uomBuf = buf;
    el.uomZone.classList.add('loaded');
    el.uomFileLabel.textContent = `✓ ${f.name} — will correct any wrong UOM labels`;
  } catch (err) {
    el.uomZone.classList.remove('loaded');
    el.uomFileLabel.textContent = `Could not read ${f.name}: ${(err as Error).message}`;
  }
}

function setStatus(msg: string, kind: 'idle' | 'busy' | 'ok' | 'error'): void {
  el.status.textContent = msg;
  el.status.dataset.kind = kind;
}

// ---- run ------------------------------------------------------------------

el.runBtn.addEventListener('click', () => {
  const buf = (window as unknown as { __buf?: ArrayBuffer }).__buf;
  if (!buf) return;
  const uomBuf = (window as unknown as { __uomBuf?: ArrayBuffer }).__uomBuf;
  setStatus('Running FEFO allocation…', 'busy');
  el.runBtn.disabled = true;
  requestAnimationFrame(() => {
    try {
      run(buf, uomBuf);
      setStatus(`Done — as of ${el.asOf.value}.`, 'ok');
    } catch (err) {
      console.error(err);
      setStatus(`Failed: ${(err as Error).message}`, 'error');
    } finally {
      el.runBtn.disabled = false;
    }
  });
});

function buildConfig(): AllocatorConfig {
  return withConfig({
    asOf: el.asOf.valueAsDate ?? new Date(),
    minRemainingShelfLifeDays: Number(el.minShelfLife.value) || 0,
    splitPalletAndCaseTasks: el.splitTasks.checked,
    replenishCoverPendingDemand: el.coverPending.checked,
    pickfaceTargetQty: el.targetQty.value === 'upp' ? 'upp' : Number(el.targetQty.value),
  });
}

function run(buf: ArrayBuffer, uomBuf?: ArrayBuffer): void {
  config = buildConfig();
  loaded = loadWorkbookFromBuffer(buf, config, uomBuf);
  stock = loaded.stock;

  allocation = allocate(loaded.stock, loaded.demand, config, loaded.stagedBySku);
  allocation.warnings.unshift(...loaded.warnings);
  allocation.picklists = buildPicklists(allocation, loaded.demand, config);

  const pickedByBin = new Map<string, number>();
  for (const l of allocation.lines) pickedByBin.set(l.binId, (pickedByBin.get(l.binId) ?? 0) + l.qtyPick);
  const stockAfterPicks = applyMovements(loaded.stock, pickedByBin);

  pickfaces = derivePickfaces(loaded.stock, config);
  replenishment = replenish(stockAfterPicks, pickfaces, config, loaded.demand, allocation.lines);
  replenishment.tasks = sequenceReplenishment(replenishment.tasks);

  movement = buildMovementReport(allocation, replenishment);

  renderResults();
}

// ---- rendering --------------------------------------------------------------

function renderResults(): void {
  if (!allocation || !replenishment) return;
  el.results.hidden = false;
  el.downloadXlsx.disabled = false;
  el.downloadHtml.disabled = false;
  el.downloadCsv.disabled = false;
  el.downloadAll.disabled = false;

  const s = allocation.stats;
  const r = replenishment.stats;
  el.kpis.innerHTML = [
    kpi('Fill rate', `${s.fillRatePct.toFixed(1)}%`, `${s.cartonsAllocated} / ${s.cartonsRequested} ctn`),
    kpi('Picklists', String(allocation.picklists.length), `${s.palletPicks} pallet · ${s.casePicks} case`),
    kpi('Shortages', String(allocation.shortages.length), 'outbound lines short'),
    kpi('Replenishment', String(replenishment.tasks.length), `${r.cartonsMoved} ctn moved`),
    kpi('Pallets opened', String(s.palletsBroken + r.palletsBroken), 'picking + replen'),
  ].join('');

  renderPicklistTab();
  renderShortageTab();
  renderReplenishmentTab();
  renderMovementTab();
  renderExceptionsTab();
  renderPickfaceTable();

  const firstTab = el.tabs.querySelector('button');
  if (firstTab) (firstTab as HTMLButtonElement).click();
}

function kpi(label: string, value: string, sub: string): string {
  return `<div class="kpi"><span class="kpi-label">${label}</span><span class="kpi-value">${value}</span><span class="kpi-sub">${sub}</span></div>`;
}

function panel(id: string): HTMLElement {
  let p = document.getElementById(id);
  if (!p) {
    p = document.createElement('div');
    p.id = id;
    p.className = 'panel';
    el.panels.appendChild(p);
  }
  return p;
}

function table(headers: string[], rows: (string | number)[][], emptyMsg = 'Nothing here.'): string {
  if (!rows.length) return `<p class="empty">${emptyMsg}</p>`;
  return `<div class="table-wrap"><table><thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function renderPicklistTab(): void {
  const p = panel('panel-picklist');
  const groups = allocation!.picklists
    .map(
      (pl) => `<details class="pl-card" open>
      <summary><span class="pl-id">${pl.picklistId}</span>
        <span class="pl-meta">NO ${pl.waveNo} · ${pl.shipmentNumbers.join(', ')} · ${escapeHtml(pl.destination)} · DO Number: ${pl.orderNos.join(', ')} · ${pl.totalCartons} ctn</span></summary>
      ${table(
        ['#', 'Lokasi', 'Material', 'Description', 'Ke Lokasi', 'Batch', 'Exp', 'Qty', 'UOM', 'Sisa'],
        pl.lines.map((l) => {
          const keLokasi = l.breaksPallet ? (pickfaces.get(l.sku)?.location ?? '') : '';
          return [
            l.seq,
            l.location,
            l.sku,
            escapeHtml(l.description),
            keLokasi ? `<span style="color:#1f3864;font-weight:700">${keLokasi}</span>` : '',
            l.batch ?? '-',
            dateStr(l.expiryDate),
            l.qtyPick,
            uomLabel(l.uom),
            l.qtyRemainingInBin,
          ];
        }),
      )}
    </details>`,
    )
    .join('');

  let replenSection = '';
  if (replenishment && replenishment.tasks.length > 0) {
    const sorted = [...replenishment.tasks].sort((a, b) => a.seq - b.seq);
    replenSection = `<details class="pl-card" open>
      <summary><span class="pl-id">REPLENISHMENT</span>
        <span class="pl-meta">Bin to Bin · ${replenishment.stats.cartonsMoved} ctn · ${replenishment.tasks.length} moves</span></summary>
      ${table(
        ['#', 'Dari Lokasi', 'Material', 'Description', 'Ke Lokasi', 'Batch', 'Exp', 'Qty', 'UOM', 'Sisa'],
        sorted.map((t) => [
          t.seq,
          `<span style="background:#e8f0fe;padding:1px 4px">${t.fromLocation}</span>`,
          t.sku,
          escapeHtml(t.description),
          `<span style="background:#e8f0fe;padding:1px 4px;font-weight:700;color:#1f3864">${t.toLocation}</span>`,
          t.batch ?? '-',
          dateStr(t.expiryDate),
          t.qtyMove,
          uomLabel(t.uom),
          t.qtyRemainingAtSource,
        ]),
      )}
    </details>`;
  }

  p.innerHTML = (groups || '<p class="empty">No picklists generated.</p>') + replenSection;
}

function renderShortageTab(): void {
  const p = panel('panel-shortage');
  p.innerHTML = table(
    ['Shipment', 'Material', 'Description', 'Requested', 'Allocated', 'Short', 'Reason'],
    allocation!.shortages.map((s) => [
      s.shipmentNumber,
      s.sku,
      escapeHtml(s.description),
      s.qtyRequested,
      s.qtyAllocated,
      s.qtyShort,
      reasonLabel(s.reason),
    ]),
    'No shortage — every outbound line fully allocated.',
  );
}

function reasonLabel(r: string): string {
  return { ALREADY_STAGED: 'Already in staging', BLOCKED_SHELF_LIFE: 'Blocked by shelf life', NO_STOCK: 'No stock' }[r] ?? r;
}

function renderReplenishmentTab(): void {
  const p = panel('panel-replenishment');
  const tasks = table(
    ['#', 'Material', 'Description', 'From', 'To pickface', 'Batch', 'Exp', 'Qty', 'UOM', 'Reason'],
    replenishment!.tasks.map((t) => [
      t.seq,
      t.sku,
      escapeHtml(t.description),
      t.fromLocation,
      t.toLocation,
      t.batch ?? '-',
      dateStr(t.expiryDate),
      t.qtyMove,
      uomLabel(t.uom),
      t.reason === 'PENDING_DEMAND' ? 'Covers order' : t.reason === 'BROKEN_PALLET' ? 'Buka palet' : 'Below target',
    ]),
    'No pickface is below its target level.',
  );
  const shortages = replenishment!.shortages.length
    ? `<h3>Replenishment shortages</h3>${table(
        ['Material', 'Description', 'Pickface', 'Needed', 'Moved', 'Short'],
        replenishment!.shortages.map((s) => [s.sku, escapeHtml(s.description), s.toLocation, s.qtyNeeded, s.qtyMoved, s.qtyShort]),
      )}`
    : '';
  p.innerHTML = tasks + shortages;
}

function renderMovementTab(): void {
  const p = panel('panel-movement');
  p.innerHTML = table(
    ['#', 'Type', 'Material', 'Description', 'Batch', 'Exp', 'Qty', 'UOM', 'From', 'To', 'Shipment', 'Sisa Qty'],
    movement.map((m) => [
      m.seq,
      `<span class="tag tag-${m.type.toLowerCase()}">${m.type}</span>`,
      m.sku,
      escapeHtml(m.description),
      m.batch ?? '-',
      dateStr(m.expiryDate),
      m.qty,
      uomLabel(m.uom),
      m.fromLocation,
      m.toLocation,
      m.shipmentNumber ?? '-',
      m.qtyRemainingAtFrom,
    ]),
  );
}

function renderExceptionsTab(): void {
  const p = panel('panel-exceptions');
  p.innerHTML = table(
    ['Level', 'Code', 'Message'],
    allocation!.warnings.map((w) => [`<span class="tag tag-${w.level.toLowerCase()}">${w.level}</span>`, w.code, escapeHtml(w.message)]),
    'No exceptions.',
  );
}

function renderPickfaceTable(filter = ''): void {
  const rows = [...pickfaces.values()]
    .filter((p) => !filter || p.sku.includes(filter) || p.description.toLowerCase().includes(filter.toLowerCase()))
    .sort((a, b) => a.sku.localeCompare(b.sku));
  el.pickfaceTable.innerHTML = table(
    ['Material', 'Description', 'Pickface bin', 'Target qty', 'Source'],
    rows.map((p) => [p.sku, escapeHtml(p.description), p.location, p.targetQtyCartons, p.isAuto ? 'Auto (nearest bin)' : 'Assigned']),
    'Run an allocation to see derived pickfaces.',
  );
}

el.pickfaceSearch.addEventListener('input', () => renderPickfaceTable(el.pickfaceSearch.value.trim()));

// ---- tabs -------------------------------------------------------------------

el.tabs.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('button[data-panel]') as HTMLButtonElement | null;
  if (!btn) return;
  el.tabs.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  el.panels.querySelectorAll('.panel').forEach((p) => p.classList.remove('visible'));
  panel(btn.dataset.panel!).classList.add('visible');
});

function renderCombinedPdf(
  alloc: AllocationResult,
  repl: ReplenishmentResult | null,
  pf: Map<string, PickfaceAssignment>,
  cfg: AllocatorConfig | null,
): { doc: jsPDF; pageRanges: PdfPageRange[] } {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const pageRanges: PdfPageRange[] = [];
  for (let i = 0; i < alloc.picklists.length; i++) {
    if (i > 0) doc.addPage();
    const startPage = doc.getNumberOfPages();
    renderPicklistPdfPage(doc, alloc.picklists[i], pf);
    const endPage = doc.getNumberOfPages();
    pageRanges.push({ startPage, endPage });
  }
  if (repl && repl.tasks.length > 0) {
    doc.addPage();
    renderReplenPdfPage(doc, repl, cfg ?? withConfig());
  }
  stampPageNumbers(doc, pageRanges);
  return { doc, pageRanges };
}

// ---- downloads ----------------------------------------------------------

el.downloadXlsx.addEventListener('click', () => {
  if (!allocation) return;
  const wb = buildWorkbook(allocation, replenishment ?? undefined, movement, pickfaces, config ?? undefined);
  downloadWorkbook(wb, outName('xlsx'));
});

el.downloadHtml.addEventListener('click', () => {
  if (!allocation) return;
  const { doc } = renderCombinedPdf(allocation, replenishment, pickfaces, config);
  const blob = doc.output('blob');
  triggerDownload(blob, outName('pdf'));
});

el.downloadCsv.addEventListener('click', () => {
  if (!allocation) return;
  triggerDownload(movementCsvBlob(), outName('movement.csv'));
});

el.downloadAll.addEventListener('click', () => {
  if (!allocation || !replenishment) return;
  const stamp = el.asOf.value || dateStr(new Date());
  const wb = buildWorkbook(allocation, replenishment, movement, pickfaces, config ?? undefined);
  const xlsxBytes = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  const csv = movementCsvText();

  const { doc } = renderCombinedPdf(allocation, replenishment, pickfaces, config);
  const pdfBytes = new Uint8Array(doc.output('arraybuffer'));

  const files: Record<string, Uint8Array> = {
    [`picklist_${stamp}.xlsx`]: new Uint8Array(xlsxBytes),
    [`picklist_${stamp}.pdf`]: pdfBytes,
    [`movement_${stamp}.csv`]: new TextEncoder().encode(csv),
  };

  const zipped = zipSync(files, { level: 6 });
  triggerDownload(new Blob([zipped], { type: 'application/zip' }), `fefo_reports_${stamp}.zip`);
});

function movementCsvText(): string {
  const header = ['Seq', 'Type', 'Material', 'Description', 'Batch', 'Exp Date', 'Qty', 'From', 'To', 'Shipment'];
  const lines = [header.join(',')];
  for (const m of movement) {
    lines.push(
      [m.seq, m.type, m.sku, csvSafe(m.description), m.batch ?? '', dateStr(m.expiryDate), m.qty, m.fromLocation, m.toLocation, m.shipmentNumber ?? ''].join(','),
    );
  }
  return lines.join('\n');
}

function movementCsvBlob(): Blob {
  return new Blob([movementCsvText()], { type: 'text/csv' });
}

function outName(ext: string): string {
  const stamp = el.asOf.value || dateStr(new Date());
  const base = ext.includes('.') ? ext : `picklist_${stamp}.${ext}`;
  return ext.includes('.') ? `${stamp}_${ext}` : base;
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function csvSafe(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function dateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string);
}
