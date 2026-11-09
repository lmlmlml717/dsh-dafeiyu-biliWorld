// 评论记录（bili-comments.jsonl）的宿主侧读取与删除。
//
// 导出：CommentKind / CommentLogEntry / ReadOptions / DeleteResult 类型，以及 commentLogPath、readCommentLog、
//       deleteCommentLogEntry；被 console/routes.ts（评论记录页）与 index.ts 调用。
// 依赖：node:fs / node:crypto，以及 B 站 reply/action、web-interface/view 两个接口（删除评论时用）。
// 坑：文件里只有“真发出去的尝试”；旧记录没有 id，用整行 sha1 补 legacy-…；B 站侧删除失败时本地行必须保留，
//     否则面板会显示已删、实际评论还在。
//
// 【链路位置】评论记录页的后端：控制台 GET /console/bili-comments 与 POST /console/bili-comments/delete
// 经 console/routes.ts 分派到 index.ts 的 ConsoleActions（readBiliCommentLog / deleteBiliComment），
// 后者把 worldDir 传进来，由本文件读、删 bili-comments.jsonl。
// 上游：工具链 tools/commands/comment.mjs 与 tools/lib/bili-write.mjs 真发之后追加的行（干跑与被闸门拦下的不写）。
// 下游：node:fs / node:crypto；删除时还要打 B 站 /x/v2/reply/action（action=del）与 /x/web-interface/view。
// 读写：读 bili-comments.jsonl 与 bili/credentials.json；删除时原子重写 jsonl（临时文件 + rename）。
// 职责边界：本文件不做风控与额度判断，那些在工具链里；这里只保证「B 站侧没删掉就不删本地行」。
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 评论记录的读写与删除（宿主侧）。
 *
 * 数据源是工具链写的 `worlds/<id>/bili/bili-comments.jsonl`：
 *   - 只有**真实发出的尝试**才在里面（成功或失败）；干跑、被闸门拦下的都不写；
 *   - v2 记录带 `id / kind / aid / 完整正文`；旧记录只有 `at/ok/bvid/title/rpid/text(200)/code/why`，
 *     读的时候用行内容哈希补一个稳定的 `legacy-…` id，`kind` 默认 `comment`。
 *
 * 「删除」是两件事：
 *   1. 按 id 删本地这一行（原子重写 jsonl，删完不留备份，避免被误恢复）；
 *   2. 如果记录里有 rpid，再调 B 站 `POST /x/v2/reply/action`（action=del）把那条评论也删掉。
 *      B 站侧删失败时不删本地记录，并把原因返回给面板。
 */

/** 评论类型：普通视频评论，或转发动态时附带的评论。 */
export type CommentKind = 'comment' | 'share-comment';

/**
 * 一条评论记录；面板按 id 展示与删除。
 * 旧格式没有 id/kind/aid，读入时由 toEntry 补齐。
 */
export interface CommentLogEntry {
  /** 稳定标识：新记录由工具链写入，旧记录用整行哈希生成 legacy-…。 */
  id: string;
  /** 发出时间（ISO 字符串）；解析失败时为空串。 */
  at: string;
  kind: CommentKind;
  /** 这次尝试是否成功；失败的记录也保留，方便排查。 */
  ok: boolean;
  bvid?: string;
  aid?: number;
  title?: string;
  /** B 站评论 id；有它才可能连 B 站上的评论一起删。 */
  rpid?: string;
  text: string;
  code?: number;
  why?: string;
}

/** readCommentLog 的过滤条件。 */
export interface ReadOptions {
  /** 只取最近几天；缺省 7，<=0 表示不限。 */
  days?: number;
  /** 最多返回几条；缺省 100，夹在 1–500。 */
  limit?: number;
}

