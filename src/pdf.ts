import { constants, inflateSync } from "node:zlib";
import { statusBadge, statusBadgeCss } from "./tabular";

const maxPdfBytes = 20 * 1024 * 1024;
const maxPages = 500;
const maxCMapEntries = 200_000;
const maxFormDepth = 5;
const maxDiffCells = 4_000_000;
const maxTotalDiffCells = 20_000_000;
const maxStreamBytes = 32 * 1024 * 1024;
const maxInflatedBytes = 128 * 1024 * 1024;
const maxOperations = 5_000_000;
const maxFragments = 200_000;

let inflatedBytes = 0;
let operations = 0;
let diffCells = 0;
const decoded = new WeakMap<PdfObject, string>();

function tooComplex(): never {
  throw new Error("PDF is too complex to preview");
}

export interface PdfPage {
  number: number;
  text: string;
}

export interface PdfDocument {
  pages: PdfPage[];
}

interface PdfObject {
  dictionary: string;
  stream?: Buffer;
}

type Matrix = [number, number, number, number, number, number];
const identity: Matrix = [1, 0, 0, 1, 0, 0];

function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ];
}

const references = (text: string) =>
  [...text.matchAll(/(\d+)\s+\d+\s+R\b/g)].map((match) => Number(match[1]));

function decodeStream(object: PdfObject | undefined): string {
  if (!object?.stream) return "";
  const cached = decoded.get(object);
  if (cached !== undefined) return cached;
  let text = "";
  try {
    text = /\/FlateDecode\b/.test(object.dictionary)
      ? inflateSync(object.stream, {
          finishFlush: constants.Z_SYNC_FLUSH,
          maxOutputLength: maxStreamBytes,
        }).toString("latin1")
      : object.stream.toString("latin1");
  } catch {
    text = "";
  }
  inflatedBytes += text.length;
  if (inflatedBytes > maxInflatedBytes) tooComplex();
  decoded.set(object, text);
  return text;
}

function parseObjects(source: string): Map<number, PdfObject> {
  const objects = new Map<number, PdfObject>();
  const headerRegex = /(\d+)\s+\d+\s+obj\b/g;
  let match: RegExpExecArray | null;
  while ((match = headerRegex.exec(source))) {
    const end = source.indexOf("endobj", headerRegex.lastIndex);
    if (end < 0) break;
    const body = source.slice(headerRegex.lastIndex, end);
    headerRegex.lastIndex = end + 6;
    const stream = /^([\s\S]*?)\bstream\r?\n([\s\S]*?)(?:\r?\n)?endstream/.exec(body);
    objects.set(
      Number(match[1]),
      stream
        ? { dictionary: stream[1], stream: Buffer.from(stream[2], "latin1") }
        : { dictionary: body },
    );
  }
  for (const object of [...objects.values()]) {
    if (!/\/Type\s*\/ObjStm\b/.test(object.dictionary)) continue;
    const data = decodeStream(object);
    const first = Number(/\/First\s+(\d+)/.exec(object.dictionary)?.[1]);
    const count = Number(/\/N\s+(\d+)/.exec(object.dictionary)?.[1]);
    if (!data || !Number.isFinite(first) || !Number.isFinite(count)) continue;
    const header = data.slice(0, first).trim().split(/\s+/).map(Number);
    for (let index = 0; index < count && index * 2 + 1 < header.length; index++) {
      const id = header[index * 2];
      const start = first + header[index * 2 + 1];
      const end =
        index * 2 + 3 < header.length ? first + header[index * 2 + 3] : data.length;
      if (!objects.has(id)) objects.set(id, { dictionary: data.slice(start, end) });
    }
  }
  return objects;
}

function dictValue(dictionary: string, key: string): string | undefined {
  const keyRegex = new RegExp(`/${key}(?![A-Za-z0-9#._-])\\s*`, "g");
  const match = keyRegex.exec(dictionary);
  if (!match) return undefined;
  const rest = dictionary.slice(keyRegex.lastIndex);
  const reference = /^(\d+)\s+\d+\s+R\b/.exec(rest);
  if (reference) return reference[0];
  const [open, close] = rest.startsWith("<<")
    ? ["<<", ">>"]
    : rest.startsWith("[")
      ? ["[", "]"]
      : ["", ""];
  if (!open) return /^\/?[^\s/<>[\]()]+/.exec(rest)?.[0];
  let depth = 0;
  for (let index = 0; index < rest.length; ) {
    if (rest.startsWith(open, index)) {
      depth++;
      index += open.length;
    } else if (rest.startsWith(close, index)) {
      depth--;
      index += close.length;
      if (depth === 0) return rest.slice(0, index);
    } else index++;
  }
  return rest;
}

