/**
 * Splits a Markdown or plain-text document into excerpts (chunks) for the document index. Pure
 * functions, so the ingestion's splitting can be tested without files, a database or a model.
 *
 * - The title is the text of the first level-1 heading (`# Title`), else the file name without its
 *   extension, with dashes and underscores as spaces.
 * - Chunks follow the headings (`#` to `######`, outside fenced code blocks): each section becomes
 *   one chunk with its heading path below the title ("Brakes > Warning lights"). Heading lines are
 *   not part of the chunk's text; the heading path carries them.
 * - A section longer than `maxChars` is split at paragraph breaks, then line breaks, then sentence
 *   ends, then spaces, never inside a word, and packed into chunks of at most `maxChars`. Each
 *   further chunk of the section starts with up to `overlapChars` of the end of the one before.
 *
 * Sizes are in characters, about four per token: the defaults give chunks of up to about 750 tokens.
 */

import { HEADING_PATH_SEPARATOR } from "../../domain/repositories/KnowledgeRepository";

export const CHUNK_MAX_CHARS = 3000;
export const CHUNK_OVERLAP_CHARS = 200;

export interface ChunkOptions {
  maxChars: number;
  overlapChars: number;
}

export interface KnowledgeChunkDraft {
  /** 0-based order within the document. */
  position: number;
  /** Headings above the chunk, below the title, joined with " > "; empty when there are none. */
  headingPath: string;
  content: string;
}

export interface ChunkedDocument {
  title: string;
  chunks: KnowledgeChunkDraft[];
}

interface Section {
  headings: string[];
  body: string;
}

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** The file name without directories and extension, dashes and underscores as spaces. */
export function titleFromFileName(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  const title = base.replace(/\.[^.]*$/, "").replace(/[-_]+/g, " ").trim();
  return title || base;
}

/** Each line with its heading (level and text) when it is one; lines in fenced code blocks never are. */
function classifyLines(text: string): Array<{ line: string; heading?: { level: number; text: string } }> {
  let fence: string | null = null;
  return text.replace(/\r\n?/g, "\n").split("\n").map((line) => {
    const fenceMatch = line.match(FENCE);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      return { line };
    }
    if (fence !== null) return { line };
    const m = line.match(HEADING);
    const headingText = m?.[2]?.trim();
    return headingText ? { line, heading: { level: m![1]!.length, text: headingText } } : { line };
  });
}

function sections(text: string): { title: string | undefined; sections: Section[] } {
  const lines = classifyLines(text);
  const titleIndex = lines.findIndex((l) => l.heading?.level === 1);
  const title = titleIndex >= 0 ? lines[titleIndex]!.heading!.text : undefined;
  const result: Section[] = [];
  const stack: Array<{ level: number; text: string }> = [];
  let body: string[] = [];
  const flush = () => {
    const joined = body.join("\n").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
    if (joined) result.push({ headings: stack.map((h) => h.text), body: joined });
    body = [];
  };
  lines.forEach((entry, i) => {
    if (!entry.heading) {
      body.push(entry.line);
      return;
    }
    flush();
    if (i === titleIndex) return;
    while (stack.length > 0 && stack[stack.length - 1]!.level >= entry.heading.level) stack.pop();
    stack.push(entry.heading);
  });
  flush();
  return { title, sections: result };
}

/** Ways to split an oversized text, coarsest first, with the separator that joins the parts again. */
const SPLITS: Array<{ pattern: RegExp; sep: string }> = [
  { pattern: /\n[ \t]*\n/, sep: "\n\n" },
  { pattern: /\n/, sep: "\n" },
  { pattern: /(?<=[.!?:;])\s+/, sep: " " },
  { pattern: /\s+/, sep: " " },
];

interface Unit {
  text: string;
  /** Joins the unit to the text before it in the same chunk. */
  sep: string;
}

/** Pieces of at most `maxChars` (a single word may be longer), each with the separator before it. */
function units(text: string, maxChars: number, level = 0): Unit[] {
  if (text.length <= maxChars || level >= SPLITS.length) return [{ text, sep: "" }];
  const { pattern, sep } = SPLITS[level]!;
  const parts = text.split(pattern).map((part) => part.trim()).filter(Boolean);
  if (parts.length <= 1) return units(text, maxChars, level + 1);
  return parts.flatMap((part, i) => {
    const pieces = units(part, maxChars, level + 1);
    if (i > 0) pieces[0] = { ...pieces[0]!, sep };
    return pieces;
  });
}

/** Up to `overlapChars` of the end of `text`, starting at a sentence start if there is one, else at a word. */
function overlapTail(text: string, overlapChars: number): string {
  if (overlapChars <= 0) return "";
  const tail = text.slice(-overlapChars);
  const sentence = tail.search(/[.!?]\s+\S/);
  if (sentence >= 0) return tail.slice(sentence + 1).trim();
  // The tail may start inside a word: begin after the first whitespace.
  const space = text.length > overlapChars ? tail.search(/\s/) : 0;
  return space >= 0 ? tail.slice(space).trim() : "";
}

/** A section's body as one or more chunk texts. */
export function splitText(body: string, options: ChunkOptions): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const unit of units(body, options.maxChars)) {
    if (!current) {
      current = unit.text;
      continue;
    }
    const joined = `${current}${unit.sep || " "}${unit.text}`;
    if (joined.length <= options.maxChars) {
      current = joined;
      continue;
    }
    chunks.push(current);
    const overlap = overlapTail(current, options.overlapChars);
    current = overlap && overlap.length + 1 + unit.text.length <= options.maxChars ? `${overlap} ${unit.text}` : unit.text;
  }
  if (current) chunks.push(current);
  return chunks;
}

/** The document's title and chunks; a document without text has no chunks. */
export function chunkDocument(
  text: string, fileName: string, options: ChunkOptions = { maxChars: CHUNK_MAX_CHARS, overlapChars: CHUNK_OVERLAP_CHARS },
): ChunkedDocument {
  const parsed = sections(text);
  const chunks: KnowledgeChunkDraft[] = [];
  for (const section of parsed.sections) {
    const headingPath = section.headings.join(HEADING_PATH_SEPARATOR);
    for (const content of splitText(section.body, options)) chunks.push({ position: chunks.length, headingPath, content });
  }
  return { title: parsed.title ?? titleFromFileName(fileName), chunks };
}

/** What is embedded for a chunk: its title and heading path give the excerpt its context. */
export function embeddingText(title: string, chunk: Pick<KnowledgeChunkDraft, "headingPath" | "content">): string {
  const path = chunk.headingPath ? `${title}${HEADING_PATH_SEPARATOR}${chunk.headingPath}` : title;
  return `${path}\n\n${chunk.content}`;
}

/** A chunk's citation: "<title>, <heading path>", or the title alone. */
export function chunkSource(title: string, headingPath: string): string {
  return headingPath ? `${title}, ${headingPath}` : title;
}
