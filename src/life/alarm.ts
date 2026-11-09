/**
 * 闹钟与回顾的文案和时刻计算：把计划、回顾、问候变成她读到的整段话，并算出下一次本地时间。
 *
 * 导出：DEFAULT_REVIEW_TIME、CLOCK_TIME、validClockTime、resolveAlarmTime、nextLocalTime、
 * formatDuration、wakeText、greetingText、nextReview、reviewOf、ReviewFiles、reviewText、
 * earlyStopText、planReply、checkReply、cancelReply、budgetText。
 * 调用方：life/runtime.ts（投递与工具回答）、tools.ts（工具描述）。
 * 依赖：timeContext.formatLocalTime、messages.ts 的模板读取与填充、types.ts。
 * 坑：本地时间要按目标时区反推，夏令时空档（被跳过的钟点）落在空档后的第一个瞬间；
 * 文案里的【我的时间】标记由插件统一加，模板删不掉，压缩指令依赖它。
 */
/**
 * 【链路位置】
 * 回顾链路的计算与文案中枢：算出下一次回顾的时刻和它回看的那一天，再填成她读到的话。
 * 上游：runtime.ts 的 start() 排第一次、lookBack() 到点后滚下一天、followSchedule() 在改作息后重排。
 * 下游：nextLocalTime 用 timeContext.formatLocalTime 反推本地时间；文案走 messages.ts 的模板合并与填充。
 * 读写：不碰文件；ReviewFiles 里的路径只是填进模板，真正读材料的是她按提示词自己去读。
 * 时机：默认 23:00；回顾时刻早于中午时回看前一天，到点后由 runtime 投递。
 */
import { formatLocalTime } from '../timeContext.ts';
import type { Alarm, Review } from './types.ts';
import { ALARM_MARK, exampleTime, fillMessage, readAlarmMessages, type AlarmMessages } from './messages.ts';

// 定闹钟至少留 1 分钟，避免刚定就响；迟到 2 分钟以上才在文案里说明。
const MIN_ALARM_MS = 60_000;
const LATE_NOTICE_MS = 2 * 60_000;
/** The local time of her evening look back unless the console sets another. */
export const DEFAULT_REVIEW_TIME = '23:00';
/** A local time of day, HH:MM on the 24-hour clock. */
export const CLOCK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
/** 是否是合法的本地 HH:MM；控制台和时间解析共用这一处判断。 */
export const validClockTime = (value: unknown): value is string => typeof value === 'string' && CLOCK_TIME.test(value);

/**
 * 谁调用：runtime 的 planNext()，她调 plan_next 定闹钟时。
 * 参数：input 二选一，at 带时区的 ISO 时间或 after_minutes 正数分钟；now 是当前时钟，timeZone 用于报错示例。
 * 返回：绝对时间 Date，至少比 now 晚 1 分钟。
 * 失败：参数不合法、格式不对、时间看不懂或太近都抛错，由工具层转成她读得懂的话。
 */
/**
 * 把 plan_next 的参数解析成绝对时间：at 与 after_minutes 必须二选一。
 * 校验 ISO 格式、正数分钟和「至少 1 分钟后」；不合法直接抛错，由工具调用方转成给她的提示。
 */
export function resolveAlarmTime(input: { at?: string; after_minutes?: number }, now: Date, timeZone = 'UTC'): Date {
  if ((input.at === undefined) === (input.after_minutes === undefined)) throw new Error('请只给 at 或 after_minutes 其中一个');
  let target: Date;
  if (input.at !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(input.at)) throw new Error(`at 需要 ISO 8601 格式并带时区，例如 ${exampleTime(timeZone)}`);
    target = new Date(input.at);
  } else {
    const minutes = input.after_minutes!;
    if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('after_minutes 必须是正数');
    target = new Date(now.getTime() + minutes * 60_000);
  }
  if (!Number.isFinite(target.getTime())) throw new Error(`无法识别的时间：${input.at ?? input.after_minutes}`);
  if (target.getTime() - now.getTime() < MIN_ALARM_MS) throw new Error('闹钟至少要定在 1 分钟之后');
  return target;
}
// 从格式化后的本地时间里取时区偏移，用于把墙上时间换算回 UTC。
const offsetMs = (at: number, timeZone: string) => {
  const m = /([+-])(\d{2}):(\d{2})$/.exec(formatLocalTime(new Date(at), timeZone))!;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60_000;
};
/** The first instant strictly after `now` whose local time in `timeZone` is hhmm:00; a time skipped by a DST gap lands on the first instant after the gap. */
/**
 * 谁调用：nextReview（排回顾）、runtime 的 morning()（兜底闹钟）、followSchedule()（改早上时间后重排）。
 * 语义：返回严格晚于 now、在 timeZone 里本地读数为 hhmm 的第一个瞬间。
 * 返回：Date；夏令时被跳过的钟点落在空档后的第一个瞬间。
 * 失败：三天内都找不到（时区配置坏掉）时抛错，不拿一个猜的时间顶上。
 */
