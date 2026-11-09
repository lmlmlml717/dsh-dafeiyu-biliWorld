/**
 * 长期记忆的唯一入口：把归档里的聊天和她写的文件合成一次「找」与一次「读」。
 *
 * 导出：MemoryPage / MemoryContent / MemoryService / MemoryDeps 类型、默认与上限常量、normalizeFind / normalizeRead
 * （唯一的参数校验处）、createMemory（服务本身），并转发 memoryStore / memoryFiles 的若干导出。
 * 调用方：index.ts 建服务后交给 memoryTools.ts 与控制台，两边走同一套 find/read。
 * 依赖：归档只读视图、她日记目录里的文件，以及可读范围判定（archiveSelection）。
 *
 * 坑：没有索引 —— 查询是扫原表加现读文件，所以旧世界的库打开就能用；但每次结果都带 coverage，
 * 有来源读不到时 state 是 partial，零命中不能当成「从没发生过」。游标绑定了查询条件、可读范围和文件集合，
 * 任何一样变了就报 cursorExpired，必须重查，不能拿旧游标接着翻。
 */
import { createAuthorFiles, type AuthorDoc, type MemorySources } from './memoryFiles.ts';
import {
  MAX_QUERY_CHARS, MEMORY_KINDS, MemoryError, chatRef, decodeRef, excerptOf, sha,
  type FindParams, type MemoryItem, type MemoryKind, type MemoryStatus, type MemoryStore, type ReadResult,
} from './memoryStore.ts';
import { errorText } from './faults.ts';

// 对外沿用 memoryStore 与 memoryFiles 的定义，调用方不必知道实现在哪一层。
export { MEMORY_KINDS, MemoryError } from './memoryStore.ts';
export { readStable } from './memoryFiles.ts';
// 类型与只读工具也一并转发，工具层只 import 这一个文件。
export type { MemoryErrorCode, MemoryItem, MemoryKind, MemoryStatus } from './memoryStore.ts';
export type { MemorySources } from './memoryFiles.ts';

/** 一页查询结果：命中项、下一页游标、来源覆盖情况与本次查询的耗时口径。 */
export interface MemoryPage { items: MemoryItem[]; nextCursor?: string; coverage: MemoryStatus; search: { method: 'browse' | 'scan'; elapsedMs: number } }
/** 一条引用读出来的正文页：带来源、版本、时间依据与下一页偏移。 */
export interface MemoryContent {
  ref: string; sourceId: string; kind: MemoryKind; version: string; title: string; time: string; timeBasis: ReadResult['timeBasis']; current: boolean;
  content: string; offset: number; nextOffset?: number; totalChars: number; turnId?: string; origin?: ReadResult['origin'];
}
/** 记忆的两个动作（找与读）加一份来源健康状况；工具和控制台都只依赖这个形状。 */
export interface MemoryService {
  find(input: Record<string, unknown>): Promise<MemoryPage>;
  read(input: Record<string, unknown>): Promise<MemoryContent>;
  status(): MemoryStatus;
}
/** 建记忆服务需要的依赖：存储、时区、她写的文件、可读范围判定，以及可替换的时钟。 */
export interface MemoryDeps {
  store: MemoryStore;
  timeZone: string;
  sources: MemorySources;
  /** Whether the caller may see this chat session; may throw while the host cannot say yet, which counts as no. */
  visible(sessionId: string): boolean;
  now?: () => Date;
}
/** 查询与读取的默认值和硬上限：工具用其中的小值，控制台可以多读一些。 */
export const DEFAULT_FIND_LIMIT = 20, MAX_FIND_LIMIT = 100, DEFAULT_READ_LIMIT = 4000, MAX_READ_LIMIT = 16000;

