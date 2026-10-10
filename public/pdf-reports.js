const PAGE_WIDTH = 210;
const PAGE_HEIGHT = 297;
const MARGIN = 12;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const FOOTER_Y = PAGE_HEIGHT - 7;
const INK = [23, 48, 77];
const BLUE = [12, 69, 184];
const PALE_BLUE = [237, 243, 255];
const LINE = [154, 169, 188];
const ROW_HEIGHT = 6;

const MONTH_FORMATTER = new Intl.DateTimeFormat('en-US', {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});
const DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  month: 'long',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});

function monthLabel(month) {
  const [year, monthIndex] = month.split('-').map(Number);
  return MONTH_FORMATTER.format(new Date(Date.UTC(year, monthIndex - 1, 1, 12)));
}

function fullDate(date) {
  return DATE_FORMATTER.format(new Date(`${date}T12:00:00Z`));
}

function display(value) {
  return value === null || value === undefined || String(value).trim() === ''
    ? '—'
    : String(value);
}

function shiftName(shift) {
  return ({
    morning: 'Morning',
    afternoon: 'Afternoon',
    evening: 'Straight Day',
    night: 'Night',
  })[shift] || display(shift);
}

function statusName(status) {
  return ({
    received: 'Received',
    pending: 'Pending Dispatch',
    dispatched: 'Dispatched',
  })[status] || display(status);
}

function safeText(value) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ');
}

function drawBrand(doc, { companyName = 'MK Business Company Ltd.', companyInfo = {}, logoData, title, subtitle }) {
  let left = MARGIN;
  if (logoData) {
    doc.addImage(logoData, 'PNG', MARGIN, MARGIN, 38, 16, undefined, 'FAST');
    left = 55;
  }
  doc.setTextColor(...BLUE);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.text(doc.splitTextToSize(safeText(companyName), PAGE_WIDTH - left - MARGIN)[0], left, MARGIN + 5);
  doc.setFontSize(12);
  doc.text(doc.splitTextToSize(safeText(title), PAGE_WIDTH - MARGIN * 2), MARGIN, 36);
  doc.setTextColor(...INK);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(doc.splitTextToSize(safeText(subtitle), CONTENT_WIDTH), MARGIN, 42);

  const info = [
    companyInfo.poBox && `P.O. Box ${companyInfo.poBox}`,
    companyInfo.address,
    companyInfo.phone,
    companyInfo.email,
  ].filter(Boolean).join(' | ');
  if (info) {
    doc.setFontSize(7.5);
    doc.setTextColor(101, 115, 138);
    doc.text(doc.splitTextToSize(safeText(info), CONTENT_WIDTH), MARGIN, 47);
    doc.setTextColor(...INK);
    return 52;
  }
  return 47;
}

function drawPageHeading(doc, title, continuation = false) {
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...BLUE);
  doc.text(safeText(title) + (continuation ? ' (continued)' : ''), MARGIN, MARGIN + 3);
  doc.setTextColor(...INK);
  return MARGIN + 8;
}

function drawTableHeader(doc, y, labels, widths) {
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.5);
  const linesByCell = labels.map((label, index) => doc.splitTextToSize(safeText(label), widths[index] - 3));
  const height = Math.max(8, ...linesByCell.map((lines) => lines.length * 3.5 + 3));
  let x = MARGIN;
  labels.forEach((label, index) => {
    doc.setFillColor(...PALE_BLUE);
    doc.setDrawColor(...LINE);
    doc.rect(x, y, widths[index], height, 'FD');
    doc.text(linesByCell[index], x + 1.5, y + 3.3);
    x += widths[index];
  });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  return y + height;
}

function drawTableRow(doc, y, cells, widths, { numericColumn } = {}) {
  const linesByCell = cells.map((cell, index) =>
    doc.splitTextToSize(safeText(cell), widths[index] - 3));
  const height = Math.max(7, ...linesByCell.map((lines) => lines.length * 3.4 + 3));
  return drawTableRowLines(doc, y, linesByCell, widths, height, numericColumn);
}

function drawTableRowLines(doc, y, linesByCell, widths, height, numericColumn) {
  let x = MARGIN;
  linesByCell.forEach((lines, index) => {
    doc.setDrawColor(...LINE);
    doc.rect(x, y, widths[index], height);
    if (index === numericColumn) doc.text(lines, x + widths[index] - 1.5, y + 3.2, { align: 'right' });
    else doc.text(lines, x + 1.5, y + 3.2);
    x += widths[index];
  });
  return y + height;
}

function addPageNumberFooters(doc, identification) {
  const pageCount = doc.getNumberOfPages();
  for (let page = 1; page <= pageCount; page += 1) {
    doc.setPage(page);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(101, 115, 138);
    doc.text(safeText(identification), MARGIN, FOOTER_Y);
    doc.text(`Page ${page} of ${pageCount}`, PAGE_WIDTH - MARGIN, FOOTER_Y, { align: 'right' });
  }
  doc.setTextColor(...INK);
}

