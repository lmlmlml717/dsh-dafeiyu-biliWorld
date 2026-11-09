/**
 * 闹钟文案：读取随插件发布的 alarm.md，合并世界目录里的自定义模板，再填模板变量。
 *
 * 导出：DEFAULT_ALARM_FILE、MESSAGE_KEYS、MessageKey、ALARM_MARK、parseSections、AlarmMessages、
 * readAlarmMessages、fillMessage、exampleTime。
 * 调用方：alarm.ts 生成各种唤醒文本，runtime 在工具描述里用同一份文案。
 * 依赖：node:fs/node:url、timeContext、worldPrompt.renderTemplate。
 * 坑：模板读不了永远不抛错，退回随包文案并返回 error 让调用方登记故障；
 * 缺哪一节就用随包的那一节，所以她可以只覆盖想改的几句。
 */
/**
 * 【链路位置】
 * 回顾文案的模板层：把 templates/alarm.md 与世界的 alarm.md 合并，再填成她读到的话。
 * 上游：alarm.ts 的 wakeText/reviewText 等调用 readAlarmMessages 与 fillMessage；runtime 用同一份节名生成工具说明。
 * 下游：worldPrompt.renderTemplate 做 {{name}} 与条件段替换；timeContext 取示例时间的时区偏移。
 * 读写：只读 templates/alarm.md 和世界目录下的 alarm.md，从不写模板。
 * 时序：每次要用文案时才读（runtime 的 alarmMessages），改完模板下一句话就生效。
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { formatLocalTime } from '../timeContext.ts';
import { renderTemplate } from '../worldPrompt.ts';

/**
 * 【上游参考】
 * templates/alarm.md 是主人可改的「她心里的声音」模板，按 ## 节覆盖，缺哪节就用随包的那节。
 * 世界目录下放同名 alarm.md 即可整段覆盖；【我的时间】标记由插件统一加，模板删不掉，压缩指令依赖它。
 */
/** The alarm wording shipped with the plugin; a world's own `alarm.md` replaces it section by section. */
export const DEFAULT_ALARM_FILE = fileURLToPath(new URL('../../templates/alarm.md', import.meta.url));
/** 模板里必须存在的节名；少一节就退回随包文案对应的一节。 */
export const MESSAGE_KEYS = ['第一次到家', '重新开始', '早上兜底', '闹钟响了', '晚到说明', '提前停下', '每日回顾', '额度用完', '结尾提醒', 'plan_next 说明', 'check_alarm 说明', 'cancel_alarm 说明'] as const;
/** 模板里可用的节名。 */
export type MessageKey = typeof MESSAGE_KEYS[number];
/** Marks her own alarm messages (in her own voice); the compaction instruction relies on it, so a template cannot drop it. Before 0.5 it read 【你的时间】. */
export const ALARM_MARK = '【我的时间】';

/** `## name` sections; with `names`, other Markdown headings stay in the current body. */
export function parseSections(text: string, names?: readonly string[]): Map<string, string> {
  const sections = new Map<string, string>();
  let key: string | undefined; let lines: string[] = [];
  const close = () => { if (key !== undefined) sections.set(key, lines.join('\n').trim()); };
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const heading = /^## (.+?)\s*$/.exec(line);
    if (heading && (!names || names.includes(heading[1]!))) { close(); key = heading[1]!; lines = []; } else if (key !== undefined) lines.push(line);
  }
  close();
  return sections;
}
/** 合并后的全部文案节；error 只在自定义模板读不了时出现。 */
export interface AlarmMessages { sections: Record<MessageKey, string>; error?: string }
/** Never throws: an unreadable world file falls back to the shipped wording and says why. Missing sections use the shipped ones. */
/**
 * 谁调用：runtime 的 alarmMessages()，每个文案函数在生成前都先过它。
 * 参数：file 是世界目录下的 alarm.md，undefined 表示只用随包模板。
 * 返回：合并后的全部节，缺的节用随包的；error 只在自定义模板读不了时出现。
 * 失败：自定义模板读不了不抛错，退回随包文案并把原因登记；随包模板本身缺失时才会抛。
 */
export function readAlarmMessages(file: string | undefined): AlarmMessages {
  const shipped = parseSections(readFileSync(DEFAULT_ALARM_FILE, 'utf8'));
  let own = new Map<string, string>(); let error: string | undefined;
  if (file && existsSync(file)) {
    try { own = parseSections(readFileSync(file, 'utf8')); }
    catch (cause) { error = `闹钟模板 ${file} 读不了，先用默认的：${cause instanceof Error ? cause.message : String(cause)}`; }
  }
  const sections = Object.fromEntries(MESSAGE_KEYS.map(key => [key, own.get(key) ?? shipped.get(key) ?? ''])) as Record<MessageKey, string>;
  return error ? { sections, error } : { sections };
}
/**
 * 用模板变量填一节文案；flags 决定可选段落留不留。
 * @param messages 已合并的模板节。
 * @param key 要填的节名。
 * @param values 模板变量。
 * @param flags 可选段开关，默认全关。
 * @returns 填好的文本；节为空时返回空串。
 */
/**
 * 谁调用：alarm.ts 的每个文案函数，按节名取合并后的那一节。
 * 参数：values 是模板变量；flags 决定可选段落留不留，默认全关。
 * 返回：填好的文本；节为空时返回空串，调用方自己决定还要不要加别的。
 */
export function fillMessage(messages: AlarmMessages, key: MessageKey, values: Record<string, string>, flags: Record<string, boolean> = {}): string {
  return renderTemplate(messages.sections[key], flags, values);
}
/** A fixed example time with the offset of the configured zone, so the description never changes between runs. */
export function exampleTime(timeZone: string): string {
  const offset = formatLocalTime(new Date('2026-10-23T12:00:00Z'), timeZone).slice(-6);
  return `2026-10-23T21:00:00${offset}`;
}
