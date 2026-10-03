/**
 * Reads the documents of a directory for the knowledge ingestion: `.md`, `.markdown` and `.txt`
 * files at any depth, as UTF-8. Entries whose name starts with a dot are skipped, which also skips
 * the `..data` links a Kubernetes ConfigMap or Secret volume adds; symbolic links are followed, so
 * the files of such a volume (links into `..data`) are read once each.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { KnowledgeSourceFile } from "../application/usecases/knowledge/IngestKnowledge";

export const KNOWLEDGE_FILE_EXTENSIONS = [".md", ".markdown", ".txt"];
/** Largest document read; a bigger file stops the ingestion, naming the file. */
export const KNOWLEDGE_FILE_MAX_BYTES = 5 * 1024 * 1024;

export async function readKnowledgeDirectory(directory: string): Promise<KnowledgeSourceFile[]> {
  const root = path.resolve(directory);
  const rootStat = await stat(root).catch(() => null);
  if (!rootStat?.isDirectory()) throw new Error(`Not a directory: ${directory}`);
  const files: KnowledgeSourceFile[] = [];
  const visited = new Set<string>();

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 20) return;
    for (const name of (await readdir(dir)).sort()) {
      if (name.startsWith(".")) continue;
      const full = path.join(dir, name);
      const info = await stat(full).catch(() => null);
      if (!info) continue;
      if (info.isDirectory()) {
        const key = `${info.dev}:${info.ino}`;
        if (visited.has(key)) continue;
        visited.add(key);
        await walk(full, depth + 1);
      } else if (info.isFile() && KNOWLEDGE_FILE_EXTENSIONS.includes(path.extname(name).toLowerCase())) {
        const sourcePath = path.relative(root, full).split(path.sep).join("/");
        if (info.size > KNOWLEDGE_FILE_MAX_BYTES) throw new Error(`Document larger than ${KNOWLEDGE_FILE_MAX_BYTES / 1024 / 1024} MB: ${sourcePath}`);
        files.push({ sourcePath, text: (await readFile(full, "utf8")).replace(/^﻿/, "") });
      }
    }
  };
  await walk(root, 0);
  return files;
}
