// Captures README screenshots from a disposable VS Code window with a synthetic Git repository.
import { chromium } from "playwright";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const images = path.join(root, "docs", "images");
const temp = mkdtempSync(path.join(tmpdir(), "udv-readme-"));
const repo = path.join(temp, "shop-app");
mkdirSync(repo);

const write = (file, data) => {
  mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  writeFileSync(path.join(repo, file), data);
};
const git = (...args) => execFileSync("git", args, { cwd: repo });

function png(width, height, paint) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(x, y);
      raw.set([r, g, b, 255], y * (width * 4 + 1) + 1 + x * 4);
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const screen = (accent, badge = false) =>
  png(360, 220, (x, y) => {
    if (y < 28) return [33, 37, 41];
    if (x > 24 && x < 336 && y > 52 && y < 120) return accent;
    if (badge && x > 260 && x < 330 && y > 140 && y < 196) return [220, 53, 69];
    if (x > 24 && x < 200 && y > 140 && y < 152) return [173, 181, 189];
    return [248, 249, 250];
  });

function pdf(lines) {
  const content = lines
    .map(([size, y, text]) => `BT /F1 ${size} Tf 56 ${y} Td (${text.replace(/[()\\]/g, "\\$&")}) Tj ET`)
    .join("\n");
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
    `4 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];
  return Buffer.from(`%PDF-1.4\n${objects.join("")}trailer\n<< /Root 1 0 R >>\n%%EOF`, "latin1");
}
const invoice = (total, terms) =>
  pdf([
    [20, 790, "Invoice INV-2026-0142"],
    [11, 760, "Bill to: Northwind Traders, 12 Harbour St"],
    [11, 744, `Payment terms: ${terms}`],
    [11, 712, "Item                         Qty    Price"],
    [11, 696, "Espresso beans 1kg            12    18.50"],
    [11, 680, "Paper cups (pack of 100)       4     6.20"],
    [11, 664, `Delivery                       1     ${total === "246.80" ? "4.00" : "0.00"}`],
    [12, 632, `Total due: ${total} EUR`],
  ]);

function zip(files) {
  const local = [], central = [];
  let offset = 0;
  for (const [name, text] of files) {
    const nameBytes = Buffer.from(name);
    const data = Buffer.from(text);
    const packed = zlib.deflateRawSync(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(zlib.crc32(data), 14);
    header.writeUInt32LE(packed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    const entry = Buffer.concat([header, nameBytes, packed]);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt32LE(zlib.crc32(data), 16);
    dir.writeUInt32LE(packed.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBytes.length, 28);
    dir.writeUInt32LE(offset, 42);
    local.push(entry);
    central.push(Buffer.concat([dir, nameBytes]));
    offset += entry.length;
  }
  const centralData = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralData.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralData, end]);
}
const cell = (ref, value) =>
  typeof value === "number"
    ? `<c r="${ref}"><v>${value}</v></c>`
    : value.startsWith("=")
      ? `<c r="${ref}"><f>${value.slice(1).split("|")[0]}</f><v>${value.split("|")[1]}</v></c>`
      : `<c r="${ref}" t="inlineStr"><is><t>${value}</t></is></c>`;
const sheet = (rows) =>
  `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows
    .map((row, r) => `<row r="${r + 1}">${row.map((value, c) => (value === "" ? "" : cell(`${"ABCDE"[c]}${r + 1}`, value))).join("")}</row>`)
    .join("")}</sheetData></worksheet>`;
const xlsx = (sales, regions) =>
  zip([
    [
      "xl/workbook.xml",
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sales" sheetId="1" r:id="rId1"/><sheet name="Regions" sheetId="2" r:id="rId2"/></sheets></workbook>',
    ],
    [
      "xl/_rels/workbook.xml.rels",
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>',
    ],
    ["xl/worksheets/sheet1.xml", sheet(sales)],
    ["xl/worksheets/sheet2.xml", sheet(regions)],
  ]);

write("screenshots/home/en/hero.png", screen([13, 110, 253]));
write("screenshots/home/en/old-banner.png", screen([255, 193, 7]));
write("screenshots/settings/dark/toggle.png", screen([25, 135, 84]));
write("reports/invoice.pdf", invoice("246.80", "Net 30"));
write(
  "reports/sales.xlsx",
  xlsx(
    [["Month", "Units", "Revenue", "Margin"], ["July", 120, 4800, "=C2*0.3|1440"], ["August", 132, 5280, "=C3*0.3|1584"], ["September", 98, 3920, "=C4*0.3|1176"]],
    [["Region", "Manager"], ["North", "Olena"], ["South", "Marco"]],
  ),
);
write("data/prices.csv", "sku,name,price,stock\nESP-1KG,Espresso beans 1kg,18.50,40\nCUP-100,Paper cups (100),6.20,250\nLID-100,Cup lids (100),3.10,180\n");
write("config/settings.json", JSON.stringify({ currency: "EUR", taxRate: 0.2, freeDeliveryFrom: 250 }, null, 2) + "\n");
git("init", "-q");
git("config", "core.autocrlf", "false");
git("add", ".");
git("-c", "user.name=Docs", "-c", "user.email=docs@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "Initial");

write("screenshots/settings/dark/toggle.png", screen([111, 66, 193]));
write("reports/q3-summary.pdf", invoice("239.20", "Net 15"));
git("add", "screenshots/settings/dark/toggle.png", "reports/q3-summary.pdf");
write("screenshots/home/en/hero.png", screen([13, 110, 253], true));
rmSync(path.join(repo, "screenshots/home/en/old-banner.png"));
write("screenshots/home/en/promo.png", screen([214, 51, 132]));
write("reports/invoice.pdf", invoice("242.80", "Net 15"));
write(
  "reports/sales.xlsx",
  xlsx(
    [["Month", "Units", "Revenue", "Margin"], ["July", 120, 4800, "=C2*0.32|1536"], ["August", 141, 5640, "=C3*0.32|1804.8"], ["September", 98, 3920, "=C4*0.32|1254.4"], ["October", 105, 4200, "=C5*0.32|1344"]],
    [["Region", "Manager"], ["North", "Olena"], ["South", "Giulia"]],
  ),
);
write("data/prices.csv", "sku,name,price,stock\nESP-1KG,Espresso beans 1kg,19.90,40\nCUP-100,Paper cups (100),6.20,310\nSTR-200,Paper straws (200),4.50,90\n");
write("config/settings.json", JSON.stringify({ currency: "EUR", taxRate: 0.2, freeDeliveryFrom: 200, giftWrap: true }, null, 2) + "\n");
write("notes/release.txt", "Prices updated for Q4.\n");

const user = path.join(temp, "user");
mkdirSync(path.join(user, "User"), { recursive: true });
writeFileSync(
  path.join(user, "User", "settings.json"),
  JSON.stringify({
    "update.mode": "none",
    "telemetry.telemetryLevel": "off",
    "workbench.colorTheme": "Default Light Modern",
    "workbench.startupEditor": "none",
    "workbench.tips.enabled": false,
    "workbench.secondarySideBar.defaultVisibility": "hidden",
    "chat.disableAIFeatures": true,
    "window.menuStyle": "custom",
    "window.commandCenter": false,
    "workbench.layoutControl.enabled": false,
    "git.autoRepositoryDetection": true,
  }),
);

const port = await new Promise((resolve) => {
  const server = createServer();
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(
  process.env.VSCODE_EXECUTABLE ?? "code",
  [
    "--new-window",
    `--remote-debugging-port=${port}`,
    "--skip-welcome",
    "--skip-release-notes",
    "--disable-workspace-trust",
    "--user-data-dir",
    user,
    "--extensions-dir",
    path.join(temp, "extensions"),
    `--extensionDevelopmentPath=${root}`,
    repo,
  ],
  { stdio: "ignore", env },
);

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let browser;
try {
  for (let attempt = 0; attempt < 60 && !browser; attempt++) {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => undefined);
    if (!browser) await pause(500);
  }
  if (!browser) throw new Error("Could not connect to VS Code");
  let page;
  for (let attempt = 0; attempt < 60 && !page; attempt++) {
    page = browser.contexts().flatMap((context) => context.pages()).find((item) => item.url().includes("workbench"));
    if (!page) await pause(500);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator(".monaco-workbench").waitFor({ timeout: 60000 });
  await pause(3000);
  await page.locator('.activitybar .action-label[aria-label^="Universal Diff Viewer"]').click();
  const row = (name) => page.getByRole("treeitem").filter({ hasText: name }).first();
  await row("hero.png").waitFor({ timeout: 60000 });
  await pause(2000);

  const open = async (name, file, settle = 3000) => {
    await row(name).click();
    await pause(settle);
    await page.mouse.move(1400, 880);
    await page.screenshot({ path: path.join(images, file) });
  };
  await row("hero.png").click();
  await pause(5000);
  await open("invoice.pdf", "pdf-diff.png");
  await open("sales.xlsx", "xlsx-diff.png");
  await open("prices.csv", "csv-diff.png");
  await row("promo.png").click();
  await pause(3000);
  await page.mouse.move(1400, 880);
  const sidebar = await page.locator(".part.sidebar").boundingBox();
  await page.screenshot({
    path: path.join(images, "sidebar.png"),
    clip: { x: sidebar.x, y: sidebar.y, width: sidebar.width, height: 560 },
  });
  console.log(`README: saved VS Code screenshots to ${images}`);
} finally {
  await browser?.close().catch(() => {});
  child.kill();
  await pause(1500);
  rmSync(temp, { recursive: true, force: true, maxRetries: 5 });
}
