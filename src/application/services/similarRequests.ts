/**
 * Which of the conversation's requests may describe the same problem as a new one, by their
 * summaries alone. Words are compared without a plural "s"; generic words never count. A word
 * with a digit (a number or an identifier such as "e4") counts strongly, a word found in most of
 * the conversation's requests weakly, any other word normally. A request whose identifier for
 * the same thing differs ("truck 12" and "truck 13") is never similar.
 */

/** Words too generic to tie two requests together. */
const GENERIC_WORDS: ReadonlySet<string> = new Set([
  // Problem and request words.
  "broken", "broke", "break", "not", "working", "work", "works", "issue", "problem", "need", "new", "again", "request", "ticket",
  "error", "fault", "faulty", "fix", "help", "doesn't", "don't", "isn't", "won't", "can't", "cannot", "anymore",
  // Common short and filler words.
  "the", "and", "for", "but", "are", "was", "has", "had", "can", "our", "its", "you", "all", "any", "get", "got", "one", "out",
  "now", "too", "off", "see", "use", "way", "who", "why", "how", "yet", "did", "due", "with", "from", "into", "this", "that",
  "about", "after", "also", "always", "been", "before", "being", "could", "does", "done", "down", "every", "have", "having",
  "just", "keeps", "keep", "more", "much", "needs", "never", "only", "other", "over", "please", "really", "same", "should",
  "since", "some", "still", "than", "their", "them", "then", "there", "these", "they", "today", "very", "want", "wants",
  "were", "what", "when", "where", "which", "while", "will", "would", "your", "makes", "make",
]);

/** A request that may be offered: its key and summary. */
export interface SummarizedRequest {
  key: string;
  summary: string;
}

/** Weight of a word with a digit, of a word in most requests, and of any other word. */
const IDENTIFIER_WEIGHT = 3;
const COMMON_WEIGHT = 0.5;
const WORD_WEIGHT = 1;
/** Least score of a similar request: one distinctive word, or two common ones. */
const MIN_SCORE = 1;

/** A word without a plural "s" ("brakes" and "brake", but not "glass"). */
function singular(word: string): string {
  return word.length > 3 && word.endsWith("s") && !word.endsWith("ss") && !/\d/.test(word) ? word.slice(0, -1) : word;
}

function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []).map((word) => singular(word.replace(/^'+|'+$/g, ""))).filter(Boolean);
}

/** The words of a summary that may tie it to another: those with a digit, and other non-generic words of three letters or more. */
function significantWords(text: string): Set<string> {
  return new Set(tokens(text).filter((word) => /\d/.test(word) || (word.length >= 3 && !GENERIC_WORDS.has(word))));
}

/** The identifiers a summary names, per thing: "truck 12" and "Truck 13" give truck: {12, 13}. */
function identifiers(text: string): Map<string, Set<string>> {
  const words = tokens(text);
  const named = new Map<string, Set<string>>();
  for (let i = 0; i + 1 < words.length; i++) {
    const thing = words[i]!;
    const id = words[i + 1]!;
    if (/\d/.test(thing) || GENERIC_WORDS.has(thing) || thing.length < 3 || !/\d/.test(id)) continue;
    named.set(thing, (named.get(thing) ?? new Set()).add(id));
  }
  return named;
}

/** True when both summaries name an identifier for the same thing and they share none ("truck 12" and "truck 13"). */
export function namesOtherIdentifier(a: string, b: string): boolean {
  const ofB = identifiers(b);
  for (const [thing, ids] of identifiers(a)) {
    const other = ofB.get(thing);
    if (other && ![...ids].some((id) => other.has(id))) return true;
  }
  return false;
}

/**
 * The requests that may describe the same problem as `summary`, most similar first (ties keep
 * the given order), each sharing at least one distinctive word or two common ones and none
 * naming another identifier for the same thing. Words common to most of the requests (at least
 * three of them) count weakly.
 */
export function rankSimilarRequests<R extends SummarizedRequest>(summary: string, requests: readonly R[]): R[] {
  const words = significantWords(summary);
  const wordsOf = new Map(requests.map((request) => [request, significantWords(request.summary)] as const));
  const frequency = new Map<string, number>();
  for (const set of wordsOf.values()) for (const word of set) frequency.set(word, (frequency.get(word) ?? 0) + 1);
  const weight = (word: string): number => {
    if (/\d/.test(word)) return IDENTIFIER_WEIGHT;
    const count = frequency.get(word) ?? 0;
    return count >= 3 && count > requests.length / 2 ? COMMON_WEIGHT : WORD_WEIGHT;
  };
  return requests
    .filter((request) => !namesOtherIdentifier(summary, request.summary))
    .map((request) => ({ request, score: [...wordsOf.get(request)!].filter((word) => words.has(word)).reduce((sum, word) => sum + weight(word), 0) }))
    .filter(({ score }) => score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .map(({ request }) => request);
}