interface CMap {
  bytes: number;
  map: Map<number, string>;
}

interface Font {
  twoByte: boolean;
  cmap?: CMap;
  widths: Map<number, number>;
  defaultWidth: number;
}

function parseNumbersAndArrays(text: string): (number | number[])[] {
  const result: (number | number[])[] = [];
  let current: number[] | undefined;
  for (const token of text.matchAll(/\[|\]|[+-]?(?:\d+\.?\d*|\.\d+)/g)) {
    if (token[0] === "[") current = [];
    else if (token[0] === "]") {
      if (current) result.push(current);
      current = undefined;
    } else (current ?? result).push(Number(token[0]));
  }
  return result;
}

function cidWidths(text: string): Map<number, number> {
  const widths = new Map<number, number>();
  const items = parseNumbersAndArrays(text.replace(/^\s*\[/, "").replace(/\]\s*$/, ""));
  for (let index = 0; index < items.length && widths.size < maxCMapEntries; ) {
    const first = items[index];
    const next = items[index + 1];
    if (typeof first !== "number") {
      index++;
    } else if (Array.isArray(next)) {
      next.forEach((width, offset) => widths.set(first + offset, width));
      index += 2;
    } else if (typeof next === "number" && typeof items[index + 2] === "number") {
      const last = Math.min(next, first + 0xffff);
      for (let code = first; code <= last && widths.size < maxCMapEntries; code++)
        widths.set(code, items[index + 2] as number);
      index += 3;
    } else index++;
  }
  return widths;
}

function utf16(hex: string): string {
  let text = "";
  for (let index = 0; index + 4 <= hex.length; index += 4)
    text += String.fromCharCode(parseInt(hex.slice(index, index + 4), 16));
  if (hex.length % 4 === 2) text += String.fromCharCode(parseInt(hex.slice(-2), 16));
  return text;
}

export function parseCMap(text: string): CMap {
  const codespace = /begincodespacerange\s*<([0-9a-fA-F]+)>/.exec(text);
  const bytes = Math.max(1, Math.min(4, Math.floor((codespace?.[1].length ?? 2) / 2)));
  const map = new Map<number, string>();
  for (const section of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g))
    for (const entry of section[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) {
      if (map.size >= maxCMapEntries) break;
      map.set(parseInt(entry[1], 16), utf16(entry[2]));
    }
  for (const section of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g))
    for (const entry of section[1].matchAll(
      /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]*>|\[[^\]]*\])/g,
    )) {
      const low = parseInt(entry[1], 16);
      const high = Math.min(parseInt(entry[2], 16), low + 0xffff);
      if (entry[3].startsWith("[")) {
        const targets = [...entry[3].matchAll(/<([0-9a-fA-F]*)>/g)];
        for (let code = low; code <= high && code - low < targets.length; code++) {
          if (map.size >= maxCMapEntries) break;
          map.set(code, utf16(targets[code - low][1]));
        }
      } else {
        const target = entry[3].slice(1, -1);
        const prefix = target.slice(0, -4);
        const base = parseInt(target.slice(-4) || "0", 16);
        for (let code = low; code <= high; code++) {
          if (map.size >= maxCMapEntries) break;
          map.set(code, utf16(prefix + (base + code - low).toString(16).padStart(4, "0")));
        }
      }
    }
  return { bytes, map };
}

interface Glyph {
  text: string;
  width: number;
  space: boolean;
}

function decodeGlyphs(font: Font | undefined, bytes: string): Glyph[] {
  const step = font?.cmap?.bytes ?? (font?.twoByte ? 2 : 1);
  const glyphs: Glyph[] = [];
  for (let index = 0; index + step <= bytes.length; index += step) {
    let code = 0;
    for (let offset = 0; offset < step; offset++)
      code = code * 256 + bytes.charCodeAt(index + offset);
    const text =
      font?.cmap?.map.get(code) ?? (step === 1 ? bytes[index] : "");
    glyphs.push({
      text,
      width: (font?.widths.get(code) ?? font?.defaultWidth ?? 500) / 1000,
      space: step === 1 && code === 32,
    });
  }
  return glyphs;
}

