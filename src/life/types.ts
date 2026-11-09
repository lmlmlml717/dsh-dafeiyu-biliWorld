/**
 * 生活线的数据形状：闹钟、回顾、问候、当日花费、投递中的唤醒，以及活动和压缩记录。
 *
 * 导出：全部是类型/接口（Alarm、Review、Greeting、Spend、PendingWake、LifeState、WakeRecord、
 * ActivityRecord、CompactionRecord、DailySchedule、LifeOptions），编译后不留下运行时代码。
 * 调用方：life/ 下的 runtime、lifeStore、alarm、earlyStop、journal 等，以及装配这些模块的入口。
 * 依赖：无，只靠 TypeScript 类型系统，所以任何一层都能安全引用而不产生循环依赖。
 * 坑：LifeState.version 目前只有 1，新增字段要按可选字段加，旧 life.json 必须还能读；
 * PendingWake 先写盘再投递，其中的 job 是投递失败后把日程放回去的唯一凭据，字段不能随手删。
 */
/** 闹钟的来源：`plan` 是她自己用 plan_next 许下的，`fallback` 是插件按作息补的兜底闹钟。 */
export type AlarmSource = 'plan' | 'fallback';
/** `nudged`: she was already asked once, when a home turn stopped well before this alarm, whether she is done. */
export interface Alarm { at: string; note: string; setAt: string; source: AlarmSource; nudged?: true }
/** The next look back on a day: when it is due, and the local day it looks back on. */
export interface Review { at: string; day: string }
/** A word the plugin owes her home: `arrival` when a new home was built, `return` when her world was started again. */
export interface Greeting { at: string; kind: 'arrival' | 'return' }
/** What her home spent on the local `day`, in CNY, and whether she was told she went past her budget. */
export interface Spend { day: string; yuan: number; reminded?: true }
/**
 * A word steered into her home whose turn has not been seen to start a step yet. It is written before the steer,
 * so a turn that never runs (a hang, a crash, a closed app) is found again and sent again instead of counted.
 */
export interface PendingWake {
  messageId: string; sessionId: string; sentAt: string; what: string;
  scheduledAt: string; source: WakeRecord['source'];
  /** What goes back on the schedule if the turn never runs. */
  job: { alarm: Alarm } | { review: Review } | { greeting: Greeting };
}
/**
 * life.json 的根：她的家、唯一一个待响的闹钟、待说的问候、下一次回顾、当天花费，以及正在投递的那句话。
 * 这是生活线重启后唯一的真相来源，任何一步失败都不能把它写成半截（见 lifeStore 的 durableWrite）。
 */
export interface LifeState { version: 1; homeSessionId?: string; alarm?: Alarm; greeting?: Greeting; review?: Review; spend?: Spend; delivering?: PendingWake }
/** 一条已确认送达的唤醒：计划时间、真正送达时间、来源，以及晚了多久（毫秒）。 */
/** `first` is a new home's first wake, `return` the word when her world starts again, `review` the daily look back. */
export interface WakeRecord { scheduledAt: string; deliveredAt: string; source: AlarmSource | 'first' | 'return' | 'review'; lateMs: number }
/**
 * 家里的一次工具调用，等结果出来才落一条：`outside` 表示动到了房间工作区之外，
 * `gapBefore` 表示上一条没写成、这里有个缺口，`status` 只在明确失败时是 error。
 */
export interface ActivityRecord { time: string; sessionId: string; callId: string; tool: string; summary: string; outside: boolean; gapBefore?: true; status?: 'ok' | 'error' }
/** 一次上下文压缩：哪个会话、成没成、压掉了多少 token，失败时带上原因。 */
export interface CompactionRecord { time: string; sessionId: string; ok: boolean; shadowedTokens?: number; error?: string }
/** 控制台可改的作息：晚上回顾与早上兜底唤醒，都是当地 HH:MM。 */
export interface DailySchedule { review: string; wake: string }
/**
 * 生活线的路径与作息来源：目录都由装配层按世界目录算好传进来；
 * schedule() 每次现读，控制台改了时间不用重启。
 */
export interface LifeOptions {
  worldDir: string; roomDir: string; diaryDir: string; selfFile: string; timeZone: string;
  /** Local HH:MM of the evening look back and of the morning wake when nothing is pending; read each time, since the console can change them. */
  schedule(): DailySchedule;
  /** Her alarm wording; the shipped `templates/alarm.md` when absent or missing. */
  alarmFile?: string;
}
