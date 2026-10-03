import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readKnowledgeDirectory } from "../../src/app/knowledgeFiles";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "wsb-knowledge-"));
  dirs.push(dir);
  return dir;
}

describe("readKnowledgeDirectory", () => {
  it("reads .md, .markdown and .txt files at any depth with relative paths, skipping other files and dot entries", async () => {
    const dir = tempDir();
    mkdirSync(path.join(dir, "sub", "deeper"), { recursive: true });
    mkdirSync(path.join(dir, ".hidden"));
    writeFileSync(path.join(dir, "a.md"), "﻿# A");
    writeFileSync(path.join(dir, "sub", "b.TXT"), "B");
    writeFileSync(path.join(dir, "sub", "deeper", "c.markdown"), "C");
    writeFileSync(path.join(dir, "image.png"), "x");
    writeFileSync(path.join(dir, ".draft.md"), "x");
    writeFileSync(path.join(dir, ".hidden", "d.md"), "x");
    expect(await readKnowledgeDirectory(dir)).toEqual([
      { sourcePath: "a.md", text: "# A" },
      { sourcePath: "sub/b.TXT", text: "B" },
      { sourcePath: "sub/deeper/c.markdown", text: "C" },
    ]);
  });

  it("reads the files of a ConfigMap-style volume once each, through their links into ..data", async () => {
    const dir = tempDir();
    mkdirSync(path.join(dir, "..2026_10_03"));
    writeFileSync(path.join(dir, "..2026_10_03", "faq.md"), "# FAQ");
    symlinkSync("..2026_10_03", path.join(dir, "..data"));
    symlinkSync(path.join("..data", "faq.md"), path.join(dir, "faq.md"));
    expect(await readKnowledgeDirectory(dir)).toEqual([{ sourcePath: "faq.md", text: "# FAQ" }]);
  });

  it("fails on a path that is not a directory", async () => {
    await expect(readKnowledgeDirectory(path.join(tempDir(), "missing"))).rejects.toThrow("Not a directory");
  });
});
