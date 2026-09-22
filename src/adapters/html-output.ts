import { checkDigit } from '../pickpath.js';
import { uomLabel } from '../picklist.js';
import type { AllocationResult, PickfaceAssignment, Picklist } from '../types.js';

export function renderPicklistHtml(
  result: AllocationResult,
  pickfaces?: Map<string, PickfaceAssignment>,
): string {
  const pages = result.picklists.map((pl) => renderPage(pl, pickfaces)).join('\n');
  return `<!doctype html>
<html lang="id"><head><meta charset="utf-8">
<title>Picklist ${result.generatedAt.toISOString().slice(0, 10)}</title>
<style>
  @page { size: A4; margin: 10mm; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 11px; color: #111; margin: 0; }
  .page { page-break-after: always; padding: 4mm 0; }
  .page:last-child { page-break-after: auto; }
  h1 { font-size: 16px; margin: 0 0 2px; }
  .meta { display: flex; flex-wrap: wrap; gap: 4px 18px; margin-bottom: 8px; font-size: 11px; }
  .meta b { font-weight: 700; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border: 1px solid #999; padding: 3px 4px; text-align: left; }
  th { background: #1f3864; color: #fff; font-size: 10px; }
  td.num, th.num { text-align: right; }
  .loc { font-weight: 700; font-size: 13px; letter-spacing: .5px; }
  .qty { font-weight: 700; font-size: 13px; }
  .tick { width: 22px; text-align: center; }
  .warn { color: #c00000; font-weight: 700; }
  .section-sep td { background: #d6e4f0; text-align: center; font-size: 11px; padding: 4px; border: 1px solid #999; }
  .foot { margin-top: 10px; display: flex; gap: 40px; font-size: 11px; }
  .sign { border-top: 1px solid #333; width: 180px; margin-top: 28px; padding-top: 2px; }
</style></head><body>
${pages}
</body></html>`;
}

function renderPage(pl: Picklist, pickfaces?: Map<string, { location: string }>): string {
  const rows = pl.lines
    .map((l, idx) => {
      const keLokasi = l.breaksPallet ? (pickfaces?.get(l.sku)?.location ?? '') : '';
      const prevType = idx > 0 ? pl.lines[idx - 1].pickType : null;
      const separator = prevType && prevType !== l.pickType
        ? `<tr class="section-sep"><td colspan="11"><b>${l.pickType === 'PALLET' ? '— FORKLIFT / FULL PALLET —' : '— HANDPICK / ECERAN —'}</b></td></tr>`
        : '';
      const typeLabel = idx === 0 && l.pickType === 'CASE' ? `<tr class="section-sep"><td colspan="11"><b>— HANDPICK / ECERAN —</b></td></tr>` : '';
      return `${typeLabel}${separator}<tr>
    <td class="num">${l.seq}</td>
    <td class="loc">${l.location}<span style="font-weight:400;color:#666"> ·${checkDigit(l.location)}</span></td>
    <td>${l.sku}</td>
    <td>${escape(l.description)}</td>
    <td${keLokasi ? ' style="color:#1f3864;font-weight:700"' : ''}>${keLokasi}</td>
    <td>${l.batch ?? '-'}</td>
    <td>${l.expiryDate.toISOString().slice(0, 10)}</td>
    <td class="qty num">${l.qtyPick}</td>
    <td>${uomLabel(l.uom)}${l.breaksPallet ? ' <span class="warn">buka palet</span>' : ''}</td>
    <td class="num">${l.qtyRemainingInBin}</td>
    <td class="tick">☐</td>
  </tr>`;
    })
    .join('\n');

  return `<section class="page">
  <h1>PICKLIST ${pl.picklistId}</h1>
  <div class="meta">
    <span><b>NO (Wave):</b> ${pl.waveNo} &nbsp; <b>Shipment:</b> ${pl.shipmentNumbers.join(', ')}</span>
    <span><b>Tujuan:</b> ${escape(pl.destination)} — ${escape(pl.shipToLocation)}</span>
    <span><b>Slot:</b> ${pl.slotTime ?? '-'}</span>
    <span><b>Truck:</b> ${pl.truckType ?? '-'}</span>
    <span><b>DO Number:</b> ${pl.orderNos.join(', ')}</span>
    <span><b>Total:</b> ${pl.totalCartons} ctn / ${pl.lines.length} stop</span>
    <span><b>Printed:</b> ${new Date().toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}</span>
  </div>
  <table>
    <thead><tr>
      <th class="num">No</th><th>Lokasi</th><th>Material</th><th>Description</th><th>Ke Lokasi</th>
      <th>Batch</th><th>Exp Date</th><th class="num">Qty Pick</th><th>UOM</th>
      <th class="num">Sisa</th><th class="tick">✓</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="foot">
    <div><div class="sign">Picker</div></div>
    <div><div class="sign">Checker</div></div>
    <div><div class="sign">Admin / Supervisor</div></div>
  </div>
</section>`;
}

function escape(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string);
}