export function nextLocalTime(now: Date, hhmm: string, timeZone: string): Date {
  const [hour, minute] = hhmm.split(':').map(Number) as [number, number];
  const today = formatLocalTime(now, timeZone);
  const [y, mo, d] = [Number(today.slice(0, 4)), Number(today.slice(5, 7)), Number(today.slice(8, 10))];
  // 最多看今天、明天、后天：夏令时最多挪一小时，三天足够兜住任何一次跳变。
  for (let k = 0; k < 3; k++) {
    const wall = Date.UTC(y, mo - 1, d + k, hour, minute);
    const date = new Date(wall).toISOString().slice(0, 10);
    const want = `${date}T${hhmm}:00`;
    const around = [offsetMs(wall - 86_400_000, timeZone), offsetMs(wall + 86_400_000, timeZone)];
    const hits = [...new Set(around)].map(offset => wall - offset).filter(at => formatLocalTime(new Date(at), timeZone).slice(0, 19) === want);
    let at = hits.length ? Math.min(...hits.filter(h => h > now.getTime()), Infinity) : NaN;
    if (!hits.length) {
      // Skipped by a gap: the first instant from which the local clock reads at least the wanted time.
      let [lo, hi] = [wall - Math.max(...around), wall - Math.min(...around)].sort((a, b) => a - b) as [number, number];
      while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (formatLocalTime(new Date(mid), timeZone).slice(0, 19) >= want) hi = mid; else lo = mid; }
      at = hi;
    }
    if (at > now.getTime() && Number.isFinite(at)) return new Date(at);
  }
  throw new Error(`找不到 ${hhmm} 之后的下一个时间`);
}
/** 把毫秒说成「X 天 X 小时 X 分」，不足一分钟按 0 分算。 */
export function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  const days = Math.floor(minutes / 1440); const hours = Math.floor((minutes % 1440) / 60); const rest = minutes % 60;
  const parts = [days ? `${days} 天` : '', hours ? `${hours} 小时` : '', rest || (!days && !hours) ? `${rest} 分` : ''];
  return parts.filter(Boolean).join(' ');
}
/**
 * 谁调用：runtime 的 send()，闹钟到点、家打开之后。
 * 时机：source 为 fallback 走「早上兜底」，否则走「闹钟响了」，并把这段时间做过的事拼进去。
 * 返回：带【我的时间】标记的整段话；did 为空时模板里那段自动省略。
 */
/**
 * What she hears when an alarm rings. The wording comes from the alarm template (`extra` carries her
 * names for templates that use them, plus `did` — one line about what she actually did since she set the
 * alarm, so the promise and the record arrive together); the 【我的时间】 mark is always the plugin's own.
 */
