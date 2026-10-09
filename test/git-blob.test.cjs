const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { readGitBlob, blobSpec } = require("../out/git-blob");

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "udv-blob-"));
  const git = (...args) => execFileSync("git", args, { cwd: root });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "core.autocrlf", "false");
  git("config", "diff.upper.textconv", "node -e \"process.stdout.write('TEXTCONV')\"");
  fs.writeFileSync(path.join(root, ".gitattributes"), "*.pdf diff=upper\n");
  return { root, git };
}

test("readGitBlob returns raw HEAD and index bytes, ignoring textconv", async () => {
  const { root, git } = repo();
  try {
    const file = path.join(root, "dir", "report one.pdf");
    fs.mkdirSync(path.dirname(file));
    const head = Buffer.from("%PDF-1.4\n\u0000\u00ff binary", "latin1");
    fs.writeFileSync(file, head);
    git("add", "-A");
    git("commit", "-qm", "init");
    const staged = Buffer.from("%PDF-1.7 staged", "latin1");
    fs.writeFileSync(file, staged);
    git("add", "-A");
    assert.deepEqual(Buffer.from(await readGitBlob("git", root, file, "HEAD", 1024)), head);
    assert.deepEqual(Buffer.from(await readGitBlob("git", root, file, "", 1024)), staged);
    await assert.rejects(readGitBlob("git", root, file, "HEAD", 4), /preview limit/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("blobSpec rejects files outside the repository", () => {
  const root = path.join(os.tmpdir(), "repo");
  assert.equal(blobSpec(root, path.join(root, "a", "b.pdf"), ""), ":a/b.pdf");
  assert.throws(() => blobSpec(root, path.join(os.tmpdir(), "other.pdf"), "HEAD"), /outside/);
});