function makePdf(jsPDF) {
  if (typeof jsPDF !== 'function') throw new Error('The PDF generator is not available.');
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
  doc.setProperties({ creator: 'Laundry Tracking', author: 'MK Business Company Ltd.' });
  return doc;
}

function drawPaginatedRows(doc, {
  records,
  y,
  widths,
  getCells,
  breakPage,
  numericColumn,
}) {
  const bottom = FOOTER_Y - 2;
  for (const record of records) {
    const linesByCell = getCells(record).map((cell, index) =>
      doc.splitTextToSize(safeText(cell), widths[index] - 3));
    const requiredLines = Math.max(...linesByCell.map((lines) => lines.length), 1);
    let offset = 0;
    while (offset < requiredLines) {
      const capacity = Math.floor((bottom - y - 3) / 3.4);
      if (capacity < 1) {
        y = breakPage();
        continue;
      }
      const end = Math.min(offset + capacity, requiredLines);
      const fragment = linesByCell.map((lines) => lines.slice(offset, end));
      const fragmentLineCount = Math.max(...fragment.map((lines) => lines.length), 1);
      const height = Math.max(7, fragmentLineCount * 3.4 + 3);
      if (y + height > bottom) {
        y = breakPage();
        continue;
      }
      y = drawTableRowLines(doc, y, fragment, widths, height, numericColumn);
      offset = end;
      if (offset < requiredLines) y = breakPage();
    }
  }
  return y;
}

function drawReportTableRows(doc, { dateHeading, records, initialY, widths, getCells, labels }) {
  let y = initialY ?? drawPageHeading(doc, dateHeading);
  if (initialY !== undefined) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(...BLUE);
    doc.text(safeText(dateHeading), MARGIN, y + 3);
    doc.setTextColor(...INK);
    y += 8;
  }
  y = drawTableHeader(doc, y, labels, widths);
  return drawPaginatedRows(doc, {
    records,
    y,
    widths,
    getCells,
    breakPage: () => {
      doc.addPage();
      const continuedHeading = `${dateHeading} (continued)`;
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.setTextColor(...BLUE);
      doc.text(safeText(continuedHeading), MARGIN, MARGIN + 3);
      doc.setTextColor(...INK);
      const continuedY = MARGIN + 8;
      const tableY = drawTableHeader(doc, continuedY, labels, widths);
      y = tableY;
      return y;
    },
  });
}

export function createDailyMonthlyReportPdf({
  jsPDF,
  report,
  companyName,
  companyInfo,
  logoData,
}) {
  const doc = makePdf(jsPDF);
  const identification = `${report.monthLabel} Day-by-Day Laundry Summary`;
  let firstDay = true;

  for (const day of report.days) {
    let initialY;
    if (firstDay) {
      initialY = drawBrand(doc, {
        companyName,
        companyInfo,
        logoData,
        title: `${report.monthLabel} Day-by-Day Laundry Summary`,
        subtitle: `Daily records from ${fullDate(`${report.month}-01`)} through ${fullDate(`${report.month}-${String(report.dayCount).padStart(2, '0')}`)}`,
      });
      firstDay = false;
    } else {
      doc.addPage();
    }
    drawReportTableRows(doc, {
      dateHeading: `${day.dateLabel} - Daily Laundry Records`,
      records: day.records,
      initialY,
      labels: ['Date / Shift', 'Material', 'Color', 'Quantity', 'Name / Signature - Laundry Personnel', 'Verified By', 'Status'],
      widths: [22, 25, 21, 16, 49, 34, 19],
      getCells: (record) => [
        `${record.date.slice(0, 10)} / ${shiftName(record.shift)}`,
        display(record.material),
        display(record.color),
        display(record.quantity),
        `Name: ${display(record.laundryPersonnel)}\nSignature: ${display(record.signature)}`,
        display(record.verifiedBy),
        statusName(record.status),
      ],
    });
  }

  if (report.days.length === 0) {
    drawBrand(doc, {
      companyName,
      companyInfo,
      logoData,
      title: `${report.monthLabel} Day-by-Day Laundry Summary`,
      subtitle: `No records were found from ${fullDate(`${report.month}-01`)} through ${fullDate(`${report.month}-${String(report.dayCount).padStart(2, '0')}`)}.`,
    });
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.text('No records were found for this month.', MARGIN, 66);
  }

  doc.addPage();
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.setTextColor(...BLUE);
  doc.text('Monthly Dates Without Records', MARGIN, 24);
  doc.setTextColor(...INK);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(identification, MARGIN, 31);
  let y = 41;
  if (report.missingDates.length === 0) {
    doc.text('All dates in this month have recorded entries.', MARGIN, y);
  } else {
    for (const { date, dateLabel } of report.missingDates) {
      const lines = doc.splitTextToSize(`${dateLabel} - No records entered.`, CONTENT_WIDTH);
      if (y + lines.length * 5 > FOOTER_Y - 2) {
        doc.addPage();
        y = drawPageHeading(doc, 'Monthly Dates Without Records', true);
      }
      doc.text(lines, MARGIN, y);
      y += lines.length * 5 + 2;
    }
  }
  addPageNumberFooters(doc, identification);
  return doc;
}