class PdfString {
  constructor(readonly bytes: string) {}
}

type Operand = number | string | boolean | null | PdfString | Operand[];

type Token =
  | { type: "operand"; value: Operand }
  | { type: "operator"; value: string }
  | { type: "arrayStart" }
  | { type: "arrayEnd" };

const delimiters = new Set([..."()<>[]{}/%"]);
const whitespace = new Set([..."\0\t\n\f\r "]);
const escapes: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" };

class Tokenizer {
  private index = 0;

  constructor(private readonly text: string) {}

  skipInlineImage() {
    const data = this.text.indexOf("ID", this.index);
    if (data < 0) {
      this.index = this.text.length;
      return;
    }
    const end = /\sEI(?=\s|$)/g;
    end.lastIndex = data + 3;
    const match = end.exec(this.text);
    this.index = match ? end.lastIndex : this.text.length;
  }

  next(): Token | undefined {
    const text = this.text;
    while (this.index < text.length) {
      const char = text[this.index];
      if (whitespace.has(char)) {
        this.index++;
        continue;
      }
      if (char === "%") {
        while (this.index < text.length && text[this.index] !== "\n" && text[this.index] !== "\r")
          this.index++;
        continue;
      }
      if (char === "[") {
        this.index++;
        return { type: "arrayStart" };
      }
      if (char === "]") {
        this.index++;
        return { type: "arrayEnd" };
      }
      if (char === "(") return { type: "operand", value: new PdfString(this.literal()) };
      if (char === "<") {
        if (text[this.index + 1] === "<") {
          this.skipDictionary();
          return { type: "operand", value: null };
        }
        const end = text.indexOf(">", this.index);
        const hex = text
          .slice(this.index + 1, end < 0 ? text.length : end)
          .replace(/[^0-9a-fA-F]/g, "");
        this.index = end < 0 ? text.length : end + 1;
        return {
          type: "operand",
          value: new PdfString(
            Buffer.from(hex.length % 2 ? hex + "0" : hex, "hex").toString("latin1"),
          ),
        };
      }
      if (char === ">" || char === ")" || char === "{" || char === "}") {
        this.index++;
        continue;
      }
      const start = this.index++;
      while (
        this.index < text.length &&
        !whitespace.has(text[this.index]) &&
        !delimiters.has(text[this.index])
      )
        this.index++;
      const word = text.slice(start, this.index);
      if (char === "/") return { type: "operand", value: word };
      if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(word)) return { type: "operand", value: Number(word) };
      if (word === "true" || word === "false") return { type: "operand", value: word === "true" };
      if (word === "null") return { type: "operand", value: null };
      return { type: "operator", value: word };
    }
    return undefined;
  }

  private skipDictionary() {
    let depth = 0;
    while (this.index < this.text.length) {
      if (this.text.startsWith("<<", this.index)) {
        depth++;
        this.index += 2;
      } else if (this.text.startsWith(">>", this.index)) {
        depth--;
        this.index += 2;
        if (depth === 0) return;
      } else if (this.text[this.index] === "(") this.literal();
      else this.index++;
    }
  }

  private literal(): string {
    const text = this.text;
    let depth = 0;
    let value = "";
    this.index++;
    while (this.index < text.length) {
      const char = text[this.index++];
      if (char === "\\") {
        const next = text[this.index++];
        if (next === undefined) break;
        if (escapes[next]) value += escapes[next];
        else if (/[0-7]/.test(next)) {
          let octal = next;
          while (octal.length < 3 && /[0-7]/.test(text[this.index] ?? ""))
            octal += text[this.index++];
          value += String.fromCharCode(parseInt(octal, 8) & 0xff);
        } else if (next === "\r") {
          if (text[this.index] === "\n") this.index++;
        } else if (next !== "\n") value += next;
      } else if (char === "(") {
        depth++;
        value += char;
      } else if (char === ")") {
        if (depth === 0) break;
        depth--;
        value += char;
      } else value += char;
    }
    return value;
  }
}

interface Fragment {
  x: number;
  y: number;
  height: number;
  width: number;
  text: string;
  order: number;
}

