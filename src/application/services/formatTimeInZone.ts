/**
 * How much of the date to show with the time of day:
 * - `time`: "17:55 CEST"
 * - `dayMonth`: "26 Sept, 17:55 CEST"
 * - `date`: "26 Sept 2026, 17:55 CEST"
 * - `weekdayDate`: "Saturday, 26 Sept 2026, 17:55 CEST"
 */
export type TimeInZoneStyle = "time" | "dayMonth" | "date" | "weekdayDate";

const STYLE_OPTIONS: Record<TimeInZoneStyle, Intl.DateTimeFormatOptions> = {
  time: {},
  dayMonth: { day: "numeric", month: "short" },
  date: { day: "numeric", month: "short", year: "numeric" },
  weekdayDate: { weekday: "long", day: "numeric", month: "short", year: "numeric" },
};

/**
 * A time of day in the given IANA zone with the zone's short name (en-GB), e.g. "17:55 CEST".
 * An unknown zone falls back to UTC rather than the host's local time.
 */
export function formatTimeInZone(date: Date, zone: string, style: TimeInZoneStyle): string {
  const format = (timeZone: string): string => new Intl.DateTimeFormat("en-GB", {
    ...STYLE_OPTIONS[style], hour: "2-digit", minute: "2-digit", timeZone, timeZoneName: "short",
  }).format(date);
  try {
    return format(zone);
  } catch {
    return format("UTC");
  }
}

/**
 * The calendar date in the given IANA zone as `YYYY-MM-DD`, e.g. the instant
 * 2026-09-30T23:30Z is "2026-10-01" in Europe/Berlin. An unknown zone falls back to UTC.
 */
export function formatDateInZone(date: Date, zone: string): string {
  const format = (timeZone: string): string => {
    const parts = new Intl.DateTimeFormat("en-GB", { year: "numeric", month: "2-digit", day: "2-digit", timeZone }).formatToParts(date);
    const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? "";
    return `${part("year")}-${part("month")}-${part("day")}`;
  };
  try {
    return format(zone);
  } catch {
    return format("UTC");
  }
}
