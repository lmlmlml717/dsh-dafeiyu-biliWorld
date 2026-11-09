/**
 * 世界的开关与设置：是否运行、每日预算、记忆轮数、冷会话阈值、归档范围、工作区权限、微信/QQ 模块与作息。
 *
 * 导出：默认值与上限常量、createWorldSwitch（读 world.json 并提供读写）、WorldSwitch 类型，以及几个校验函数。
 * 调用方：index.ts 建一份；控制台动作、runtime.ts、生活线、微信与 QQ 模块都从这里读设置。
 * 依赖：life/lifeStore.ts 的 durableWrite、life/alarm.ts 的时间校验、archiveSelection 的范围校验。
 *
 * 坑：world.json 可能被手改坏或只写了一半，解析失败只当「没存过」并登记故障，绝不在 load 阶段抛错 ——
 * 抛错会让整个插件起不来，控制台和所有路由一起消失。设置只在内存里改完再整份写回；默认值不落盘，
 * 只有非默认值才写进去，这样以后改默认值时老世界也能跟着变。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { durableWrite } from './life/lifeStore.ts';
import { validArchiveScope, type MemoryArchiveScope } from './archiveSelection.ts';
import { DEFAULT_REVIEW_TIME, validClockTime } from './life/alarm.ts';

/** world.json 里存的东西：全部可选，缺的项按默认值算。 */
interface WorldSettings { running: boolean; dailyBudget?: number; memoryTurns?: number; coldHours?: number; archiveScope?: MemoryArchiveScope; workspacePermission?: string; wechatContext?: number; wechatBufferSeconds?: number; wechatEnabled?: boolean; qqEnabled?: boolean; compactAfterReview?: boolean; compactionSwapped?: boolean; reviewTime?: string; wakeTime?: string }
/** How many of the newest turns the memory block carries when nothing else is set. */
export const DEFAULT_MEMORY_TURNS = 200;
/** Hours a session stays silent before its next turn re-reads her memory block and prompt (#36); see `runtime.ts`. */
export const DEFAULT_COLD_HOURS = 24, MAX_COLD_HOURS = 720;
/** WeChat group messages read before a mention, and seconds a private image waits for its companions. */
export const DEFAULT_WECHAT_CONTEXT = 5, MAX_WECHAT_CONTEXT = 20;
// 与上一条共用上面那句说明：私聊里连发的图片先攒 3 秒，等上下文凑齐再一起读。
export const DEFAULT_WECHAT_BUFFER_SECONDS = 3, MAX_WECHAT_BUFFER_SECONDS = 30;

/**
 * Her world's own settings, changed from the world console and kept in `<world>/world.json` so they outlast a
 * restart: whether it runs (memory block, prompts, archive and life line together), how much her home may
 * spend a day, and how many recent turns her memory block carries. A world that already has a life line from before the switch existed is running; a new one waits
 * for its partner to press start.
 */
