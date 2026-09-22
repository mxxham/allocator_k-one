import { zipSync } from 'fflate';
import * as XLSX from 'xlsx';
import jsPDF from 'jspdf';
import { allocate, relocateByWaveOrder } from '../allocator.js';
import { computeStockAfterMovements } from '../ledger.js';
import { withConfig, type AllocatorConfig } from '../config.js';
import { renderBlankPicklistHtml, renderPicklistHtml } from '../adapters/html-output.js';
import { renderPicklistPdfPage, stampPageNumbers, type PdfPageRange } from '../adapters/pdf-output.js';
import { buildMovementReport } from '../movement.js';
import { derivePickfaces } from '../pickface.js';
import { parseLocation } from '../pickpath.js';
import { buildPicklists, formatQty, uomLabel } from '../picklist.js';
import { detectDoubles, type DoubleEntry } from '../double.js';
import type {
  AllocationResult,
  MovementRow,
  PickfaceAssignment,
  StockBin,
} from '../types.js';
import { loadWorkbookFromBuffer, type LoadedData } from './browser-input.js';
import { buildWorkbook, downloadWorkbook } from './browser-output.js';

// ---- state ------------------------------------------------------------------

let loaded: LoadedData | null = null;
let stock: StockBin[] = [];
let pickfaces: Map<string, PickfaceAssignment> = new Map();
let allocation: AllocationResult | null = null;
let movement: MovementRow[] = [];
let doubles: { pickDoubles: DoubleEntry[]; total: number } | null = null;
let config: AllocatorConfig | null = null;
let fileName = '';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

