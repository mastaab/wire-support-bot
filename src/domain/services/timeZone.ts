/**
 * The canonical IANA name of a timezone, e.g. "europe/berlin" -> "Europe/Berlin", or null when
 * the runtime does not know it. Abbreviations such as "CEST" or "cet", fixed offsets such as
 * "+01:00" and "Etc/" zones are not region names and return null; "UTC" in any case is accepted.
 */
export function canonicalTimeZone(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  if (trimmed.toUpperCase() === "UTC") return "UTC";
  if (/^[A-Za-z]{2,5}$/.test(trimmed)) return null;
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat("en-GB", { timeZone: trimmed }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
  if (resolved === "UTC") return resolved;
  return resolved.includes("/") && !resolved.startsWith("Etc/") ? resolved : null;
}
