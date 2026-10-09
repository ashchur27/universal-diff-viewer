const test = require("node:test");
const assert = require("node:assert/strict");
const { readPdf, renderPdfDiffHtml, diffPageLines } = require("../out/pdf");

function pdf(pages, { kids, extraStream = false } = {}) {
  const pageIds = pages.map((_, index) => 10 + index * 2);
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    `2 0 obj\n<< /Type /Pages /Kids [${(kids ?? pageIds).map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>\nendobj\n`,
    extraStream
      ? "3 0 obj\n<< /Length 18 >>\nstream\n(Font junk) Tj\nendstream\nendobj\n"
      : "",
    ...pages.map((content, index) => {
      const id = pageIds[index];
      return (
        `${id} 0 obj\n<< /Type /Page /Parent 2 0 R /Contents ${id + 1} 0 R >>\nendobj\n` +
        `${id + 1} 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`
      );
    }),
  ].join("");
  return Buffer.from(
    `%PDF-1.7\n${objects}trailer\n<< /Root 1 0 R >>\n%%EOF`,
    "latin1",
  );
}
const page = (text) => `(${text}) Tj`;

test("readPdf extracts page text from basic content streams", () => {
  const document = readPdf(pdf([page("Hello"), page("World")]));
  assert.equal(document.pages.length, 2);
  assert.equal(document.pages[0].text, "Hello");
  assert.equal(document.pages[1].text, "World");
});

test("readPdf maps text through each page's /Contents, not stream order", () => {
  const document = readPdf(
    pdf([page("First"), page("Second")], { extraStream: true }),
  );
  assert.deepEqual(
    document.pages.map((item) => item.text),
    ["First", "Second"],
  );
});

test("readPdf follows the /Kids page order", () => {
  const document = readPdf(pdf([page("A"), page("B")], { kids: [12, 10] }));
  assert.deepEqual(
    document.pages.map((item) => item.text),
    ["B", "A"],
  );
});

test("readPdf keeps Tj/TJ order and joins kerned TJ arrays", () => {
  const document = readPdf(
    pdf(["BT 0 700 Td (Title) Tj 0 -20 Td [(Hel) -20 (lo) 15 (!)] TJ 0 -20 Td (End) Tj ET"]),
  );
  assert.equal(document.pages[0].text, "Title\nHello!\nEnd");
});

test("readPdf joins text on the same baseline and orders lines top to bottom", () => {
  const document = readPdf(
    pdf(["BT 0 100 Td (Bottom) Tj ET BT 0 700 Td (Top) Tj 200 0 Td (Right) Tj ET"]),
  );
  assert.equal(document.pages[0].text, "Top Right\nBottom");
});

test("readPdf decodes Type0 Identity-H text through ToUnicode with glyph widths", () => {
  const cmap =
    "begincodespacerange <0000> <FFFF> endcodespacerange\n" +
    "1 beginbfchar <0003> <00E9> endbfchar\n" +
    "1 beginbfrange <0001> <0002> [<004D> <0020>] endbfrange";
  const content =
    "BT /F1 10 Tf 1 0 0 -1 0 0 Tm 0 -700 Td <0001> Tj 9 0 Td <0003> Tj 5 0 Td <0002> Tj 3 0 Td <0001> Tj ET";
  const source =
    "%PDF-1.4\n" +
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n" +
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n" +
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n" +
    `4 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n` +
    "5 0 obj\n<< /Type /Font /Subtype /Type0 /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>\nendobj\n" +
    "6 0 obj\n<< /Type /Font /Subtype /CIDFontType2 /DW 500 /W [1 [900 300 500]] >>\nendobj\n" +
    `7 0 obj\n<< /Length ${cmap.length} >>\nstream\n${cmap}\nendstream\nendobj\n` +
    "trailer\n<< /Root 1 0 R >>\n%%EOF";
  assert.equal(readPdf(Buffer.from(source, "latin1")).pages[0].text, "Mé M");
});