const el = {
  dropzone: $('#dropzone'),
  fileInput: $<HTMLInputElement>('#fileInput'),
  fileLabel: $('#fileLabel'),
  asOf: $<HTMLInputElement>('#asOf'),
  minShelfLife: $<HTMLInputElement>('#minShelfLife'),
  targetQty: $<HTMLSelectElement>('#targetQty'),
  splitTasks: $<HTMLInputElement>('#splitTasks'),
  runBtn: $<HTMLButtonElement>('#runBtn'),
  status: $('#status'),
  results: $('#results'),
  tabs: $('#tabs'),
  panels: $('#panels'),
  kpis: $('#kpis'),
  downloadXlsx: $<HTMLButtonElement>('#downloadXlsx'),
  downloadPdf: $<HTMLButtonElement>('#downloadPdf'),
  downloadCsv: $<HTMLButtonElement>('#downloadCsv'),
  downloadAll: $<HTMLButtonElement>('#downloadAll'),
  printBlankBtn: $<HTMLButtonElement>('#printBlankBtn'),
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

function setStatus(msg: string, kind: 'idle' | 'busy' | 'ok' | 'error'): void {
  el.status.textContent = msg;
  el.status.dataset.kind = kind;
}

// ---- run ------------------------------------------------------------------

el.runBtn.addEventListener('click', () => {
  const buf = (window as unknown as { __buf?: ArrayBuffer }).__buf;
  if (!buf) return;
  setStatus('Running FEFO allocation…', 'busy');
  el.runBtn.disabled = true;
  requestAnimationFrame(() => {
    try {
      run(buf);
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
    pickfaceTargetQty: el.targetQty.value === 'upp' ? 'upp' : Number(el.targetQty.value),
  });
}

function run(buf: ArrayBuffer): void {
  config = buildConfig();
  loaded = loadWorkbookFromBuffer(buf, config);
  stock = loaded.stock;

  pickfaces = derivePickfaces(loaded.stock, config);

  allocation = allocate(loaded.stock, loaded.demand, config, loaded.stagedBySku);
  allocation.warnings.unshift(...loaded.warnings);
  relocateByWaveOrder(allocation.lines, pickfaces, config, loaded.stock);
  allocation.picklists = buildPicklists(allocation, loaded.demand, config);

  // Use computeStockAfterMovements to account for picks AND relocations
  const stockAfterMovements = computeStockAfterMovements(loaded.stock, allocation.lines, pickfaces);

  movement = buildMovementReport(allocation);
  doubles = detectDoubles(allocation);

  renderResults();
}

// ---- rendering --------------------------------------------------------------

function renderResults(): void {
  if (!allocation) return;
  el.results.hidden = false;
  el.downloadXlsx.disabled = false;
  el.downloadPdf.disabled = false;
  el.downloadCsv.disabled = false;
  el.downloadAll.disabled = false;

  const s = allocation.stats;
  el.kpis.innerHTML = [
    kpi('Fill rate', `${s.fillRatePct.toFixed(1)}%`, `${s.cartonsAllocated} / ${s.cartonsRequested} ctn`),
    kpi('Picklists', String(allocation.picklists.length), `${s.palletPicks} pallet · ${s.casePicks} case`),
    kpi('Shortages', String(allocation.shortages.length), 'outbound lines short'),
    kpi('Pallets opened', String(s.palletsBroken), 'sealed pallets broken'),
  ].join('');

  renderPicklistTab();
  renderShortageTab();
  renderMovementTab();
  renderExceptionsTab();
  renderDoubleTab();
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
          const pfLoc = pickfaces.get(l.sku)?.location ?? '';
          const srcLevel = parseLocation(l.location)?.level ?? '';
          const keLokasi = srcLevel !== 'A' && l.qtyRemainingInBin > 0 && pfLoc && l.location !== pfLoc ? pfLoc : '';
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

  p.innerHTML = groups || '<p class="empty">No picklists generated.</p>';
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

function renderDoubleTab(): void {
  const p = panel('panel-double');
  if (!doubles || doubles.total === 0) {
    p.innerHTML = '<p class="empty">No double movements detected — each bin touched only once.</p>';
    return;
  }

  const sections: string[] = [];

  if (doubles.pickDoubles.length > 0) {
    const rows = doubles.pickDoubles.map((d) => {
      const movements = d.movements.map((m) =>
        `<span class="tag tag-pick">PICK</span> #${m.seq} ${m.qty} ctn → ${m.toLocation}`
      ).join(' ');
      return [
        `<span style="color:#1f3864;font-weight:700">${d.location}</span>`,
        d.sku,
        escapeHtml(d.description),
        d.batch ?? '-',
        dateStr(d.expiryDate),
        `<span style="color:var(--bad);font-weight:700">${d.totalQty}</span>`,
        `<span style="font-size:.76rem;color:var(--ink-dim)">${movements}</span>`,
      ];
    });
    sections.push(`<h3 style="margin-bottom:.5rem">Double Picks <span class="tag tag-error">${doubles.pickDoubles.length}</span></h3>`);
    sections.push(table(
      ['Location', 'Material', 'Description', 'Batch', 'Exp', 'Total Qty', 'Details'],
      rows,
      'No double picks.',
    ));
  }

  p.innerHTML = sections.join('');
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
  stampPageNumbers(doc, pageRanges);
  return { doc, pageRanges };
}

// ---- downloads ----------------------------------------------------------

el.downloadXlsx.addEventListener('click', () => {
  if (!allocation) return;
  const wb = buildWorkbook(allocation, movement, pickfaces);
  downloadWorkbook(wb, outName('xlsx'));
});

el.downloadPdf.addEventListener('click', () => {
  if (!allocation) return;
  const { doc } = renderCombinedPdf(allocation, pickfaces, config);
  const blob = doc.output('blob');
  triggerDownload(blob, outName('pdf'));
});

el.downloadCsv.addEventListener('click', () => {
  if (!allocation) return;
  triggerDownload(movementCsvBlob(), outName('movement.csv'));
});

el.downloadAll.addEventListener('click', () => {
  if (!allocation) return;
  const stamp = el.asOf.value || dateStr(new Date());
  const wb = buildWorkbook(allocation, movement, pickfaces);
  const xlsxBytes = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  const csv = movementCsvText();

  const { doc } = renderCombinedPdf(allocation, pickfaces, config);
  const pdfBytes = new Uint8Array(doc.output('arraybuffer'));

  const files: Record<string, Uint8Array> = {
    [`picklist_${stamp}.xlsx`]: new Uint8Array(xlsxBytes),
    [`picklist_${stamp}.pdf`]: pdfBytes,
    [`movement_${stamp}.csv`]: new TextEncoder().encode(csv),
  };

  const zipped = zipSync(files, { level: 6 });
  triggerDownload(new Blob([zipped], { type: 'application/zip' }), `fefo_reports_${stamp}.zip`);
});

el.printBlankBtn.addEventListener('click', () => {
  const html = renderBlankPicklistHtml();
  const w = window.open('', '_blank');
  if (!w) return;
  w.document.open();
  w.document.write(html);
  w.document.close();
  setTimeout(() => w.print(), 400);
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
