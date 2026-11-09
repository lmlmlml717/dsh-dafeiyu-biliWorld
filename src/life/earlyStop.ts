/**
 * 判断「她是不是提前收工了」：一轮正常结束、离自己定的闹钟还早、这一轮又没被问过，才问一次。
 *
 * 导出：EARLY_STOP_MS、createEarlyStopWatch。
 * 调用方：life/runtime.ts 在 turn/end 与 user/message 事件里喂它。
 * 依赖：types.ts 的 Alarm（只看 source 和 nudged）。
 * 坑：搭档说过话的轮次算对话暂停、插件自己起的轮次（问候、提醒）不算，否则会自己问自己；
 * 每个闹钟只问一次（nudged），问过就不再打扰。
 */
import type { Alarm } from './types.ts';

/** A home turn that stops more than this before her own alarm stopped early. */
export const EARLY_STOP_MS = 5 * 60_000;

/**
 * Decides when a home turn that ends counts as her stopping early: a completed turn, well before her own
 * alarm, not yet asked about for that alarm. A turn in which her partner spoke is a conversation pausing,
 * and a turn the plugin started itself (the question, a new home's greeting) is never asked about, so nothing loops.
 */
export function createEarlyStopWatch() {
  // 两个标记都只描述当前这一轮：turnEnded 读完立刻清零，下一轮重新算。
  let partnerSpoke = false;
  let ownTurn = false;
  return {
    partnerSpoke(): void { partnerSpoke = true; },
    /** Ends the turn's marks; true when this ending should be asked about. */
    turnEnded(completed: boolean, alarm: Alarm | undefined, now: Date): alarm is Alarm & { source: 'plan' } {
      // 三个条件同时成立才算「安静地提前停了」，少一个都可能是正常对话或插件自己起的话头。
      const quiet = completed && !partnerSpoke && !ownTurn;
      partnerSpoke = false; ownTurn = false;
      return quiet && alarm?.source === 'plan' && !alarm.nudged && Date.parse(alarm.at) - now.getTime() > EARLY_STOP_MS;
    },
    /** The plugin is starting a turn of its own; that turn is not asked about. */
    startsOwnTurn(): void { ownTurn = true; },
    /** Its message never arrived, so no turn of its own will follow. */
    ownTurnFailed(): void { ownTurn = false; },
  };
}
