import { execFile } from "node:child_process";
import * as path from "node:path";

export function blobSpec(root: string, file: string, ref: string): string {
  const relative = path.relative(root, file).split(path.sep).join("/");
  if (!relative || relative.startsWith("../") || path.isAbsolute(relative))
    throw new Error("File is outside the repository");
  return `${ref}:${relative}`;
}

export function readGitBlob(
  gitPath: string,
  root: string,
  file: string,
  ref: string,
  maxBytes: number,
): Promise<Uint8Array> {
  const spec = blobSpec(root, file, ref);
  return new Promise((resolve, reject) => {
    execFile(
      gitPath,
      ["cat-file", "blob", spec],
      { cwd: root, encoding: "buffer", maxBuffer: maxBytes + 1, windowsHide: true, timeout: 30_000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            /maxBuffer/i.test(error.message)
              ? new Error(`File exceeds the ${Math.round(maxBytes / 1048576)} MiB preview limit`)
              : error.killed
                ? new Error("Reading the Git version timed out")
                : new Error(Buffer.from(stderr).toString("utf8").trim() || error.message),
          );
          return;
        }
        if (stdout.length > maxBytes)
          reject(new Error(`File exceeds the ${Math.round(maxBytes / 1048576)} MiB preview limit`));
        else if (stdout.subarray(0, 64).toString("latin1").startsWith("version https://git-lfs.github.com/spec/v1"))
          reject(new Error("This version is a Git LFS pointer; its content is not stored in Git"));
        else resolve(new Uint8Array(stdout));
      },
    );
  });
}
