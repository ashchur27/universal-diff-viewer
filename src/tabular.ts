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
  const refs = new Set<string>([...(before?.keys() ?? []), ...(after?.keys() ?? [])]);
  const status = new Map<string, CellStatus>();
  for (const ref of refs) {
    const beforeValue = before?.get(ref);
    const afterValue = after?.get(ref);
    status.set(
      ref,
      beforeValue === undefined
        ? "added"
        : afterValue === undefined
          ? "removed"
          : afterValue === beforeValue
            ? "same"
            : "changed",
    );
  }
  return status;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const maxRenderedRows = 200;
const maxRenderedCols = 40;

export function renderTabularDiffHtml(title: string, sheets: SheetDiff[]): string {
  const sections = sheets.map((sheet) => {
    const rows = Math.min(sheet.rows, maxRenderedRows);
    const cols = Math.min(sheet.cols, maxRenderedCols);
    const truncated = sheet.rows > maxRenderedRows || sheet.cols > maxRenderedCols;
    let header = "<tr><th></th>";
    for (let c = 0; c < cols; c++) header += `<th>${columnIndexToLetters(c)}</th>`;
    header += "</tr>";
    let body = "";
    for (let r = 0; r < rows; r++) {
      body += `<tr><th>${r + 1}</th>`;
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
    return `<section>
      <h2>${escapeHtml(sheet.name)} <span class="count">${changedCount} changed cell${changedCount === 1 ? "" : "s"}</span></h2>
      ${truncated ? `<p class="notice">Showing the first ${rows} rows × ${cols} columns of ${sheet.rows} × ${sheet.cols}.</p>` : ""}
      <div class="scroll"><table>${header}${body}</table></div>
    </section>`;
  });
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 12px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em; margin: 20px 0 6px; }
  .count { font-weight: normal; opacity: 0.7; text-transform: none; letter-spacing: normal; margin-left: 8px; }
  .notice { opacity: 0.7; font-size: 12px; margin: 0 0 6px; }
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
</style>
</head>
<body>
  <div class="legend">
    <span><i style="background: rgba(50, 180, 90, 0.25);"></i> Added</span>
    <span><i style="background: rgba(220, 80, 80, 0.25);"></i> Removed</span>
    <span><i style="background: rgba(220, 180, 60, 0.3);"></i> Changed</span>
  </div>
  ${sections.join("\n") || '<p class="notice">No rows found.</p>'}
</body>
</html>`;
}