function layoutLines(fragments: Fragment[]): string[] {
  const sorted = [...fragments].sort((a, b) => b.y - a.y || a.x - b.x || a.order - b.order);
  const lines: Fragment[][] = [];
  for (const fragment of sorted) {
    const line = lines.at(-1);
    const tolerance = Math.max(fragment.height, line?.[0].height ?? 0) * 0.5 || 1;
    if (line && Math.abs(line[0].y - fragment.y) <= tolerance) line.push(fragment);
    else lines.push([fragment]);
  }
  return lines
    .map((line) => {
      line.sort((a, b) => a.x - b.x || a.order - b.order);
      let text = "";
      let end = -Infinity;
      for (const fragment of line) {
        if (
          text &&
          fragment.x - end > fragment.height * 0.25 &&
          !/\s$/.test(text) &&
          !/^\s/.test(fragment.text)
        )
          text += " ";
        text += fragment.text;
        end = Math.max(end, fragment.x + fragment.width);
      }
      return text.replace(/\s+/g, " ").trim();
    })
    .filter(Boolean);
}

class PdfReader {
  private readonly fonts = new Map<number, Font>();

  constructor(
    private readonly source: string,
    private readonly objects: Map<number, PdfObject>,
  ) {}

  private resolve(value: string | undefined): string {
    if (!value) return "";
    const reference = /^(\d+)\s+\d+\s+R\b/.exec(value);
    return reference ? (this.objects.get(Number(reference[1]))?.dictionary ?? "") : value;
  }

  private namedReferences(value: string | undefined): Map<string, number> {
    const result = new Map<string, number>();
    for (const match of this.resolve(value).matchAll(/\/([^\s/<>[\]()]+)\s+(\d+)\s+\d+\s+R\b/g))
      result.set(match[1], Number(match[2]));
    return result;
  }

  private font(id: number): Font {
    let font = this.fonts.get(id);
    if (!font) {
      const dictionary = this.objects.get(id)?.dictionary ?? "";
      const toUnicode = /\/ToUnicode\s+(\d+)\s+\d+\s+R\b/.exec(dictionary);
      const twoByte = /\/Subtype\s*\/Type0\b/.test(dictionary);
      let widths = new Map<number, number>();
      let defaultWidth = 500;
      if (twoByte) {
        const descendant = references(this.resolve(dictValue(dictionary, "DescendantFonts")))[0];
        const cid = descendant === undefined ? "" : (this.objects.get(descendant)?.dictionary ?? "");
        defaultWidth = Number(/\/DW\s+([+-]?[\d.]+)/.exec(cid)?.[1] ?? 1000);
        const w = dictValue(cid, "W");
        if (w) widths = cidWidths(/^\d+\s+\d+\s+R/.test(w) ? this.resolve(w) : w);
      } else {
        const firstChar = Number(/\/FirstChar\s+(\d+)/.exec(dictionary)?.[1] ?? 0);
        const list = dictValue(dictionary, "Widths");
        const values = (list && /^\d+\s+\d+\s+R/.test(list) ? this.resolve(list) : (list ?? ""))
          .match(/[+-]?(?:\d+\.?\d*|\.\d+)/g)
          ?.map(Number) ?? [];
        values.forEach((width, offset) => widths.set(firstChar + offset, width));
        const descriptor = /\/FontDescriptor\s+(\d+)\s+\d+\s+R\b/.exec(dictionary);
        const missing = descriptor
          ? /\/MissingWidth\s+([+-]?[\d.]+)/.exec(this.objects.get(Number(descriptor[1]))?.dictionary ?? "")
          : null;
        if (missing) defaultWidth = Number(missing[1]);
      }
      font = {
        twoByte,
        cmap: toUnicode
          ? parseCMap(decodeStream(this.objects.get(Number(toUnicode[1]))))
          : undefined,
        widths,
        defaultWidth: Number.isFinite(defaultWidth) ? defaultWidth : 500,
      };
      this.fonts.set(id, font);
    }
    return font;
  }

  pageOrder(): number[] {
    const isPage = (id: number) =>
      /\/Type\s*\/Page\b/.test(this.objects.get(id)?.dictionary ?? "");
    const ordered: number[] = [];
    const seen = new Set<number>();
    const visit = (id: number) => {
      if (seen.has(id) || ordered.length > maxPages) return;
      seen.add(id);
      if (isPage(id)) {
        ordered.push(id);
        return;
      }
      const kids = dictValue(this.objects.get(id)?.dictionary ?? "", "Kids");
      if (kids) references(this.resolve(kids)).forEach(visit);
    };
    const root = [...this.source.matchAll(/\/Root\s+(\d+)\s+\d+\s+R\b/g)].at(-1);
    const pages =
      root &&
      /\/Pages\s+(\d+)\s+\d+\s+R\b/.exec(this.objects.get(Number(root[1]))?.dictionary ?? "");
    if (pages) visit(Number(pages[1]));
    return ordered.length ? ordered : [...this.objects.keys()].filter(isPage);
  }

