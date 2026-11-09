// 控制台快照：把世界/生活线/记忆/B 站各模块的只读状态汇总成一个对象，供前端一次轮询拉全。
//
// 导出：estimateTokens / todaySpend（纯函数）、SnapshotDeps 类型与 consoleSources（带 5 秒 TTL 的快照工厂）。
// 被谁调用：index.ts 组装 SnapshotDeps 后创建，console/routes.ts 的 GET /console/snapshot 调用。
// 依赖：history/diary/lifeStore/life.runtime/store/memory 等模块；本文件只读它们，不直接写盘。
// 坑：快照里任何一个可选模块（微信/QQ/相册/记忆）不可用时都要降级成 null，不能让整页 500；
//     预算按世界时区的本地日切，展示和记账必须用同一把尺子。
//
// 【链路位置】B 站卡片的数据汇总点：SnapshotDeps 里的 bili / biliQuota / biliMood / biliComment 四个回调
// 由 index.ts 注入（分别读 plan.json、src/bili/quota.ts、src/bili/mood.ts、bili.config.json 与评论记录），
// compute() 把它们放进快照的同名字段，GET /console/snapshot 一次下发；GET /console/bili-quota 与
// /console/bili-mood 走返回对象末尾的两个包装器。
// 失败语义：回调缺省或返回 undefined 时字段为 null，前端按「不可用」渲染；本文件不写任何 B 站文件。
import type { Context } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session';
import { createHistory, renderHistory } from '../history.ts';
import { createDiaryReader } from '../life/diary.ts';
import type { LifeStore } from '../life/lifeStore.ts';
import type { LifeRuntime } from '../life/runtime.ts';
import type { ArchiveStore } from '../store.ts';
import type { WorldConfig } from '../types.ts';
import type { Spend } from '../life/types.ts';
import { formatLocalTime } from '../timeContext.ts';
import type { WorldNames } from '../worldPrompt.ts';
import type { MemoryArchiveScope } from '../archiveSelection.ts';
import type { ConsoleSources, BiliStatus, BiliQuota, BiliMood, BiliCommentState } from './routes.ts';
import type { ShareView } from '../bili/shares.ts';
import type { HomeApplyState } from './homeApply.ts';
import type { PhotoStore } from '../life/photos.ts';
import type { DailySchedule } from '../life/types.ts';
import type { MemoryService } from '../memory.ts';

// 5 秒缓存：控制台会高频轮询，同一份快照在 TTL 内复用，避免每次轮询都扫归档。
const SNAPSHOT_TTL_MS = 5000;
/**
 * 估算一段文本的 token 数：CJK 按 0.6 token/字，其余按 3.5 字符/token。
 * 只是面板展示的近似值，不用于计费或阈值判断。
 * @param text 要估算的文本
 * @returns 四舍五入后的 token 估计
 */
export function estimateTokens(text: string): number {
  // CJK 字符按 0.6 token/字估算，拉丁字符约 3.5 字符/token；误差足够面板展示。
  const cjk = (text.match(/[㐀-鿿豈-﫿　-〿＀-￯]/g) ?? []).length;
  return Math.round(cjk * 0.6 + (text.length - cjk) / 3.5);
}
/**
 * 控制台看到的“今天”。记账那边（`life/runtime.ts` 的 `spent`）按 `timeZone` 的本地日切，
 * 展示必须用同一把尺子：记录不是今天的（跨过零点还没花钱、或世界停了好几天）就当 0，
 * 别把昨天的钱显示成今天花的。
 */
export function todaySpend(spend: Spend | undefined, timeZone: string, now: Date = new Date()): Spend {
  let day: string;
  // 时区写错时 Intl 会抛 RangeError；记账那边已经会报错，控制台不该跟着整页 500，退回 UTC 日。
  try { day = formatLocalTime(now, timeZone).slice(0, 10); } catch { day = now.toISOString().slice(0, 10); }
  return spend?.day === day ? spend : { day, yuan: 0 };
}
/**
 * 控制台快照的依赖：世界配置、归档、生活线、记忆、B 站等。
 * 可选字段缺省时对应卡片显示 null 或不出现，控制台不因某个模块没启用而整页失败。
 */
