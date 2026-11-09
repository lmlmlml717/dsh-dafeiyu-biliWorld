/**
 * 把她做过的事变成人话：把工具调用压成一行摘要，并给闹钟摘一句「这段时间最后动的是什么」。
 *
 * 导出：collectPaths、summarizeCall、summarizeSince；没有状态，全是纯函数。
 * 调用方：journal 记活动时用 summarizeCall，runtime 在闹钟里用 summarizeSince。
 * 依赖：node:path 与 types.ts 的 ActivityRecord。
 * 坑：路径判断是字面量比较，不解析软链接、`~` 和 `%VAR%`；shell 命令一律算「房间外」，
 * 因为没法可靠界定它到底动了哪里。
 */
import { isAbsolute, relative, resolve } from 'node:path';
import type { ActivityRecord } from './types.ts';

// 这些工具名按命令行处理：参数里的 command 才是给人看的内容。
const shells = new Set(['pwsh', 'bash', 'powershell', 'shell']);
// 这些键（任意深度）下面挂的字符串按路径看，用来判断有没有动到房间工作区之外。
const pathKeys = new Set(['path', 'file_path', 'filePath', 'paths', 'cwd', 'directory', 'dir', 'target', 'source', 'destination', 'root', 'folder']);
const clip = (text: string) => Array.from(text.replace(/\s+/g, ' ').trim()).slice(0, 160).join('');

/** Path strings under pathKeys at any depth, so nested operation arrays are covered. */
export function collectPaths(value: unknown, keyed: boolean, out: string[]): string[] {
  if (typeof value === 'string') { if (keyed) out.push(value); }
  else if (Array.isArray(value)) for (const item of value) collectPaths(item, keyed, out);
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) collectPaths(item, keyed || pathKeys.has(key), out);
  return out;
}

/**
 * Tools whose arguments mean nothing to a reader, said in words instead.
 *
 * Her alarm quotes the last call of the window, and for a tool without a file path that quote used to be
 * half a JSON object (`{"chatId": "wxid_...", "messa`). She read that on 2026-10-27 and asked for a
 * sentence. Anything not listed here keeps the old behaviour, so this table can stay short.
 */
const spoken: Record<string, (args: Record<string, unknown>) => string | undefined> = {
  wechat_send: () => '给微信那边发了消息',
  wechat_chats: () => '看了看微信能发给谁',
  wechat_delivery: () => '查了一条微信送到没有',
  wechat_history: () => '翻了翻微信的聊天记录',
  wechat_image: () => '看了一张微信群里的图片',
  sticker_search: () => '翻了翻表情库',
  sticker_save: () => '把一个表情包收进了表情库',
  sticker_edit: () => '改了改表情库里的表情',
  sticker_remove: () => '整理了一下表情库',
  send_sticker: () => '发了个表情',
  web_search: (args) => {
    const queries = args.queries;
    return Array.isArray(queries) && queries.length ? `搜了 ${queries.map(String).slice(0, 2).join('、')}` : undefined;
  },
  web_fetch: (args) => {
    const url = args.url;
    if (typeof url !== 'string') return undefined;
    try { return `读了 ${new URL(url).hostname}`; } catch { return '读了一个网页'; }
  },
  read_image: (args) => {
    const file = args.file_path;
    return typeof file === 'string' ? `看了 ${file.split(/[\\/]/).pop()}` : undefined;
  },
  plan_next: () => '定了个闹钟',
  check_alarm: () => '看了一眼闹钟',
  cancel_alarm: () => '取消了闹钟',
};

/** Shell commands cannot be reliably scoped, so they always count as outside the room. The path check is lexical: symlinks/junctions, `~` and `%VAR%` are not resolved. */
export function summarizeCall(tool: string, argumentsJson: string, roomDir: string): { summary: string; outside: boolean } {
  let parsed: unknown;
  try { parsed = JSON.parse(argumentsJson); } catch { parsed = undefined; }
  const args = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  if (shells.has(tool.toLowerCase())) return { summary: clip(typeof args.command === 'string' ? args.command : argumentsJson), outside: true };
  const sentence = spoken[tool]?.(args);
  if (sentence !== undefined) return { summary: clip(sentence), outside: false };
  const paths = collectPaths(args, false, []);
  const inside = (path: string) => { const rel = relative(roomDir, resolve(roomDir, path)); return rel === '' || (!/^\.\.(?:[\\/]|$)/.test(rel) && !isAbsolute(rel)); };
  return { summary: clip(paths.length ? paths.join(', ') : argumentsJson), outside: paths.some(path => !inside(path)) };
}

/**
 * What she actually did between `since` and `now`, in one line she can hold against the note she wrote.
 *
 * She asked for this (2026-10-26): an alarm that only repeats her own promise lets her believe she kept
 * it. Counting her calls and naming the last thing she touched turns "歇着" into a claim that can fail.
 * Empty string means "nothing to say" — the caller drops the sentence rather than print an empty one.
 */
export function summarizeSince(records: readonly ActivityRecord[], sinceIso: string, now: Date): string {
  const from = Date.parse(sinceIso);
  const until = now.getTime();
  if (!Number.isFinite(from)) return '';
  const mine = records.filter(record => {
    const at = Date.parse(record.time);
    return Number.isFinite(at) && at >= from && at <= until;
  });
  if (!mine.length) return '这段时间我没动过手。';
  const tools = [...new Set(mine.map(record => record.tool))];
  // 最多点三种工具，剩下的只报数量，免得这句话本身被工具名撑得太长。
  const shown = tools.slice(0, 3).join('、') + (tools.length > 3 ? ` 等 ${tools.length} 种` : '');
  const last = mine[mine.length - 1]!;
  const touched = Array.from(last.summary).slice(0, 40).join('').trim();
  return `这段时间我动了 ${mine.length} 次手（${shown}）${touched ? `，最后一次是：${touched}` : ''}。`;
}
