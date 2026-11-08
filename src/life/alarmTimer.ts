export interface LifeTimers { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void }
export const realTimers: LifeTimers = { set: (fn, ms) => setTimeout(fn, ms), clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) };

const retryMinutes = [1, 5, 15, 30, 60];
/** Timers wait at most this long before re-checking the wall clock, so suspend and clock changes cannot strand an alarm. */
const SEGMENT_MS = 5 * 60_000;

/**
 * Waits for the pending alarm and calls `fire` once it is due, never before. A failed delivery backs off
 * (1, 5, 15, 30, 60 minutes); a new alarm or a delivery that worked starts the backoff over.
 */
export function createAlarmTimer(deps: { clock: () => Date; timers: LifeTimers; dueAlarm: () => string | undefined; fire: () => void }) {
  const { clock, timers } = deps;
  let handle: unknown;
  let retries = 0;
  let retryAt: number | undefined;
  let stopped = false;
  const dueAt = (at: string) => Math.max(Date.parse(at), retryAt ?? 0);
  function cancel(): void {
    if (handle !== undefined) { timers.clear(handle); handle = undefined; }
  }
  function arm(): void {
    cancel();
    const at = deps.dueAlarm();
    if (stopped || at === undefined) return;
    handle = timers.set(() => {
      handle = undefined;
      const current = deps.dueAlarm();
      if (current !== undefined && dueAt(current) > clock().getTime()) arm(); else deps.fire();
    }, Math.min(Math.max(0, dueAt(at) - clock().getTime()), SEGMENT_MS));
  }
  return {
    arm,
    /** Starts the backoff over (a new alarm, or one that was delivered) and re-arms. */
    reset(): void { retries = 0; retryAt = undefined; arm(); },
    /** A delivery failed: the next try waits out the backoff. Returns the wait in minutes. */
    failed(): number {
      const minutes = retryMinutes[Math.min(retries++, retryMinutes.length - 1)]!;
      retryAt = clock().getTime() + minutes * 60_000;
      arm();
      return minutes;
    },
    stop(): void { stopped = true; cancel(); },
  };
}
