// 控制台的 HTTP 路由层：把 GET/POST /dsh-world/console/* 分派给 ConsoleSources（只读）与 ConsoleActions（写）。
//
// 导出：CONSOLE_PREFIX / WRITE_HEADER、Bili* 状态类型、ConsoleSources / ConsoleActions / ConsoleRequest，
//       以及 handleConsole（纯分派，便于单测）和 consoleRoute（挂到宿主 http 的 route）。
// 被谁调用：index.ts 注册 consoleRoute；控制台前端按 CONSOLE_PREFIX 拼请求。
// 依赖：../http.ts 的 jsonObject/knownHost/readBody/sendJson，以及 worldSwitch/archiveSelection/memory 等校验函数。
// 坑：写请求必须同时满足 POST、x-dsh-world: 1、JSON content-type，三者缺一按只读处理；跨站/未知 Host 一律 403，
//     因为控制台能改世界配置与人格，不能让任意网页直接调用。
//
// 【链路位置】控制台 HTTP 层里 B 站那几组路由的入口：/console/bili（定时器状态）、/console/bili-config、
// /console/bili-cred、/console/bili-comment(s)、/console/bili-history、/console/bili-quota、/console/bili-mood、
// /console/bili/trigger、/console/bili/replan。
// 上游：控制台前端（client/index.js）按 CONSOLE_PREFIX 拼请求；index.ts 注册 consoleRoute。
// 下游：handleConsole → write() 或 GET 分支 → ConsoleActions / ConsoleSources → src/bili/*.ts。
// 职责边界：这里只做字段校验与状态码（404 表示模块不可用、400 表示参数不对），业务在 actions 里。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { jsonObject, knownHost, readBody, sendJson, type JsonResult } from '../http.ts';
import { PERSONA_LAYERS, type Persona } from '../persona.ts';
import { validColdHours, validTurns, validWechatBuffer, MAX_COLD_HOURS, validWechatContext, validWorkspacePermission, MAX_WECHAT_BUFFER_SECONDS, MAX_WECHAT_CONTEXT } from '../worldSwitch.ts';
import { validArchiveScope, type MemoryArchiveScope } from '../archiveSelection.ts';
import type { PhotoStore } from '../life/photos.ts';
import { validClockTime } from '../life/alarm.ts';
import { MemoryError, type MemoryContent, type MemoryErrorCode, type MemoryPage } from '../memory.ts';
import type { CommentLogEntry } from '../bili/commentLog.ts';
import type { ShareView } from '../bili/shares.ts';

