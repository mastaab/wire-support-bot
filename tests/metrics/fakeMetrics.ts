import { vi } from "vitest";
import { NO_METRICS, type MetricsPort } from "../../src/application/ports/MetricsPort";

/** Where each timed method has its duration in seconds. */
const DURATION_AT: Partial<Record<keyof MetricsPort, number>> = { modelCall: 2, jiraRequest: 2, watchCheck: 1 };

/**
 * A MetricsPort that records every call, for instrumentation tests. `of(name)` lists the
 * arguments of each call of one method with the duration left out (it varies); `durations`
 * collects the durations. Registered gauge readers are kept in `readers`.
 */
export function fakeMetrics() {
  const events: Array<{ name: keyof MetricsPort; args: unknown[] }> = [];
  const durations: number[] = [];
  const readers = new Map<string, () => number>();
  const record = (name: keyof MetricsPort) => vi.fn((...args: unknown[]) => {
    if (name === "collect") {
      readers.set(args[0] as string, args[1] as () => number);
      return;
    }
    const at = DURATION_AT[name];
    if (at !== undefined) durations.push(args[at] as number);
    // A trailing undefined (watchCheck without a count) is dropped, so it compares like a missing argument.
    const kept = args.filter((_arg, i) => i !== at);
    while (kept.length > 0 && kept[kept.length - 1] === undefined) kept.pop();
    events.push({ name, args: kept });
  });
  const metrics = Object.fromEntries((Object.keys(NO_METRICS) as Array<keyof MetricsPort>).map((name) => [name, record(name)])) as unknown as MetricsPort;
  const of = (name: keyof MetricsPort) => events.filter((event) => event.name === name).map((event) => event.args);
  return { metrics, events, durations, readers, of };
}