test("diffPageLines pairs similar lines instead of shifting by position", () => {
  const rows = diffPageLines(
    "Title / Titre\nDate / Date: 2014\nItem A\n(1000ct)\nNotes / Remarques:",
    "Title\nDate: 2/1/2014\nItem A (1000ct)\nNotes:",
  );
  assert.deepEqual(
    rows.map((row) => [row.type, row.left ?? "", row.right ?? ""]),
    [
      ["changed", "Title / Titre", "Title"],
      ["changed", "Date / Date: 2014", "Date: 2/1/2014"],
      ["changed", "Item A", "Item A (1000ct)"],
      ["removed", "(1000ct)", ""],
      ["changed", "Notes / Remarques:", "Notes:"],
    ],
  );
});

test("renderPdfDiffHtml marks changed and unchanged pages", () => {
  const before = readPdf(pdf([page("Same"), page("Total Old")]));
  const after = readPdf(pdf([page("Same"), page("Total New")]));
  const html = renderPdfDiffHtml("report.pdf", before, after);
  assert.match(html, /2 pages · 1 changed/);
  assert.match(html, /class="page same"/);
  assert.match(html, /class="page changed" open/);
  assert.match(html, /<mark>Old<\/mark>/);
  assert.match(html, /<mark>New<\/mark>/);
});

test("renderPdfDiffHtml shows added and deleted files as a single column", () => {
  const document = readPdf(pdf([page("Hello"), page("World")]));
  const added = renderPdfDiffHtml("new.pdf", undefined, document);
  assert.match(added, /class="badge ins">New file<\/span>new\.pdf<\/h1>/);
  assert.match(added, /2 pages · 2 lines of text/);
  assert.match(added, /<td class="ins">Hello<\/td>/);
  assert.doesNotMatch(added, /Before|After/);
  const deleted = renderPdfDiffHtml("old.pdf", document, undefined);
  assert.match(deleted, /class="badge del">Deleted file<\/span>/);
  assert.match(deleted, /<td class="del">World<\/td>/);
});

test("readPdf rejects non-PDF bytes", () => {
  assert.throws(() => readPdf(Buffer.from("not a pdf")), /Not a PDF/);
});

test("readPdf falls back when no page has extractable text", () => {
  assert.throws(() => readPdf(pdf(["0 0 m 10 10 l S"])), /no extractable text/);
});

test("readPdf rejects decompression bombs and exponential form fan-out quickly", () => {
  const zlib = require("node:zlib");
  const bomb = zlib.deflateSync(Buffer.alloc(200 * 1024 * 1024, 32));
  const bombPdf = Buffer.concat([
    Buffer.from(
      "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n" +
        "2 0 obj\n<< /Type /Pages /Kids [3 0 R] >>\nendobj\n" +
        "3 0 obj\n<< /Type /Page /Contents 4 0 R >>\nendobj\n" +
        `4 0 obj\n<< /Length ${bomb.length} /Filter /FlateDecode >>\nstream\n`,
      "latin1",
    ),
    bomb,
    Buffer.from("\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF", "latin1"),
  ]);
  let started = Date.now();
  assert.throws(() => readPdf(bombPdf), /no extractable text|too complex/);
  assert.ok(Date.now() - started < 5000);
  const fan = Array.from({ length: 200 }, () => "/X Do").join(" ");
  const form = `BT (A) Tj ET ${fan}`;
  const fanPdf =
    "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n" +
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] >>\nendobj\n" +
    "3 0 obj\n<< /Type /Page /Contents 4 0 R /Resources << /XObject << /X 5 0 R >> >> >>\nendobj\n" +
    `4 0 obj\n<< /Length ${fan.length} >>\nstream\n${fan}\nendstream\nendobj\n` +
    `5 0 obj\n<< /Type /XObject /Subtype /Form /Resources << /XObject << /X 5 0 R >> >> /Length ${form.length} >>\nstream\n${form}\nendstream\nendobj\n` +
    "trailer\n<< /Root 1 0 R >>\n%%EOF";
  started = Date.now();
  assert.throws(() => readPdf(Buffer.from(fanPdf, "latin1")), /too complex/);
  assert.ok(Date.now() - started < 5000);
});

test("readPdf scans objects linearly when endobj markers are missing", () => {
  const headers = Array.from({ length: 20000 }, (_, index) => `${index} 0 obj `).join("");
  const started = Date.now();
  assert.throws(() => readPdf(Buffer.from(`%PDF-1.4\n${headers}`, "latin1")), /page count/);
  assert.ok(Date.now() - started < 2000);
});
