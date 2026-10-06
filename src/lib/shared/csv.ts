import { DIRECTORY_STATUSES, type DirectoryStatus } from "./constants";

export type CsvRow = Record<string, string>;

/**
 * RFC 4180 CSV parser.
 *
 * Handles quoted fields, escaped quotes (""), embedded newlines and both CRLF
 * and LF line endings. Written by hand rather than pulled in as a dependency
 * because the import path is the only thing needed and the file is small.
 */
export function parseCsv(input: string): string[][] {
  const text = (input ?? "").replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\r") {
      // handled by the \n branch
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  // Flush the trailing field/row if the file did not end with a newline.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

/**
 * Parses CSV into objects keyed by a normalised header name.
 *
 * Headers are matched case-insensitively and ignoring spaces/underscores so
 * `Employee ID`, `employeeId` and `employee_id` all resolve to the same field.
 */
export function parseCsvObjects(input: string): CsvRow[] {
  const rows = parseCsv(input);
  if (rows.length === 0) return [];

  const headers = rows[0].map((header) => normalizeHeader(header));
  const out: CsvRow[] = [];

  for (let i = 1; i < rows.length; i += 1) {
    const record: CsvRow = {};
    headers.forEach((header, index) => {
      if (!header) return;
      record[header] = (rows[i][index] ?? "").trim();
    });
    out.push(record);
  }

  return out;
}

function normalizeHeader(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}

/** Escapes a value for CSV output. */
function escapeCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/** Serialises rows to CSV with a header line and CRLF line endings. */
export function toCsv(headers: string[], rows: Array<Record<string, unknown>>): string {
  const lines = [headers.map(escapeCell).join(",")];
  for (const row of rows) {
    lines.push(headers.map((header) => escapeCell(row[header])).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

export function isDirectoryStatus(value: string): value is DirectoryStatus {
  return (DIRECTORY_STATUSES as readonly string[]).includes(value);
}