/** 删除一条记录的结果；失败时 why 说明原因。 */
export interface DeleteResult {
  ok: boolean;
  why?: string;
  /** 是否连 B 站上的评论一起删掉了；false 表示只删了本地（旧记录没有 rpid / 找不到 aid）。 */
  biliDeleted?: boolean;
}

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const REPLY_DELETE_URL = 'https://api.bilibili.com/x/v2/reply/action';
const VIDEO_VIEW_URL = 'https://api.bilibili.com/x/web-interface/view';

/** 评论记录文件的位置：`<worldDir>/bili/bili-comments.jsonl`。 */
export const commentLogPath = (worldDir: string): string => join(worldDir, 'bili', 'bili-comments.jsonl');

// 旧记录没有 id：用整行内容的 sha1 前 16 位补一个稳定 id，删除时才能定位到同一行。
const legacyId = (line: string): string => `legacy-${createHash('sha1').update(line).digest('hex').slice(0, 16)}`;

interface RawRecord {
  id?: unknown;
  at?: unknown;
  kind?: unknown;
  ok?: unknown;
  bvid?: unknown;
  aid?: unknown;
  title?: unknown;
  rpid?: unknown;
  text?: unknown;
  code?: unknown;
  why?: unknown;
}

// jsonl 是工具链写的，宿主不能假设每行都合法：字段逐个校验，缺 id 的旧行现场补 legacy id。
function toEntry(raw: RawRecord, line: string): CommentLogEntry {
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : legacyId(line),
    at: typeof raw.at === 'string' ? raw.at : '',
    kind: raw.kind === 'share-comment' ? 'share-comment' : 'comment',
    ok: raw.ok === true,
    ...(typeof raw.bvid === 'string' && raw.bvid ? { bvid: raw.bvid } : {}),
    ...(Number.isFinite(Number(raw.aid)) ? { aid: Number(raw.aid) } : {}),
    ...(typeof raw.title === 'string' ? { title: raw.title } : {}),
    ...(typeof raw.rpid === 'string' && raw.rpid ? { rpid: raw.rpid } : {}),
    text: typeof raw.text === 'string' ? raw.text : '',
    ...(raw.code === undefined ? {} : { code: Number(raw.code) }),
    ...(typeof raw.why === 'string' && raw.why ? { why: raw.why } : {}),
  };
}

// 调用方：index.ts 的 readBiliCommentLog（routes 的 GET /console/bili-comments 把 days / limit 传下来）。
// 参数：worldDir 是 <world>（函数内部再拼 bili/bili-comments.jsonl）；options.days 缺省 7、<=0 不限，
//       options.limit 缺省 100、夹在 1–500。
// 返回：按 at 倒序的记录数组，旧记录现场补 legacy id；坏行只跳过那一行。
// 空值：文件不存在返回空数组；单行不是 JSON 也跳过，不抛错。
// 【上游参考】记录形状与工具链写入的 v2 行一一对应（id / kind / aid / 完整正文），宿主只读不猜。
/** 读记录：按天过滤、按时间倒序、截断 limit。days<=0 表示不限。 */
export function readCommentLog(worldDir: string, options: ReadOptions = {}): CommentLogEntry[] {
  const file = commentLogPath(worldDir);
  if (!existsSync(file)) return [];
  // days 缺省 7 天；<=0 表示不限，cutoff 用 -Infinity 让所有记录通过。
  const days = Number.isFinite(Number(options.days)) ? Number(options.days) : 7;
  // limit 夹在 1–500，防止一次把整份 jsonl 返回给面板。
  const limit = Math.max(1, Math.min(500, Number(options.limit) || 100));
  const cutoff = days > 0 ? Date.now() - days * 86_400_000 : Number.NEGATIVE_INFINITY;
  const entries: CommentLogEntry[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let raw: RawRecord;
    // 坏行跳过：一条记录损坏不能让整页评论记录打不开。
    try { raw = JSON.parse(line) as RawRecord; } catch { continue; }
    const at = Number(Date.parse(typeof raw.at === 'string' ? raw.at : ''));
    if (Number.isFinite(at) && at < cutoff) continue;
    entries.push(toEntry(raw, line));
  }
  return entries
    // 按 at 倒序；时间解析失败的记录排在最后（按 0 处理）。
    .sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0))
    .slice(0, limit);
}

