import { inflateRawSync } from "node:zlib";
import { diffCells, SheetDiff } from "./tabular";

const maxEntryXmlLength = 8_000_000;

function findEndOfCentralDirectory(buffer: Buffer): number {
  const minEOCD = 22;
  const maxCommentLength = 65535;
  const start = Math.max(0, buffer.length - minEOCD - maxCommentLength);
  for (let i = buffer.length - minEOCD; i >= start; i--) {
    if (buffer.length - i >= 4 && buffer.readUInt32LE(i) === 0x06054b50)
      return i;
  }
  throw new Error("Not a valid .xlsx package (missing end of central directory)");
}

function readZipEntries(buffer: Buffer): Map<string, Buffer> {
  const eocd = findEndOfCentralDirectory(buffer);
  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map<string, Buffer>();
  let offset = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50)
      throw new Error("Corrupt .xlsx package (bad central directory entry)");
    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString("utf8");
    offset += 46 + nameLength + extraLength + commentLength;

    const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    const data =
      compressionMethod === 0
        ? Buffer.from(compressed)
        : compressionMethod === 8
          ? inflateRawSync(compressed)
          : null;
    if (!data)
      throw new Error(`Unsupported .xlsx compression method ${compressionMethod}`);
    entries.set(name, data);
  }
  return entries;
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, "&");
}

function columnLettersToIndex(letters: string): number {
  let index = 0;
  for (const char of letters) index = index * 26 + (char.charCodeAt(0) - 64);
  return index - 1;
}

function splitCellRef(ref: string): { col: number; row: number } {
  const match = /^([A-Z]+)(\d+)$/.exec(ref)!;
  return { col: columnLettersToIndex(match[1]), row: parseInt(match[2], 10) - 1 };
}

function parseSharedStrings(xml: string | undefined): string[] {
  if (!xml) return [];
  const strings: string[] = [];
  const siRegex = /<si[^>]*>([\s\S]*?)<\/si>/g;
  let match: RegExpExecArray | null;
  while ((match = siRegex.exec(xml))) {
    const parts: string[] = [];
    const tRegex = /<t[^>]*>([\s\S]*?)<\/t>/g;
    let textMatch: RegExpExecArray | null;
    while ((textMatch = tRegex.exec(match[1]))) parts.push(decodeXmlEntities(textMatch[1]));
    strings.push(parts.join(""));
  }
  return strings;
}

function parseWorksheet(xml: string, sharedStrings: string[]): Map<string, string> {
  const grid = new Map<string, string>();
  const cellRegex = /<c r="([A-Z]+\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let match: RegExpExecArray | null;
  while ((match = cellRegex.exec(xml))) {
    const [, ref, attrs, inner = ""] = match;
    const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
    let value: string | undefined;
    if (type === "inlineStr") {
      const text = /<t[^>]*>([\s\S]*?)<\/t>/.exec(inner)?.[1];
      value = text !== undefined ? decodeXmlEntities(text) : "";
    } else {
      const raw = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      if (raw === undefined) continue;
      value =
        type === "s"
          ? (sharedStrings[Number(raw)] ?? "")
          : type === "b"
            ? raw === "1"
              ? "TRUE"
              : "FALSE"
            : decodeXmlEntities(raw);
    }
    if (value) grid.set(ref, value);
  }
  return grid;
}

function parseWorkbookSheets(xml: string): { name: string; rId: string }[] {
  const sheets: { name: string; rId: string }[] = [];
  const sheetRegex = /<sheet\b[^>]*\/>/g;
  let match: RegExpExecArray | null;
  while ((match = sheetRegex.exec(xml))) {
    const tag = match[0];
    const name = /\bname="([^"]*)"/.exec(tag)?.[1];
    const rId = /\br:id="([^"]*)"/.exec(tag)?.[1];
    if (name && rId) sheets.push({ name: decodeXmlEntities(name), rId });
  }
  return sheets;
}

function parseRelationships(xml: string): Map<string, string> {
  const map = new Map<string, string>();
  const relRegex = /<Relationship\b[^>]*\/>/g;
  let match: RegExpExecArray | null;
  while ((match = relRegex.exec(xml))) {
    const tag = match[0];
    const id = /\bId="([^"]*)"/.exec(tag)?.[1];
    const target = /\bTarget="([^"]*)"/.exec(tag)?.[1];
    if (id && target) map.set(id, target);
  }
  return map;
}

export interface WorkbookSheet {
  name: string;
  cells: Map<string, string>;
  maxRow: number;
  maxCol: number;
}

export interface Workbook {
  sheets: WorkbookSheet[];
}

export function readWorkbook(bytes: Uint8Array): Workbook {
  const buffer = Buffer.from(bytes);
  const entries = readZipEntries(buffer);
  const workbookXml = entries.get("xl/workbook.xml")?.toString("utf8");
  if (!workbookXml) throw new Error("Not a recognized .xlsx workbook");
  const relsXml = entries.get("xl/_rels/workbook.xml.rels")?.toString("utf8") ?? "";
  const sharedStrings = parseSharedStrings(entries.get("xl/sharedStrings.xml")?.toString("utf8"));
  const relationships = parseRelationships(relsXml);
  const sheets = parseWorkbookSheets(workbookXml).map(({ name, rId }) => {
    const target = relationships.get(rId);
    const path = target ? (target.startsWith("/") ? target.slice(1) : `xl/${target}`) : undefined;
    const sheetBuffer = path ? entries.get(path) : undefined;
    const sheetXml = sheetBuffer?.toString("utf8");
    if (sheetXml && sheetXml.length > maxEntryXmlLength)
      throw new Error(`Worksheet "${name}" is too large to preview`);
    const cells = sheetXml ? parseWorksheet(sheetXml, sharedStrings) : new Map<string, string>();
    let maxRow = 0,
      maxCol = 0;
    for (const ref of cells.keys()) {
      const { row, col } = splitCellRef(ref);
      if (row > maxRow) maxRow = row;
      if (col > maxCol) maxCol = col;
    }
    return { name, cells, maxRow, maxCol };
  });
  return { sheets };
}

export function diffWorkbooks(before: Workbook | undefined, after: Workbook | undefined): SheetDiff[] {
  const names = new Set<string>([
    ...(before?.sheets.map((sheet) => sheet.name) ?? []),
    ...(after?.sheets.map((sheet) => sheet.name) ?? []),
  ]);
  return [...names].map((name) => {
    const beforeSheet = before?.sheets.find((sheet) => sheet.name === name);
    const afterSheet = after?.sheets.find((sheet) => sheet.name === name);
    return {
      name,
      rows: Math.max(beforeSheet?.maxRow ?? 0, afterSheet?.maxRow ?? 0) + 1,
      cols: Math.max(beforeSheet?.maxCol ?? 0, afterSheet?.maxCol ?? 0) + 1,
      status: diffCells(beforeSheet?.cells, afterSheet?.cells),
      before: beforeSheet?.cells ?? new Map(),
      after: afterSheet?.cells ?? new Map(),
    };
  });
}