/** 控制台路由前缀；index.ts 注册 route 与前端拼请求都用它。 */
export const CONSOLE_PREFIX = '/dsh-world';
/** A write must carry this header; a page on another site cannot add it without a CORS preflight, which is never answered. */
export const WRITE_HEADER = 'x-dsh-world';
// 64 KiB 上限：控制台只提交设置项和短文本，放大请求体只会拖垮宿主。
const MAX_BODY_BYTES = 64 * 1024;
// 这四个 B 站类型是「路由层与实现层之间的契约」：index.ts 按它们组装返回值，
// src/bili/quota.ts 与 src/bili/mood.ts 只消费不定义，console/snapshot.ts 只透传，不在这里做校验。
/** B 站自由模式在控制台上的状态。 */
export interface BiliStatus {
  /** 主配置里 dailyBili 是否启用。 */
  enabled: boolean
  /** 本次 fire 是否正在投递（控制台据此禁用「立即触发」）。不是「世界在运行」——那由 world 开关决定。 */
  running: boolean
  /** 是否允许对外写（false 时只干跑）。 */
  allowWrite: boolean
  /** plan.json 所在目录，面板展示用。 */
  dataDir: string
  /** 当前 plan.json 的内容；没有计划时为 null。 */
  plan: Record<string, unknown> | null
}
/** 今日额度：`limits` 是配置上限，其余字段是今天已用条数（没做就不出现）。 */
export interface BiliQuota {
  day: string
  dyn_pure?: number
  dyn_share?: number
  like?: number
  coin?: number
  danmaku?: number
  limits: { dyn_pure: number; dyn_share: number; like: number; coin: number; danmaku: number }
}
/** 心情与饥饿度状态；`opts` 是当前生效的参数。 */
export interface BiliMood {
  value: number
  hunger: number
  updatedAt: string | null
  day: string
  opts: { hungerCap: number; mealGain: number; decayPerTick: number; moodBase: number; hungryMoodPenalty: number }
}
// 【上游参考】字段与 tools/lib/config.mjs 的 DEFAULTS.comment 同名同义（enabled / allowWrite / dailyMax /
// hardDailyMax / minIntervalSec / skipChance），面板、镜像文件与工具链读的是同一组键。
/** 评论页的状态：开关、概率、条数、真发条件、今日计数与最近几条。 */
export interface BiliCommentState {
  /** 主配置 comment.enabled（镜像写入 bili.config.json）。 */
  enabled: boolean
  /** world 主配置 dailyBili.allowWrite：评论真发还要求它为 true。 */
  allowWrite: boolean
  /** 工具链 guard.dryRun：true 时所有写操作只干跑。 */
  dryRun: boolean
  /** 每日硬上限（主配置），面板的 dailyMax 不能超过它；0 = 不限。 */
  hardDailyMax: number
  minIntervalSec: number
  /** 面板可改的每日上限，0 = 不限。 */
  dailyMax: number
  /** 跳过概率，语义同作息 night.skipChance。 */
  skipChance: number
  /** 今日已发条数。 */
  today: number
  /** 最近几条评论尝试（含失败）。 */
  recent: { at: string; ok: boolean; bvid: string; title: string; text: string; rpid: string; code?: number; why?: string }[]
}
/** 控制台只读数据源；snapshot.ts 的 consoleSources() 提供实现。 */
export interface ConsoleSources {
  snapshot(): Promise<unknown>;
  activity(day: string, outsideOnly: boolean): unknown;
  diary(date: string): string | undefined;
  photos?(limit: number, offset: number): ReturnType<PhotoStore['list']>;
  photo?(id: string): ReturnType<PhotoStore['image']>;
  /** The same lookups the memory tools make; they check the query themselves. */
  memoryFind?(input: Record<string, unknown>): Promise<MemoryPage>;
  memoryRead?(input: Record<string, unknown>): Promise<MemoryContent>;
  bili?(): BiliStatus | undefined;
  biliQuota?(): BiliQuota | undefined;
  biliMood?(): BiliMood | undefined;
  biliComment?(): BiliCommentState | undefined;
  /** 她「想给你看这条」的队列（面板的分享卡）；读失败/队列不存在时返回 undefined。 */
  biliShares?(): ShareView | undefined;
}
/** What the console can change: whether her world runs, and her persona and world prompt. */
export interface ConsoleActions {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Enqueue one application of saved prompts and idle-home compaction; returns a refusal, if any. */
  applyHome(): string | undefined;
  prompts(): { persona: Persona; worldPrompt: { text: string; custom: boolean; memory?: { missing: string[]; snippet: string } } };
  savePersona(persona: Partial<Persona>): void;
  /** An empty text goes back to the shipped template. */
  saveWorldPrompt(text: string): void;
  /** CNY a day for her home; undefined removes the limit. */
  setDailyBudget(yuan: number | undefined): void;
  /** Turns in her memory block; undefined goes back to the default. */
  setMemoryTurns(turns: number | undefined): void;
  /** Hours of silence after which a session re-reads her memory and prompt; undefined goes back to the default. */
  setColdHours(hours: number | undefined): void;
  setArchiveScope(scope: MemoryArchiveScope): boolean;
  setWorkspacePermission(permission: string): void;
  /** Whether the evening look back is followed by applying and compacting her home (on unless turned off). */
  setCompactAfterReview(on: boolean): void;
  /** 立即触发一次 B 站自由模式定时器 */
  triggerBiliNow(): Promise<string | undefined>;
  readBiliConfig(): unknown;
  saveBiliConfig(patch: Record<string, unknown>): string | undefined;
  readBiliCred(): unknown;
  /** 评论页：开关/概率/条数/今日计数/最近几条。 */
  readBiliComment(): BiliCommentState;
  /** 评论记录页：按天读 jsonl（新的在前），只含真实发出的尝试。 */
  readBiliCommentLog(days: string, limit: string): CommentLogEntry[];
  /** 删除一条评论记录：先删 B 站评论，再删本地行；返回失败原因，成功返回 undefined。 */
  deleteBiliComment(id: string): Promise<string | undefined>;
  /** 保存评论设置：enabled / allowWrite 写主配置（enabled 需要重启生效），dailyMax/skipChance 写 bili.config.json 并钳制硬上限。 */
  saveBiliComment(patch: { enabled?: boolean; allowWrite?: boolean; dailyMax?: number; skipChance?: number }): Promise<string | undefined>;
  saveBiliCred(patch: Record<string, unknown>): string | undefined;
  readBiliHistory(days: string): unknown;
  /** 分享队列：把某一条再递一次（追加新 id，不动原记录）。返回失败原因。 */
  retryBiliShare(id: string): string | undefined;
  /** 分享队列：清掉已经发出去的记录（待发的不动）。返回删掉几条。 */
  clearBiliShares(): number;
  /** 按 bili.config.json 里的上限清一遍 frames / covers 缓存；两个目录各自删掉几条。 */
  cleanBiliCache(): Promise<{ frames: number; covers: number }>;
  /** 手动设置心情 value（0-100）；hunger 随心情一起 fed */
  setBiliMood(value: number): unknown;
  /** 手动喂饭：hunger 降到 level（默认 20），心情 +8 */
  feedBili(level?: number): unknown;
  /** 改完「每天触发次数 / 最小间隔」后立刻重排下一次随机时刻（不投递 prompt）。 */
  replanBili(): void;
  /** Local HH:MM of the evening look back and the morning wake; a field left out stays, null goes back to its default. */
  setSchedule(schedule: { review?: string | null; wake?: string | null }): void;
  /** A field left out stays as it is; null goes back to its default. */
  /** Turns the WeChat and QQ modules on or off now (their tools and routes come and go with the switch). Returns why it cannot, or nothing. */
  setModules(modules: { wechat?: boolean; qq?: boolean }): Promise<string | { restartRequired: true; message: string } | undefined>;
  /** Restarts the adapter the plugin manages; false when it does not manage one. */
  restartWechatAdapter(): Promise<boolean>;
  setWechatSettings(settings: { context?: number | null; bufferSeconds?: number | null }): void;
}
/** 已经过 HTTP 层校验的一次控制台请求；`write` 为真才允许走写分派。 */
export interface ConsoleRequest { method: string; url: string; write: boolean; body?: Record<string, unknown> | undefined }
// 记忆错误码 → HTTP 状态码；未列出的异常继续抛给外层按 500 处理，不在这里吞掉。
const MEMORY_STATUS: Record<MemoryErrorCode, number> = { invalidQuery: 400, invalidRef: 400, invalidCursor: 400, notFound: 404, outOfScope: 403, cursorExpired: 409, sourceChanged: 409, scopeChanged: 409, readFailed: 500 };
/** Query-string values to the shape the tools take: a number that is not one stays NaN and is refused by the shared check. */
function memoryInput(params: URLSearchParams, numbers: readonly string[], lists: readonly string[]): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const [key, value] of params) {
    // 空值直接跳过：前端把“没填”也拼成 ?key=，不能当成空字符串参数。
    if (value === '') continue;
    input[key] = numbers.includes(key) ? Number(value) : lists.includes(key) ? value.split(',') : value;
  }
  return input;
}
async function memoryCall<T>(run: (() => Promise<T>) | undefined): Promise<JsonResult> {
  if (!run) return { status: 404, body: { error: '记忆查找不可用' } };
  // MemoryError 是预期内的业务错误，转成状态码；其它异常不吞，交给外层 500。
  try { return ok(await run()); }
  catch (error) {
    if (error instanceof MemoryError) return { status: MEMORY_STATUS[error.code], body: { error: error.message, code: error.code } };
    throw error;
  }
}
// 统一的 JSON 结果构造：ok 默认 { ok: true }，bad 只带 error 文本。
const ok = (body: unknown = { ok: true }): JsonResult => ({ status: 200, body });
const bad = (error: string): JsonResult => ({ status: 400, body: { error } });

