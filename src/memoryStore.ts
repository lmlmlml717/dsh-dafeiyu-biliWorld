/**
 * 长期记忆的存储层：引用的编码解码、字面匹配查询，以及从原表与文件里取出一条原文。
 *
 * 导出：记忆种类与时间依据、MemoryError（带错误码）、各种结果类型、上限常量、sha、decodeRef、chatRef、
 * fileRef、refHash、extractLinks、localDayStart、excerptOf、createMemoryStore 及其推断类型 MemoryStore。
 * 调用方：memory.ts 是唯一入口；store.ts 建记忆视图，memoryTools.ts 经 memory.ts 间接使用。
 * 依赖：node:sqlite 里的 records 表、node:crypto、时区格式化；不建索引、不复制数据。
 *
 * 坑：ref 绑定的是「当时那段文字」的哈希，正文一改旧 ref 就失效并报 sourceChanged —— 这是有意的：
 * 引用必须能证明出处，不能悄悄指向改过的内容。时间比较统一换成 SQLite 的 UTC 毫秒格式，避免时区串味。
 */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { formatLocalTime } from './timeContext.ts';
import type { ConversationRecord } from './types.ts';

/** 记忆的种类：原始聊天，以及她自己写的日记等文件。 */
export const MEMORY_KINDS = ['conversation', 'diary'] as const;
/** 记忆种类的联合类型，由 MEMORY_KINDS 推导，免得两处各写一遍。 */
export type MemoryKind = typeof MEMORY_KINDS[number];
/** `message`: when the line was said. `diaryDate`: the day in a diary's file name. `fileObserved`: when the file last changed. */
export type TimeBasis = 'message' | 'diaryDate' | 'fileObserved';
/** 记忆层抛出的错误码；工具与控制台按码区分「查法不对」「引用失效」「范围变了」。 */
export type MemoryErrorCode = 'invalidQuery' | 'invalidRef' | 'invalidCursor' | 'cursorExpired' | 'notFound' | 'outOfScope' | 'sourceChanged' | 'scopeChanged' | 'readFailed';
/**
 * 记忆层对外抛的错误：带一个稳定错误码，回包和面板据此说人话。
 * @param code 错误码。
 * @param message 给人看的中文说明。
 * @param options 可选的原错误，用来保留 cause 与栈。
 */
export class MemoryError extends Error {
  readonly code: MemoryErrorCode;
  constructor(code: MemoryErrorCode, message: string, options?: ErrorOptions) { super(message, options); this.name = 'MemoryError'; this.code = code; }
}
/** 记忆来源的健康状况：ready 全部读到；partial 表示有来源没读到，failures 逐条说明。 */
export interface MemoryStatus {
  state: 'ready' | 'partial';
  failures: { sourceId: string; message: string }[];
  checkedAt: string;
}
/** Where a chat line came from: only what the record itself carries. */
export interface MemoryOrigin {
  sessionId?: string; role?: 'user' | 'assistant'; speakerId?: string; speakerName?: string; channel?: string;
  conversationId?: string; conversationName?: string; conversationType?: string;
}
/** 一条命中的卡片：引用、来源、时间（含时间依据）与摘录；聊天还带轮次与出处。 */
export interface MemoryItem {
  ref: string; sourceId: string; kind: MemoryKind; title: string; time: string; timeBasis: TimeBasis; current: boolean; excerpt: string;
  turnId?: string; origin?: MemoryOrigin; version?: number;
}
/** 归一化后的查询条件；外部输入必须先过 normalizeFind，别直接构造这个对象往里传。 */
export interface FindParams {
  query?: string; kinds?: readonly MemoryKind[]; fromMs?: number; toMs?: number; sourceId?: string; turnId?: string; linkedTo?: string;
  order: 'newest' | 'oldest'; limit: number; cursor?: string;
}
/** 一条引用的原文读取结果；version 是引用时绑定的正文哈希前缀，用来判断出处有没有改过。 */
export interface ReadResult {
  ref: string; sourceId: string; kind: MemoryKind; version: string; title: string; time: string; timeBasis: TimeBasis; current: boolean;
  content: string; turnId?: string; origin?: MemoryOrigin;
}

