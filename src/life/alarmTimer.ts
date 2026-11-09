/**
 * 闹钟的定时器：按墙上时钟把 `fire` 叫一次，投递失败时按 1/5/15/30/60 分钟退避。
 *
 * 导出：LifeTimers、realTimers、createAlarmTimer。
 * 调用方：life/runtime.ts（生活线）和 ecosystem/shared/turn.ts（请求超时）。
 * 依赖：无；时钟和定时器都从参数注入，测试里可以换成假实现。
 * 坑：一次最多睡 5 分钟就醒来重看墙上时钟，否则系统挂起、改时间会让闹钟永远不来；
 * 退避只推迟下一次尝试，不会改闹钟本身的时间。
 */
/**
 * 【链路位置】
 * 回顾链路的时钟：只负责在下一个到点时刻叫一声，叫醒之后做什么由 runtime 决定。
 * 上游：runtime.ts 用 dueAlarm() 告诉它待办是问候/回顾/闹钟里的哪一个、定在几点。
 * 下游：到点回调 runtime 的 deliver() 去真正投递；投递失败后由 runtime 调 failed() 排退避。
 * 读写：不读写任何文件；句柄、重试次数、下次重试时刻都只在这个闭包里。
 * 时机：最多睡 5 分钟就醒来重看墙上时钟，系统挂起或改时间都不会让闹钟永远不来。
 */
/** 定时器的最小接口；抽出来是为了测试里不真的等。 */
export interface LifeTimers { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void }
/** 真实实现：直接用 setTimeout，句柄原样交给 clear。 */
export const realTimers: LifeTimers = { set: (fn, ms) => setTimeout(fn, ms), clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) };

// 失败后的等待梯度；到顶之后一直按 60 分钟重试，不再拉长。
const retryMinutes = [1, 5, 15, 30, 60];
/**
 * 【上游参考】
 * 生活线骨架（alarm/journal/runtime 的闹钟+回顾模型）来自 dsh-dafeiyu-life；
 * 这个文件是该模型里的定时部分：等待、叫醒、失败退避，文案和投递都不在这里。
 */
/** Timers wait at most this long before re-checking the wall clock, so suspend and clock changes cannot strand an alarm. */
const SEGMENT_MS = 5 * 60_000;

/**
 * 谁调用：runtime.ts 创建一次；start()、setAlarm()、confirmed() 时 arm/reset，投递失败时 failed。
 * 参数：clock 取当前时刻；timers 提供 set/clear（测试可换假实现）；dueAlarm 返回下一个待办时刻；
 *   fire 是到点后的投递入口。
 * 返回：arm/reset/failed/stop；failed 返回这次退避的分钟数，故障文案要用它。
 * 失败：退避只推迟下一次尝试，不改闹钟本身的时间；stop 之后不再排任何定时器。
 */
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