// 只接受 PERSONA_LAYERS 里的键且值都是字符串；有一个不合法就整份拒绝，避免写进半份人格。
function persona(body: Record<string, unknown> | undefined): Partial<Persona> | undefined {
  if (!body) return undefined;
  const entries = Object.entries(body);
  if (!entries.every(([key, value]) => (PERSONA_LAYERS as readonly string[]).includes(key) && typeof value === 'string')) return undefined;
  return Object.fromEntries(entries) as Partial<Persona>;
}
// 写操作按路径分派；所有输入在这里校验完再交给 actions，actions 不重复校验。
async function write(actions: ConsoleActions, path: string, body: Record<string, unknown> | undefined): Promise<JsonResult> {
  switch (path) {
    case '/console/start': await actions.start(); return ok();
    case '/console/stop': await actions.stop(); return ok();
    case '/console/apply-home': { const refused = actions.applyHome(); return refused ? bad(refused) : ok(); }
    case '/console/persona': { const layers = persona(body); if (!layers) return bad('persona layers must be strings'); actions.savePersona(layers); return ok(); }
    case '/console/budget': {
      const daily = body?.daily;
      // daily 只接受 null 或不小于 0 的有限数；null 表示取消上限。
      if (daily !== null && (typeof daily !== 'number' || !Number.isFinite(daily) || daily < 0)) return bad('daily must be a non-negative number or null');
      actions.setDailyBudget(daily === null ? undefined : daily); return ok();
    }
    case '/console/memory': {
      const turns = body?.turns, coldHours = body?.coldHours;
      // turns/coldHours 至少传一个；null 表示恢复默认，undefined 表示这一项不动。
      if (turns !== undefined && turns !== null && !validTurns(turns)) return bad('turns must be a whole number of at least 1, or null');
      if (coldHours !== undefined && coldHours !== null && !validColdHours(coldHours)) return bad(`coldHours must be a whole number from 1 to ${MAX_COLD_HOURS}, or null`);
      if (turns === undefined && coldHours === undefined) return bad('nothing to change');
      if (turns !== undefined) actions.setMemoryTurns(turns ?? undefined);
      if (coldHours !== undefined) actions.setColdHours(coldHours ?? undefined);
      return ok();
    }
    case '/console/wechat': {
      const context = body?.contextMessages, bufferSeconds = body?.bufferSeconds;
      if (context !== undefined && context !== null && !validWechatContext(context)) return bad(`contextMessages must be a whole number from 1 to ${MAX_WECHAT_CONTEXT}, or null`);
      if (bufferSeconds !== undefined && bufferSeconds !== null && !validWechatBuffer(bufferSeconds)) return bad(`bufferSeconds must be a number from 0 to ${MAX_WECHAT_BUFFER_SECONDS}, or null`);
      if (context === undefined && bufferSeconds === undefined) return bad('nothing to change');
      actions.setWechatSettings({ ...(context === undefined ? {} : { context }), ...(bufferSeconds === undefined ? {} : { bufferSeconds }) }); return ok();
    }
    case '/console/modules': {
      const wechat = body?.wechat, qq = body?.qq;
      if ((wechat !== undefined && typeof wechat !== 'boolean') || (qq !== undefined && typeof qq !== 'boolean')) return bad('wechat 和 qq 必须是 true 或 false');
      if (wechat === undefined && qq === undefined) return bad('nothing to change');
      // 返回字符串表示拒绝，返回对象表示需要重启；两种都原样回给前端。
      const refused = await actions.setModules({ ...(wechat === undefined ? {} : { wechat }), ...(qq === undefined ? {} : { qq }) });
      return typeof refused === 'string' ? bad(refused) : ok({ ok: true, ...refused });
    }
    case '/console/wechat-adapter': return await actions.restartWechatAdapter() ? ok() : bad('适配器不是由插件管理的，请在配置里写 wechatAdapter');
    case '/console/archive-scope': {
      if (!validArchiveScope(body?.scope)) return bad('scope must be home or workspace');
      // scope 变更要重启才生效，restartRequired 回给前端提示。
      return ok({ ok: true, restartRequired: actions.setArchiveScope(body.scope) });
    }
    case '/console/compact-after-review': {
      if (typeof body?.on !== 'boolean') return bad('on must be true or false');
      actions.setCompactAfterReview(body.on); return ok();
    }
    case '/console/schedule': {
      const review = body?.review, wake = body?.wake;
      for (const [name, value] of [['review', review], ['wake', wake]] as const) if (value !== undefined && value !== null && !validClockTime(value)) return bad(`${name} must be HH:MM (00:00–23:59), or null`);
      if (review === undefined && wake === undefined) return bad('nothing to change');
      actions.setSchedule({ ...(review === undefined ? {} : { review: review as string | null }), ...(wake === undefined ? {} : { wake: wake as string | null }) }); return ok();
    }
    case '/console/workspace-permission': {
      if (!validWorkspacePermission(body?.permission)) return bad('工作区权限必须为非空字符串');
      try { actions.setWorkspacePermission(body.permission); return ok(); }
      catch (error) { return bad(error instanceof Error ? error.message : String(error)); }
    }
    case '/console/world-prompt': { if (typeof body?.text !== 'string') return bad('text must be a string'); actions.saveWorldPrompt(body.text); return ok(); }
    // ── B 站写路由：触发 / 重排 / 配置 / 凭据 / 心情 / 评论设置 / 删除评论记录 ──
    // 各自只校验参数形状；闸门（allowWrite、dryRun、额度、风控）全在 index.ts 与工具链里，不在这一层。
    case '/console/bili/trigger': {
      const reason = await actions.triggerBiliNow();
      return reason ? bad(reason) : ok();
    }
    case '/console/bili/replan': { actions.replanBili(); return ok(); }
    case '/console/bili-config': {
      if (!body || typeof body !== 'object') return bad('body 必须是 JSON 对象');
      const reason = actions.saveBiliConfig(body as Record<string, unknown>);
      return reason ? bad(reason) : ok();
    }
    case '/console/bili-cred': {
      if (!body || typeof body !== 'object') return bad('body 必须是 JSON 对象');
      const reason = actions.saveBiliCred(body as Record<string, unknown>);
      return reason ? bad(reason) : ok();
    }
    case '/console/bili-mood': {
      if (body?.value === undefined && body?.feed === undefined) return bad('body 需要 value（设置心情 0-100）或 feed（喂饭）');
      // value 与 feed 二选一：有 value 就设置心情，否则按 feed 喂饭（true 表示用默认饥饿度）。
      if (body.value !== undefined) {
        const v = Number(body.value);
        if (!Number.isFinite(v) || v < 0 || v > 100) return bad('value 必须是 0-100 的数字');
        return ok(actions.setBiliMood(v));
      }
      const level = body.feed === true ? undefined : Number(body.feed);
      return ok(actions.feedBili(Number.isFinite(level) ? level : undefined));
    }
    case '/console/bili-comment': {
      const enabled = body?.enabled, allowWrite = body?.allowWrite, dailyMax = body?.dailyMax, skipChance = body?.skipChance;
      // 四个字段都可选，但至少要改一个；dailyMax 是面板上限，不能超过主配置的硬上限（由 actions 钳制）。
      if (enabled !== undefined && typeof enabled !== 'boolean') return bad('enabled 必须是 true 或 false');
      if (allowWrite !== undefined && typeof allowWrite !== 'boolean') return bad('allowWrite 必须是 true 或 false');
      if (dailyMax !== undefined && (typeof dailyMax !== 'number' || !Number.isFinite(dailyMax) || !Number.isInteger(dailyMax) || dailyMax < 0)) return bad('dailyMax 必须是非负整数（0 = 不限）');
      if (skipChance !== undefined && (typeof skipChance !== 'number' || !Number.isFinite(skipChance) || skipChance < 0 || skipChance > 1)) return bad('skipChance 必须是 0–1 的数字');
      if (enabled === undefined && allowWrite === undefined && dailyMax === undefined && skipChance === undefined) return bad('nothing to change');
      const refused = await actions.saveBiliComment({
        ...(enabled === undefined ? {} : { enabled }),
        ...(allowWrite === undefined ? {} : { allowWrite }),
        ...(dailyMax === undefined ? {} : { dailyMax }),
        ...(skipChance === undefined ? {} : { skipChance }),
      });
      return refused ? bad(refused) : ok();
    }
    case '/console/bili-comments/delete': {
      const id = typeof body?.id === 'string' ? body.id.trim() : '';
      if (!id) return bad('id 必须是非空字符串');
      // 删除失败（B 站侧失败/凭据缺失）会返回原因，本地记录此时保留。
      const refused = await actions.deleteBiliComment(id);
      return refused ? bad(refused) : ok();
    }
    // ── 分享队列（0.8.27）：重发一条 / 清掉已发的 ──
    case '/console/bili-shares/retry': {
      const id = typeof body?.id === 'string' ? body.id.trim() : '';
      if (!id) return bad('id 必须是非空字符串');
      const refused = actions.retryBiliShare(id);
      return refused ? bad(refused) : ok();
    }
    case '/console/bili-shares/clear': return ok({ removed: actions.clearBiliShares() });
    // ── 缓存清理（0.8.27）：把 frames / covers 两组缓存按当前上限清一遍 ──
    case '/console/bili-cache/clean': return ok(await actions.cleanBiliCache());
    default: return { status: 404, body: { error: 'not found' } };
  }
}

