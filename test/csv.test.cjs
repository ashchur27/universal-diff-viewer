const test = require("node:test");
const assert = require("node:assert/strict");
const { parseCsv, diffCsv } = require("../out/csv");
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

test("renderTabularDiffHtml renders a CSV diff as a single sheet", () => {
  const diff = diffCsv("sample.csv", "a,b\n1,2\n", "a,b\n1,3\n");
  const html = renderTabularDiffHtml("sample.csv", [diff]);
  assert.match(html, /sample\.csv/);
  assert.match(html, /class="changed">.*2.*3/s);
});