const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
function text(input: Record<string, unknown>, key: string, max: number): string | undefined {
  const value = input[key];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > max) throw new MemoryError('invalidQuery', `${key} 必须是不超过 ${max} 个字符的字符串`);
  return value;
}
// 只认带时区的 ISO 时间：不带时区的本地时间换台机器含义就变了，宁可让调用方换算好再给。
function time(input: Record<string, unknown>, key: 'from' | 'to', timeZone: string): number | undefined {
  const value = text(input, key, 40);
  if (value === undefined) return undefined;
  const ms = iso.test(value) ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms)) throw new MemoryError('invalidQuery', `${key} 需要带时区的 ISO 时间（如 2026-10-30T00:00:00+08:00）；日期请按 ${timeZone} 换算成当天零点`);
  return ms;
}
function whole(input: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const value = input[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new MemoryError('invalidQuery', `${key} 必须是 ${min} 到 ${max} 的整数`);
  return value;
}
/** The one place a query is checked, for the tools and the console alike. */
export function normalizeFind(input: Record<string, unknown>, timeZone: string): FindParams {
  // 先按 UTF-16 长度粗筛（字符数上限的 4 倍），过了再按真实字符数精确判，超长串不会白走一遍 Array.from。
  const query = text(input, 'query', MAX_QUERY_CHARS * 4);
  if (query !== undefined && (Array.from(query).length > MAX_QUERY_CHARS || query.includes('\0'))) throw new MemoryError('invalidQuery', `query 不能超过 ${MAX_QUERY_CHARS} 个字符，也不能含空字符`);
  const kindsInput = input.kinds;
  if (kindsInput !== undefined && kindsInput !== null && (!Array.isArray(kindsInput) || kindsInput.some(kind => !(MEMORY_KINDS as readonly unknown[]).includes(kind)))) throw new MemoryError('invalidQuery', `kinds 只能是 ${MEMORY_KINDS.join('、')}`);
  const order = input.order ?? 'newest';
  if (order !== 'newest' && order !== 'oldest') throw new MemoryError('invalidQuery', 'order 只能是 newest 或 oldest');
  const fromMs = time(input, 'from', timeZone), toMs = time(input, 'to', timeZone);
  if (fromMs !== undefined && toMs !== undefined && fromMs >= toMs) throw new MemoryError('invalidQuery', 'from 必须早于 to（区间左闭右开）');
  // 去重：kinds 里重复的项只认一次，后面的过滤与哈希不必再处理重复。
  const kinds = kindsInput?.length ? [...new Set(kindsInput as MemoryKind[])] : undefined;
  const sourceId = text(input, 'sourceId', 300), turnId = text(input, 'turnId', 300), linkedTo = text(input, 'linkedTo', 2000), cursor = text(input, 'cursor', 4000);
  return {
    order, limit: whole(input, 'limit', DEFAULT_FIND_LIMIT, 1, MAX_FIND_LIMIT),
    ...(query === undefined ? {} : { query }), ...(kinds ? { kinds } : {}), ...(fromMs === undefined ? {} : { fromMs }), ...(toMs === undefined ? {} : { toMs }),
    ...(sourceId ? { sourceId } : {}), ...(turnId ? { turnId } : {}), ...(linkedTo ? { linkedTo } : {}), ...(cursor ? { cursor } : {}),
  };
}
/**
 * 校验并补全 memory_read 的参数。
 * @param input 工具或控制台传来的原始对象。
 * @returns ref（必填）、offset（默认 0，不能为负）、limit（默认 4000，1 到 16000）。
 * @throws ref 缺失或超长时抛 MemoryError('invalidQuery')。
 */
export function normalizeRead(input: Record<string, unknown>): { ref: string; offset: number; limit: number } {
  const ref = text(input, 'ref', 2000);
  if (!ref) throw new MemoryError('invalidQuery', 'ref 必须是 memory_find 给出的引用');
  return { ref, offset: whole(input, 'offset', 0, 0, Number.MAX_SAFE_INTEGER), limit: whole(input, 'limit', DEFAULT_READ_LIMIT, 1, MAX_READ_LIMIT) };
}

/** A hit of either source, before it becomes an item: what the filters and the ordering need. */
interface Candidate { item: MemoryItem; content: string; timeMs: number }
const chatKind = (params: FindParams) => !params.kinds || params.kinds.includes('conversation');
const asksForChat = (params: FindParams) => chatKind(params) && (!params.sourceId || params.sourceId.startsWith('chat:'));
/** The filters every candidate passes the same way, whichever source it came from. */
function accepts(candidate: Candidate, params: FindParams): boolean {
  const { item } = candidate;
  return (!params.kinds || params.kinds.includes(item.kind)) && (!params.sourceId || item.sourceId === params.sourceId)
    && (params.fromMs === undefined || candidate.timeMs >= params.fromMs) && (params.toMs === undefined || candidate.timeMs < params.toMs)
    && (!params.query || candidate.content.includes(params.query));
}
function authorItem(doc: AuthorDoc, query: string | undefined): MemoryItem {
  return { ref: doc.ref, sourceId: doc.sourceId, kind: doc.kind, title: doc.title, time: doc.time, timeBasis: doc.timeBasis, current: true, excerpt: excerptOf(doc.content, query) };
}
const authorCandidate = (doc: AuthorDoc, query: string | undefined): Candidate => ({ item: authorItem(doc, query), content: doc.content, timeMs: doc.timeMs });

/** The state a page cursor was taken in: it applies only while nothing it depends on has changed. */
interface CursorState { hash: string; upTo: number; revisions: number; files: string; offset: number }

/**
 * The one entry to long-term memory: tools and console call the same `find` and `read`. Nothing is indexed: chat is
 * scanned in the archive and her files are read when asked, so there is no queue to wait for and no index to rebuild.
 */
export function createMemory(deps: MemoryDeps): MemoryService {
  const { store, timeZone } = deps;
  const authors = createAuthorFiles(deps.sources, timeZone);
  const now = deps.now ?? (() => new Date());
  let checkedAt = now().toISOString();
  const scopeFailures = new Map<string, string>();
  const canSee = (sessionId: string): boolean => {
    // 可读范围问不出来（宿主还没起来）时按「看不见」处理并登记故障，不能默认放行。
    try { const yes = deps.visible(sessionId); scopeFailures.delete('scope'); return yes; }
    catch (error) { scopeFailures.set('scope', `暂时说不清哪些会话在范围内：${errorText(error)}`); return false; }
  };
  const sessionsInScope = () => store.sessionIds().filter(canSee);
  // 每次取文件都刷新 checkedAt：面板上的「最近检查」要反映这次真的读过，而不是插件启动时间。
  const docs = async () => { const all = await authors.docs(); checkedAt = now().toISOString(); return all; };

  function status(): MemoryStatus {
    const failures = [...authors.failures(), ...[...scopeFailures].map(([sourceId, message]) => ({ sourceId, message }))];
    return { state: failures.length ? 'partial' : 'ready', failures, checkedAt };
  }
  // 游标是 base64url 的 JSON：坏串与结构字段缺失都归成同一个 invalidCursor，不把内部结构透给调用方。
  function readCursor(cursor: string, hash: string, files: string): CursorState {
    let parsed: Partial<CursorState>;
    try { parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<CursorState>; } catch { throw new MemoryError('invalidCursor', '翻页游标无效'); }
    if (typeof parsed.hash !== 'string' || !Number.isSafeInteger(parsed.upTo) || !Number.isSafeInteger(parsed.revisions) || typeof parsed.files !== 'string' || !Number.isSafeInteger(parsed.offset) || parsed.offset! < 0) throw new MemoryError('invalidCursor', '翻页游标无效');
    // 查询条件、可读会话或文件集合任一变化，上一页的偏移就失去意义，只能让游标过期重查。
    if (parsed.hash !== hash || parsed.revisions !== store.snapshot().revisions || parsed.files !== files) throw new MemoryError('cursorExpired', '查询条件、访问范围或资料已经变化，请重新查询（cursorExpired）');
    return parsed as CursorState;
  }
  const cursorOf = (state: CursorState) => Buffer.from(JSON.stringify(state)).toString('base64url');

  /** What a link-following query looks at: the files that cite the ref and what the ref's own file cites, never a line she may not see. */
  function linked(ref: string, all: readonly AuthorDoc[], query: string | undefined): Candidate[] {
    const found = new Map<string, Candidate>();
    // 反查谁引用了它。
    for (const doc of all) if (doc.links.includes(ref)) found.set(doc.ref, authorCandidate(doc, query));
    // 再取它自己引用了谁；只走一步，不做传递闭包，免得一次查询把整张引用图拉进来。
    for (const target of all.find(doc => doc.ref === ref)?.links ?? []) {
      let decoded: ReturnType<typeof decodeRef>;
      try { decoded = decodeRef(target); } catch { continue; }
      const file = decoded.kind === 'a' ? all.find(doc => doc.ref === target) : undefined;
      if (file) { found.set(file.ref, authorCandidate(file, query)); continue; }
      const record = decoded.kind === 'c' ? store.byRecordId(decoded.recordId) : undefined;
      if (record && canSee(record.sourceSessionId) && chatRef(record.recordId, record.content) === target) found.set(target, { item: store.item(record, query), content: record.content, timeMs: Date.parse(record.occurredAt) });
    }
    return [...found.values()];
  }

  async function find(input: Record<string, unknown>): Promise<MemoryPage> {
    const started = performance.now();
    const params = normalizeFind(input, timeZone);
    const all = await docs();
    const sessions = sessionsInScope();
    if (params.linkedTo) {
      const session = store.refSession(params.linkedTo);
      if (session !== undefined && !canSee(session)) throw new MemoryError('outOfScope', 'linkedTo 指向的聊天不在当前可读范围内');
    }
    // 把影响结果的每一项都混进哈希：任何一项变了，旧游标都不该继续用。
    const hash = sha(JSON.stringify([params.query ?? null, params.kinds ?? null, params.fromMs ?? null, params.toMs ?? null, params.sourceId ?? null, params.turnId ?? null, params.linkedTo ?? null, params.order, [...sessions].sort()]));
    const files = sha(all.map(doc => doc.sourceId + doc.ref).sort().join('\n'));
    const resumed = params.cursor ? readCursor(params.cursor, hash, files) : undefined;
    // 续翻页时冻结在上次见过的最大 sequence：期间新写入的行不会漏进中间页，造成重复或错位。
    const upTo = resumed?.upTo ?? store.snapshot().head, offset = resumed?.offset ?? 0;
    const want = offset + params.limit + 1;
    let candidates: Candidate[];
    if (params.linkedTo) candidates = linked(params.linkedTo, all, params.query).filter(candidate => accepts(candidate, params));
    else {
      // 只有问聊天时才扫归档：kinds 里没有 conversation，或 sourceId 指向文件，就不必碰原表。
      const chat = asksForChat(params) ? store.find(params, sessions, upTo, want).map((record): Candidate => ({ item: store.item(record, params.query), content: record.content, timeMs: Date.parse(record.occurredAt) })) : [];
      const written = params.turnId ? [] : all.map(doc => authorCandidate(doc, params.query)).filter(candidate => accepts(candidate, params));
      candidates = [...chat, ...written];
    }
    // A turn is read in the order it was said; everything else by time, ties keeping the order the sources gave.
    if (!params.turnId) { const way = params.order === 'newest' ? -1 : 1; candidates = candidates.map((candidate, index) => ({ candidate, index })).sort((a, b) => way * (a.candidate.timeMs - b.candidate.timeMs) || a.index - b.index).map(entry => entry.candidate); }
    const page = candidates.slice(offset, offset + params.limit);
    // Membership is asked again on what is about to be returned: a session that left the scope meanwhile is refused, not trimmed.
    for (const { item } of page) if (item.kind === 'conversation' && item.origin?.sessionId && !canSee(item.origin.sessionId)) throw new MemoryError('scopeChanged', '查询期间可读范围变了，请重新查询');
    const more = candidates.length > offset + params.limit;
    return {
      items: page.map(candidate => candidate.item),
      ...(more ? { nextCursor: cursorOf({ hash, upTo, revisions: store.snapshot().revisions, files, offset: offset + params.limit }) } : {}),
      coverage: status(), search: { method: params.query ? 'scan' : 'browse', elapsedMs: Math.round((performance.now() - started) * 10) / 10 },
    };
  }

  async function read(input: Record<string, unknown>): Promise<MemoryContent> {
    const { ref, offset, limit } = normalizeRead(input);
    const decoded = decodeRef(ref);
    let found: ReadResult;
    if (decoded.kind === 'c') {
      // 聊天要再确认一次可读范围：ref 可能是上一次查询给的，中间范围变过就不该读。
      found = store.read(ref, canSee);
      if (found.origin?.sessionId && !canSee(found.origin.sessionId)) throw new MemoryError('scopeChanged', '读取期间可读范围变了，请重新读取');
    } else {
      const doc = (await docs()).find(candidate => candidate.sourceId === decoded.sourceId);
      if (!doc) throw new MemoryError('notFound', '这条引用对应的文件不存在');
      // 文件改过之后旧 ref 失效，不保留历史版本：这是「引用能证明出处」要付的代价，如实报给调用方。
      if (doc.ref !== ref) throw new MemoryError('sourceChanged', '这个文件在引用之后被改过，旧版正文没有保留（sourceChanged）');
      found = { ref, sourceId: doc.sourceId, kind: doc.kind, version: decoded.hash, title: doc.title, time: doc.time, timeBasis: doc.timeBasis, current: true, content: doc.content };
    }
    // 按字符切而不是按 UTF-16 码元切，分页才不会把汉字或 emoji 切成半个。
    const chars = Array.from(found.content);
    const end = Math.min(chars.length, offset + limit);
    return {
      ref: found.ref, sourceId: found.sourceId, kind: found.kind, version: found.version, title: found.title, time: found.time, timeBasis: found.timeBasis, current: found.current,
      content: chars.slice(offset, end).join(''), offset, ...(end < chars.length ? { nextOffset: end } : {}), totalChars: chars.length,
      ...(found.turnId ? { turnId: found.turnId } : {}), ...(found.origin ? { origin: found.origin } : {}),
    };
  }
  return { find, read, status };
}