interface Credential { SESSDATA: string; bili_jct: string; buvid3: string }

// 凭据缺失/损坏就让调用方收到异常：没有凭据不能保证删掉 B 站侧评论。
function readCredential(worldDir: string): Credential {
  const file = join(worldDir, 'bili', 'credentials.json');
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<Credential>;
  return { SESSDATA: String(raw.SESSDATA ?? ''), bili_jct: String(raw.bili_jct ?? ''), buvid3: String(raw.buvid3 ?? '') };
}

type FetchLike = typeof fetch;

function cookieHeaders(cred: Credential, extra: Record<string, string> = {}): Record<string, string> {
  return {
    'user-agent': USER_AGENT,
    referer: 'https://www.bilibili.com/',
    cookie: `SESSDATA=${cred.SESSDATA}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3}`,
    ...extra,
  };
}

// 【上游参考】B 站开放接口的删除语义：POST /x/v2/reply/action 带 type=1（视频）、oid=aid、rpid、action=del，
// csrf 取 cookie 里的 bili_jct；旧记录没有 aid 时先用 /x/web-interface/view 由 bvid 现查。
// 与工具链发评论（/x/v2/reply/add）是同一组接口的两个方向。
/** B 站删除接口：form 编码 + csrf（bili_jct）。 */
async function postForm(fetchImpl: FetchLike, cred: Credential, url: string, params: Record<string, string>): Promise<{ code?: number; message?: string }> {
  // csrf 两个字段都带：不同 B 站接口读的字段名不一致，bili_jct 同时作为 csrf 与 csrf_token。
  const body = new URLSearchParams({ ...params, csrf: cred.bili_jct, csrf_token: cred.bili_jct });
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: cookieHeaders(cred, { 'content-type': 'application/x-www-form-urlencoded' }),
    body: body.toString(),
    // 20 秒超时：B 站接口偶尔挂住，不能让删除请求一直占着面板。
    signal: AbortSignal.timeout(20_000),
  });
  return await response.json().catch(() => ({ code: -1, message: '响应不是 JSON' })) as { code?: number; message?: string };
}

/** 旧记录没有 aid 时，用 bvid 现查一次。 */
async function resolveAid(fetchImpl: FetchLike, cred: Credential, bvid: string | undefined): Promise<number | undefined> {
  if (!bvid) return undefined;
  // 查不到视频就返回 undefined，由调用方决定保留本地记录，不能在这里当成删除成功。
  try {
    const response = await fetchImpl(`${VIDEO_VIEW_URL}?bvid=${encodeURIComponent(bvid)}`, {
      headers: cookieHeaders(cred),
      signal: AbortSignal.timeout(15_000),
    });
    const json = await response.json().catch(() => undefined) as { code?: number; data?: { aid?: number } } | undefined;
    return Number(json?.code) === 0 && Number(json?.data?.aid) ? Number(json?.data?.aid) : undefined;
  } catch { return undefined; }
}