  private pageResources(id: number): string {
    const seen = new Set<number>();
    for (let current: number | undefined = id; current !== undefined && !seen.has(current); ) {
      seen.add(current);
      const dictionary = this.objects.get(current)?.dictionary ?? "";
      const resources = dictValue(dictionary, "Resources");
      if (resources) return this.resolve(resources);
      const parent = /\/Parent\s+(\d+)\s+\d+\s+R\b/.exec(dictionary);
      current = parent ? Number(parent[1]) : undefined;
    }
    return "";
  }

  pageText(id: number): string {
    const contents = dictValue(this.objects.get(id)?.dictionary ?? "", "Contents");
    const stream = contents
      ? references(contents)
          .flatMap((ref) => {
            const object = this.objects.get(ref);
            return object?.stream
              ? [object]
              : references(object?.dictionary ?? "").map((inner) => this.objects.get(inner));
          })
          .map((object) => decodeStream(object))
          .join("\n")
      : "";
    const fragments: Fragment[] = [];
    this.interpret(stream, this.pageResources(id), identity, fragments, 0);
    return layoutLines(fragments).join("\n");
  }

  private interpret(
    stream: string,
    resources: string,
    initialCtm: Matrix,
    fragments: Fragment[],
    depth: number,
  ) {
    const fonts = this.namedReferences(dictValue(resources, "Font"));
    const xObjects = this.namedReferences(dictValue(resources, "XObject"));
    let ctm = initialCtm;
    const stack: Matrix[] = [];
    let tm = identity;
    let lm = identity;
    let font: Font | undefined;
    let size = 1;
    let leading = 0;
    let charSpacing = 0;
    let wordSpacing = 0;
    const moveLine = (tx: number, ty: number) => {
      lm = multiply([1, 0, 0, 1, tx, ty], lm);
      tm = lm;
    };
    const show = (parts: (string | number)[]) => {
      let text = "";
      let advance = 0;
      for (const part of parts) {
        if (typeof part === "number") {
          if (part < -200 && text && !/\s$/.test(text)) text += " ";
          advance -= (part / 1000) * size;
        } else
          for (const glyph of decodeGlyphs(font, part)) {
            text += glyph.text;
            advance += glyph.width * size + charSpacing + (glyph.space ? wordSpacing : 0);
          }
      }
      const trm = multiply(tm, ctm);
      if (text.trim()) {
        if (fragments.length >= maxFragments) tooComplex();
        fragments.push({
          x: trm[4],
          y: trm[5],
          height: size * Math.hypot(trm[2], trm[3]),
          width: advance * Math.hypot(trm[0], trm[1]),
          text,
          order: fragments.length,
        });
      }
      tm = multiply([1, 0, 0, 1, advance, 0], tm);
    };
    const strings = (values: Operand[]) =>
      values.filter((value): value is PdfString => value instanceof PdfString);
    const operands: Operand[] = [];
    const arrays: Operand[][] = [];
    const tokenizer = new Tokenizer(stream);
    for (let token = tokenizer.next(); token; token = tokenizer.next()) {
      if (++operations > maxOperations) tooComplex();
      if (token.type === "arrayStart") {
        arrays.push([]);
        continue;
      }
      if (token.type === "arrayEnd") {
        const array = arrays.pop() ?? [];
        (arrays.at(-1) ?? operands).push(array);
        continue;
      }
      if (token.type === "operand") {
        (arrays.at(-1) ?? operands).push(token.value);
        continue;
      }
      const numbers = operands.filter((value): value is number => typeof value === "number");
      const name = [...operands]
        .reverse()
        .find((value): value is string => typeof value === "string" && value.startsWith("/"))
        ?.slice(1);
      switch (token.value) {
        case "q":
          stack.push(ctm);
          break;
        case "Q":
          ctm = stack.pop() ?? ctm;
          break;
        case "cm":
          if (numbers.length >= 6) ctm = multiply(numbers.slice(-6) as Matrix, ctm);
          break;
        case "BT":
          tm = lm = identity;
          break;
        case "Tf": {
          const ref = name === undefined ? undefined : fonts.get(name);
          font = ref === undefined ? undefined : this.font(ref);
          size = numbers.at(-1) ?? size;
          break;
        }
        case "TL":
          leading = numbers.at(-1) ?? leading;
          break;
        case "Tc":
          charSpacing = numbers.at(-1) ?? charSpacing;
          break;
        case "Tw":
          wordSpacing = numbers.at(-1) ?? wordSpacing;
          break;
        case "Td":
          if (numbers.length >= 2) moveLine(numbers.at(-2)!, numbers.at(-1)!);
          break;
        case "TD":
          if (numbers.length >= 2) {
            leading = -numbers.at(-1)!;
            moveLine(numbers.at(-2)!, numbers.at(-1)!);
          }
          break;
        case "Tm":
          if (numbers.length >= 6) tm = lm = numbers.slice(-6) as Matrix;
          break;
        case "T*":
          moveLine(0, -leading);
          break;
        case "Tj":
          show(strings(operands).slice(-1).map((value) => value.bytes));
          break;
        case "'":
        case '"':
          if (token.value === '"' && numbers.length >= 2) {
            wordSpacing = numbers.at(-2)!;
            charSpacing = numbers.at(-1)!;
          }
          moveLine(0, -leading);
          show(strings(operands).slice(-1).map((value) => value.bytes));
          break;
        case "TJ": {
          const array = [...operands].reverse().find(Array.isArray) ?? [];
          show(
            array.flatMap((value): (string | number)[] =>
              value instanceof PdfString
                ? [value.bytes]
                : typeof value === "number"
                  ? [value]
                  : [],
            ),
          );
          break;
        }
        case "Do": {
          const ref = name === undefined ? undefined : xObjects.get(name);
          const object = ref === undefined ? undefined : this.objects.get(ref);
          if (object && depth < maxFormDepth && /\/Subtype\s*\/Form\b/.test(object.dictionary)) {
            const values = dictValue(object.dictionary, "Matrix")
              ?.match(/[+-]?(?:\d+\.?\d*|\.\d+)/g)
              ?.map(Number);
            const formResources = dictValue(object.dictionary, "Resources");
            this.interpret(
              decodeStream(object),
              formResources ? this.resolve(formResources) : resources,
              multiply(values?.length === 6 ? (values as Matrix) : identity, ctm),
              fragments,
              depth + 1,
            );
          }
          break;
        }
        case "BI":
          tokenizer.skipInlineImage();
          break;
      }
      operands.length = 0;
      arrays.length = 0;
    }
  }
}

