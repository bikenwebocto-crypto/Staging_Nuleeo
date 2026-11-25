// Bank-statement CSV parsing (upload) and ledger CSV building (export).
//
// Banks disagree on everything, so the parser is lenient:
//   • delimiter: , ; or tab (sniffed from the header line)
//   • columns: matched by header name — a signed "Amount" column, or separate
//     Debit / Credit (money out / money in) columns
//   • dates: ISO (2026-09-08), or day-first DD/MM/YYYY, DD.MM.YYYY, DD-MM-YYYY
//   • amounts: "1,234.56", "1.234,56", "-61", "€ 61.00", "(61.00)"
import type { BankMovementUpload } from "./ownerQueries";

export interface ParsedStatement {
  movements: BankMovementUpload[];
  skipped: number; // rows we couldn't read (bad date / amount)
  error?: string; // fatal: no usable columns found
}

function splitCsv(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === delim) {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

const norm = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^a-z]/g, " ")
    .replace(/\s+/g, " ");

function findCol(headers: string[], patterns: RegExp[]): number {
  for (const p of patterns) {
    const i = headers.findIndex((h) => p.test(h));
    if (i >= 0) return i;
  }
  return -1;
}

export function parseAmount(raw: string | undefined): number | null {
  if (!raw) return null;
  let s = raw.trim();
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  if (/-$/.test(s)) {
    neg = true;
    s = s.slice(0, -1);
  }
  s = s.replace(/[^\d.,-]/g, "");
  if (s.startsWith("-")) {
    neg = !neg;
    s = s.slice(1);
  }
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  if (lastComma > lastDot) {
    // "1.234,56" or "61,00" → comma is the decimal separator
    s = s.replace(/\./g, "").replace(",", ".");
  } else {
    s = s.replace(/,/g, "");
  }
  const n = Number(s);
  if (!Number.isFinite(n) || s === "") return null;
  return neg ? -n : n;
}

export function parseDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
  if (m) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    let d = +m[1];
    let mo = +m[2];
    // Day-first by default; flip only when that's impossible (US export).
    if (mo > 12 && d <= 12) [d, mo] = [mo, d];
    return iso(y, mo, d);
  }
  const t = new Date(s);
  return isNaN(t.getTime()) ? null : t.toISOString().slice(0, 10);
}

function iso(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  return dt.toISOString().slice(0, 10);
}

export function parseBankCsv(text: string): ParsedStatement {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const firstLine = clean.split(/\r?\n/, 1)[0] ?? "";
  const delim = [";", "\t", ","].reduce((best, d) =>
    firstLine.split(d).length > firstLine.split(best).length ? d : best,
  );
  const rows = splitCsv(clean, delim);
  if (rows.length < 2) return { movements: [], skipped: 0, error: "The file has no data rows." };

  const headers = rows[0].map(norm);
  const dateCol = findCol(headers, [
    /^date$/,
    /booking date/,
    /transaction date/,
    /posting date/,
    /value date/,
    /date/,
  ]);
  const descCol = findCol(headers, [
    /description/,
    /details/,
    /narrative/,
    /payee/,
    /merchant/,
    /reference/,
    /memo/,
    /name/,
    /particulars/,
  ]);
  const amountCol = findCol(headers, [/^amount$/, /amount/, /^value$/, /^sum$/]);
  const debitCol = findCol(headers, [/debit/, /withdraw/, /money out/, /paid out/, /^out$/]);
  const creditCol = findCol(headers, [/credit/, /deposit/, /money in/, /paid in/, /^in$/]);
  const currencyCol = findCol(headers, [/currency/, /^ccy$/]);

  if (dateCol < 0) return { movements: [], skipped: 0, error: "No date column found." };
  if (amountCol < 0 && debitCol < 0 && creditCol < 0) {
    return { movements: [], skipped: 0, error: "No amount (or debit/credit) column found." };
  }

  const movements: BankMovementUpload[] = [];
  let skipped = 0;
  for (const r of rows.slice(1)) {
    const date = parseDate(r[dateCol]);
    let amount: number | null = null;
    if (amountCol >= 0) amount = parseAmount(r[amountCol]);
    if (amount === null || amount === 0) {
      const out = debitCol >= 0 ? parseAmount(r[debitCol]) : null;
      const inn = creditCol >= 0 ? parseAmount(r[creditCol]) : null;
      if (inn) amount = Math.abs(inn);
      else if (out) amount = -Math.abs(out);
    }
    if (!date || amount === null || amount === 0) {
      skipped++;
      continue;
    }
    const currency = currencyCol >= 0 ? r[currencyCol]?.trim().toUpperCase() : "";
    movements.push({
      date,
      amount: Math.round(amount * 100) / 100,
      description: (descCol >= 0 ? r[descCol]?.trim() : "") || "Bank movement",
      ...(/^[A-Z]{3}$/.test(currency ?? "") ? { currency } : {}),
    });
  }
  return { movements, skipped };
}

// ---------------------------------------------------------------- export

const cell = (v: unknown) => {
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  const s = v === null || v === undefined ? "" : String(v);
  // Quote always; neutralise spreadsheet formula injection.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
};

export function downloadCsv(filename: string, header: string[], rows: unknown[][]): void {
  const body = [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n");
  // BOM so Excel opens UTF-8 (€, Greek names) correctly.
  const blob = new Blob([String.fromCharCode(0xfeff) + body], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