// 调用方：index.ts 的 deleteBiliComment（控制台删除按钮）→ 本函数；测试可注入 fetch。
// 参数：worldDir 同 readCommentLog；id 是记录 id（新记录由工具链给，旧记录是 legacy-…）；deps.fetch 只在测试里换。
// 返回：DeleteResult —— ok 表示本地行已删；biliDeleted 表示 B 站那条也删掉了；why 在失败时给出原因。
// 失败语义：凭据读不到、查不到 aid、B 站返回非 0 码，都返回 ok:false 且保留本地行（面板显示原因，
//       人可以重试）；只有「记录没有 rpid」时才只删本地并在 why 里说明。
/** 删一条记录：先删 B 站评论（有 rpid 时），再删本地行；B 站失败则本地保留。 */
export async function deleteCommentLogEntry(worldDir: string, id: string, deps: { fetch?: FetchLike } = {}): Promise<DeleteResult> {
  if (!id) return { ok: false, why: '缺少 id' };
  const file = commentLogPath(worldDir);
  if (!existsSync(file)) return { ok: false, why: '还没有评论记录' };
  const fetchImpl = deps.fetch ?? fetch;

  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  let targetLine = -1;
  let target: CommentLogEntry | undefined;
  // 逐行找目标 id；旧记录的 id 由 toEntry 现场算出来，和读取时看到的一致。
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line.trim()) continue;
    let raw: RawRecord;
    try { raw = JSON.parse(line) as RawRecord; } catch { continue; }
    const entry = toEntry(raw, line);
    if (entry.id === id) { targetLine = index; target = entry; break; }
  }
  if (!target || targetLine < 0) return { ok: false, why: '记录不存在（可能已经被删掉）' };

  let biliDeleted = false;
  let note: string | undefined;
  if (target.rpid) {
    let cred: Credential;
    try { cred = readCredential(worldDir); } catch { return { ok: false, why: '读不到 B 站凭据，无法删除 B 站评论（本地记录保留）' }; }
    const aid = target.aid ?? await resolveAid(fetchImpl, cred, target.bvid);
    if (!aid) {
      // 有 rpid 说明 B 站上确实可能有这条评论；查不到视频就不能保证「连 B 站一起删」，
      // 这时保留本地记录，让人能重试或手工处理（只有本来就没有 rpid 的记录才只删本地）。
      return { ok: false, why: '这条记录有 rpid 但查不到 aid（视频可能已删/接口失败），无法删 B 站评论（本地记录保留）' };
    } else {
      let result: { code?: number; message?: string };
      try {
        result = await postForm(fetchImpl, cred, REPLY_DELETE_URL, { type: '1', oid: String(aid), rpid: String(target.rpid), action: 'del' });
      } catch (error) {
        return { ok: false, why: `调用 B 站删除接口失败：${error instanceof Error ? error.message : String(error)}（本地记录保留）` };
      }
      const code = Number(result.code);
      if (code === 0) biliDeleted = true;
      // 12002/-404 或文案说“不存在/已删除”都表示评论本来就不在了，B 站侧算删除成功，本地才能跟着删。
      else if (code === 12002 || code === -404 || /不存在|已删除/.test(String(result.message ?? ''))) biliDeleted = true;
      else return { ok: false, why: `B 站删除失败 code=${code} ${result.message ?? ''}（本地记录保留）` };
    }
  } else {
    note = '这条记录没有 rpid（评论没发成功或旧格式），只删了本地记录';
  }

  // 本地：删掉目标行，原子重写。写之前再读一次，避免覆盖并发追加的新记录。
  const latest = readFileSync(file, 'utf8');
  const latestLines = latest === text ? lines : latest.split('\n');
  const index = latest === text ? targetLine : latestLines.findIndex(line => line.trim() && toEntry(safeParse(line), line).id === id);
  if (index < 0) return { ok: true, biliDeleted, why: '本地记录已不存在' };
  const remaining = latestLines.filter((line, position) => position !== index).join('\n').replace(/\n+$/, '') + '\n';
  // 临时文件名带随机串，避免并发删除互相覆盖；rename 同目录才是原子的。
  const temporary = `${file}.${createHash('sha1').update(String(Date.now())).digest('hex').slice(0, 8)}.tmp`;
  try {
    writeFileSync(temporary, remaining, 'utf8');
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    return { ok: false, why: `写回记录失败：${error instanceof Error ? error.message : String(error)}` };
  }
  return { ok: true, biliDeleted, ...(note ? { why: note } : {}) };
}

// 解析失败返回空对象：调用方拿到的 id 会是 legacy 哈希，不会误删别的行。
function safeParse(line: string): RawRecord {
  try { return JSON.parse(line) as RawRecord; } catch { return {}; }
}