export function wakeText(alarm: Alarm, now: Date, timeZone: string, fallbackWakeTime: string, messages: AlarmMessages = readAlarmMessages(undefined), extra: Record<string, string> = {}): string {
  const base = { ...extra, timeZone, fallbackWakeTime };
  const lateText = lateNotice(now.getTime() - Date.parse(alarm.at), messages, base);
  const body = alarm.source === 'fallback' ? fillMessage(messages, '早上兜底', { ...base, late: lateText })
    : fillMessage(messages, '闹钟响了', { ...base, time: formatLocalTime(new Date(alarm.at), timeZone), note: alarm.note, late: lateText }, { note: Boolean(alarm.note), did: Boolean(extra.did) });
  return withTail(body, messages, base);
}
/** What a new home says the moment it is built, or her home when her world starts again. */
export function greetingText(kind: 'arrival' | 'return', timeZone: string, fallbackWakeTime: string, messages: AlarmMessages = readAlarmMessages(undefined), extra: Record<string, string> = {}): string {
  const base = { ...extra, timeZone, fallbackWakeTime };
  return withTail(fillMessage(messages, kind === 'arrival' ? '第一次到家' : '重新开始', base), messages, base);
}
const dayBefore = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
/**
 * 谁调用：runtime 的 start()（第一次排期）、lookBack() 的 take（发出后滚到下一天）、followSchedule()（改作息）。
 * 参数：now 是当前时钟；timeZone 是世界时区；time 是控制台里的回顾时刻，缺省 23:00。
 * 返回：at 是下一次回顾的 ISO 时刻，day 是它回看的那一天；time 早于 12:00 时 day 取前一天。
 * 失败：nextLocalTime 找不到时刻时直接抛错，本函数不兜底。
 */
/** The next look back after `now` at local `time`, and the day it looks back on: one before noon looks back on the day before. */
export function nextReview(now: Date, timeZone: string, time = DEFAULT_REVIEW_TIME): Review {
  const at = nextLocalTime(now, time, timeZone);
  const date = formatLocalTime(at, timeZone).slice(0, 10);
  return { at: at.toISOString(), day: time < '12:00' ? dayBefore(date) : date };
}
/**
 * 谁调用：runtime 的 followSchedule()，控制台把回顾时刻改早或改晚之后。
 * 参数：day 是原来排定的回看日，now/timeZone/time 是新的时钟、时区与时刻。
 * 返回：同一个 day 的新 Review；新时刻已经错过这一天时返回 at=now 的立即回顾，避免漏掉或重复。
 * 做法：沿 nextReview 一次次往后推，直到回看日追上 day；只读不写。
 */
/**
 * The look back on `day` once its time has changed to `time`: no day is looked back on twice or skipped. Moved
 * earlier than now, the day's look back is due at once.
 */
export function reviewOf(day: string, now: Date, timeZone: string, time: string): Review {
  let review = nextReview(now, timeZone, time);
  while (review.day < day) review = nextReview(new Date(review.at), timeZone, time);
  return review.day > day ? { at: now.toISOString(), day } : review;
}
/** Where her day is written down; a file that does not exist is left out. */
/**
 * 回顾要读的材料：conversations/activity/snapshot 都是可选文件，不存在就不填；
 * diaryDir 与 selfFile 一定给，模板据此告诉她日记写在哪、我是谁在哪。
 */
export interface ReviewFiles { conversations?: string; activity?: string; diaryDir: string; selfFile: string; snapshot?: string }
/**
 * 谁调用：runtime 的 lookBack()，在回顾到点、家已打开、写进收件箱之前。
 * 参数：review 是到点的 day/at；now 是投递时刻，用来算迟到；files 是材料路径；
 *   timeZone 与 fallbackWakeTime 进模板变量；messages 是合并后的 alarm.md；extra 追加名字等。
 * 返回：带【我的时间】标记的整段提示词；材料缺失时对应段落由 flags 关掉。
 * 失败：模板读不了已在 messages 里退回随包文案，这里只做字符串替换，不抛错。
 */
