import { randomBytes } from "crypto";

export type CellStatus = "added" | "removed" | "changed" | "same";

export interface SheetDiff {
  name: string;
  rows: number;
  cols: number;
  status: Map<string, CellStatus>;
  before: Map<string, string>;
  after: Map<string, string>;
}

export function columnIndexToLetters(index: number): string {
  let n = index + 1;
  let letters = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

export function diffCells(
  before: Map<string, string> | undefined,
  after: Map<string, string> | undefined,
): Map<string, CellStatus> {
  const status = new Map<string, CellStatus>();
  for (const [ref, beforeValue] of before ?? []) {
    const afterValue = after?.get(ref);
    status.set(
      ref,
      afterValue === undefined ? "removed" : afterValue === beforeValue ? "same" : "changed",
    );
  }
  for (const ref of after?.keys() ?? []) if (!before?.has(ref)) status.set(ref, "added");
  return status;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const rowsPerPage = 500;
const maxRenderedCols = 1000;
// Safety valve for sparse sheets with huge declared dimensions.
const maxRenderedCells = 1_000_000;

const statusBadges: Record<string, [string, string]> = {
  Added: ["New file", "ins"],
  Deleted: ["Deleted file", "del"],
  Modified: ["Modified", "mod"],
  Renamed: ["Renamed", "mod"],
  Conflict: ["Conflict", "del"],
};

export function statusBadge(status: string | undefined): string {
  if (!status) return "";
  const [label, kind] = statusBadges[status] ?? [status, "mod"];
  return `<span class="badge ${kind}">${escapeHtml(label)}</span>`;
}

export const statusBadgeCss = `
.badge { display: inline-block; padding: 1px 8px; margin-right: 6px; border-radius: 10px; color: var(--vscode-foreground); font-weight: 600; font-size: 12px; vertical-align: middle; }
.badge.ins { background: var(--vscode-diffEditor-insertedTextBackground, rgba(0, 255, 0, .3)); }
.badge.del { background: var(--vscode-diffEditor-removedTextBackground, rgba(255, 0, 0, .35)); }
.badge.mod { background: rgba(255, 140, 0, .35); }`;

export function renderTabularDiffHtml(
  title: string,
  sheets: SheetDiff[],
  status?: string,
): string {
  const sections = sheets.map((sheet) => {
    const cols = Math.min(sheet.cols, maxRenderedCols);
    const rows = Math.min(sheet.rows, Math.max(1, Math.floor(maxRenderedCells / Math.max(cols, 1))));
    const truncated = rows < sheet.rows || cols < sheet.cols;
    const pending = Math.max(0, rows - rowsPerPage);
    let header = "<tr><th></th>";
    for (let c = 0; c < cols; c++) header += `<th>${columnIndexToLetters(c)}</th>`;
    header += "</tr>";
    let body = "";
    for (let r = 0; r < rows; r++) {
      body += `<tr${r >= rowsPerPage ? " hidden" : ""}><th>${r + 1}</th>`;
      for (let c = 0; c < cols; c++) {
        const ref = `${columnIndexToLetters(c)}${r + 1}`;
        const status = sheet.status.get(ref) ?? "same";
        let content: string;
        if (status === "changed")
          content = `<div class="old">${escapeHtml(sheet.before.get(ref) ?? "")}</div><div class="new">${escapeHtml(sheet.after.get(ref) ?? "")}</div>`;
        else if (status === "removed") content = escapeHtml(sheet.before.get(ref) ?? "");
        else content = escapeHtml(sheet.after.get(ref) ?? sheet.before.get(ref) ?? "");
        body += `<td class="${status}">${content}</td>`;
      }
      body += "</tr>";
    }
    const changedCount = [...sheet.status.values()].filter((value) => value !== "same").length;
    return `<section id="sheet-${sheets.indexOf(sheet)}">
      <h2>${escapeHtml(sheet.name)} <span class="count">${changedCount} changed cell${changedCount === 1 ? "" : "s"}</span></h2>
      ${truncated ? `<p class="notice">Showing the first ${rows} rows × ${cols} columns of ${sheet.rows} × ${sheet.cols}.</p>` : ""}
      <div class="scroll"><table>${header}${body}</table></div>
      ${pending ? `<p class="more"><button type="button" data-more="${rowsPerPage}">Show ${rowsPerPage} more rows</button> <button type="button" data-more="all">Show all rows</button> <span class="remaining">${pending} more row${pending === 1 ? "" : "s"} hidden</span></p>` : ""}
    </section>`;
  });
  const sheetLinks = sheets
    .map((sheet, index) => `<a href="#sheet-${index}">${escapeHtml(sheet.name)}</a>`)
    .join(" ");
  const nonce = randomBytes(16).toString("base64");
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 12px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em; margin: 20px 0 6px; }
  .count { font-weight: normal; opacity: 0.7; text-transform: none; letter-spacing: normal; margin-left: 8px; }
  .notice { opacity: 0.7; font-size: 12px; margin: 0 0 6px; }
  .more { font-size: 12px; margin: 6px 0 0; display: flex; gap: 8px; align-items: center; }
  .more button { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); border: 0; padding: 3px 10px; cursor: pointer; }
  .more button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .more .remaining { opacity: 0.7; }
  .scroll { overflow: auto; max-height: 70vh; border: 1px solid var(--vscode-panel-border); }
  table { border-collapse: collapse; font-size: 12px; white-space: nowrap; }
  th, td { border: 1px solid var(--vscode-panel-border); padding: 2px 6px; text-align: left; vertical-align: top; }
  th { background: var(--vscode-editorWidget-background); position: sticky; top: 0; }
  th:first-child { position: sticky; left: 0; background: var(--vscode-editorWidget-background); }
  td.added { background: rgba(50, 180, 90, 0.25); }
  td.removed { background: rgba(220, 80, 80, 0.25); }
  td.changed { background: rgba(220, 180, 60, 0.3); }
  td .old { opacity: 0.6; text-decoration: line-through; }
  .legend { display: flex; gap: 16px; font-size: 12px; margin-bottom: 8px; }
  .legend span { display: inline-flex; align-items: center; gap: 4px; }
  .legend i { width: 10px; height: 10px; display: inline-block; border: 1px solid var(--vscode-panel-border); }
  .sheets { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
  .sheets a { color: var(--vscode-textLink-foreground); }
  td .old, td .new { white-space: pre-line; }
  h1 { font-size: 16px; margin: 0 0 10px; display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
  ${statusBadgeCss}
</style>
</head>
<body>
  <h1>${statusBadge(status)}${escapeHtml(title)}</h1>
  <div class="legend">
    <span><i style="background: rgba(50, 180, 90, 0.25);"></i> Added</span>
    <span><i style="background: rgba(220, 80, 80, 0.25);"></i> Removed</span>
    <span><i style="background: rgba(220, 180, 60, 0.3);"></i> Changed</span>
  </div>
    ${sheetLinks ? `<nav class="sheets" aria-label="Worksheets">Sheets: ${sheetLinks}</nav>` : ""}
  ${sections.join("\n") || '<p class="notice">No rows found.</p>'}
<script nonce="${nonce}">
document.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-more]");
  if (!button) return;
  const section = button.closest("section");
  const hidden = [...section.querySelectorAll("tr[hidden]")];
  const count = button.dataset.more === "all" ? hidden.length : Number(button.dataset.more);
  for (const row of hidden.slice(0, count)) row.hidden = false;
  const left = hidden.length - Math.min(count, hidden.length);
  if (!left) section.querySelector(".more").remove();
  else section.querySelector(".remaining").textContent = left + " more row" + (left === 1 ? "" : "s") + " hidden";
});
</script>
</body>
</html>`;
}