/** 查询词上限：再长就只是把一整段话贴进来当条件了。 */
export const MAX_QUERY_CHARS = 200;
/** 摘录长度：工具回包每一步都会重发，这条线直接决定每轮要花多少上下文。 */
export const EXCERPT_CHARS = 300;
/** 一个文件最多认这么多条显式引用：防止一篇文件把链接查询的结果撑爆。 */
const MAX_LINKS_PER_DOC = 200;
/**
 * 统一的 sha256 十六进制摘要；ref 与分页游标都靠它判断「东西变没变」。
 * @param text 要摘要的文本。
 * @returns 64 位十六进制串；同样的输入永远同样的输出。
 */
export const sha = (text: string) => createHash('sha256').update(text).digest('hex');

// ref 的线格式：前缀 m1. 加 base64url 的 JSON 数组。短、能塞进工具参数，也不含需要转义的字符。
const encodeRef = (parts: unknown[]) => 'm1.' + Buffer.from(JSON.stringify(parts)).toString('base64url');
/**
 * 解析一条 ref。
 * @param ref memory_find 给出的引用串。
 * @returns 聊天引用（c，带记录 id 与正文哈希）或文件引用（a，带来源 id 与正文哈希）。
 * @throws 前缀、base64 或结构任一不对时抛 MemoryError('invalidRef')；不会返回 undefined。
 */
export function decodeRef(ref: string): { kind: 'c'; recordId: string; hash: string } | { kind: 'a'; sourceId: string; hash: string } {
  try {
    if (!ref.startsWith('m1.')) throw new Error('prefix');
    const parts = JSON.parse(Buffer.from(ref.slice(3), 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(parts) && typeof parts[1] === 'string' && typeof parts[2] === 'string') {
      if (parts[0] === 'c') return { kind: 'c', recordId: parts[1], hash: parts[2] };
      if (parts[0] === 'a') return { kind: 'a', sourceId: parts[1], hash: parts[2] };
    }
  } catch { /* falls through */ }
  // 任何一步不对都归到同一个错误码：调用方只该知道「这不是有效引用」，不该看到内部结构。
  throw new MemoryError('invalidRef', '引用无效：这不是 memory_find 给出的 ref');
}
/** A ref is bound to the text it showed, so a revised line or an edited file is told apart from the one that was cited. */
const hashOf = (content: string) => sha(content).slice(0, 12);
/** 聊天记录的引用：绑定记录 id 与当时正文的短哈希。 */
export const chatRef = (recordId: string, content: string) => encodeRef(['c', recordId, hashOf(content)]);
/** 文件（日记等）的引用：绑定来源 id 与当时正文的短哈希。 */
export const fileRef = (sourceId: string, content: string) => encodeRef(['a', sourceId, hashOf(content)]);
/** 正文的短哈希前缀；读取时拿它比对「还是不是当初那段字」。 */
export const refHash = hashOf;

/** Explicit links only: a line `引用：memory:<ref> memory:<ref>`. */
export function extractLinks(content: string): string[] {
  // 只认「引用：」开头的行：这是她和程序约定好的格式，正文里随手提到的 ref 不算链接。
  const found = new Set<string>();
  for (const line of content.matchAll(/^引用[：:][ \t]*(.+)$/gm)) {
    for (const token of line[1]!.matchAll(/memory:(m1\.[A-Za-z0-9_-]+)/g)) { found.add(token[1]!); if (found.size >= MAX_LINKS_PER_DOC) return [...found]; }
  }
  return [...found];
}
/** The instant a local calendar day starts in the zone, with the offset it has then. */
export function localDayStart(date: string, timeZone: string): { ms: number; time: string } | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  const guess = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(guess) || new Date(guess).toISOString().slice(0, 10) !== date) return undefined;
  const offsetMs = (at: number) => { const text = formatLocalTime(new Date(at), timeZone); return Date.parse(text.slice(0, 19) + 'Z') - Math.floor(at / 1000) * 1000; };
  let ms = guess - offsetMs(guess);
  // 用第一次算出的偏移再算一次：夏令时切换那天的偏移与零点时不同，一次换算会差一小时。
  ms = guess - offsetMs(ms);
  const time = formatLocalTime(new Date(ms), timeZone);
  return { ms, time: time.startsWith(date) ? time : `${date}T00:00:00${time.slice(19)}` };
}
/** A window of `EXCERPT_CHARS` characters around the first match (or the start), cut on whole characters. */
export function excerptOf(content: string, query: string | undefined): string {
  // 按「字」而不是 UTF-16 码元切，免得把汉字或 emoji 的代理对切成半个。
  const at = query ? Math.max(0, content.indexOf(query)) : 0;
  const lead = Array.from(content.slice(Math.max(0, at - 400), at)).length;
  const from = Math.max(0, lead - 100);
  return Array.from(content.slice(Math.max(0, at - 400), at + 1200)).slice(from, from + EXCERPT_CHARS).join('');
}
// 只带记录里真有的字段：缺的不补默认值，免得把「不知道」写成某个具体身份。
const originOf = (record: ConversationRecord): MemoryOrigin => ({
  sessionId: record.sourceSessionId, role: record.role,
  ...(record.speakerId ? { speakerId: record.speakerId } : {}), ...(record.speakerName ? { speakerName: record.speakerName } : {}), ...(record.channel ? { channel: record.channel } : {}),
  ...(record.conversationId ? { conversationId: record.conversationId } : {}), ...(record.conversationName ? { conversationName: record.conversationName } : {}), ...(record.conversationType ? { conversationType: record.conversationType } : {}),
});
/** SQLite's own normal form of a timestamp (UTC, milliseconds), so lines stored with any offset compare as the same instants. */
const SQL_INSTANT = "strftime('%Y-%m-%dT%H:%M:%f', occurredAt)";
const instant = (ms: number) => new Date(ms).toISOString().slice(0, 23);
const SESSION = "json_extract(body, '$.sourceSessionId')";

