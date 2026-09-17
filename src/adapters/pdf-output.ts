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

// ── Page geometry helpers ────────────────────────────────────────────────────

interface PageGeometry {
  pageWidth: number;
  pageHeight: number;
  marginLeft: number;
  marginRight: number;
  marginTop: number;
  marginBottom: number;
  contentWidth: number;
  contentBottom: number;
}

function getPageGeometry(doc: jsPDF): PageGeometry {
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const marginLeft = 14;
  const marginRight = 14;
  const marginTop = 12;
  const marginBottom = 12;
  return {
    pageWidth,
    pageHeight,
    marginLeft,
    marginRight,
    marginTop,
    marginBottom,
    contentWidth: pageWidth - marginLeft - marginRight,
    contentBottom: pageHeight - marginBottom,
  };
}

function hasRoom(currentY: number, requiredHeight: number, geo: PageGeometry): boolean {
  return currentY + requiredHeight <= geo.contentBottom;
}

function wrapText(doc: jsPDF, text: string, width: number): string[] {
  return doc.splitTextToSize(text, width);
}

export type PdfPageRange = {
  startPage: number;
  endPage: number;
};

export function stampPageNumbers(doc: jsPDF, pageRanges?: PdfPageRange[]): void {
  const geo = getPageGeometry(doc);

  if (pageRanges) {
    // Per-picklist numbering: each picklist's pages are numbered independently
    for (const range of pageRanges) {
      const picklistPageCount = range.endPage - range.startPage + 1;
      for (let p = 0; p < picklistPageCount; p++) {
        doc.setPage(range.startPage + p);
        doc.setFontSize(8);
        doc.setFont('helvetica', 'normal');
        doc.text(`Page ${p + 1} of ${picklistPageCount}`, geo.pageWidth - geo.marginRight, geo.pageHeight - 5, { align: 'right' });
      }
    }
  } else {
    // Fallback: global numbering (used by generatePicklistPdfs which creates one doc per picklist)
    const pageCount = doc.getNumberOfPages();
    for (let i = 1; i <= pageCount; i++) {
      doc.setPage(i);
      doc.setFontSize(8);
      doc.setFont('helvetica', 'normal');
      doc.text(`Page ${i} of ${pageCount}`, geo.pageWidth - geo.marginRight, geo.pageHeight - 5, { align: 'right' });
    }
  }
}

// ── Picklist column widths (A4 landscape content = 268mm) ────────────────────

const PICKLIST_COL_WIDTHS = [10, 30, 22, 50, 26, 20, 20, 14, 20, 12, 10] as const;
const PICKLIST_TOTAL_WIDTH = PICKLIST_COL_WIDTHS.reduce((a, b) => a + b, 0);

// ── Replenishment column widths (same layout) ───────────────────────────────

const REPLEN_COL_WIDTHS = [10, 30, 22, 50, 26, 20, 20, 14, 20, 12, 10] as const;
const REPLEN_TOTAL_WIDTH = REPLEN_COL_WIDTHS.reduce((a, b) => a + b, 0);

// ── Picklist PDF rendering ──────────────────────────────────────────────────

