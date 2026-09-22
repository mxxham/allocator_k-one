import { jsPDF } from 'jspdf';
import { autoTable } from 'jspdf-autotable';
import { checkDigit, parseLocation } from '../pickpath.js';
import { uomLabel } from '../picklist.js';

import { withConfig, type AllocatorConfig } from '../config.js';
import type { AllocationResult, PickfaceAssignment, Picklist } from '../types.js';

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

function wrapText(doc: jsPDF, text: string, width: number): string[] {
  return doc.splitTextToSize(text, width);
}

// ── Layout constants ─────────────────────────────────────────────────────────

const SIGNATURE_GAP = 8;
const SIGNATURE_LINE_OFFSET = 22;
const PAGE_NUMBER_RESERVE = 5;
const SIGNATURE_BLOCK_HEIGHT = SIGNATURE_GAP + SIGNATURE_LINE_OFFSET + PAGE_NUMBER_RESERVE;

// ── Picklist header ──────────────────────────────────────────────────────────

function picklistHeaderHeight(doc: jsPDF, pl: Picklist, geo: PageGeometry): number {
  let h = 9;

  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  const row1Parts = [
    `NO (Wave): ${pl.waveNo}`,
    `Shipment: ${pl.shipmentNumbers.join(', ')}`,
    `Slot: ${pl.slotTime ?? '-'}`,
    `Truck: ${pl.truckType ?? '-'}`,
    `Total: ${pl.totalCartons} ctn / ${pl.lines.length} stop`,
  ];
  const row1Lines = wrapText(doc, row1Parts.join('   |   '), geo.contentWidth);
  h += row1Lines.length * 5 + 1;

  const tujuanLines = wrapText(doc, `Tujuan: ${escape(pl.destination)} — ${escape(pl.shipToLocation)}`, geo.contentWidth);
  h += tujuanLines.length * 5 + 1;

  const doText = pl.orderNos.length ? pl.orderNos.join(', ') : '-';
  const doLines = wrapText(doc, `DO Number: ${doText}`, geo.contentWidth);
  h += doLines.length * 5 + 1;

  const printedDate = new Date().toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  const printedLines = wrapText(doc, `Printed: ${printedDate}`, geo.contentWidth);
  h += printedLines.length * 5 + 4;

  return h;
}

function drawPicklistHeader(doc: jsPDF, pl: Picklist, geo: PageGeometry): void {
  let y = geo.marginTop;

  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.text(`PICKLIST ${pl.picklistId}`, geo.marginLeft, y + 4);
  y += 9;

  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  const row1Parts = [
    `NO (Wave): ${pl.waveNo}`,
    `Shipment: ${pl.shipmentNumbers.join(', ')}`,
    `Slot: ${pl.slotTime ?? '-'}`,
    `Truck: ${pl.truckType ?? '-'}`,
    `Total: ${pl.totalCartons} ctn / ${pl.lines.length} stop`,
  ];
  const row1Lines = wrapText(doc, row1Parts.join('   |   '), geo.contentWidth);
  for (const line of row1Lines) {
    doc.text(line, geo.marginLeft, y + 4);
    y += 5;
  }
  y += 1;

  const tujuanLines = wrapText(doc, `Tujuan: ${escape(pl.destination)} — ${escape(pl.shipToLocation)}`, geo.contentWidth);
  for (const line of tujuanLines) {
    doc.text(line, geo.marginLeft, y + 4);
    y += 5;
  }
  y += 1;

  const doText = pl.orderNos.length ? pl.orderNos.join(', ') : '-';
  const doLines = wrapText(doc, `DO Number: ${doText}`, geo.contentWidth);
  for (const line of doLines) {
    doc.text(line, geo.marginLeft, y + 4);
    y += 5;
  }
  y += 1;

  const printedDate = new Date().toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  doc.text(`Printed: ${printedDate}`, geo.marginLeft, y + 4);
}

function drawSignatures(doc: jsPDF, finalY: number, geo: PageGeometry): void {
  const footY = finalY + SIGNATURE_GAP;
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text('Picker', geo.marginLeft, footY);
  doc.text('Checker', 90, footY);
  doc.text('Admin / Supervisor', 160, footY);
  doc.line(geo.marginLeft, footY + SIGNATURE_LINE_OFFSET, 70, footY + SIGNATURE_LINE_OFFSET);
  doc.line(90, footY + SIGNATURE_LINE_OFFSET, 146, footY + SIGNATURE_LINE_OFFSET);
  doc.line(160, footY + SIGNATURE_LINE_OFFSET, 216, footY + SIGNATURE_LINE_OFFSET);
}

// ── Page numbering ───────────────────────────────────────────────────────────

export type PdfPageRange = {
  startPage: number;
  endPage: number;
};

export function stampPageNumbers(doc: jsPDF, pageRanges?: PdfPageRange[]): void {
  const geo = getPageGeometry(doc);

  if (pageRanges) {
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
// idx:  0-No  1-Lokasi  2-Material  3-Description  4-DO  5-BinToBin  6-Batch  7-ExpDate  8-QtyPick  9-UOM  10-Sisa  11-✓

// ── Picklist PDF rendering ──────────────────────────────────────────────────

export function renderPicklistPdfPage(doc: jsPDF, pl: Picklist, pickfaces?: Map<string, { location: string }>) {
  const geo = getPageGeometry(doc);
  const headerH = picklistHeaderHeight(doc, pl, geo);
  const tableStartY = geo.marginTop + headerH;

  const head = [['No', 'Lokasi', 'Material', 'Description', 'Bin To Bin', 'Batch', 'Exp Date', 'Qty Pick', 'UOM', 'Sisa', '✓']];
  const body: any[][] = [];
  let lastPickType: string | null = null;
  for (const l of pl.lines) {
    if (lastPickType !== l.pickType) {
      const label = l.pickType === 'CASE' ? '— HANDPICK / ECERAN —' : '— FORKLIFT / FULL PALLET —';
      body.push([{ content: label, colSpan: 11, styles: { fillColor: [230, 230, 230], fontStyle: 'bold', halign: 'center', textColor: [0, 0, 0] } }]);
      lastPickType = l.pickType;
    }
    const pfLoc = pickfaces?.get(l.sku)?.location ?? '';
    const srcLevel = parseLocation(l.location)?.level ?? '';
    const keLokasi = srcLevel !== 'A' && l.qtyRemainingInBin > 0 && pfLoc && l.location !== pfLoc ? pfLoc : '';
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

  autoTable(doc, {
    startY: tableStartY,
    head,
    body,
    theme: 'grid',
    pageBreak: 'auto',
    rowPageBreak: 'auto',
    showHead: 'everyPage',
    margin: {
      left: geo.marginLeft,
      right: geo.marginRight,
      top: tableStartY,
      bottom: SIGNATURE_BLOCK_HEIGHT,
    },
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
      1: { fontStyle: 'bold' },
      3: { overflow: 'linebreak' },
      4: { fontStyle: 'bold' },
      7: { halign: 'right' },
      9: { halign: 'right' },
      10: { halign: 'center' },
    },
    didDrawPage() {
      drawPicklistHeader(doc, pl, geo);
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

  const finalY = (doc as any).lastAutoTable?.finalY ?? tableStartY + 20;
  drawSignatures(doc, finalY, geo);
}

// ── Generate all picklist PDFs ──────────────────────────────────────────────

export function generatePicklistPdfs(
  result: AllocationResult,
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

  return pdfs;
}
