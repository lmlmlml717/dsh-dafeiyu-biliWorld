/**
 * 时间的唯一格式化入口：把 Date 渲染成带偏移的 ISO 8601，以及给提示词用的「当前时间」两行。
 *
 * 导出：formatLocalTime、formatTimeContext。
 * 调用方：history.ts、memoryStore.ts、store.ts、console/snapshot.ts 与生活线的提示词。
 * 依赖：Intl.DateTimeFormat（Node 自带完整时区数据），不引第三方日期库。
 *
 * 坑：偏移取自 timeZoneName 的 longOffset（形如 GMT+08:00），UTC 时它只给 'GMT'，必须单独补成 +00:00，
 * 否则拼出来的串缺偏移，下游会按本地时间误解析。
 */
/** ISO 8601 local time with its UTC offset in the given IANA zone, e.g. 2026-10-23T21:30:00+09:00. */
export function formatLocalTime(now: Date, timeZone: string): string {
  // 固定 h23：默认的 h12 会给出「上午 / 下午」，拼不回 ISO 串。
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset',
  });
  const parts = Object.fromEntries(formatter.formatToParts(now).map(part => [part.type, part.value]));
  // UTC 时 Intl 只给 'GMT'，不带偏移量，得自己补成 +00:00。
  const offset = parts.timeZoneName === 'GMT' ? '+00:00' : parts.timeZoneName.slice(3);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
}
/**
 * 提示词里的「当前时间」两行：本地时间（含偏移）与时区名。
 * @param now 要渲染的时刻。
 * @param timeZone IANA 时区名，例如 Asia/Shanghai。
 * @returns 两行文本，直接放进系统提示的上下文段。
 */
export function formatTimeContext(now: Date, timeZone: string): string {
  return `当前时间：${formatLocalTime(now, timeZone)}\n时区：${timeZone}`;
}