export function createWorldSwitch(worldDir: string, configuredScope: MemoryArchiveScope = 'workspace', configuredWake = '09:00', options: { onFault?: (message: string) => void } = {}) {
  const file = join(worldDir, 'world.json');
  // world.json 是手改/半截写入也会碰到的文件：解析失败只当「没有存过」，
  // 绝不能在这里抛错 —— 那会让整个插件 load 失败，控制台和所有路由一起消失。
  let stored: Partial<WorldSettings> | undefined;
  if (existsSync(file)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object') stored = parsed as Partial<WorldSettings>;
      else options.onFault?.(`world.json 不是对象，已按默认设置启动：${file}`);
    } catch (error) {
      options.onFault?.(`world.json 读取失败，已按默认设置启动：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  let settings: WorldSettings = {
    // 从旧版本升上来的世界已经有生活线：没有 world.json 时按 life.json 在不在判断它本来就在跑。
    running: stored ? stored.running === true : existsSync(join(worldDir, 'life.json')),
    ...(typeof stored?.dailyBudget === 'number' ? { dailyBudget: stored.dailyBudget } : {}),
    ...(validTurns(stored?.memoryTurns) ? { memoryTurns: stored.memoryTurns } : {}),
    ...(validColdHours(stored?.coldHours) ? { coldHours: stored.coldHours } : {}),
    ...(validArchiveScope(stored?.archiveScope) ? { archiveScope: stored.archiveScope } : {}),
    ...(validWorkspacePermission(stored?.workspacePermission) ? { workspacePermission: stored.workspacePermission } : {}),
    ...(validWechatContext(stored?.wechatContext) ? { wechatContext: stored.wechatContext } : {}),
    ...(validWechatBuffer(stored?.wechatBufferSeconds) ? { wechatBufferSeconds: stored.wechatBufferSeconds } : {}),
    ...(typeof stored?.wechatEnabled === 'boolean' ? { wechatEnabled: stored.wechatEnabled } : {}),
    ...(typeof stored?.qqEnabled === 'boolean' ? { qqEnabled: stored.qqEnabled } : {}),
    ...(stored?.compactAfterReview === false ? { compactAfterReview: false } : {}),
    ...(stored?.compactionSwapped === true ? { compactionSwapped: true } : {}),
    ...(validClockTime(stored?.reviewTime) ? { reviewTime: stored.reviewTime } : {}),
    ...(validClockTime(stored?.wakeTime) ? { wakeTime: stored.wakeTime } : {}),
  };
  // 启动时定下的范围：改配置只影响下次启动，所以「当前生效」与「已选择」要分开报，才能提示重启。
  const activeScope = settings.archiveScope ?? configuredScope;
  // 整份写回：world.json 只有一份，不做增量，读的时候就不会读到半套设置。
  function save(next: WorldSettings): void {
    durableWrite(file, JSON.stringify(next, null, 2));
    settings = next;
  }
  return {
    archiveScope: () => activeScope,
    selectedArchiveScope: () => settings.archiveScope ?? configuredScope,
    restartRequired: () => (settings.archiveScope ?? configuredScope) !== activeScope,
    setArchiveScope(scope: MemoryArchiveScope): void {
      if (!validArchiveScope(scope)) throw new Error('归档范围只能为 home 或 workspace');
      save({ ...settings, archiveScope: scope });
    },
    workspacePermission: () => settings.workspacePermission ?? 'danger-full-access',
    setWorkspacePermission(permission: string): void {
      if (!validWorkspacePermission(permission)) throw new Error('工作区权限必须为非空字符串');
      save({ ...settings, workspacePermission: permission });
    },
    /** After each evening look back her home is applied and compacted, so the 我是谁 she has just rewritten takes effect; on unless the partner turns it off. */
    compactAfterReview: () => settings.compactAfterReview !== false,
    setCompactAfterReview(on: boolean): void {
      const { compactAfterReview: _old, ...rest } = settings;
      save(on ? rest : { ...rest, compactAfterReview: false });
    },
    /** Whether the profile has been switched to the tool-free compaction (by this plugin or by hand); asked once, so putting the stock one back sticks. */
    compactionSwapped: () => settings.compactionSwapped === true,
    markCompactionSwapped: () => save({ ...settings, compactionSwapped: true }),
    running: () => settings.running,
    set: (running: boolean) => save({ ...settings, running }),
    /** CNY a day for her home; undefined is no limit. */
    dailyBudget: () => settings.dailyBudget,
    setDailyBudget(yuan: number | undefined): void {
      const { dailyBudget: _old, ...rest } = settings;
      save(yuan === undefined ? rest : { ...rest, dailyBudget: yuan });
    },
    /** Turns in her memory block; read when a block is built, so a change shows from the next session start or compaction. */
    memoryTurns: () => settings.memoryTurns ?? DEFAULT_MEMORY_TURNS,
    setMemoryTurns(turns: number | undefined): void {
      const { memoryTurns: _old, ...rest } = settings;
      save(turns === undefined || turns === DEFAULT_MEMORY_TURNS ? rest : { ...rest, memoryTurns: turns });
    },
    /** Read at every turn start, so a change applies from the next turn of each session. */
    coldHours: () => settings.coldHours ?? DEFAULT_COLD_HOURS,
    setColdHours(hours: number | undefined): void {
      const { coldHours: _old, ...rest } = settings;
      save(hours === undefined || hours === DEFAULT_COLD_HOURS ? rest : { ...rest, coldHours: hours });
    },
    /**
     * The console's switches for the WeChat and QQ modules; both are off until someone turns them on. QQ's SDK is an
     * optional dependency, so its code is not even loaded before then. WeChat used to default to on, so a world that
     * never stored a choice but whose WeChat module has already run (it keeps its outbox) stays on after the upgrade.
     */
    wechatEnabled: () => settings.wechatEnabled ?? existsSync(join(worldDir, 'wechat-outbox.sqlite')),
    qqEnabled: () => settings.qqEnabled === true,
    setModules(next: { wechat?: boolean; qq?: boolean }): void {
      const { wechatEnabled, qqEnabled, ...rest } = settings;
      // qqEnabled 只在为 true 时落盘：关掉就是没有这个键，默认即关，文件也不会越写越乱。
      const wechat = next.wechat ?? wechatEnabled ?? existsSync(join(worldDir, 'wechat-outbox.sqlite')), qq = next.qq ?? qqEnabled === true;
      save({ ...rest, wechatEnabled: wechat, ...(qq ? { qqEnabled: true } : {}) });
    },
    /** Her evening look back and her morning wake when nothing is pending; the configured `fallbackWakeTime` is the morning's default. */
    reviewTime: () => settings.reviewTime ?? DEFAULT_REVIEW_TIME,
    wakeTime: () => settings.wakeTime ?? configuredWake,
    /** A field left out stays as it is; null goes back to its default. */
    setSchedule(next: { review?: string | null; wake?: string | null }): void {
      const { reviewTime: oldReview, wakeTime: oldWake, ...rest } = settings;
      const review = next.review === undefined ? oldReview : next.review ?? undefined;
      const wake = next.wake === undefined ? oldWake : next.wake ?? undefined;
      save({ ...rest, ...(review === undefined || review === DEFAULT_REVIEW_TIME ? {} : { reviewTime: review }), ...(wake === undefined || wake === configuredWake ? {} : { wakeTime: wake }) });
    },
    /** Read by the WeChat adapter on its next poll; a batch already waiting keeps the value it started with. */
    wechatContext: () => settings.wechatContext ?? DEFAULT_WECHAT_CONTEXT,
    wechatBufferSeconds: () => settings.wechatBufferSeconds ?? DEFAULT_WECHAT_BUFFER_SECONDS,
    setWechat(next: { context?: number | null; bufferSeconds?: number | null }): void {
      const { wechatContext: oldContext, wechatBufferSeconds: oldBuffer, ...rest } = settings;
      const context = next.context === undefined ? oldContext : next.context ?? undefined;
      const buffer = next.bufferSeconds === undefined ? oldBuffer : next.bufferSeconds ?? undefined;
      save({ ...rest, ...(context === undefined || context === DEFAULT_WECHAT_CONTEXT ? {} : { wechatContext: context }), ...(buffer === undefined || buffer === DEFAULT_WECHAT_BUFFER_SECONDS ? {} : { wechatBufferSeconds: buffer }) });
    },
  };
}
/** 世界设置的公开形状，由 createWorldSwitch 的返回值推导。 */
export type WorldSwitch = ReturnType<typeof createWorldSwitch>;
/**
 * 记忆轮数是否合法。
 * @param value world.json 里读出的任意值。
 * @returns 是大于等于 1 的整数时才算；undefined、小数与 0 都不算。
 */
export const validTurns = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1;
/**
 * 冷会话阈值（小时）是否合法。
 * @param value world.json 里读出的任意值。
 * @returns 1 到 MAX_COLD_HOURS 之间的整数才算；再大就没有实际意义了。
 */
export const validColdHours = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_COLD_HOURS;
/**
 * 工作区权限名是否可用：非空字符串即可。
 * @param value world.json 或控制台传来的任意值。
 * @returns 去掉空白后仍有内容才算。
 */
export const validWorkspacePermission = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

/**
 * 微信上下文条数是否在范围内。
 * @param value world.json 里读出的任意值。
 * @returns 1 到 MAX_WECHAT_CONTEXT 之间的整数才算。
 */
export const validWechatContext = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_WECHAT_CONTEXT;
/**
 * 微信私聊图片的等待秒数是否在范围内。
 * @param value world.json 里读出的任意值。
 * @returns 0 到 MAX_WECHAT_BUFFER_SECONDS 之间的数才算（0 表示不等）。
 */
export const validWechatBuffer = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_WECHAT_BUFFER_SECONDS;