export function createMonthlyRevenuePdf({ jsPDF, revenue, month, companyName, companyInfo, logoData }) {
  const doc = makePdf(jsPDF);
  const title = 'Monthly Laundry Revenue Report';
  const label = monthLabel(month);
  const identification = `${title} - ${label}`;
  let y = drawBrand(doc, {
    companyName,
    companyInfo,
    logoData,
    title,
    subtitle: `Billing period: ${label}`,
  }) + 4;
  const widths = [43, 35, 30, 37, 41];
  const labels = ['Item', 'Color', 'Monthly Quantity', 'Unit Price', 'Total Amount'];
  y = drawTableHeader(doc, y, labels, widths);
  const revenueCells = (line) => [
      display(line.material),
      display(line.color),
      String(line.quantity),
      line.unitPriceCents === null ? '—' : formatCentsForPdf(line.unitPriceCents),
      line.amountCents === null ? 'Set a unit price' : formatCentsForPdf(line.amountCents),
    ];
  y = drawPaginatedRows(doc, {
    records: revenue.lines,
    y,
    widths,
    getCells: revenueCells,
    numericColumn: 2,
    breakPage: () => {
      doc.addPage();
      return drawTableHeader(doc, drawPageHeading(doc, `${label} Revenue - Continued`), labels, widths);
    },
  });
  if (y + 10 > FOOTER_Y - 2) {
    doc.addPage();
    y = drawPageHeading(doc, `${label} Revenue - Continued`);
  }
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text('Grand Monthly Total', MARGIN + 3, y + 6);
  doc.text(formatCentsForPdf(revenue.grandTotalCents), PAGE_WIDTH - MARGIN - 3, y + 6, { align: 'right' });
  y += 12;
  if (!revenue.complete) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(159, 63, 63);
    doc.text('Some recorded quantities do not have a unit price; the grand total excludes those amounts.', MARGIN, y);
  }
  addPageNumberFooters(doc, identification);
  return doc;
}

function formatCentsForPdf(value) {
  const cents = BigInt(value || 0);
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}

export function createInvoicePdf({ jsPDF, invoice, companyInfo, logoData }) {
  const doc = makePdf(jsPDF);
  const title = `Monthly Laundry Invoice ${invoice.invoiceNumber}`;
  const label = invoice.month;
  let y = drawBrand(doc, {
    companyName: companyInfo?.name || invoice.companyInfo?.name || 'MK Business Company Ltd.',
    companyInfo: companyInfo || invoice.companyInfo,
    logoData,
    title: 'MONTHLY LAUNDRY STATEMENT - INVOICE',
    subtitle: `Invoice ${invoice.invoiceNumber} | Billing period ${label} | Date ${String(invoice.generatedAt || '').slice(0, 10)}`,
  }) + 3;
  const billTo = invoice.billTo || {};
  const billToLines = [
    `Bill To: ${billTo.recipientName || ''}`,
    billTo.companyName,
    billTo.street,
    billTo.city,
    billTo.phone,
    billTo.email,
  ].filter(Boolean);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.text('Bill To', MARGIN, y + 4);
  y += 8;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  for (const line of billToLines) {
    const lines = doc.splitTextToSize(safeText(line), CONTENT_WIDTH);
    doc.text(lines, MARGIN, y);
    y += lines.length * 4 + 1;
  }
  y += 2;
  const widths = [48, 38, 27, 36, 37];
  const labels = ['Item', 'Color', 'Quantity', 'Unit Price', 'Amount'];
  y = drawTableHeader(doc, y, labels, widths);
  const items = Array.isArray(invoice.lineItems) ? invoice.lineItems : [];
  const invoiceCells = (line) => [
      display(line.item),
      display(line.color),
      String(line.quantity),
      formatCentsForPdf(line.unitPriceCents),
      formatCentsForPdf(line.amountCents),
    ];
  if (!items.length) {
    y = drawTableRow(doc, y, ['No active laundry items were recorded.', '', '', '', ''], widths);
  }
  y = drawPaginatedRows(doc, {
    records: items,
    y,
    widths,
    getCells: invoiceCells,
    breakPage: () => {
      doc.addPage();
      return drawTableHeader(doc, drawPageHeading(doc, `${title} - Continued`), labels, widths);
    },
  });
  if (y + 12 > FOOTER_Y) {
    doc.addPage();
    y = drawPageHeading(doc, `${title} - Continued`);
  }
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text('Grand Monthly Total', MARGIN + 3, y + 6);
  doc.text(formatCentsForPdf(invoice.grandTotalCents), PAGE_WIDTH - MARGIN - 3, y + 6, { align: 'right' });
  addPageNumberFooters(doc, title);
  return doc;
}

