import type { PartDetails } from "../../domain/entities/SupportRequest";
import { PART_DETAIL_KEYS } from "./offers";

/** Number words a requester may use for a quantity, in English and German. */
const NUMBER_WORDS: Readonly<Record<string, number>> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, dozen: 12, pair: 2, couple: 2, single: 1,
  eins: 1, ein: 1, eine: 1, einen: 1, zwei: 2, drei: 3, vier: 4, "fünf": 5, sechs: 6, sieben: 7, acht: 8, neun: 9,
  zehn: 10, elf: 11, "zwölf": 12, dutzend: 12, paar: 2,
};

const words = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** Short filler words a model may add around a stated value; they need not appear in the message. */
const FILLER_WORDS = new Set([
  "a", "an", "the", "to", "at", "in", "on", "of", "for", "from", "by", "with", "and", "or",
  "my", "our", "your", "their", "its", "this", "that", "please", "deliver", "delivered", "delivery",
]);

/** True when the message has the word, allowing for a plural "s" either way ("mirror" and "mirrors"). */
function inMessage(word: string, messageWords: ReadonlySet<string>): boolean {
  return messageWords.has(word) || messageWords.has(`${word}s`) || (word.endsWith("s") && messageWords.has(word.slice(0, -1)));
}

/** Every quantity the text states explicitly: digits or number words, never "a" or "an". */
function statedNumbers(text: string): Set<number> {
  const numbers = new Set<number>();
  for (const word of words(text)) {
    if (/^\d+$/.test(word)) numbers.add(Number(word));
    else if (word in NUMBER_WORDS) numbers.add(NUMBER_WORDS[word]!);
  }
  return numbers;
}

/**
 * Keeps only the part essentials the requester's own message states, whatever the model returned,
 * so a model that fills a gap (a quantity of 1 for "a new filter", a depot from elsewhere) cannot
 * complete an order. Every word of an asset, part or delivery location must appear in the message,
 * apart from short filler words and a plural "s", so an invented "the truck location" does not pass
 * because the message mentions a truck.
 * A quantity must be a number the message states explicitly, as digits or a number word ("two"
 * matches 2); an article such as "a" never counts, so the bot asks instead of assuming one.
 */
export function statedPartDetails(details: PartDetails | undefined, message: string): PartDetails {
  const messageWords = new Set(words(message));
  // A number that belongs to the asset ("pump 7", "serial 4411") is not a quantity.
  const asset = details?.asset?.trim();
  const messageNumbers = statedNumbers(asset ? message.split(new RegExp(escapeRegExp(asset), "gi")).join(" ") : message);
  const stated: PartDetails = {};
  for (const key of PART_DETAIL_KEYS) {
    const value = details?.[key];
    if (!value) continue;
    if (key === "quantity") {
      const valueNumbers = statedNumbers(value);
      if (valueNumbers.size > 0 && [...valueNumbers].every((n) => messageNumbers.has(n))) stated[key] = value;
      continue;
    }
    const significant = words(value).filter((word) => !FILLER_WORDS.has(word));
    if (significant.length > 0 && significant.every((word) => inMessage(word, messageWords))) stated[key] = value;
  }
  return stated;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
