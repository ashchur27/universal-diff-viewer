import { columnIndexToLetters, diffCells, SheetDiff } from "./tabular";

function countOutsideQuotes(text: string, delimiter: string): number {
  let count = 0;
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') {
      if (inQuotes && text[i + 1] === '"') i++;
      else inQuotes = !inQuotes;
    } else if (!inQuotes && text[i] === delimiter) count++;
  }
  return count;
}

export function detectCsvDelimiter(text: string): string {
  const sample = text.slice(0, 16_384);
  return [",", ";", "\t"].reduce((best, delimiter) =>
    countOutsideQuotes(sample, delimiter) > countOutsideQuotes(sample, best)
      ? delimiter
      : best,
  );
}

export function parseCsv(text: string, delimiter = detectCsvDelimiter(text)): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const normalized = text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i];
    if (inQuotes) {
      if (char === '"') {
        if (normalized[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += char;
      continue;
    }
    if (char === '"') inQuotes = true;
    else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += char;
  }
  row.push(field);
  if (row.length > 1 || row[0] !== "") rows.push(row);
  return rows;
}

function cellsFromRows(rows: string[][]): { cells: Map<string, string>; maxRow: number; maxCol: number } {
  const cells = new Map<string, string>();
  const letters: string[] = [];
  let maxRow = 0,
    maxCol = 0;
  rows.forEach((cols, r) => {
    if (cols.length) maxRow = Math.max(maxRow, r);
    cols.forEach((value, c) => {
      if (value === "") return;
      cells.set(`${(letters[c] ??= columnIndexToLetters(c))}${r + 1}`, value);
      if (c > maxCol) maxCol = c;
    });
  });
  return { cells, maxRow, maxCol };
}

export function diffCsv(
  name: string,
  before: string | undefined,
  after: string | undefined,
): SheetDiff {
  const beforeGrid = before !== undefined ? cellsFromRows(parseCsv(before)) : undefined;
  const afterGrid = after !== undefined ? cellsFromRows(parseCsv(after)) : undefined;
  return {
    name,
    rows: Math.max(beforeGrid?.maxRow ?? 0, afterGrid?.maxRow ?? 0) + 1,
    cols: Math.max(beforeGrid?.maxCol ?? 0, afterGrid?.maxCol ?? 0) + 1,
    status: diffCells(beforeGrid?.cells, afterGrid?.cells),
    before: beforeGrid?.cells ?? new Map(),
    after: afterGrid?.cells ?? new Map(),
  };
}