export function createDailyRegisterPdf({ jsPDF, date, records, companyName, companyInfo, logoData }) {
  const doc = makePdf(jsPDF);
  const title = `Daily Register - ${fullDate(date)}`;
  let y = drawBrand(doc, {
    companyName,
    companyInfo,
    logoData,
    title,
    subtitle: 'Daily Laundry Records',
  }) + 4;
  if (!records.length) {
    doc.setFontSize(11);
    doc.text(`No records are available for ${fullDate(date)}.`, MARGIN, y + 4);
    addPageNumberFooters(doc, title);
    return doc;
  }

  const shifts = ['morning', 'afternoon', 'evening', 'night'];
  const shiftOrder = new Map(shifts.map((shift, index) => [shift, index]));
  const groups = new Map(shifts.map((shift) => [shift, []]));
  for (const record of records) {
    const shift = groups.has(record.shift) ? record.shift : 'morning';
    groups.get(shift).push(record);
  }
  const labels = ['Date / Shift', 'Material', 'Color', 'Quantity', 'Name / Signature - Laundry Personnel', 'Verified By', 'Status'];
  const widths = [22, 25, 21, 16, 49, 34, 19];
  let firstGroup = true;
  for (const shift of [...groups.keys()].sort((left, right) => shiftOrder.get(left) - shiftOrder.get(right))) {
    const rows = groups.get(shift);
    if (!rows.length) continue;
    if (!firstGroup && y + 14 > FOOTER_Y) {
      doc.addPage();
      y = drawPageHeading(doc, title, true);
    }
    const shiftHeading = `${shiftName(shift)} Shift`;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.text(shiftHeading, MARGIN, y);
    y += 3;
    y = drawTableHeader(doc, y, labels, widths);
    firstGroup = false;
    y = drawPaginatedRows(doc, {
      records: rows,
      y,
      widths,
      getCells: (record) => [
        `${fullDate(date)} / ${shiftName(record.shift)}`,
        display(record.material),
        display(record.color),
        display(record.quantity),
        `Name: ${display(record.laundryPersonnel)}\nSignature: ${display(record.signature)}`,
        display(record.verifiedBy),
        statusName(record.status),
      ],
      breakPage: () => {
        doc.addPage();
        let continuedY = drawPageHeading(doc, title, true);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(9);
        doc.text(`${shiftHeading} - Continued`, MARGIN, continuedY);
        continuedY += 3;
        return drawTableHeader(doc, continuedY, labels, widths);
      },
    });
    y += 4;
  }
  addPageNumberFooters(doc, title);
  return doc;
}

export function createPdfFilename(report, month) {
  const date = month || report?.month;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(date || ''))) {
    throw new Error('A valid month is required to name the PDF.');
  }
  const label = monthLabel(date).replace(/\s+/g, '_');
  return `Laundry_${report ? 'Daily_Monthly' : 'Revenue'}_Report_${label}.pdf`;
}

export function savePdfFile(doc, filename, {
  navigatorObject = globalThis.navigator,
  documentObject = globalThis.document,
  urlObject = globalThis.URL,
  fileConstructor = globalThis.File,
  schedule = globalThis.setTimeout,
} = {}) {
  const blob = doc.output('blob');
  if (!(blob instanceof Blob) || blob.size === 0) throw new Error('PDF generation returned an empty file.');
  const file = fileConstructor ? new fileConstructor([blob], filename, { type: 'application/pdf' }) : null;
  const download = () => {
    if (!documentObject?.createElement || !urlObject?.createObjectURL) {
      throw new Error('This device does not support saving PDF files from the app.');
    }
    const objectUrl = urlObject.createObjectURL(blob);
    const link = documentObject.createElement('a');
    link.href = objectUrl;
    link.download = filename;
    link.rel = 'noopener';
    link.style.display = 'none';
    documentObject.body.appendChild(link);
    link.click();
    link.remove();
    schedule(() => urlObject.revokeObjectURL(objectUrl), 60_000);
    return 'downloaded';
  };
  if (file && navigatorObject?.canShare?.({ files: [file] }) && navigatorObject.share) {
    return navigatorObject.share({ files: [file], title: filename })
      .then(() => 'shared')
      .catch((error) => {
        if (error?.name === 'AbortError') return 'cancelled';
        return download();
      });
  }
  return Promise.resolve(download());
}
