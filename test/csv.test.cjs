const test = require("node:test");
const assert = require("node:assert/strict");
const { detectCsvDelimiter, parseCsv, diffCsv } = require("../out/csv");
const { renderTabularDiffHtml } = require("../out/tabular");

test("parseCsv splits quoted fields, escaped quotes, and commas inside quotes", () => {
  const rows = parseCsv('a,"b,c","she said ""hi""\"\r\nd,e,f\n');
  assert.deepEqual(rows, [
    ["a", "b,c", 'she said "hi"'],
    ["d", "e", "f"],
  ]);
});

test("parseCsv ignores a trailing newline and empty input", () => {
  assert.deepEqual(parseCsv("a,b\nc,d\n"), [
    ["a", "b"],
    ["c", "d"],
  ]);
  assert.deepEqual(parseCsv(""), []);
});

test("parseCsv detects semicolon and tab delimiters and removes UTF-8 BOM", () => {
  assert.equal(detectCsvDelimiter("\uFEFFname;age\nAlice;30\n"), ";");
  assert.deepEqual(parseCsv("\uFEFFname;age\nAlice;30\n"), [
    ["name", "age"],
    ["Alice", "30"],
  ]);
  assert.deepEqual(parseCsv("name\tage\nAlice\t30\n"), [
    ["name", "age"],
    ["Alice", "30"],
  ]);
});

test("parseCsv accepts an explicit delimiter for ambiguous input", () => {
  assert.deepEqual(parseCsv("a|b\n1|2\n", "|"), [
    ["a", "b"],
    ["1", "2"],
  ]);
});

test("diffCsv classifies added, removed, and changed cells by position", () => {
  const before = "name,age\nAlice,30\nBob,25\n";
  const after = "name,age\nAlice,31\nCara,40\n";
  const diff = diffCsv("sample.csv", before, after);
  assert.equal(diff.name, "sample.csv");
  assert.equal(diff.status.get("A1"), "same");
  assert.equal(diff.status.get("B2"), "changed");
  assert.equal(diff.before.get("B2"), "30");
  assert.equal(diff.after.get("B2"), "31");
  assert.equal(diff.status.get("A3"), "changed");
  assert.equal(diff.before.get("B3"), "25");
  assert.equal(diff.after.get("B3"), "40");
});

test("diffCsv treats a missing side as entirely added or removed", () => {
  const onlyAfter = diffCsv("new.csv", undefined, "a,b\n1,2\n");
  assert.equal(onlyAfter.status.get("A1"), "added");
  assert.equal(onlyAfter.status.get("B2"), "added");

  const onlyBefore = diffCsv("deleted.csv", "a,b\n1,2\n", undefined);
  assert.equal(onlyBefore.status.get("A1"), "removed");
});

test("diffCsv treats an emptied file as removed cells, not a missing file", () => {
  const emptied = diffCsv("emptied.csv", "a,b\n", "");
  assert.equal(emptied.status.get("A1"), "removed");
  assert.equal(emptied.after.size, 0);
});

test("renderTabularDiffHtml renders a CSV diff as a single sheet", () => {
  const diff = diffCsv("sample.csv", "a,b\n1,2\n", "a,b\n1,3\n");
  const html = renderTabularDiffHtml("sample.csv", [diff]);
  assert.match(html, /sample\.csv/);
  assert.match(html, /class="changed">.*2.*3/s);
});

test("renderTabularDiffHtml shows the file status badge", () => {
  const added = renderTabularDiffHtml("new.csv", [diffCsv("new.csv", undefined, "a\n")], "Added");
  assert.match(added, /<h1><span class="badge ins">New file<\/span>new\.csv<\/h1>/);
  const deleted = renderTabularDiffHtml("old.csv", [diffCsv("old.csv", "a\n", undefined)], "Deleted");
  assert.match(deleted, /<span class="badge del">Deleted file<\/span>/);
  const modified = renderTabularDiffHtml("x.csv", [diffCsv("x.csv", "a\n", "b\n")], "Modified");
  assert.match(modified, /<span class="badge mod">Modified<\/span>/);
  assert.doesNotMatch(renderTabularDiffHtml("x.csv", []), /class="badge/);
});