export function renderPicklistPdfPage(doc: jsPDF, pl: Picklist, pickfaces?: Map<string, { location: string }>) {
  const geo = getPageGeometry(doc);

  let currentY = geo.marginTop;

  // Title
  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.text(`PICKLIST ${pl.picklistId}`, geo.marginLeft, currentY + 4);
  currentY += 9;

  // Row 1: NO (Wave) | Shipment | Slot | Truck | Total
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  const row1Parts = [
    `NO (Wave): ${pl.waveNo}`,
    `Shipment: ${pl.shipmentNumbers.join(', ')}`,
    `Slot: ${pl.slotTime ?? '-'}`,
    `Truck: ${pl.truckType ?? '-'}`,
    `Total: ${pl.totalCartons} ctn / ${pl.lines.length} stop`,
  ];
  const row1Text = row1Parts.join('   |   ');
  const row1Lines = wrapText(doc, row1Text, geo.contentWidth);
  for (const line of row1Lines) {
    doc.text(line, geo.marginLeft, currentY + 4);
    currentY += 5;
  }
  currentY += 1;

  // Row 2: Tujuan (destination — shipToLocation)
  const tujuanText = `Tujuan: ${escape(pl.destination)} — ${escape(pl.shipToLocation)}`;
  const tujuanLines = wrapText(doc, tujuanText, geo.contentWidth);
  for (const line of tujuanLines) {
    doc.text(line, geo.marginLeft, currentY + 4);
    currentY += 5;
  }
  currentY += 1;

  // Row 3: DO Number (wrapped)
  const doText = pl.orderNos.length ? pl.orderNos.join(', ') : '-';
  const doLabel = `DO Number: ${doText}`;
  const doLines = wrapText(doc, doLabel, geo.contentWidth);
  for (const line of doLines) {
    doc.text(line, geo.marginLeft, currentY + 4);
    currentY += 5;
  }
  currentY += 4;

  // ── Build table body ────────────────────────────────────────────────────
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

  // ── AutoTable with page-safe options ────────────────────────────────────
  (doc as any).autoTable({
    startY: currentY,
    head,
    body,
    theme: 'grid',
    pageBreak: 'auto',
    rowPageBreak: 'auto',
    showHead: 'everyPage',
    margin: { left: geo.marginLeft, right: geo.marginRight },
    styles: {
      fontSize: 10,
      cellPadding: 1.5,
      textColor: [0, 0, 0],
      lineWidth: 0.2,
      lineColor: [0, 0, 0],
      overflow: 'linebreak',
    },
    headStyles: {
      fillColor: [255, 255, 255],
      textColor: [0, 0, 0],
      fontStyle: 'bold',
      fontSize: 10,
      lineWidth: 0.2,
      lineColor: [0, 0, 0],
    },
    columnStyles: {
      0: { cellWidth: PICKLIST_COL_WIDTHS[0] },
      1: { cellWidth: PICKLIST_COL_WIDTHS[1], fontStyle: 'bold' },
      2: { cellWidth: PICKLIST_COL_WIDTHS[2] },
      3: { cellWidth: PICKLIST_COL_WIDTHS[3], overflow: 'linebreak' },
      4: { cellWidth: PICKLIST_COL_WIDTHS[4], fontStyle: 'bold' },
      5: { cellWidth: PICKLIST_COL_WIDTHS[5] },
      6: { cellWidth: PICKLIST_COL_WIDTHS[6] },
      7: { cellWidth: PICKLIST_COL_WIDTHS[7], halign: 'right' },
      8: { cellWidth: PICKLIST_COL_WIDTHS[8] },
      9: { cellWidth: PICKLIST_COL_WIDTHS[9], halign: 'right' },
      10: { cellWidth: PICKLIST_COL_WIDTHS[10], halign: 'center' },
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

  // ── Footer / signatures ────────────────────────────────────────────────
  const signatureHeight = 30;
  let footY = (doc as any).lastAutoTable?.finalY ?? currentY + 20;

  // Check if we have room for signatures on the current page
  if (!hasRoom(footY + 4, signatureHeight, geo)) {
    doc.addPage();
    footY = geo.marginTop;
  }

  footY += 8;
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text('Picker', geo.marginLeft, footY);
  doc.text('Checker', 90, footY);
  doc.text('Admin / Supervisor', 160, footY);
  doc.line(geo.marginLeft, footY + 22, 70, footY + 22);
  doc.line(90, footY + 22, 146, footY + 22);
  doc.line(160, footY + 22, 216, footY + 22);
}

// ── Replenishment PDF rendering ─────────────────────────────────────────────

export function renderReplenPdfPage(doc: jsPDF, replenishment: ReplenishmentResult, config: AllocatorConfig) {
  const geo = getPageGeometry(doc);

  const sorted = [...replenishment.tasks].sort((a, b) => {
    const pa = parseLocation(a.fromLocation);
    const pb = parseLocation(b.fromLocation);
    const ka = pa ? pickSequenceKey(pa, config) : Number.MAX_SAFE_INTEGER;
    const kb = pb ? pickSequenceKey(pb, config) : Number.MAX_SAFE_INTEGER;
    return ka - kb;
  });

  let currentY = geo.marginTop;

  // Title
  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.text('REPLENISHMENT (Bin to Bin)', geo.marginLeft, currentY + 4);
  currentY += 9;

  // Subtitle
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  const subText = `Total: ${replenishment.stats.cartonsMoved} ctn / ${replenishment.tasks.length} moves`;
  const subLines = wrapText(doc, subText, geo.contentWidth);
  for (const line of subLines) {
    doc.text(line, geo.marginLeft, currentY + 4);
    currentY += 5;
  }
  currentY += 4;

  // Table body
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
    startY: currentY,
    head,
    body,
    theme: 'grid',
    pageBreak: 'auto',
    rowPageBreak: 'auto',
    showHead: 'everyPage',
    margin: { left: geo.marginLeft, right: geo.marginRight },
    styles: {
      fontSize: 10,
      cellPadding: 1.5,
      textColor: [0, 0, 0],
      lineWidth: 0.2,
      lineColor: [0, 0, 0],
      overflow: 'linebreak',
    },
    headStyles: {
      fillColor: [255, 255, 255],
      textColor: [0, 0, 0],
      fontStyle: 'bold',
      fontSize: 10,
      lineWidth: 0.2,
      lineColor: [0, 0, 0],
    },
    columnStyles: {
      0: { cellWidth: REPLEN_COL_WIDTHS[0] },
      1: { cellWidth: REPLEN_COL_WIDTHS[1], fontStyle: 'bold' },
      2: { cellWidth: REPLEN_COL_WIDTHS[2] },
      3: { cellWidth: REPLEN_COL_WIDTHS[3], overflow: 'linebreak' },
      4: { cellWidth: REPLEN_COL_WIDTHS[4], fontStyle: 'bold' },
      5: { cellWidth: REPLEN_COL_WIDTHS[5] },
      6: { cellWidth: REPLEN_COL_WIDTHS[6] },
      7: { cellWidth: REPLEN_COL_WIDTHS[7], halign: 'right' },
      8: { cellWidth: REPLEN_COL_WIDTHS[8] },
      9: { cellWidth: REPLEN_COL_WIDTHS[9], halign: 'right' },
      10: { cellWidth: REPLEN_COL_WIDTHS[10], halign: 'center' },
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

// ── Generate all picklist PDFs ──────────────────────────────────────────────

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
    stampPageNumbers(doc);
    const data = new Uint8Array(doc.output('arraybuffer'));
    const name = `picklist_${pl.picklistId}.pdf`;
    pdfs.push({ name, data });
  }

  if (replenishment && replenishment.tasks.length > 0) {
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    renderReplenPdfPage(doc, replenishment, cfg);
    stampPageNumbers(doc);
    const data = new Uint8Array(doc.output('arraybuffer'));
    pdfs.push({ name: 'replenishment.pdf', data });
  }

  return pdfs;
}
