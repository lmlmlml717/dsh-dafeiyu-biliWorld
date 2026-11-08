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

export type CommentKind = 'comment' | 'share-comment';

export interface CommentLogEntry {
  id: string;
  at: string;
  kind: CommentKind;
  ok: boolean;
  bvid?: string;
  aid?: number;
  title?: string;
  rpid?: string;
  text: string;
  code?: number;
  why?: string;
}

export interface ReadOptions {
  days?: number;
  limit?: number;
}

export interface DeleteResult {
  ok: boolean;
  why?: string;
  /** 是否连 B 站上的评论一起删掉了；false 表示只删了本地（旧记录没有 rpid / 找不到 aid）。 */
  biliDeleted?: boolean;
}

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const REPLY_DELETE_URL = 'https://api.bilibili.com/x/v2/reply/action';
const VIDEO_VIEW_URL = 'https://api.bilibili.com/x/web-interface/view';

export const commentLogPath = (worldDir: string): string => join(worldDir, 'bili', 'bili-comments.jsonl');

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

/** 读记录：按天过滤、按时间倒序、截断 limit。days<=0 表示不限。 */
export function readCommentLog(worldDir: string, options: ReadOptions = {}): CommentLogEntry[] {
  const file = commentLogPath(worldDir);
  if (!existsSync(file)) return [];
  const days = Number.isFinite(Number(options.days)) ? Number(options.days) : 7;
  const limit = Math.max(1, Math.min(500, Number(options.limit) || 100));
  const cutoff = days > 0 ? Date.now() - days * 86_400_000 : Number.NEGATIVE_INFINITY;
  const entries: CommentLogEntry[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let raw: RawRecord;
    try { raw = JSON.parse(line) as RawRecord; } catch { continue; }
    const at = Number(Date.parse(typeof raw.at === 'string' ? raw.at : ''));
    if (Number.isFinite(at) && at < cutoff) continue;
    entries.push(toEntry(raw, line));
  }
  return entries
    .sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0))
    .slice(0, limit);
}

interface Credential { SESSDATA: string; bili_jct: string; buvid3: string }

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

/** B 站删除接口：form 编码 + csrf（bili_jct）。 */
async function postForm(fetchImpl: FetchLike, cred: Credential, url: string, params: Record<string, string>): Promise<{ code?: number; message?: string }> {
  const body = new URLSearchParams({ ...params, csrf: cred.bili_jct, csrf_token: cred.bili_jct });
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: cookieHeaders(cred, { 'content-type': 'application/x-www-form-urlencoded' }),
    body: body.toString(),
    signal: AbortSignal.timeout(20_000),
  });
  return await response.json().catch(() => ({ code: -1, message: '响应不是 JSON' })) as { code?: number; message?: string };
}

/** 旧记录没有 aid 时，用 bvid 现查一次。 */
async function resolveAid(fetchImpl: FetchLike, cred: Credential, bvid: string | undefined): Promise<number | undefined> {
  if (!bvid) return undefined;
  try {
    const response = await fetchImpl(`${VIDEO_VIEW_URL}?bvid=${encodeURIComponent(bvid)}`, {
      headers: cookieHeaders(cred),
      signal: AbortSignal.timeout(15_000),
    });
    const json = await response.json().catch(() => undefined) as { code?: number; data?: { aid?: number } } | undefined;
    return Number(json?.code) === 0 && Number(json?.data?.aid) ? Number(json?.data?.aid) : undefined;
  } catch { return undefined; }
}

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

function safeParse(line: string): RawRecord {
  try { return JSON.parse(line) as RawRecord; } catch { return {}; }
}