/** The evening look back: the day, where to read it, and her 我是谁 to rewrite if she has changed. */
export function reviewText(review: Review, now: Date, files: ReviewFiles, timeZone: string, fallbackWakeTime: string, messages: AlarmMessages = readAlarmMessages(undefined), extra: Record<string, string> = {}): string {
  const base = { ...extra, timeZone, fallbackWakeTime };
  const values = { ...base, date: review.day, diaryDir: files.diaryDir, selfFile: files.selfFile, conversations: files.conversations ?? '', activity: files.activity ?? '', snapshot: files.snapshot ?? '', late: lateNotice(now.getTime() - Date.parse(review.at), messages, base) };
  return withTail(fillMessage(messages, '每日回顾', values, { conversations: Boolean(files.conversations), activity: Boolean(files.activity), snapshot: Boolean(files.snapshot) }), messages, base);
}
function lateNotice(late: number, messages: AlarmMessages, values: Record<string, string>): string {
  // 迟到不足两分钟不提，免得每句话都先道歉。
  return late >= LATE_NOTICE_MS ? fillMessage(messages, '晚到说明', { ...values, lateBy: formatDuration(late) }) : '';
}
/**
 * 【上游参考】
 * 文案模板来自 templates/alarm.md，「每日回顾」是其中一节；世界目录下的同名 alarm.md 可整段覆盖。
 * 生活线骨架（alarm/journal/runtime 的闹钟+回顾模型）来自 dsh-dafeiyu-life。
 * 【我的时间】标记由插件统一加在这里，模板删不掉，压缩指令依赖它。
 */
function withTail(body: string, messages: AlarmMessages, values: Record<string, string>): string {
  // 标记永远由插件加在最前面，模板只能决定正文和尾巴。
  const tail = fillMessage(messages, '结尾提醒', values);
  return `${ALARM_MARK}${body}${tail ? `\n${tail}` : ''}`;
}
/** What she hears when a home turn stops well before the time she said she would keep at it. */
export function earlyStopText(alarm: Alarm, now: Date, timeZone: string, messages: AlarmMessages = readAlarmMessages(undefined), extra: Record<string, string> = {}): string {
  const body = fillMessage(messages, '提前停下', { ...extra, timeZone, time: formatLocalTime(new Date(alarm.at), timeZone), now: formatLocalTime(now, timeZone), note: alarm.note }, { note: Boolean(alarm.note) });
  return `${ALARM_MARK}${body}`;
}
const local = (at: string | Date, timeZone: string) => formatLocalTime(new Date(at), timeZone);
/** plan_next's answer. Replacing her own plan says what it carried, while she can still copy it over; the plugin's own alarms are replaced silently. */
export function planReply(at: Date, replaced: Alarm | undefined, timeZone: string): string {
  const old = replaced?.source === 'plan' ? `（替换了原来做到 ${local(replaced.at, timeZone)} 的安排${replaced.note ? `：「${replaced.note}」。还想留着里面的事，就写进新的 note` : ''}。）` : '';
  return `记下了，到 ${local(at, timeZone)} 提醒我。${old}`;
}
/** check_alarm 的回答：有闹钟就说还有多久，没有就说下一次什么时候。 */
export function checkReply(alarm: Alarm | undefined, now: Date, timeZone: string): string {
  if (!alarm) return '现在没有闹钟。';
  const left = Date.parse(alarm.at) - now.getTime();
  const when = `${local(alarm.at, timeZone)}（${left > 0 ? `还有 ${formatDuration(left)}` : '已经到点，正在叫我'}）`;
  if (alarm.source === 'plan') return `我说好${alarm.note ? `做「${alarm.note}」` : ''}做到 ${when}。`;
  return `我现在没有自己定的闹钟。下一次会在 ${when}按平常的时间叫我。`;
}
/** cancel_alarm 的回答：只取消她自己定的，兜底闹钟照常排到下一个早上。 */
export function cancelReply(cancelled: Alarm | undefined, next: Alarm | undefined, timeZone: string): string {
  if (cancelled?.source !== 'plan') return `现在没有我自己定的闹钟，不用取消。${next ? `下一次会在 ${local(next.at, timeZone)} 按平常的时间叫我。` : ''}`;
  return `取消了做到 ${local(cancelled.at, timeZone)} 的安排${cancelled.note ? `：「${cancelled.note}」` : ''}。不另定的话，我就休息到 ${next ? local(next.at, timeZone) : '明早'}。`;
}
/** Told once a day, when her home has spent past the daily budget. */
export function budgetText(spent: number, budget: number, messages: AlarmMessages = readAlarmMessages(undefined), extra: Record<string, string> = {}): string {
  return `${ALARM_MARK}${fillMessage(messages, '额度用完', { ...extra, spent: spent.toFixed(2), budget: budget.toFixed(2) })}`;
}
