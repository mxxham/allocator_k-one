import jsPDF from 'jspdf';
import { applyPlugin } from 'jspdf-autotable';
import { checkDigit, parseLocation, pickSequenceKey } from '../pickpath.js';
import { uomLabel } from '../picklist.js';

(applyPlugin as any)(jsPDF);
import { withConfig, type AllocatorConfig } from '../config.js';
import type { AllocationResult, PickfaceAssignment, Picklist, ReplenishmentResult } from '../types.js';

function escape(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string);
}

export function renderPicklistPdfPage(doc: jsPDF, pl: Picklist, pickfaces?: Map<string, { location: string }>) {
  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.text(`PICKLIST ${pl.picklistId}`, 14, 15);

  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  const meta = [
    `NO (Wave): ${pl.waveNo}`,
    `Shipment: ${pl.shipmentNumbers.join(', ')}`,
    `Tujuan: ${escape(pl.destination)} — ${escape(pl.shipToLocation)}`,
    `Slot: ${pl.slotTime ?? '-'}`,
    `Truck: ${pl.truckType ?? '-'}`,
    `DO Number: ${pl.orderNos.join(', ')}`,
    `Total: ${pl.totalCartons} ctn / ${pl.lines.length} stop`,
  ];
  doc.text(meta.join('   |   '), 14, 22);

  const head = [['No', 'Lokasi', 'Material', 'Description', 'Bin To Bin', 'Batch', 'Exp Date', 'Qty Pick', 'UOM', 'Sisa', '✓']];
  const body: any[][] = [];
  let lastPickType: string | null = null;
  for (const l of pl.lines) {
    if (lastPickType !== l.pickType) {
      const label = l.pickType === 'CASE' ? '— HANDPICK / ECERAN —' : '— FORKLIFT / FULL PALLET —';
      body.push([{ content: label, colSpan: 11, styles: { fillColor: [230, 230, 230], fontStyle: 'bold', halign: 'center', textColor: [0, 0, 0] } }]);
      lastPickType = l.pickType;
    }
    const keLokasi = l.breaksPallet ? (pickfaces?.get(l.sku)?.location ?? '') : '';
    body.push([
      String(l.seq),
      l.location,
      l.sku,
      escape(l.description),
      keLokasi,
      l.batch ?? '-',
      l.expiryDate.toISOString().slice(0, 10),
      String(l.qtyPick),
      `${uomLabel(l.uom)}${l.breaksPallet ? ' buka palet' : ''}`,
      String(l.qtyRemainingInBin),
      '',
    ]);
  }

  (doc as any).autoTable({
    startY: 26,
    head,
    body,
    theme: 'grid',
    styles: { fontSize: 10, cellPadding: 1.5, textColor: [0, 0, 0], lineWidth: 0.2, lineColor: [0, 0, 0] },
    headStyles: { fillColor: [255, 255, 255], textColor: [0, 0, 0], fontStyle: 'bold', fontSize: 10, lineWidth: 0.2, lineColor: [0, 0, 0] },
    columnStyles: {
      0: { cellWidth: 10 },
      1: { cellWidth: 30, fontStyle: 'bold' },
      2: { cellWidth: 22 },
      3: { cellWidth: 50 },
      4: { cellWidth: 26, fontStyle: 'bold' },
      5: { cellWidth: 20 },
      6: { cellWidth: 20 },
      7: { cellWidth: 14, halign: 'right' },
      8: { cellWidth: 20 },
      9: { cellWidth: 12, halign: 'right' },
      10: { cellWidth: 10, halign: 'center' },
    },
    didDrawCell(data: any) {
      if (data.column.index === 10 && data.section === 'body') {
        const { x, y, width, height } = data.cell;
        const size = Math.min(width, height) * 0.5;
        const cx = x + width / 2 - size / 2;
        const cy = y + height / 2 - size / 2;
        doc.rect(cx, cy, size, size);
      }
    },
  });

  const y = (doc as any).lastAutoTable?.finalY ?? 80;
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  const footY = Math.min(y + 8, 260);
  doc.text('Picker', 14, footY);
  doc.text('Checker', 90, footY);
  doc.text('Admin / Supervisor', 160, footY);
  doc.line(14, footY + 22, 70, footY + 22);
  doc.line(90, footY + 22, 146, footY + 22);
  doc.line(160, footY + 22, 216, footY + 22);
}