export function readPdf(bytes: Uint8Array): PdfDocument {
  const buffer = Buffer.from(bytes);
  if (buffer.length > maxPdfBytes) throw new Error("PDF exceeds the 20 MiB preview limit");
  if (!buffer.subarray(0, 1024).toString("latin1").includes("%PDF-"))
    throw new Error("Not a PDF document");
  const source = buffer.toString("latin1");
  inflatedBytes = 0;
  operations = 0;
  const reader = new PdfReader(source, parseObjects(source));
  const pages = reader.pageOrder();
  if (!pages.length || pages.length > maxPages)
    throw new Error("PDF page count is unsupported");
  const result = pages.map((id, index) => ({ number: index + 1, text: reader.pageText(id) }));
  if (result.every((page) => !page.text))
    throw new Error("PDF has no extractable text (scanned or unsupported encoding)");
  return { pages: result };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

type DiffOp = { type: "same" | "removed" | "added"; value: string };

function diffSequence(left: string[], right: string[]): DiffOp[] {
  const cells = left.length * right.length;
  if (cells > maxDiffCells || diffCells + cells > maxTotalDiffCells)
    return [
      ...left.map((value) => ({ type: "removed" as const, value })),
      ...right.map((value) => ({ type: "added" as const, value })),
    ];
  diffCells += cells;
  const width = right.length + 1;
  const table = new Uint32Array((left.length + 1) * width);
  for (let i = left.length - 1; i >= 0; i--)
    for (let j = right.length - 1; j >= 0; j--)
      table[i * width + j] =
        left[i] === right[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
  const result: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      result.push({ type: "same", value: left[i] });
      i++;
      j++;
    } else if (
      i < left.length &&
      (j >= right.length || table[(i + 1) * width + j] >= table[i * width + j + 1])
    )
      result.push({ type: "removed", value: left[i++] });
    else result.push({ type: "added", value: right[j++] });
  }
  return result;
}

