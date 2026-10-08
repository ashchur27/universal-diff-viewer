const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const { readWorkbook, diffWorkbooks } = require("../out/xlsx");
const { renderTabularDiffHtml, columnIndexToLetters } = require("../out/tabular");

function buildZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const file of files) {
    const nameBuf = Buffer.from(file.name, "utf8");
    const method = file.method ?? 8;
    const uncompressed = Buffer.from(file.data, "utf8");
    const compressed =
      method === 8 ? zlib.deflateRawSync(uncompressed) : uncompressed;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(uncompressed.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    const localEntry = Buffer.concat([localHeader, nameBuf, compressed]);
    localParts.push(localEntry);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(uncompressed.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(Buffer.concat([centralHeader, nameBuf]));

    offset += localEntry.length;
  }
  const localData = Buffer.concat(localParts);
  const centralData = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralData.length, 12);
  eocd.writeUInt32LE(localData.length, 16);
  return Buffer.concat([localData, centralData, eocd]);
}

const workbookXml =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
  '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>';
const relsXml =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
  "</Relationships>";
const sharedStringsXml =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2" uniqueCount="2">' +
  "<si><t>Name</t></si><si><t>Alice</t></si></sst>";

function workbookBytes(sheetXml) {
  return buildZip([
    { name: "xl/workbook.xml", data: workbookXml, method: 8 },
    { name: "xl/_rels/workbook.xml.rels", data: relsXml, method: 0 },
    { name: "xl/sharedStrings.xml", data: sharedStringsXml, method: 8 },
    { name: "xl/worksheets/sheet1.xml", data: sheetXml, method: 8 },
  ]);
}

const beforeSheetXml =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
  '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>42</v></c></row>' +
  '<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>7</v></c></row>' +
  "</sheetData></worksheet>";
const afterSheetXml =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
  '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>43</v></c></row>' +
  '<row r="2"><c r="A2" t="s"><v>1</v></c><c r="C2" t="inlineStr"><is><t>new</t></is></c></row>' +
  "</sheetData></worksheet>";

test("readWorkbook parses shared strings, numbers, and inline strings", () => {
  const before = readWorkbook(workbookBytes(beforeSheetXml));
  assert.equal(before.sheets.length, 1);
  const [sheet] = before.sheets;
  assert.equal(sheet.name, "Sheet1");
  assert.equal(sheet.cells.get("A1"), "Name");
  assert.equal(sheet.cells.get("B1"), "42");
  assert.equal(sheet.cells.get("A2"), "Alice");
  assert.equal(sheet.cells.get("B2"), "7");

  const after = readWorkbook(workbookBytes(afterSheetXml));
  const [afterSheet] = after.sheets;
  assert.equal(afterSheet.cells.get("B1"), "43");
  assert.equal(afterSheet.cells.get("C2"), "new");
  assert.equal(afterSheet.cells.has("B2"), false);
});

test("diffWorkbooks classifies added, removed, changed, and unchanged cells", () => {
  const before = readWorkbook(workbookBytes(beforeSheetXml));
  const after = readWorkbook(workbookBytes(afterSheetXml));
  const [diff] = diffWorkbooks(before, after);
  assert.equal(diff.name, "Sheet1");
  assert.equal(diff.status.get("A1"), "same");
  assert.equal(diff.status.get("B1"), "changed");
  assert.equal(diff.status.get("B2"), "removed");
  assert.equal(diff.status.get("C2"), "added");
});

test("renderTabularDiffHtml highlights every status and escapes cell text", () => {
  const before = readWorkbook(workbookBytes(beforeSheetXml));
  const after = readWorkbook(workbookBytes(afterSheetXml));
  const html = renderTabularDiffHtml("sample.xlsx", diffWorkbooks(before, after));
  assert.match(html, /class="changed">.*42.*43/s);
  assert.match(html, /class="removed">7/);
  assert.match(html, /class="added">new/);
  assert.match(html, /3 changed cells/);
});

test("columnIndexToLetters matches spreadsheet column naming", () => {
  assert.equal(columnIndexToLetters(0), "A");
  assert.equal(columnIndexToLetters(25), "Z");
  assert.equal(columnIndexToLetters(26), "AA");
  assert.equal(columnIndexToLetters(701), "ZZ");
});

test("readWorkbook rejects a non-zip buffer", () => {
  assert.throws(() => readWorkbook(Buffer.from("not a zip")), /end of central directory/);
});