export function renderReplenPdfPage(doc: jsPDF, replenishment: ReplenishmentResult, config: AllocatorConfig) {
  const sorted = [...replenishment.tasks].sort((a, b) => {
    const pa = parseLocation(a.fromLocation);
    const pb = parseLocation(b.fromLocation);
    const ka = pa ? pickSequenceKey(pa, config) : Number.MAX_SAFE_INTEGER;
    const kb = pb ? pickSequenceKey(pb, config) : Number.MAX_SAFE_INTEGER;
    return ka - kb;
  });

  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.text('REPLENISHMENT (Bin to Bin)', 14, 15);

  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text(`Total: ${replenishment.stats.cartonsMoved} ctn / ${replenishment.tasks.length} moves`, 14, 22);

  const head = [['No', 'Dari Lokasi', 'Material', 'Description', 'Bin To Bin', 'Batch', 'Exp Date', 'Qty', 'UOM', 'Sisa', '✓']];
  const body = sorted.map((t, i) => [
    String(i + 1),
    t.fromLocation,
    t.sku,
    escape(t.description),
    t.toLocation,
    t.batch ?? '-',
    t.expiryDate.toISOString().slice(0, 10),
    String(t.qtyMove),
    `${uomLabel(t.uom)}${t.breaksPallet ? ' buka palet' : ''}`,
    String(t.qtyRemainingAtSource),
    '',
  ]);

  (doc as any).autoTable({
    startY: 26,
    head,
    body,
    theme: 'grid',
    styles: { fontSize: 10, cellPadding: 1.5, textColor: [0, 0, 0], lineWidth: 0.2, lineColor: [0, 0, 0] },
    headStyles: { fillColor: [255, 255, 255], textColor: [0, 0, 0], fontStyle: 'bold', fontSize: 10, lineWidth: 0.2, lineColor: [0, 0, 0] },
    columnStyles: {
      0: { cellWidth: 10 },
      1: { cellWidth: 30, fontStyle: 'bold' },
      2: { cellWidth: 22 },
      3: { cellWidth: 50 },
      4: { cellWidth: 26, fontStyle: 'bold' },
      5: { cellWidth: 20 },
      6: { cellWidth: 20 },
      7: { cellWidth: 14, halign: 'right' },
      8: { cellWidth: 20 },
      9: { cellWidth: 12, halign: 'right' },
      10: { cellWidth: 10, halign: 'center' },
    },
    didDrawCell(data: any) {
      if (data.column.index === 10 && data.section === 'body') {
        const { x, y, width, height } = data.cell;
        const size = Math.min(width, height) * 0.5;
        const cx = x + width / 2 - size / 2;
        const cy = y + height / 2 - size / 2;
        doc.rect(cx, cy, size, size);
      }
    },
  });
}

export function generatePicklistPdfs(
  result: AllocationResult,
  replenishment?: ReplenishmentResult,
  config?: AllocatorConfig,
  pickfaces?: Map<string, PickfaceAssignment>,
): { name: string; data: Uint8Array }[] {
  const cfg = config ?? withConfig();
  const pdfs: { name: string; data: Uint8Array }[] = [];

  for (const pl of result.picklists) {
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    renderPicklistPdfPage(doc, pl, pickfaces);
    const data = new Uint8Array(doc.output('arraybuffer'));
    const name = `picklist_${pl.picklistId}.pdf`;
    pdfs.push({ name, data });
  }

  if (replenishment && replenishment.tasks.length > 0) {
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    renderReplenPdfPage(doc, replenishment, cfg);
    const data = new Uint8Array(doc.output('arraybuffer'));
    pdfs.push({ name: 'replenishment.pdf', data });
  }

  return pdfs;
}