export interface PdfDiffRow {
  type: "same" | "changed" | "removed" | "added";
  left?: string;
  right?: string;
}

export function diffPageLines(before: string, after: string): PdfDiffRow[] {
  const split = (text: string) => (text ? text.split("\n") : []);
  const ops = diffSequence(split(before), split(after));
  const rows: PdfDiffRow[] = [];
  for (let index = 0; index < ops.length; ) {
    if (ops[index].type === "same") {
      rows.push({ type: "same", left: ops[index].value, right: ops[index].value });
      index++;
      continue;
    }
    const removed: string[] = [];
    const added: string[] = [];
    while (index < ops.length && ops[index].type !== "same") {
      (ops[index].type === "removed" ? removed : added).push(ops[index].value);
      index++;
    }
    rows.push(...alignBlock(removed, added));
  }
  return rows;
}

function similarity(left: string, right: string): number {
  const words = (text: string) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const a = words(left);
  const b = words(right);
  if (!a.length || !b.length) return 0;
  const counts = new Map<string, number>();
  for (const word of a) counts.set(word, (counts.get(word) ?? 0) + 1);
  let common = 0;
  for (const word of b) {
    const count = counts.get(word) ?? 0;
    if (count) {
      common++;
      counts.set(word, count - 1);
    }
  }
  return (2 * common) / (a.length + b.length);
}

function alignBlock(removed: string[], added: string[]): PdfDiffRow[] {
  if (removed.length * added.length > 40_000)
    return Array.from({ length: Math.max(removed.length, added.length) }, (_, k) => ({
      type: k < removed.length && k < added.length ? "changed" : k < removed.length ? "removed" : "added",
      left: removed[k],
      right: added[k],
    }));
  const width = added.length + 1;
  const score = new Float64Array((removed.length + 1) * width);
  for (let i = removed.length - 1; i >= 0; i--)
    for (let j = added.length - 1; j >= 0; j--) {
      const value = similarity(removed[i], added[j]);
      score[i * width + j] = Math.max(
        score[(i + 1) * width + j],
        score[i * width + j + 1],
        value >= 0.3 ? score[(i + 1) * width + j + 1] + value : -1,
      );
    }
  const rows: PdfDiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < removed.length || j < added.length) {
    if (i < removed.length && j < added.length) {
      const value = similarity(removed[i], added[j]);
      if (value >= 0.3 && score[i * width + j] === score[(i + 1) * width + j + 1] + value) {
        rows.push({ type: "changed", left: removed[i++], right: added[j++] });
        continue;
      }
    }
    if (i < removed.length && (j >= added.length || score[i * width + j] === score[(i + 1) * width + j]))
      rows.push({ type: "removed", left: removed[i++] });
    else rows.push({ type: "added", right: added[j++] });
  }
  return rows;
}

function highlightWords(left: string, right: string): [string, string] {
  const ops = diffSequence(left.split(/(\s+)/), right.split(/(\s+)/));
  const render = (side: "removed" | "added") =>
    ops
      .filter((op) => op.type === "same" || op.type === side)
      .map((op) =>
        op.type === "same" || !op.value.trim()
          ? escapeHtml(op.value)
          : `<mark>${escapeHtml(op.value)}</mark>`,
      )
      .join("");
  return [render("removed"), render("added")];
}

function renderRows(rows: PdfDiffRow[]): string {
  return rows
    .map((row, index) => {
      let left = row.left === undefined ? "" : escapeHtml(row.left);
      let right = row.right === undefined ? "" : escapeHtml(row.right);
      if (row.type === "changed") [left, right] = highlightWords(row.left!, row.right!);
      const leftClass = row.type === "same" ? "" : row.left === undefined ? "empty" : "del";
      const rightClass = row.type === "same" ? "" : row.right === undefined ? "empty" : "ins";
      return `<tr class="${row.type}"><td class="n">${index + 1}</td><td class="${leftClass}">${left}</td><td class="${rightClass}">${right}</td></tr>`;
    })
    .join("");
}