/** Reads are open to the console page; writes need POST, the write header and a JSON body. */
export async function handleConsole(sources: ConsoleSources, actions: ConsoleActions, request: ConsoleRequest): Promise<JsonResult> {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname !== CONSOLE_PREFIX && !url.pathname.startsWith(CONSOLE_PREFIX + '/')) return { status: 404, body: { error: 'not found' } };
  const path = url.pathname.slice(CONSOLE_PREFIX.length);
  if (request.method === 'POST') {
    // POST 没带写头按 403：自定义头会触发 CORS 预检，而本服务从不响应预检，别的站点加不上。
    if (!request.write) return { status: 403, body: { error: 'forbidden' } };
    return write(actions, path, request.body);
  }
  if (request.method !== 'GET') return { status: 405, body: { error: 'method not allowed' }, headers: { allow: 'GET, POST' } };
  switch (path) {
    case '/console/snapshot': return ok(await sources.snapshot());
    case '/console/bili': {
      const bili = sources.bili?.();
      // dailyBili 未启用时返回 404，前端据此隐藏卡片而不是显示空状态。
      return bili ? ok(bili) : { status: 404, body: { error: 'dailyBili 未启用' } };
    }
    case '/console/bili-config': return ok(actions.readBiliConfig());
    case '/console/bili-comment': return ok(actions.readBiliComment());
    case '/console/bili-cred': return ok(actions.readBiliCred());
    case '/console/bili-history': return ok(actions.readBiliHistory(url.searchParams.get('days') ?? '7'));
    case '/console/bili-comments': return ok(actions.readBiliCommentLog(url.searchParams.get('days') ?? '7', url.searchParams.get('limit') ?? '100'));
    // 额度/心情来自 ConsoleSources 的可选回调，dailyBili 关闭时它们不存在，所以这里统一按 404 处理。
    case '/console/bili-quota': {
      const q = sources.biliQuota?.();
      // 额度不可用（dailyBili 未启用或读盘失败）返回 404，前端隐藏卡片。
      return q ? ok(q) : { status: 404, body: { error: 'bili 额度不可用（dailyBili 未启用？）' } };
    }
    case '/console/bili-mood': {
      const m = sources.biliMood?.();
      return m ? ok(m) : { status: 404, body: { error: 'bili 心情不可用' } };
    }
    case '/console/bili-shares': {
      const shares = sources.biliShares?.();
      // 队列文件还没生成（她从没分享过）也算可用：返回空视图，卡片显示「还没有」而不是 404。
      return shares ? ok(shares) : { status: 404, body: { error: '分享队列不可用' } };
    }
    case '/console/activity': return ok(sources.activity(url.searchParams.get('day') ?? '', url.searchParams.get('outside') === '1'));
    case '/console/diary': {
      const date = url.searchParams.get('date') ?? '';
      const text = sources.diary(date);
      // 没有这一天的日记返回 404，前端显示“这天没写”。
      return text === undefined ? { status: 404, body: { error: 'no diary for this date' } } : ok({ date, text });
    }
    case '/console/prompts': return ok(actions.prompts());
    case '/console/memory/find': { const input = memoryInput(url.searchParams, ['limit'], ['kinds']); return memoryCall(sources.memoryFind && (() => sources.memoryFind!(input))); }
    case '/console/memory/read': { const input = memoryInput(url.searchParams, ['offset', 'limit'], []); return memoryCall(sources.memoryRead && (() => sources.memoryRead!(input))); }
    case '/console/photos': {
      // 分页参数必须是安全整数且在 1..100 / 0.. 内，避免一次拉整本相册。
      const limit = Number(url.searchParams.get('limit') ?? 20), offset = Number(url.searchParams.get('offset') ?? 0);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) return bad('相册分页参数无效');
      return sources.photos ? ok(sources.photos(limit, offset)) : { status: 404, body: { error: '相册不可用' } };
    }
    default: return { status: 404, body: { error: 'not found' } };
  }
}
/**
 * 把控制台挂成宿主 route：负责跨站/主机校验、请求体读取与 JSON 响应，业务分派交给 handleConsole。
 * @param sources 只读数据源
 * @param actions 写操作
 * @param allowedHosts 额外允许的 Host；默认空数组，只认 knownHost 认为合法的本地主机
 * @returns kind 为 prefix 的 route 定义，交给宿主 http 服务注册
 */
