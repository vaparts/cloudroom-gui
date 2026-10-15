import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { applyChanges } from "../../src/services/cloudroom/teleport-local.js";

it("Teleport to Local never overwrites Mac work and never writes into .git", async () => {
  const temp = mkdtempSync(join(tmpdir(), "cloudroom-teleport-local-"));
  const root = join(temp, "mac");
  const cloud = join(temp, "cloud");
  const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args]).toString().trim();
  const write = (folder: string, text: string) => (path: string) => {
    mkdirSync(dirname(join(folder, path)), { recursive: true });
    writeFileSync(join(folder, path), text);
  };
  const read = (path: string) => readFileSync(join(root, path), "utf8");
  try {
    mkdirSync(root);
    git("init", "-q");
    ["main.txt", "wip.txt", "clean.txt"].forEach(write(root, "base"));
    git("add", ".");
    git("commit", "-qm", "cloud base");
    const base = git("rev-parse", "HEAD");
    // The Mac moves on after the cloud started: one new commit, one uncommitted edit.
    write(root, "mac")("main.txt");
    git("commit", "-qam", "mac commit");
    write(root, "mac")("wip.txt");

    const files = ["main.txt", "wip.txt", "clean.txt", "new.txt", ".git/hooks/pre-commit"];
    files.forEach(write(cloud, "cloud"));
    const archive = join(temp, "changes.tgz");
    execFileSync("tar", ["-czf", archive, "-C", cloud, ...files]);

    expect(await applyChanges(root, readFileSync(archive), "run", base)).toBe(2);
    expect([read("main.txt"), read("wip.txt"), read("clean.txt"), read("new.txt")]).toEqual(["mac", "mac", "cloud", "cloud"]);
    expect([read(".cloudroom/teleport/run/main.txt"), read(".cloudroom/teleport/run/wip.txt")]).toEqual(["cloud", "cloud"]);
    expect(existsSync(join(root, ".git/hooks/pre-commit"))).toBe(false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
