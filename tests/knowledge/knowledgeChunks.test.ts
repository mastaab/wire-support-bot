import { describe, expect, it } from "vitest";
import {
  CHUNK_MAX_CHARS, chunkDocument, chunkSource, embeddingText, splitText, titleFromFileName,
} from "../../src/application/services/knowledgeChunks";

const words = (n: number, word = "word") => Array.from({ length: n }, (_, i) => `${word}${i}`).join(" ");

describe("chunkDocument", () => {
  it("takes the title from the first level-1 heading and keeps the heading path below it", () => {
    const doc = [
      "# Fleet handbook",
      "Read this first.",
      "",
      "## Brakes",
      "Check the brakes daily.",
      "### Warning lights",
      "A red light means stop.",
      "## Tires",
      "Check the pressure weekly.",
    ].join("\n");
    expect(chunkDocument(doc, "guides/handbook.md")).toEqual({
      title: "Fleet handbook",
      chunks: [
        { position: 0, headingPath: "", content: "Read this first." },
        { position: 1, headingPath: "Brakes", content: "Check the brakes daily." },
        { position: 2, headingPath: "Brakes > Warning lights", content: "A red light means stop." },
        { position: 3, headingPath: "Tires", content: "Check the pressure weekly." },
      ],
    });
  });

  it("falls back to the file name, skips empty sections, ignores headings in code blocks and strips closing hashes", () => {
    const doc = [
      "## Start ##",
      "## Steps",
      "```",
      "# not a heading",
      "```",
      "Done.",
      "#hashtag is text",
    ].join("\r\n");
    expect(chunkDocument(doc, "dir/tire_pressure-guide.txt")).toEqual({
      title: "tire pressure guide",
      chunks: [{ position: 0, headingPath: "Steps", content: "```\n# not a heading\n```\nDone.\n#hashtag is text" }],
    });
  });

  it("keeps a later level-1 heading in the path and has no chunks for a document without text", () => {
    const doc = "# Title\n\n# Part two\n## Detail\nText.";
    expect(chunkDocument(doc, "a.md").chunks).toEqual([{ position: 0, headingPath: "Part two > Detail", content: "Text." }]);
    expect(chunkDocument("# Only a title\n\n", "a.md")).toEqual({ title: "Only a title", chunks: [] });
    expect(chunkDocument("", "empty.md")).toEqual({ title: "empty", chunks: [] });
  });

  it("splits a long section into chunks within the limit, with overlap, never inside a word", () => {
    const paragraphs = Array.from({ length: 12 }, (_, p) => `${words(60, `p${p}w`)}.`).join("\n\n");
    const { chunks } = chunkDocument(`# Manual\n## Long\n${paragraphs}`, "m.md");
    expect(chunks.length).toBeGreaterThan(1);
    const all = new Set(paragraphs.split(/\s+/));
    for (const chunk of chunks) {
      expect(chunk.headingPath).toBe("Long");
      expect(chunk.content.length).toBeLessThanOrEqual(CHUNK_MAX_CHARS);
      for (const word of chunk.content.split(/\s+/)) expect(all.has(word)).toBe(true);
    }
    expect(chunks.map((c) => c.position)).toEqual(chunks.map((_, i) => i));
    // Each further chunk starts with the end of the one before.
    for (let i = 1; i < chunks.length; i++) {
      const firstWord = chunks[i]!.content.split(/\s+/)[0]!;
      expect(chunks[i - 1]!.content).toContain(firstWord);
    }
  });
});

describe("splitText", () => {
  const options = { maxChars: 50, overlapChars: 15 };

  it("keeps a short text whole and packs paragraphs up to the limit", () => {
    expect(splitText("Short text.", options)).toEqual(["Short text."]);
    expect(splitText("aaaa bbbb.\n\ncccc dddd.\n\neeee ffff.", { maxChars: 30, overlapChars: 0 })).toEqual([
      "aaaa bbbb.\n\ncccc dddd.", "eeee ffff.",
    ]);
  });

  it("splits by sentences and then words, with overlap starting at a sentence or a word", () => {
    const text = "One two three four. Five six seven eight. Nine ten eleven twelve. Thirteen fourteen.";
    expect(splitText(text, options)).toEqual([
      "One two three four. Five six seven eight.", "seven eight. Nine ten eleven twelve.", "eleven twelve. Thirteen fourteen.",
    ]);
    expect(splitText("alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu", { maxChars: 30, overlapChars: 12 })).toEqual([
      "alpha beta gamma delta epsilon", "epsilon zeta eta theta iota", "theta iota kappa lambda mu",
    ]);
    const longSentence = words(30);
    for (const chunk of splitText(longSentence, options)) {
      expect(chunk.length).toBeLessThanOrEqual(50);
      for (const word of chunk.split(" ")) expect(word).toMatch(/^word\d+$/);
    }
  });

  it("keeps a single word longer than the limit whole", () => {
    const long = "x".repeat(80);
    expect(splitText(`short ${long} end`, options)).toEqual(["short", long, "end"]);
  });
});

describe("helpers", () => {
  it("builds the embedded text, the citation and the file-name title", () => {
    expect(embeddingText("Manual", { headingPath: "Brakes > Lights", content: "Red means stop." })).toBe("Manual > Brakes > Lights\n\nRed means stop.");
    expect(embeddingText("Manual", { headingPath: "", content: "Intro." })).toBe("Manual\n\nIntro.");
    expect(chunkSource("Manual", "Brakes > Lights")).toBe("Manual, Brakes > Lights");
    expect(chunkSource("Manual", "")).toBe("Manual");
    expect(titleFromFileName("a/b/def-warnings.md")).toBe("def warnings");
    expect(titleFromFileName("FAQ.txt")).toBe("FAQ");
  });
});