export function renderPdfDiffHtml(
  title: string,
  before: PdfDocument | undefined,
  after: PdfDocument | undefined,
  status?: string,
): string {
  const pageCount = Math.max(before?.pages.length ?? 0, after?.pages.length ?? 0);
  diffCells = 0;
  const only = !before ? after : !after ? before : undefined;
  const onlyClass = !before ? "ins" : "del";
  let changedCount = 0;
  let changedLines = 0;
  const sections = only
    ? only.pages.map((page) => {
        const lines = page.text ? page.text.split("\n") : [];
        changedLines += lines.length;
        const body = lines.length
          ? `<table><colgroup><col class="n"><col></colgroup><tbody>${lines
              .map(
                (line, index) =>
                  `<tr><td class="n">${index + 1}</td><td class="${onlyClass}">${escapeHtml(line)}</td></tr>`,
              )
              .join("")}</tbody></table>`
          : `<p class="none">No extractable text</p>`;
        return `<details class="page changed" open>
      <summary><strong>Page ${page.number}</strong><span>${lines.length} line${lines.length === 1 ? "" : "s"}</span></summary>
      ${body}
    </details>`;
      })
    : Array.from({ length: pageCount }, (_, index) => {
    const left = before?.pages[index];
    const right = after?.pages[index];
    const rows = diffPageLines(left?.text ?? "", right?.text ?? "");
    const lineChanges = rows.filter((row) => row.type !== "same").length;
    const changed = !left || !right || left.text !== right.text;
    if (changed) changedCount++;
    changedLines += lineChanges;
    const status = !left
      ? "Added page"
      : !right
        ? "Removed page"
        : changed
          ? `Changed · ${lineChanges} line${lineChanges === 1 ? "" : "s"}`
          : "Unchanged";
    const body = rows.length
      ? `<table><colgroup><col class="n"><col><col></colgroup><thead><tr><th></th><th>Before</th><th>After</th></tr></thead><tbody>${renderRows(rows)}</tbody></table>`
      : `<p class="none">No extractable text</p>`;
    return `<details class="page ${changed ? "changed" : "same"}"${changed ? " open" : ""}>
      <summary><strong>Page ${index + 1}</strong><span>${status}</span></summary>
      ${body}
    </details>`;
  });
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
:root { color-scheme: light dark; }
body { margin: 0; padding: 18px; color: var(--vscode-foreground); background: var(--vscode-editor-background); font: var(--vscode-font-size) var(--vscode-font-family); }
h1 { font-size: 18px; margin: 0 0 6px; } .summary { color: var(--vscode-descriptionForeground); margin-bottom: 16px; }
.page { margin: 0 0 12px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; overflow: hidden; }
.page > summary { display: flex; justify-content: space-between; gap: 12px; padding: 8px 12px; cursor: pointer; background: var(--vscode-editorWidget-background); }
.page.changed > summary span { color: var(--vscode-testing-iconFailed); } .page.same > summary span { color: var(--vscode-testing-iconPassed); }
table { width: 100%; border-collapse: collapse; table-layout: fixed; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
col.n { width: 3.5em; }
th { text-align: left; padding: 4px 8px; color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--vscode-panel-border); }
td { padding: 1px 8px; vertical-align: top; white-space: pre-wrap; overflow-wrap: anywhere; border-left: 1px solid var(--vscode-panel-border); }
td.n { border-left: 0; text-align: right; color: var(--vscode-editorLineNumber-foreground); user-select: none; }
td.del { background: var(--vscode-diffEditor-removedLineBackground, rgba(255, 0, 0, .15)); }
td.ins { background: var(--vscode-diffEditor-insertedLineBackground, rgba(0, 255, 0, .12)); }
td.empty { background: repeating-linear-gradient(135deg, transparent 0 6px, var(--vscode-panel-border) 6px 7px); }
td.del mark { background: var(--vscode-diffEditor-removedTextBackground, rgba(255, 0, 0, .35)); color: inherit; }
td.ins mark { background: var(--vscode-diffEditor-insertedTextBackground, rgba(0, 255, 0, .3)); color: inherit; }
.none { margin: 0; padding: 12px; color: var(--vscode-descriptionForeground); }
h1 { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
${statusBadgeCss}
</style></head><body>
<h1>${statusBadge(status ?? (!before ? "Added" : !after ? "Deleted" : "Modified"))}${escapeHtml(title)}</h1><div class="summary">${
    only
      ? `${pageCount} page${pageCount === 1 ? "" : "s"} · ${changedLines} line${changedLines === 1 ? "" : "s"} of text`
      : `${pageCount} page${pageCount === 1 ? "" : "s"} · ${changedCount} changed · ${changedLines} line${changedLines === 1 ? "" : "s"} differ`
  }</div>
${sections.join("\n") || "<p>No pages found.</p>"}
</body></html>`;
}