/**
 * Chat lines are searched where they already are: the archive's `records` table, by scanning. Nothing is copied or
 * indexed, so there is nothing to build, migrate or rebuild; an archive from before this existed answers at once.
 */
export function createMemoryStore(db: DatabaseSync, deps: { timeZone: string }) {
  // db 由 store.ts 持有并负责关闭，这里只借用；timeZone 用来把记录时间渲染成本地时间。
  const { timeZone } = deps;
  /** Bumped when a stored line is revised, so a page cursor taken before the revision no longer applies. */
  let revisions = 0;
  let sessionCache: { head: number; ids: string[] } | undefined;
  const head = () => Number(db.prepare('SELECT COALESCE(MAX(sequence), 0) AS n FROM records').get()?.n);
  const recordOf = (body: string) => JSON.parse(body) as ConversationRecord;

  /** The newest line the archive has; a page cursor stays inside the lines that existed when it was taken. */
  const snapshot = () => ({ head: head(), revisions });
  const revised = () => { revisions++; };
  /** Chat sessions that have lines; the caller decides which of them it may see. */
  function sessionIds(): string[] {
    const now = head();
    // 按 head 缓存会话列表：没有新行就不必每次再扫一遍全表。
    if (sessionCache?.head !== now) sessionCache = { head: now, ids: (db.prepare(`SELECT DISTINCT ${SESSION} AS sessionId FROM records`).all() as unknown as { sessionId: string }[]).map(row => row.sessionId) };
    return sessionCache.ids;
  }

  /** The matching lines of the given sessions in the asked order, at most `take` of them, never past `upTo`. */
  function find(params: FindParams, sessions: readonly string[], upTo: number, take: number): ConversationRecord[] {
    // 条件片段全是写死的，值一律走占位符绑定：查询词再怪也进不了 SQL 结构。
    const where = [`${SESSION} IN (SELECT value FROM json_each(?))`, 'sequence<=?'];
    const values: (string | number)[] = [JSON.stringify(sessions), upTo];
    if (params.sourceId) { where.push(`${SESSION}=?`); values.push(params.sourceId.slice('chat:'.length)); }
    if (params.fromMs !== undefined) { where.push(`${SQL_INSTANT}>=?`); values.push(instant(params.fromMs)); }
    if (params.toMs !== undefined) { where.push(`${SQL_INSTANT}<?`); values.push(instant(params.toMs)); }
    if (params.turnId) { where.push('turnId=?'); values.push(params.turnId); }
    if (params.query) { where.push("instr(json_extract(body, '$.content'), ?)>0"); values.push(params.query); }
    const way = params.order === 'newest' ? 'DESC' : 'ASC';
    // 和分页游标用同一套排序键（day、occurredAt、recordId），否则同一时刻的行在不同页里顺序会不一致。
    const order = params.turnId ? `sourceSeq ${way}, sequence ${way}` : `day ${way}, occurredAt ${way}, recordId ${way}`;
    const rows = db.prepare(`SELECT body FROM records WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?`).all(...values, take) as unknown as { body: string }[];
    return rows.map(row => recordOf(row.body));
  }
  function item(record: ConversationRecord, query: string | undefined): MemoryItem {
    const timeMs = Date.parse(record.occurredAt);
    return {
      ref: chatRef(record.recordId, record.content), sourceId: `chat:${record.sourceSessionId}`, kind: 'conversation', title: record.speakerName ?? (record.role === 'assistant' ? 'assistant' : 'user'),
      time: formatLocalTime(new Date(timeMs), timeZone), timeBasis: 'message', current: true, excerpt: excerptOf(record.content, query), turnId: record.turnId, origin: originOf(record),
    };
  }
  const byRecordId = (recordId: string): ConversationRecord | undefined => {
    const row = db.prepare('SELECT body FROM records WHERE recordId=? LIMIT 1').get(recordId) as { body: string } | undefined;
    return row && recordOf(row.body);
  };
  /** The chat session a ref points into, when it is a chat line that still exists. */
  function refSession(ref: string): string | undefined {
    const decoded = decodeRef(ref);
    return decoded.kind === 'c' ? byRecordId(decoded.recordId)?.sourceSessionId : undefined;
  }
  /** What a chat ref points at, if the caller may see its session and the line still reads as it did when cited. */
  function read(ref: string, canSee: (sessionId: string) => boolean): ReadResult {
    const decoded = decodeRef(ref);
    if (decoded.kind !== 'c') throw new MemoryError('invalidRef', '这不是聊天的引用');
    const record = byRecordId(decoded.recordId);
    if (!record) throw new MemoryError('notFound', '这条引用对应的聊天不存在');
    if (!canSee(record.sourceSessionId)) throw new MemoryError('outOfScope', '这条聊天不在当前可读范围内');
    if (hashOf(record.content) !== decoded.hash) throw new MemoryError('sourceChanged', '这条聊天在引用之后被修订过，旧版正文没有保留（sourceChanged）');
    const timeMs = Date.parse(record.occurredAt);
    return {
      ref, sourceId: `chat:${record.sourceSessionId}`, kind: 'conversation', version: decoded.hash, title: record.speakerName ?? record.role, time: formatLocalTime(new Date(timeMs), timeZone),
      timeBasis: 'message', current: true, content: record.content, turnId: record.turnId, origin: originOf(record),
    };
  }
  return { find, item, byRecordId, refSession, read, sessionIds, snapshot, revised };
}
/** 记忆层看到的存储接口，由 createMemoryStore 的返回值推导。 */
export type MemoryStore = ReturnType<typeof createMemoryStore>;
