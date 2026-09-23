/**
 * Ops area — the database-backed daily workflow, mounted next to the existing
 * allocator UI (which is untouched and still runs 100% in-browser).
 *
 * Hidden with a "database not configured" notice when the build did not
 * inject VITE_SUPABASE_URL / publishable key. The service-role key is never
 * part of this bundle (see scripts/build-web.mjs).
 */

import * as XLSX from 'xlsx';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { getBrowserClient, type DbClient } from '../lib/supabase.js';
import { createRepositories, type Repositories } from '../repository/index.js';
import { ExecutionService } from '../services/execution.js';
import { DailyService } from '../services/daily.js';
import { ReconciliationService } from '../services/reconciliation.js';
import { adjustStock } from '../services/adjustment.js';
import { validateImport, executeImport, formatPreview, type ImportPreview } from '../adapters/import-preview.js';
import { renderPicklistPdfPage, stampPageNumbers, type PdfPageRange } from '../adapters/pdf-output.js';
import { buildPicklistsFromDB } from '../services/daily-workflow.js';
import { buildStockWorkbook } from '../services/stock-sheet.js';
import { loadWorkbookFromBuffer } from './browser-input.js';
import { withConfig } from '../config.js';
import { derivePickfaces } from '../pickface.js';
import { loadStockFromDatabase } from '../adapters/database-stock.js';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

const client: DbClient | null = getBrowserClient();
let repos: Repositories | null = null;
let exec: ExecutionService | null = null;
let daily: DailyService | null = null;
let recon: ReconciliationService | null = null;
if (client) {
  repos = createRepositories(client);
  exec = new ExecutionService(client);
  daily = new DailyService(client);
  recon = new ReconciliationService(client);
}

let importPreview: ImportPreview | null = null;

// ---- shared helpers ---------------------------------------------------------

function actor(): string {
  return ($<HTMLInputElement>('#opsActor').value || 'ops-ui').trim();
}

function setOps(msg: string, kind: 'idle' | 'busy' | 'ok' | 'error' = 'idle'): void {
  const el = $('#opsStatus');
  el.textContent = msg;
  el.dataset.kind = kind;
}

function errText(err: unknown): string {
  const e = err as { code?: string; message?: string };
  return e?.code ? `[${e.code}] ${e.message}` : String((err as Error)?.message ?? err);
}

async function run<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  setOps(`${label}…`, 'busy');
  try {
    const out = await fn();
    setOps(`${label} — done.`, 'ok');
    return out;
  } catch (err) {
    console.error(err);
    setOps(`${label} failed: ${errText(err)}`, 'error');
    return null;
  }
}

function escapeHtml(s: string): string {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
}

function dateStr(d: Date | null | undefined): string {
  return d ? d.toISOString().slice(0, 10) : '-';
}