export interface SnapshotDeps {
  ctx: Context;
  config: WorldConfig;
  archive: ArchiveStore;
  names(): WorldNames;
  /** Absent when the life line could not be set up. */
  lifeStore?: LifeStore;
  /** The running life line; undefined while her world is stopped. */
  life(): LifeRuntime | undefined;
  homeApply?(): HomeApplyState;
  photos?(): PhotoStore;
  /** Long-term memory: the console's lookups and the health of its index. */
  longTerm?: MemoryService;
  diaryDir: string;
  running(): boolean;
  /** CNY a day for her home; undefined is no limit. */
  dailyBudget(): number | undefined;
  /** Turns her memory block carries. */
  memoryTurns(): number;
  /** Hours of silence after which a session re-reads her memory block and prompt. */
  coldHours?(): number;
  selectedArchiveScope?(): MemoryArchiveScope;
  compactAfterReview?(): boolean;
  /** The evening look back and the morning wake, with what an empty field goes back to; absent without the life line. */
  schedule?(): DailySchedule & { defaults: DailySchedule };
  workspacePermissions?(): { defaultPermission: string; options: { value: string; name: string; description?: string }[] };
  /** The WeChat module's state; undefined while it is off or her world is stopped. */
  wechat?(): unknown;
  /** Whose conversations her archive keeps; the memory block shown is read through it. */
  archiveSession?(id: string): boolean;
  /** Faults outside the life line: the memory line, the bridge, the QQ bridge, starting and stopping. */
  faults(): string[];
  /** Which modules the config allows, whether their console switch is on, and whether they are running now. */
  modules?(): unknown;
  /** The OneBot channel she runs herself; null while it is off. */
  native?(): unknown;
  /** The QQ bridge, when the module is on; absent leaves that card out of the console. */
  qq?: () => Promise<unknown>;
  // 四个 B 站回调都是可选的：dailyBili 没启用时 index.ts 直接不提供，快照里就是 null。
  // 它们各自读盘（plan.json / 额度 / 心情 / bili.config.json），本文件不缓存 B 站状态，只跟随整份快照的 TTL。
  /** B 站自由模式定时器状态。 */
  bili?(): BiliStatus | undefined;
  /** B 站今日额度（纯动态/转发/点赞/投币/弹幕 分开计数）。 */
  biliQuota?(): BiliQuota | undefined;
  /** B 站心情状态（饥饿度 + 心情值 + 参数）。 */
  biliMood?(): BiliMood | undefined;
  /** 评论页状态（开关/概率/条数/今日计数/最近几条）。 */
  biliComment?(): BiliCommentState | undefined;
  /** 她「想给你看这条」的队列（分享卡）：待发/已发/最近几条。 */
  biliShares?(): ShareView | undefined;
}
/** Read-only views for the console; repeated polling within a few seconds reuses one snapshot until `invalidate`. */
export function consoleSources(deps: SnapshotDeps): ConsoleSources & { invalidate(): void } {
  const { config, archive, lifeStore } = deps;
  const history = createHistory(archive);
  const diary = createDiaryReader(deps.diaryDir);
  let cached: { at: number; value: Promise<unknown> } | undefined;
  async function compute(): Promise<unknown> {
    // 生活线没跑时 life 为 undefined，预算/闹钟/压缩记录等卡片整块为 null。
    const life = deps.life()?.snapshot();
    const home = life?.homeSessionId ? deps.ctx.agents.get(SessionId(life.homeSessionId)) : undefined;
    const window = deps.memoryTurns();
    const turns = await history.loadRecentTurns(window, deps.archiveSession);
    const archiveScope = config.archiveScope ?? 'workspace';
    const selectedArchiveScope = deps.selectedArchiveScope?.() ?? archiveScope;
    // archiveScope 是配置值，selectedArchiveScope 是当前实际生效值；两者不同说明要重启才能生效。
    // Never let a dead bridge take the whole console down with it: a broken QQ module shows as "not running".
    const qq = deps.qq ? await deps.qq().catch(() => null) : null;
    const native = deps.native?.() ?? null;
    return {
      worldId: config.worldId, timeZone: config.timeZone, now: new Date().toISOString(), running: deps.running(), name: deps.names().companion,
      budget: { daily: deps.dailyBudget() ?? null, today: life ? todaySpend(life.spend, config.timeZone) : null },
      workspace: deps.workspacePermissions?.() ?? null,
      compactAfterReview: deps.compactAfterReview?.() ?? null,
      schedule: deps.schedule?.() ?? null,
      life: life ? { homeSessionId: life.homeSessionId, status: home ? home.status : 'cold', alarm: life.alarm, review: life.review, recentWakes: lifeStore?.wakes().slice(-5).reverse() ?? [] } : null,
      homeApply: deps.homeApply?.() ?? null,
      // 生活线故障和外部故障合并成一张健康列表，前端只渲染这一份。
      health: [...(life?.faults ?? []), ...deps.faults()],
      memory: { index: deps.longTerm?.status() ?? null, turns: turns.length, windowTurns: window, coldHours: deps.coldHours?.() ?? null, archiveScope, selectedArchiveScope, restartRequired: archiveScope !== selectedArchiveScope, approxTokens: estimateTokens(renderHistory(turns, config.timeZone, deps.names(), archiveScope === 'home')), oldest: turns.at(-1)?.messages[0]?.occurredAt, ...archive.stats() },
      wechat: deps.wechat?.() ?? null,
      compactions: lifeStore?.compactions().slice(-5).reverse() ?? [],
      diaryDates: diary.dates(), activityDays: lifeStore?.activityDays() ?? [],
      qq: deps.qq ? qq : null,
      native,
      // B 站四块只做透传与 null 兜底：字段形状见 routes.ts 的 BiliStatus / BiliQuota / BiliMood / BiliCommentState。
      bili: deps.bili?.() ?? null,
      biliMood: deps.biliMood?.() ?? null,
      biliQuota: deps.biliQuota?.() ?? null,
      biliComment: deps.biliComment?.() ?? null,
      biliShares: deps.biliShares?.() ?? null,
      modules: deps.modules?.() ?? null,
    };
  }
  return {
    snapshot() {
      // TTL 内复用同一个 promise：并发轮询也只会算一次。
      if (cached && Date.now() - cached.at < SNAPSHOT_TTL_MS) return cached.value;
      const entry = { at: Date.now(), value: compute() };
      cached = entry;
      // 计算失败就把缓存清掉，下一次轮询重试；否则 5 秒内会一直拿到同一个 rejected promise。
      entry.value.catch(() => { if (cached === entry) cached = undefined; });
      return entry.value;
    },
    invalidate() { cached = undefined; },
    activity: (day, outsideOnly) => lifeStore?.activity(day).filter(record => !outsideOnly || record.outside).reverse() ?? [],
    diary: date => diary.read(date),
    // 相册没启用时抛错而不是返回空数组：前端据此显示“不可用”，而不是“没有照片”。
    photos: (limit, offset) => { if (!deps.photos) throw new Error('相册不可用'); return deps.photos().list(limit, offset); },
    photo: id => deps.photos?.().image(id),
    ...(deps.longTerm ? { memoryFind: (input: Record<string, unknown>) => deps.longTerm!.find(input), memoryRead: (input: Record<string, unknown>) => deps.longTerm!.read(input) } : {}),
    // ConsoleSources 的签名不允许 undefined，这里把可选依赖再包一层。
    // ConsoleSources 的签名不允许 undefined，这里再把两个可选依赖包一层（未启用时返回 undefined）。
    biliQuota: () => deps.biliQuota?.() ?? undefined,
    biliMood: () => deps.biliMood?.() ?? undefined,
    // 分享队列：面板的「分享给我」卡自己拉这一份（不进 snapshot，省得每 10 秒都读一遍队列文件）。
    biliShares: () => deps.biliShares?.() ?? undefined,
  };
}