export function consoleRoute(sources: ConsoleSources, actions: ConsoleActions, allowedHosts: readonly string[] = []) {
  return {
    kind: 'prefix' as const, path: CONSOLE_PREFIX,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      let result: JsonResult;
      try {
        // 跨站请求或 Host 不认识直接 403：控制台能改世界配置，不能让任意网页调用。
        if (req.headers['sec-fetch-site'] === 'cross-site' || !knownHost(req.headers.host, allowedHosts)) result = { status: 403, body: { error: 'cross-site requests are not allowed' } };
        else {
          const method = req.method ?? 'GET';
          const url = new URL(req.url ?? '/', 'http://localhost');
          // 照片是二进制，绕开 sendJson：单独写 content-type，并禁用缓存与嗅探。
          if (method === 'GET' && url.pathname === CONSOLE_PREFIX + '/console/photo') {
            const image = sources.photo?.(url.searchParams.get('id') ?? '');
            if (!image) { sendJson(res, { status: 404, body: { error: '找不到这张照片' } }); return; }
            res.writeHead(200, { 'content-type': image.ref.mediaType, 'content-length': image.data.byteLength, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox" });
            res.end(image.data); return;
          }
          // 写请求必须同时满足 POST、x-dsh-world: 1、JSON content-type；缺一按只读处理，随后由 handleConsole 拒绝。
          const write = method === 'POST' && req.headers[WRITE_HEADER] === '1' && String(req.headers['content-type'] ?? '').startsWith('application/json');
          const body = write ? jsonObject(await readBody(req, MAX_BODY_BYTES)) : undefined;
          result = write && body === undefined ? bad('a JSON object body is required') : await handleConsole(sources, actions, { method, url: req.url ?? '/', write, body });
        }
      // 兜底 500：不把异常细节回给浏览器，避免泄露路径/堆栈。
      } catch { result = { status: 500, body: { error: 'internal error' } }; }
      sendJson(res, result);
    },
  };
}