function table(headers: string[], rows: (string | number)[][], emptyMsg = 'Nothing here.'): string {
  if (!rows.length) return `<p class="empty">${emptyMsg}</p>`;
  return `<div class="table-wrap"><table><thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function statusTag(s: string): string {
  const cls = s === 'COMPLETED' ? 'tag-pick' : s === 'CANCELLED' || s === 'FAILED' ? 'tag-error' : s === 'RESCHEDULED' ? 'tag-warn' : 'tag-info';
  return `<span class="tag ${cls}">${s}</span>`;
}

function btn(action: string, id: string, label: string, cls = 'btn sm'): string {
  return `<button class="${cls}" data-action="${action}" data-id="${escapeHtml(id)}">${label}</button>`;
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---- mode switch (Allocator | Ops) ------------------------------------------

const modeAllocator = $<HTMLButtonElement>('#modeAllocator');
const modeOps = $<HTMLButtonElement>('#modeOps');
const opsSection = $<HTMLElement>('#ops');
const setupSection = $<HTMLElement>('.setup');
const resultsSection = $<HTMLElement>('#results');

function showOps(on: boolean): void {
  modeAllocator.classList.toggle('active', !on);
  modeOps.classList.toggle('active', on);
  setupSection.style.display = on ? 'none' : '';
  resultsSection.style.display = on ? 'none' : '';
  opsSection.hidden = !on;
  if (on) {
    $('#opsNotConfigured').toggleAttribute('hidden', client !== null);
    $('#opsBody').toggleAttribute('hidden', client === null);
  }
}

modeAllocator.addEventListener('click', () => showOps(false));
modeOps.addEventListener('click', () => showOps(true));

// ---- ops tabs ----------------------------------------------------------------

$('#opsTabs').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button[data-opspanel]') as HTMLButtonElement | null;
  if (!b) return;
  document.querySelectorAll('#opsTabs button').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  document.querySelectorAll('#opsPanels .panel').forEach((p) => p.classList.remove('visible'));
  document.getElementById(b.dataset.opspanel!)!.classList.add('visible');
});

// ---- inventory ---------------------------------------------------------------

async function loadStock(filter: { sku?: string; location?: string }): Promise<void> {
  if (!repos) return;
  const rows = await run('Loading stock', async () => {
    const recs = filter.sku || filter.location ? await repos!.stock.find(filter) : await repos!.stock.listAll();
    return recs.filter((r) => r.quantity > 0);
  });
  if (!rows) return;
  $('#invTable').innerHTML = table(
    ['Location', 'SKU', 'Description', 'Batch', 'Expiry', 'Qty', 'UPP', 'Identity', ''],
    rows.map((r) => [
      r.location,
      r.sku,
      escapeHtml(r.description),
      r.batch ?? '-',
      dateStr(r.expiryDate),
      r.quantity,
      r.upp,
      `<span style="font-size:.7rem;color:var(--ink-faint)">${escapeHtml(r.identityKey)}</span>`,
      btn('history', escapeHtml(r.identityKey), 'History'),
    ]),
    'No stock matches.',
  );
}

$('#invSearch').addEventListener('click', () => {
  void loadStock({
    sku: $<HTMLInputElement>('#invSku').value.trim() || undefined,
    location: $<HTMLInputElement>('#invLocation').value.trim().toUpperCase() || undefined,
  });
});
$('#invAll').addEventListener('click', () => void loadStock({}));

$('#invTable').addEventListener('click', async (e) => {
  const b = (e.target as HTMLElement).closest('button[data-action="history"]') as HTMLButtonElement | null;
  if (!b || !repos) return;
  const identity = b.dataset.id!;
  const txs = await run(`Loading history ${identity}`, () => repos!.stock.history(identity));
  if (!txs) return;
  $('#invHistory').innerHTML =
    `<h3 style="font-size:.8rem;color:var(--ink-dim)">History — ${escapeHtml(identity)}</h3>` +
    table(
      ['Date', 'Type', 'Δ Qty', 'Reference', 'Movement', 'Notes', 'By'],
      txs.map((t) => [
        dateStr(t.transactionDate),
        t.transactionType,
        t.quantityDelta > 0 ? `+${t.quantityDelta}` : t.quantityDelta,
        t.referenceType ? `${t.referenceType}${t.referenceId ? ` ${escapeHtml(t.referenceId.slice(0, 8))}` : ''}` : '-',
        t.movementId ? escapeHtml(t.movementId.slice(0, 8)) : '-',
        escapeHtml(t.notes ?? '-'),
        escapeHtml(t.createdBy),
      ]),
      'No transactions for this identity.',
    );
});

$('#adjSubmit').addEventListener('click', async () => {
  if (!client) return;
  const location = $<HTMLInputElement>('#adjLocation').value.trim().toUpperCase();
  const sku = $<HTMLInputElement>('#adjSku').value.trim();
  const batch = $<HTMLInputElement>('#adjBatch').value.trim() || null;
  const expiry = $<HTMLInputElement>('#adjExpiry').value;
  const delta = Number($<HTMLInputElement>('#adjDelta').value);
  const reason = $<HTMLInputElement>('#adjReason').value.trim();
  if (!location || !sku || !expiry) {
    setOps('Adjustment needs location, SKU and expiry date.', 'error');
    return;
  }
  const res = await run('Adjusting stock', () =>
    adjustStock(client!, { location, sku, batch, expiry, delta, reason, actor: actor() }),
  );
  if (res) {
    setOps(`Adjustment posted — new quantity ${String(res.new_quantity ?? '?')}.`, 'ok');
    $<HTMLInputElement>('#adjReason').value = '';
    $<HTMLInputElement>('#adjDelta').value = '0';
    void loadStock({ sku, location });
  }
});

// ---- inbound -----------------------------------------------------------------

async function loadInbound(): Promise<void> {
  if (!repos) return;
  const date = $<HTMLInputElement>('#inbDate').value || undefined;
  const status = ($<HTMLSelectElement>('#inbStatus').value || undefined) as 'PENDING' | 'COMPLETED' | 'CANCELLED' | undefined;
  const rows = await run('Loading inbound', () => repos!.inbound.list({ date, status }));
  if (!rows) return;
  $('#inbTable').innerHTML = table(
    ['Date', 'Reference', 'SKU', 'Location', 'Batch', 'Expiry', 'Qty', 'Status', 'Actions'],
    rows.map((r) => [
      dateStr(r.inboundDate),
      escapeHtml(r.referenceNo),
      r.sku,
      r.location,
      r.batch ?? '-',
      dateStr(r.expiryDate),
      r.quantity,
      statusTag(r.status),
      r.status === 'PENDING'
        ? btn('inb-complete', r.id, 'Complete') + ' ' + btn('inb-cancel', r.id, 'Cancel', 'btn sm danger')
        : escapeHtml(r.completedBy ?? ''),
    ]),
    'No inbound rows.',
  );
}

$('#inbRefresh').addEventListener('click', () => void loadInbound());

$('#inbRecord').addEventListener('click', async () => {
  if (!daily) return;
  const referenceNo = $<HTMLInputElement>('#inbNewRef').value.trim();
  const sku = $<HTMLInputElement>('#inbNewSku').value.trim();
  const location = $<HTMLInputElement>('#inbNewLocation').value.trim().toUpperCase();
  const expiryDate = $<HTMLInputElement>('#inbNewExpiry').value;
  const quantity = Number($<HTMLInputElement>('#inbNewQty').value);
  if (!referenceNo || !sku || !location || !expiryDate || !(quantity > 0)) {
    setOps('Receipt needs reference, SKU, location, expiry and qty > 0.', 'error');
    return;
  }
  const res = await run('Recording receipt', () =>
    daily!.recordInbound([
      {
        inboundDate: $<HTMLInputElement>('#inbNewDate').value || today(),
        referenceNo,
        sku,
        location,
        batch: $<HTMLInputElement>('#inbNewBatch').value.trim() || null,
        expiryDate,
        quantity,
        upp: Number($<HTMLInputElement>('#inbNewUpp').value) || 1,
      },
    ]),
  );
  if (res) {
    $<HTMLInputElement>('#inbNewRef').value = '';
    void loadInbound();
  }
});

$('#inbTable').addEventListener('click', async (e) => {
  const b = (e.target as HTMLElement).closest('button[data-action]') as HTMLButtonElement | null;
  if (!b || !daily) return;
  const id = b.dataset.id!;
  if (b.dataset.action === 'inb-complete') {
    const res = await run('Completing inbound', () => daily!.completeInbound(id, actor()));
    if (res) setOps(`Inbound ${String(res.result)} — stock updated once.`, 'ok');
    void loadInbound();
  } else if (b.dataset.action === 'inb-cancel') {
    const reason = window.prompt('Cancel reason?');
    if (!reason) return;
    await run('Cancelling inbound', () => daily!.cancelInbound(id, actor(), reason));
    void loadInbound();
  }
});

// ---- outbound ----------------------------------------------------------------

async function loadOutbound(): Promise<void> {
  if (!repos) return;
  const date = $<HTMLInputElement>('#outDate').value || undefined;
  const status = ($<HTMLSelectElement>('#outStatus').value || undefined) as 'PLANNED' | 'COMPLETED' | 'RESCHEDULED' | 'CANCELLED' | undefined;
  const rows = await run('Loading outbound', () => repos!.outbound.list({ date, status }));
  if (!rows) return;
  $('#outTable').innerHTML = table(
    ['Date', 'Shipment', 'Wave', 'SKU', 'Destination', 'Qty', 'Origin', 'Status', 'Actions'],
    rows.map((r) => [
      dateStr(r.outboundDate),
      escapeHtml(r.shipmentNumber),
      escapeHtml(r.waveNo ?? '-'),
      r.sku,
      escapeHtml(r.destination),
      r.quantity,
      r.origin,
      statusTag(r.status),
      r.status === 'PLANNED'
        ? r.origin === 'ALLOCATION'
          ? '<span style="font-size:.74rem;color:var(--ink-faint)">posted via wave</span>'
          : btn('out-confirm', r.id, 'Confirm') + ' ' + btn('out-cancel', r.id, 'Cancel', 'btn sm danger')
        : escapeHtml(r.completedBy ?? ''),
    ]),
    'No outbound rows.',
  );
}

$('#outRefresh').addEventListener('click', () => void loadOutbound());

$('#outTable').addEventListener('click', async (e) => {
  const b = (e.target as HTMLElement).closest('button[data-action]') as HTMLButtonElement | null;
  if (!b || !daily || !repos) return;
  const id = b.dataset.id!;
  if (b.dataset.action === 'out-confirm') {
    const res = await run('Confirming outbound', () => daily!.confirmOutbound(id, actor()));
    if (res) setOps(`Outbound ${String(res.result)} — stock deducted once.`, 'ok');
    void loadOutbound();
  } else if (b.dataset.action === 'out-cancel') {
    const reason = window.prompt('Cancel reason?');
    if (!reason) return;
    await run('Cancelling outbound', () => daily!.cancelOutbound(id, actor(), reason));
    void loadOutbound();
  }
});

// ---- execution ---------------------------------------------------------------

async function loadWaves(): Promise<void> {
  if (!repos || !exec) return;
  const date = $<HTMLInputElement>('#execDate').value || undefined;
  const waves = await run('Loading waves', () => repos!.waves.list({ date }));
  if (!waves) return;
  const rows: (string | number)[][] = [];
  for (const w of waves) {
    const movements = await repos.movements.listByWave(w.id);
    const counts: Record<string, number> = {};
    for (const m of movements) counts[m.status] = (counts[m.status] ?? 0) + 1;
    const summary = Object.entries(counts).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(', ') || 'none';
    rows.push([
      escapeHtml(w.waveNo),
      escapeHtml(w.truck ?? '-'),
      escapeHtml(w.plannedSlot ?? '-'),
      escapeHtml(w.destination),
      statusTag(w.status),
      summary,
      btn('wave-pdf', w.id, 'PDF', 'btn sm') + ' ' +
      (w.status === 'PENDING'
        ? btn('wave-detail', w.id, 'Movements') + ' ' +
          btn('wave-complete', w.id, 'Complete', 'btn sm primary') + ' ' +
          btn('wave-reschedule', w.id, 'Reschedule') + ' ' +
          btn('wave-cancel', w.id, 'Cancel', 'btn sm danger')
        : btn('wave-detail', w.id, 'Movements')),
    ]);
  }
  $('#execTable').innerHTML = table(
    ['Wave', 'Truck', 'Slot', 'Destination', 'Status', 'Movements', 'Actions'],
    rows,
    'No waves for this date.',
  );
}

$('#execRefresh').addEventListener('click', () => void loadWaves());

$('#execTable').addEventListener('click', async (e) => {
  const b = (e.target as HTMLElement).closest('button[data-action]') as HTMLButtonElement | null;
  if (!b || !exec) return;
  const id = b.dataset.id!;
  const action = b.dataset.action!;
  if (action === 'wave-complete') {
    const res = await run('Completing wave', () => exec!.completeWave(id, actor()));
    if (res) setOps(`Wave ${String(res.result)} — ${String(res.movements_posted ?? res.posted ?? 0)} movement(s) posted.`, 'ok');
    void loadWaves();
  } else if (action === 'wave-reschedule') {
    const reason = window.prompt('Reschedule reason?');
    if (!reason) return;
    const newSlot = window.prompt('New slot time (HH:MM), empty to keep:') || null;
    await run('Rescheduling wave', () => exec!.rescheduleWave(id, actor(), reason, { newSlot }));
    void loadWaves();
  } else if (action === 'wave-cancel') {
    const reason = window.prompt('Cancel reason?');
    if (!reason) return;
    await run('Cancelling wave', () => exec!.cancelWave(id, actor(), reason));
    void loadWaves();
  } else if (action === 'wave-pdf') {
    if (!repos) return;
    const wave = await repos.waves.get(id);
    if (!wave) return;
    const movements = await repos.movements.listByWave(id);
    const outbound = await repos.outbound.list({ waveNo: wave.waveNo });
    const outboundByWave = new Map<string, typeof outbound>();
    outboundByWave.set(wave.id, outbound);
    const movementsByWave = new Map<string, typeof movements>();
    movementsByWave.set(wave.id, movements);
    const picklists = buildPicklistsFromDB([wave], movementsByWave, outboundByWave);
    if (picklists.length === 0) { setOps('No pick movements for this wave.', 'error'); return; }
    const result = await run('Loading stock', () => loadStockFromDatabase(repos!.stock));
    if (!result) { setOps('No stock data found.', 'error'); return; }
    const { stock } = result;
    const pickfaces = derivePickfaces(stock, withConfig({ asOf: new Date(wave.plannedDate ?? today() + 'T00:00:00Z') }));
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const ranges: PdfPageRange[] = [];
    for (let i = 0; i < picklists.length; i++) {
      if (i > 0) doc.addPage();
      const start = doc.getNumberOfPages();
      renderPicklistPdfPage(doc, picklists[i], pickfaces);
      ranges.push({ startPage: start, endPage: doc.getNumberOfPages() });
    }
    stampPageNumbers(doc, ranges);
    const blob = doc.output('blob');
    triggerDownload(blob, `picklist_${wave.waveNo}.pdf`);
    setOps(`PDF downloaded: picklist_${wave.waveNo}.pdf`, 'ok');
    return;
  } else if (action === 'wave-detail') {
    const snap = await run('Loading movements', () => exec!.waveSnapshot(id));
    if (!snap) return;
    $('#execDetail').innerHTML =
      `<h3 style="font-size:.8rem;color:var(--ink-dim)">Wave ${escapeHtml(snap.wave.waveNo)} — ${snap.wave.status}</h3>` +
      table(
        ['Seq', 'Type', 'SKU', 'From', 'To', 'Batch', 'Expiry', 'Qty', 'Shipment', 'Status', 'Actions'],
        snap.movements.map((m) => [
          m.seq ?? '-',
          m.movementType,
          m.sku,
          m.sourceLocation,
          m.destinationLocation ?? '-',
          m.batch ?? '-',
          dateStr(m.expiryDate),
          m.quantity,
          escapeHtml(m.shipmentNumber ?? '-'),
          statusTag(m.status),
          m.status === 'PLANNED'
            ? btn('mv-complete', m.id, 'Complete', 'btn sm primary') + ' ' +
              btn('mv-reschedule', m.id, 'Reschedule') + ' ' +
              btn('mv-cancel', m.id, 'Cancel', 'btn sm danger')
            : m.status === 'RESCHEDULED'
              ? btn('mv-reactivate', m.id, 'Reactivate')
              : '',
        ]),
        'No movements in this wave.',
      );
  }
});

$('#execDetail').addEventListener('click', async (e) => {
  const b = (e.target as HTMLElement).closest('button[data-action]') as HTMLButtonElement | null;
  if (!b || !exec) return;
  const id = b.dataset.id!;
  const action = b.dataset.action!;
  if (action === 'mv-complete') {
    const res = await run('Posting movement', () => exec!.completeMovement(id, actor()));
    if (res) setOps(`Movement ${String(res.result)}.`, 'ok');
  } else if (action === 'mv-reschedule') {
    const reason = window.prompt('Reschedule reason?');
    if (!reason) return;
    await run('Rescheduling movement', () => exec!.rescheduleMovement(id, actor(), reason));
  } else if (action === 'mv-cancel') {
    const reason = window.prompt('Cancel reason?');
    if (!reason) return;
    await run('Cancelling movement', () => exec!.cancelMovement(id, actor(), reason));
  } else if (action === 'mv-reactivate') {
    await run('Reactivating movement', () => exec!.reactivateMovement(id, actor()));
  } else {
    return;
  }
  void loadWaves();
  // refresh the open detail view: find the wave via the header is overkill —
  // re-click the wave's Movements button when still present
});

// ---- database (import / reconciliation / export) ------------------------------

$('#dbImportFile').addEventListener('change', async () => {
  const f = $<HTMLInputElement>('#dbImportFile').files?.[0];
  if (!f) return;
  setOps(`Parsing ${f.name}…`, 'busy');
  try {
    const buf = await f.arrayBuffer();
    const loaded = loadWorkbookFromBuffer(buf, withConfig({ asOf: new Date() }));
    importPreview = validateImport(f.name, loaded);
    const pre = $<HTMLPreElement>('#dbImportPreview');
    pre.textContent = formatPreview(importPreview);
    pre.hidden = false;
    $<HTMLButtonElement>('#dbImportConfirm').disabled = !importPreview.canImport;
    setOps(importPreview.canImport ? 'Preview ready — review, then confirm.' : 'Preview BLOCKED by validation errors.', importPreview.canImport ? 'ok' : 'error');
  } catch (err) {
    importPreview = null;
    $<HTMLButtonElement>('#dbImportConfirm').disabled = true;
    setOps(`Could not parse ${f.name}: ${errText(err)}`, 'error');
  }
});

$('#dbImportConfirm').addEventListener('click', async () => {
  if (!client || !importPreview?.canImport) return;
  const preview = importPreview;
  const mode = $<HTMLSelectElement>('#dbImportMode').value as 'FAIL_ON_CONFLICT' | 'REPLACE';
  if (!window.confirm(`Import ${preview.stockRowCount} stock rows (${preview.totalCartons} cartons) into the database?`)) return;
  const res = await run('Importing WMS snapshot', () =>
    executeImport(client!, preview, { actor: actor(), mode }),
  );
  if (res) {
    setOps(
      `Import ${String(res.result).toLowerCase()}: imported=${String(res.imported ?? 0)} replaced=${String(res.replaced ?? 0)} skipped_zero_qty=${String(res.skipped_zero_qty ?? 0)}`,
      'ok',
    );
    $<HTMLButtonElement>('#dbImportConfirm').disabled = true;
    importPreview = null;
  }
});

$('#reconMismatch').addEventListener('click', async () => {
  if (!recon) return;
  const rows = await run('Checking stock vs ledger', () => recon!.mismatchReport());
  if (!rows) return;
  $('#reconTable').innerHTML = table(
    ['Identity', 'Stock qty', 'Ledger qty', 'Mismatch'],
    rows.map((r) => [escapeHtml(r.identityKey), r.stockQuantity, r.ledgerQuantity, r.mismatch]),
    'No mismatches — the ledger explains every balance.',
  );
});

$('#reconSummary').addEventListener('click', async () => {
  if (!recon) return;
  const date = $<HTMLInputElement>('#reconDate').value || today();
  const rows = await run(`Summarising ${date}`, () => recon!.dailySummary(date));
  if (!rows) return;
  $('#reconTable').innerHTML = table(
    ['Identity', 'Opening', 'Initial', 'Inbound', 'Picks', 'Outbound', 'Reloc in', 'Reloc out', 'Adjust', 'Closing'],
    rows.map((r) => [
      escapeHtml(r.identityKey),
      r.openingQty,
      r.initialImport,
      r.inboundQty,
      r.pickQty,
      r.outboundQty,
      r.relocInQty,
      r.relocOutQty,
      r.adjustmentQty,
      r.closingQty,
    ]),
    'No activity recorded on this date.',
  );
});

$('#dbExport').addEventListener('click', async () => {
  if (!repos) return;
  const records = await run('Exporting stock', async () => {
    const recs = await repos!.stock.listAll();
    return recs.filter((r) => r.quantity > 0);
  });
  if (!records) return;
  const wb = buildStockWorkbook(records);
  const bytes = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  downloadBlob(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `WMS_updated_${stamp}.xlsx`);
  setOps(`Exported ${records.length} stock rows — your original workbook was not touched.`, 'ok');
});

// ---- inbound file import ----------------------------------------------------

let inbImportRecords: import('../repository/inbound-repo.js').NewInbound[] | null = null;

$('#inbImportFile').addEventListener('change', async () => {
  const f = $<HTMLInputElement>('#inbImportFile').files?.[0];
  if (!f) return;
  setOps(`Parsing ${f.name}…`, 'busy');
  try {
    const { parseInboundFromWorkbook } = await import('../adapters/inbound-import.js');
    const buf = await f.arrayBuffer();
    const inboundDate = $<HTMLInputElement>('#inbNewDate').value || today();
    const result = parseInboundFromWorkbook(buf, { inboundDate });
    inbImportRecords = result.records.length > 0 ? result.records : null;
    const lines: string[] = [
      `Import preview — ${f.name}`,
      `  records to import : ${result.records.length}`,
      `  warnings         : ${result.warnings.length}`,
    ];
    for (const w of result.warnings) lines.push(`    ${w}`);
    lines.push(result.records.length > 0 ? '  status           : READY TO IMPORT' : '  status           : EMPTY (no records)');
    const pre = $<HTMLPreElement>('#inbImportPreview');
    pre.textContent = lines.join('\n');
    pre.hidden = false;
    $<HTMLButtonElement>('#inbImportConfirm').disabled = !inbImportRecords;
    setOps(inbImportRecords ? 'Preview ready — review, then confirm.' : 'No valid records found.', inbImportRecords ? 'ok' : 'error');
  } catch (err) {
    inbImportRecords = null;
    $<HTMLButtonElement>('#inbImportConfirm').disabled = true;
    setOps(`Could not parse ${f.name}: ${errText(err)}`, 'error');
  }
});

$('#inbImportConfirm').addEventListener('click', async () => {
  if (!daily || !inbImportRecords) return;
  const records = inbImportRecords;
  if (!window.confirm(`Import ${records.length} inbound records as PENDING?`)) return;
  const res = await run('Importing inbound', () => daily!.recordInbound(records));
  if (res) {
    setOps(`Imported ${res.length} inbound records — Complete each to add stock.`, 'ok');
    inbImportRecords = null;
    $<HTMLButtonElement>('#inbImportConfirm').disabled = true;
    $<HTMLInputElement>('#inbImportFile').value = '';
    void loadInbound();
  }
});

// ---- outbound file import ---------------------------------------------------

let outImportRecords: import('../repository/outbound-repo.js').NewOutbound[] | null = null;

$('#outImportFile').addEventListener('change', async () => {
  const f = $<HTMLInputElement>('#outImportFile').files?.[0];
  if (!f) return;
  setOps(`Parsing ${f.name}…`, 'busy');
  try {
    const { parseOutboundFromWorkbook } = await import('../adapters/outbound-import.js');
    const buf = await f.arrayBuffer();
    const outboundDate = $<HTMLInputElement>('#outDate').value || today();
    const result = parseOutboundFromWorkbook(buf, { outboundDate });
    outImportRecords = result.records.length > 0 ? result.records : null;
    const lines: string[] = [
      `Import preview — ${f.name}`,
      `  records to import : ${result.records.length}`,
      `  warnings         : ${result.warnings.length}`,
    ];
    for (const w of result.warnings) lines.push(`    ${w}`);
    lines.push(result.records.length > 0 ? '  status           : READY TO IMPORT' : '  status           : EMPTY (no records)');
    const pre = $<HTMLPreElement>('#outImportPreview');
    pre.textContent = lines.join('\n');
    pre.hidden = false;
    $<HTMLButtonElement>('#outImportConfirm').disabled = !outImportRecords;
    setOps(outImportRecords ? 'Preview ready — review, then confirm.' : 'No valid records found.', outImportRecords ? 'ok' : 'error');
  } catch (err) {
    outImportRecords = null;
    $<HTMLButtonElement>('#outImportConfirm').disabled = true;
    setOps(`Could not parse ${f.name}: ${errText(err)}`, 'error');
  }
});

$('#outImportConfirm').addEventListener('click', async () => {
  if (!repos || !outImportRecords) return;
  const records = outImportRecords;
  if (!window.confirm(`Import ${records.length} outbound records as PLANNED?`)) return;
  const res = await run('Importing outbound', () => repos!.outbound.create(records));
  if (res) {
    setOps(`Imported ${res.length} outbound records — ready for allocation.`, 'ok');
    outImportRecords = null;
    $<HTMLButtonElement>('#outImportConfirm').disabled = true;
    $<HTMLInputElement>('#outImportFile').value = '';
    void loadOutbound();
  }
});

// ---- allocation from DB -----------------------------------------------------

$('#allocRunBtn').addEventListener('click', async () => {
  if (!client) return;
  if (!window.confirm('Run allocation from DB? This reads stock and imported demand, creates waves + movements.')) return;
  const asOf = $<HTMLInputElement>('#execDate').value || today();
  const res = await run('Running allocation', async () => {
    const { runAllocationFromDB } = await import('../services/daily-workflow.js');
    return runAllocationFromDB(client!, { asOf: new Date(asOf + 'T00:00:00Z') });
  });
  if (res) {
    setOps(
      `Allocation complete — ${res.waves.length} waves, ${res.movementCount} movements, ${res.stats.cartonsAllocated}/${res.stats.cartonsRequested} cartons (${res.stats.fillRatePct.toFixed(1)}% fill).`,
      'ok',
    );
    void loadWaves();
    void loadOutbound();
  }
});

// ---- init ---------------------------------------------------------------------

$<HTMLInputElement>('#execDate').value = today();
$<HTMLInputElement>('#reconDate').value = today();
$<HTMLInputElement>('#inbNewDate').value = today();
if (client) {
  void loadStock({});
  void loadInbound();
  void loadOutbound();
  void loadWaves();
}
