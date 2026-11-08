import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDailyBili, type DailyBili } from './bili/dailyBili.ts';
import { deleteCommentLogEntry, readCommentLog } from './bili/commentLog.ts';
import { readBiliHistory } from './bili/history.ts';
import { getBiliQuota } from './bili/quota.ts';
import { getBiliMood, setBiliMood, feedBili } from './bili/mood.ts';
import type { BiliStatus, BiliQuota, BiliMood, BiliCommentState } from './console/routes.ts';
// DSH's HMR reconciles the profile once at every start and drops, as failed imports, the profile modules whose import
// has not finished (dsh-hmr `reconcileProfile`). The QQ module is imported later and is the only way to `ws`, a CommonJS
// package: dropped halfway, Node fails it with ERR_INTERNAL_ASSERTION and QQ switched on at boot never starts. Loaded
// with the plugin, `ws` is complete before that reconciliation runs.
import 'ws';
import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
import z from '@deepseek-ai/schemastery';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { createBridge, type Bridge } from './ecosystem/bridge/bridge.ts';
import { bridgeRoute, compactRoute } from './ecosystem/bridge/route.ts';
import { consoleRoute, type ConsoleActions } from './console/routes.ts';
import { consoleSources } from './console/snapshot.ts';
import { compactionFor, createHomeApply } from './console/homeApply.ts';
import { errorText, Faults } from './faults.ts';
import { swapCompactionOnce, swapPresetCompaction, swapStockCompaction, type ConfigEditor } from './compactionSwap.ts';
import { ensureSelfRegistered } from './install/selfRegister.ts';
import { hostLife } from './life/host.ts';
import { createLifeStore, durableWrite } from './life/lifeStore.ts';
import { toastSupported, windowsToast, type Notifier } from './life/notify.ts';
import { createLifeRuntime, type LifeRuntime } from './life/runtime.ts';
import type { LifeOptions } from './life/types.ts';
import { createOutlet } from './ecosystem/shared/outlets.ts';
import { readPersona, writePersona } from './persona.ts';
import type { QqNativeModule } from './ecosystem/qq-native/index.ts';
import { qqRoute } from './ecosystem/qq/route.ts';
import { createConsoleDoors, discoverSnowlumaHome } from './ecosystem/qq/panel.ts';
import { createMemory } from './memory.ts';
import { createWorldRuntime } from './runtime.ts';
import { createArchiveStore, validWorldId } from './store.ts';
import type { WorldConfig } from './types.ts';
import { DEFAULT_TEMPLATE_FILE, MEMORY_SNIPPET_FILE, memoryTemplateGaps, roomTitle, worldNames } from './worldPrompt.ts';
import { createWorldSwitch } from './worldSwitch.ts';
import { CLOCK_TIME, DEFAULT_REVIEW_TIME } from './life/alarm.ts';
import { createWechatModule, type WechatModule } from './ecosystem/wechat/index.ts';
import { createWechatRecorder } from './ecosystem/wechat/archive.ts';
import { createAdapterSupervisor, type AdapterSupervisor } from './ecosystem/wechat/supervisor.ts';
import { createChannelSessions } from './ecosystem/shared/sessions.ts';
import { createArchiveSelection, createWorkspaceMembership } from './archiveSelection.ts';
import { inWorld } from './sourceArchive.ts';
import { createWorkspacePermissions } from './workspacePermissions.ts';
import { createPhotoStore, type PhotoStore } from './life/photos.ts';
import { createQqSdkInstaller, type QqSdkProfile } from './ecosystem/qq-native/sdkInstall.ts';

export { createWorldRuntime } from './runtime.ts';
export type { WorldConfig, ConversationRecord, ConversationTurn, ArchiveCursor } from './types.ts';
export const name = 'dsh-world-bili';
export const inject = ['agents', 'sessions', 'sessionPersistence', 'llm'];
/** What `apply` receives: the schema below fills these defaults. */
export type Config = WorldConfig & Required<Pick<WorldConfig, 'life' | 'replaceCompaction' | 'fallbackWakeTime' | 'outlets' | 'bridge' | 'toast' | 'allowedHosts'>>;
// One companion per profile is the usual case, so it works as installed: the standard preset, a world named
// default and the system time zone, with the life line on (it needs the desktop host's services and stays off without them).
const systemTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
export const Config = z.object({
  worldId: z.string().default('default'), agentPreset: z.string().default('standard'), timeZone: z.string().default(systemTimeZone),
  companionName: z.string(), partnerName: z.string(),
  archiveScope: z.union([z.const('home').description('仅家会话'), z.const('workspace').description('家所在工作区'), z.transform(z.const('world').hidden(), () => 'workspace' as const).hidden()]).default('workspace').description('记忆归档范围，修改后重启生效'),
  // Install means the tool-free compaction: the first start rewrites the profile's stock compaction row (see README); false leaves it alone.
  replaceCompaction: z.boolean().default(true),
  life: z.boolean().default(true), diaryDir: z.string(), fallbackWakeTime: z.string().pattern(CLOCK_TIME).default('09:00'),
  selfFile: z.string(), worldPromptFile: z.string(), alarmTemplateFile: z.string(), personaFile: z.string(),
  // Where her words go outside DSH; no app is known by name (see README for the push body).
  outlets: z.array(z.object({ name: z.string().required(), url: z.string(), urlFile: z.string(), path: z.string(), kinds: z.array(z.union([z.const('reply'), z.const('busy'), z.const('reach')])) })).default([]),
  // A local app may hand her partner's words to her home through POST /dsh-world/bridge/say.
  bridge: z.boolean().default(false),
  qqNative: z.object({
    enabled: z.boolean().default(false),
    wsUrl: z.string().default('ws://127.0.0.1:3003'),
    accessToken: z.string().default(''),
    allowPrivate: z.array(z.string()).default([]),
    // 她自己开口（家里闹钟那一轮）的话推给谁。空着退回 allowPrivate 的第一个；白名单不止一人时一定要填。
    ownerQQ: z.string().default(''),
    allowGroups: z.array(z.string()).default([]),
    autoReply: z.boolean().default(true),
    contextMessages: z.number().default(6),
    // 同一会话这几毫秒内说的话攒成一条再问她（0 = 一条一问）。
    batchQuietMs: z.number().default(10_000),
    // 群里什么时候接话。量出来的事实是：不做这个判断的话，群里每句都会让她跑完一轮、还往群里冒一条
    // （她自己会在话里写「这句不接」，但那句话本身也发到群里了）。默认只接被叫到的。
    groupTrigger: z.union([z.const('mention').description('只接被叫到的（被 @ / 被引用她的话 / 命中关键词）'), z.const('all').description('每句都接')]).default('mention'),
    groupKeywords: z.array(z.string()).default([]),
    // 只停嘴不停耳：这个时间之前照收、照记，但不回，到点自己醒。ISO 时间，如 2026-10-28T08:00:00+08:00。
    mutedUntil: z.string().default(''),
    // SnowLuma 装在哪：控制台那扇门要去它的 config/runtime.json 拿地址与端口。空着就按 D:\SnowLuma、
    // C:\SnowLuma、~/SnowLuma 挨个认（认「里面有 config/runtime.json」这一条）。
    snowlumaHome: z.string().default(''),
    // 看门狗：通道开着时每 30 秒探一次 wsUrl 的端口，不通就把 SnowLuma 拉起来。不想让插件动手就关掉，面板上的按钮照旧能用。
    supervise: z.boolean().default(true),
    // 谁和她的家会话共用一个入口。'owner'（默认）＝群各自独立、私聊用她的家；'all'＝都用她的家；
    // 'none'＝谁都不绑，每个入口各建一个 —— 开发测试 QQ 的时候填 none，回合就不会走进步话生活的家里。
    bindHomeSession: z.union([z.const('owner').description('群各自独立，私聊用她的家会话'), z.const('all').description('都用她的家会话'), z.const('none').description('谁都不绑，每个入口各建一个'), z.const('')]).default('owner'),
    // 阳台：给这台机器上别的程序留的一条线。口令空着就由插件自己生成一条并存在世界目录里。
    bridge: z.object({
      port: z.number().default(0),
      token: z.string().default(''),
      title: z.string().default('阳台'),
      contextMessages: z.number().default(6),
    }).default({ port: 0, token: '', title: '阳台', contextMessages: 6 }),
  }).description('QQ 直接连 OneBot：不经过 qq-bridge 进程，会话与状态都由这个插件自己管'),
  wechat: z.boolean().default(false),
  wechatAdapter: z.object({ python: z.string(), config: z.string() }).description('随微信模块启动和停止 Windows 适配器；写上即视为允许它发送消息'),
  toast: z.boolean().default(true),
  toastAppId: z.string().description('系统通知用的 AppUserModelID；不填就在开始菜单里找 DSH 桌面版'),
  // The console and the bridge answer only this machine by name, plus these (a LAN address or domain behind a proxy).
  allowedHosts: z.array(z.string()).default([]),
  // 每日 B 站打卡：定时唤醒 home session，让 agent 刷视频→深读→写动态→（可选）真发。
  dailyBili: z.object({
    enabled: z.boolean().default(false).description('显式写 true 才开（防不小心误启动）'),
    dailyTime: z.string().default('20:00').description('本地 HH:MM，night-plan 会在这个时间点前后算随机窗口'),
    dailyMaxVideos: z.number().default(10).description('每日转发视频硬上限（跨 fire 累加；0=不限）'),
    napcatHttp: z.string().default('http://127.0.0.1:3000').description('通知主人 QQ 的 OneBot HTTP 地址'),
    ownerQQ: z.string().default('').description('主人 QQ（显式写在这，或从 qqNative.allowPrivate[0] 拿）'),
    allowWrite: z.boolean().default(false).description('真发开关 —— tool 链 guard.dryRun=false 才真正生效'),
  }).description('每日 B 站打卡：定时唤醒 home session'),
  // 给视频发一条顶层评论（不回复任何人）。开关在主配置，真发还要求 dailyBili.allowWrite。
  comment: z.object({
    enabled: z.boolean().default(false).description('评论功能开关（真发还要求 dailyBili.allowWrite）'),
    hardDailyMax: z.number().default(5).description('每日硬上限：面板里能改的条数不能超过它（0 = 不限）'),
    minIntervalSec: z.number().default(3600).description('两条评论之间的最小间隔（秒）'),
  }).default({}).description('B站评论：给视频发顶层评论'),
});
interface WebServer { register(route: ReturnType<typeof consoleRoute> | ReturnType<typeof bridgeRoute> | ReturnType<typeof compactRoute> | ReturnType<typeof qqRoute>): () => void }

/**
 * Her world runs only after her partner presses start in the world console, and stops when they press stop:
 * memory block, persona, world prompt, archive and life line come and go together. The switch is kept in
 * `<world>/world.json`, so it outlasts a restart.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const dshHome = resolveDshHome();
  // 自注册的实现和风险说明都在 src/install/selfRegister.ts：这里只传“我是谁、profile 在哪”。
  ensureSelfRegistered({ dshHome, packageName: name, logger: ctx.logger });
  /**
   * 把主配置的评论开关/真发总开关/硬上限/最小间隔镜像进 bili.config.json。
   * CLI 与面板都读这一份，所以「主配置是事实来源、面板与命令行看到同一组值」。
   */
  function mirrorCommentConfig(): void {
    try {
      const file = join(worldDir, 'bili.config.json');
      let current: any = {};
      if (existsSync(file)) { try { current = JSON.parse(readFileSync(file, 'utf8')); } catch {} }
      current.comment = {
        ...(current.comment ?? {}),
        enabled: !!config.comment?.enabled,
        // 真发总开关镜像：工具链在 postReply 里硬校验这一项，缺了它 allowWrite 只是提示词里的空话。
        allowWrite: !!config.dailyBili?.allowWrite,
        hardDailyMax: Number(config.comment?.hardDailyMax ?? 5),
        minIntervalSec: Number(config.comment?.minIntervalSec ?? 3600),
      };
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(current, null, 2), 'utf8');
    } catch { /* 读不到配置就下次启动再镜像，不拖住插件 */ }
  }

  /** 评论页状态：设置（主配置镜像）+ 今日已发 + 最近几条尝试。 */
  function readBiliCommentState(): BiliCommentState {
    const configFile = join(worldDir, 'bili.config.json');
    const biliDir = join(worldDir, 'bili');
    let file: any = {};
    try { if (existsSync(configFile)) file = JSON.parse(readFileSync(configFile, 'utf8')); } catch {}
    const comment = file.comment ?? {};
    const day = new Date().toLocaleDateString('sv-SE');
    let today = 0;
    try {
      const acts = JSON.parse(readFileSync(join(biliDir, 'bili-actions.json'), 'utf8'));
      if (acts?.day === day) today = Number(acts.comment ?? 0);
    } catch {}
    let recent: BiliCommentState['recent'] = [];
    try {
      const lines = readFileSync(join(biliDir, 'bili-comments.jsonl'), 'utf8').trim().split('\n').filter(Boolean).slice(-5);
      recent = lines.flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    } catch {}
    return {
      enabled: comment.enabled !== undefined ? !!comment.enabled : !!config.comment?.enabled,
      // 与 enabled 一样先看镜像文件：面板改完立即看到新值，不用等重启。
      allowWrite: comment.allowWrite !== undefined ? !!comment.allowWrite : !!config.dailyBili?.allowWrite,
      dryRun: file.guard?.dryRun !== false,
      hardDailyMax: Number(comment.hardDailyMax ?? config.comment?.hardDailyMax ?? 5),
      minIntervalSec: Number(comment.minIntervalSec ?? config.comment?.minIntervalSec ?? 3600),
      dailyMax: Number(comment.dailyMax ?? 0),
      skipChance: Number(comment.skipChance ?? 0.3),
      today,
      recent,
    };
  }

  // worldId 会变成目录名：先校验，再用于任何 join / mkdir / 写文件（M-04）。
  if (!validWorldId(config.worldId)) throw new TypeError(`dsh-world: worldId ${JSON.stringify(config.worldId)} 不合法`);
  const worldDir = join(dshHome, 'worlds', config.worldId);
  // B站工具链（tools/lib/paths.mjs）靠这两个环境变量定位世界。不论 dailyBili 是否启用都要设置：
  // 否则手动 `node tools/bili.mjs …` 与控制台的心情/额度会读写 worlds/default（H-01）。
  // 卸载时恢复原值，避免影响同进程里的其它消费者。
  const biliDataDir = join(worldDir, 'bili');
  const previousWorldId = process.env.WORLD_ID;
  const previousBiliDataDir = process.env.WORLD_BILI_DATA_DIR;
  process.env.WORLD_ID = config.worldId;
  process.env.WORLD_BILI_DATA_DIR = biliDataDir;
  ctx.effect(() => () => {
    if (previousWorldId === undefined) delete process.env.WORLD_ID; else process.env.WORLD_ID = previousWorldId;
    if (previousBiliDataDir === undefined) delete process.env.WORLD_BILI_DATA_DIR; else process.env.WORLD_BILI_DATA_DIR = previousBiliDataDir;
  }, 'dsh-world bili environment');
  // 评论设置以主配置为准，镜像给 CLI 与面板（同一份 bili.config.json）。
  mirrorCommentConfig();
  const store = createArchiveStore({ ...config, root: dshHome });
  const faults = new Faults();
  const power = createWorldSwitch(worldDir, config.archiveScope ?? 'workspace', config.fallbackWakeTime, { onFault: message => faults.set('world-switch', message) });
  const memoryConfig = { ...config, archiveScope: power.archiveScope() };
  let photoStore: PhotoStore | undefined;
  const photos = () => {
    try { photoStore ??= createPhotoStore(worldDir); faults.clear('photos'); return photoStore; }
    catch (error) { faults.set('photos', `相册打不开：${errorText(error)}`); throw error; }
  };
  ctx.effect(() => () => photoStore?.close(), 'dsh-world album');
  // Her self-description lives in her room whether or not the life line runs; she writes it with her file tools.
  const selfFile = config.selfFile || join(worldDir, 'room', '我是谁.md');
  const personaFile = config.personaFile || join(worldDir, 'persona.md');
  const worldPromptFile = config.worldPromptFile || join(worldDir, 'world-prompt.md');
  const roomDir = join(worldDir, 'room');
  const options: LifeOptions = { worldDir, roomDir, diaryDir: config.diaryDir || join(worldDir, 'diary'), selfFile, schedule: () => ({ review: power.reviewTime(), wake: power.wakeTime() }), timeZone: config.timeZone, alarmFile: config.alarmTemplateFile || join(worldDir, 'alarm.md') };
  /** The name in her persona comes first, then the configured one. */
  const names = () => worldNames({ ...config, companionName: readPersona(personaFile).名字 || config.companionName });
  const lifeStore = (() => {
    if (!config.life) return undefined;
    try { const current = createLifeStore(worldDir, config.timeZone); current.read(); return current; }
    catch (error) { faults.set('life', `生活线没能启动：${errorText(error)}`); ctx.logger.error(error); return undefined; }
  })();
  const storedHome = () => lifeStore?.read().homeSessionId;
  let isHome: (sessionId: string) => boolean = id => id === storedHome();
  /** Whose conversations her archive keeps (the home, or her whole workspace). */
  const archiveSession = createArchiveSelection(ctx, power.archiveScope(), id => isHome(id), options.roomDir);
  /** Where her world reaches: her room's workspace, and in it the sessions of her preset. */
  const inWorkspace = createWorkspaceMembership(ctx, options.roomDir);
  const inWorldSession = (session: Session) => inWorld(session, config, inWorkspace);
  /** Long-term memory over the archive and her own files; the tools and the console are two doors to it. */
  const memoryService = createMemory({ store: store.memory, timeZone: config.timeZone, sources: { diaryDir: options.diaryDir }, visible: id => archiveSession(id) });

  /** What is wrong with long-term memory, in the console's health list: a source that could not be read. */
  const memoryHealth = (): string[] => memoryService.status().failures.map(failure => `记忆来源 ${failure.sourceId}：${failure.message}`);
  let memory: ReturnType<typeof createWorldRuntime> | undefined;
  let stopLifeLine: (() => Promise<void>) | undefined;
  /**
   * A memory line that cannot start is a fault, never a failed plugin: the console must still open to say so, and
   * the life line and channels run on. Stopping and starting the world from the console tries again.
   */
  async function startMemory(fresh: boolean): Promise<void> {
    if (memory) return;
    const prompt = { file: worldPromptFile, persona: personaFile, conversationsDir: join(worldDir, 'conversations'), names: names(), memoryTools: true, ...(config.life ? { life: options } : {}) };
    const runtime = createWorldRuntime(ctx, { ...memoryConfig, selfFile }, store, { prompt, names, isHome: id => isHome(id), archiveSession, inWorkspace, memory: memoryService }, power.memoryTurns, power.coldHours);
    try { await runtime.start({ fresh }); memory = runtime; faults.clear('memory'); }
    catch (error) { faults.set('memory', `记忆线没能启动：${errorText(error)}`); ctx.logger.error(error); }
  }
  async function stopMemory(): Promise<void> {
    const running = memory; memory = undefined;
    await running?.stop();
  }
  ctx.effect(() => async () => {
    try { await stopLifeLine?.(); }
    finally { await stopMemory().finally(() => store.close()); }
  }, 'dsh-world memory line');
  if (power.running()) await startMemory(false);
  // The host's workspace service may come up after this plugin; what the first catch-up could not place is read then.
  ctx.inject(['workspaceRegistry'], injected => { void memory?.retryCatchUp().catch(error => injected.logger.error(error)); });

  // The console and the life line need the desktop host.
  ctx.inject(['sessionController', 'permissionPresets', 'webServer'], async lifeCtx => {
    const webServer = (lifeCtx as unknown as { webServer: WebServer }).webServer;
    const host = hostLife(lifeCtx);
    const configEditor = lifeCtx.get('configEditor') as ConfigEditor | undefined;
    const swapCompaction = () => swapCompactionOnce({ enabled: config.replaceCompaction, profileDir: (lifeCtx.get('profileContext') as { dir?: string } | undefined)?.dir, done: power.compactionSwapped, markDone: power.markCompactionSwapped,
      swap: async dir => { const row = swapStockCompaction(dir); return row.status === 'unchanged' && configEditor ? swapPresetCompaction(configEditor, config.agentPreset, dir, { toolFreeFor: [options.roomDir] }) : row; },
      report: message => { faults.set('compaction-swap', message); lifeCtx.logger.warn(`dsh-world: ${message}`); } });
    // The preset row the editor rewrites is active only once the host has finished loading.
    const appReady = lifeCtx.get('appReady') as { onReady(listener: () => void): () => void } | undefined;
    if (!appReady) void swapCompaction();
    else lifeCtx.effect(() => {
      let closed = false;
      const cancel = appReady.onReady(() => { if (!closed) void swapCompaction(); });
      return () => { closed = true; cancel(); };
    }, 'dsh-world compaction swap');
    const permissions = createWorkspacePermissions(lifeCtx, options.roomDir, power);
    // QQ 的两扇门：她自己那条 OneBot 通道的状态与开关，以及 SnowLuma 的控制台。**无条件注册** —— 通道
    // 关着的时候 /native 回 null，而 SnowLuma 那扇门跟通道没关系。（这里原来还有一半是给外面那个
    // qq-bridge 进程用的，连 qqBridgeDir 一起在 2026-10-27 拆掉了。当时的教训：那条路由是注册在「有桥
    // 目录」这个分支里的，配置一摘，整片 /dsh-world/qq/* 就全 404，界面也一起没了。所以现在它不再挂在
    // 任何配置上 —— 端点先存在，功能再按需开关。）
    const doors = createConsoleDoors({ worldDir, snowlumaHome: config.qqNative?.snowlumaHome ?? '' });
    const unregisterQq = webServer.register(
      qqRoute(config.allowedHosts, doors, () => qqNative?.status() ?? null, patch => qqNative?.update(patch) ?? null),
    );
    lifeCtx.effect(() => () => unregisterQq(), 'dsh-world qq route');
    let life: LifeRuntime | undefined;
    const sdkAbort = new AbortController();
    const sdkAvailable = () => { try { import.meta.resolve('@snowluma/sdk'); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') return false; throw error; } };
    const qqSdk = createQqSdkInstaller({ available: sdkAvailable, profile: () => lifeCtx.get('profileContext') as QqSdkProfile | undefined, signal: sdkAbort.signal });
    lifeCtx.effect(() => () => sdkAbort.abort(new Error('世界插件已卸载')), 'dsh-world SDK installation');
    let qqChange = 0;
    const homeApply = createHomeApply({
      ctx: lifeCtx,
      home: async () => { if (!life) throw new Error('请先启动世界生活线'); return life.home(); },
      isHome: agent => !!life?.isHome(agent.id) && ctx.agents.get(agent.id) === agent && !host.isArchived(agent.id) && inWorldSession(agent.session),
      compaction: agent => compactionFor(lifeCtx, agent),
      refresh: session => { if (!memory) throw new Error('世界记忆线已停止'); memory.refreshPrompt(session); },
      changed: () => sources.invalidate(),
      fault: message => { if (message) faults.set('home-apply', message); else faults.clear('home-apply'); },
    });
    let bridge: Bridge | undefined;
    let dailyBili: DailyBili | undefined;

// ---- B站 bili.config.json / credentials.json 路径 ----
function biliConfigPath_(): string { return join(worldDir, 'bili.config.json'); }
function biliCredPath_(): string { return join(worldDir, 'bili', 'credentials.json'); }
function biliRoot_(): string { return join(worldDir, 'bili'); }
function deepMerge_(a: any, b: any): any {
  const out = { ...a };
  for (const k of Object.keys(b)) {
    if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && a[k] && typeof a[k] === 'object') {
      out[k] = deepMerge_(a[k], b[k]);
    } else { out[k] = b[k]; }
  }
  return out;
}

    let wechat: WechatModule | undefined;
    let qqNative: QqNativeModule | undefined;
    let qqChannels: ReturnType<typeof createChannelSessions> | undefined;
    let adapter: AdapterSupervisor | undefined;
    let channels: ReturnType<typeof createChannelSessions> | undefined;
    let unregisterWechat: (() => void) | undefined;
    let lifeStop: Promise<void> | undefined;
    let wechatClosing: Promise<void> = Promise.resolve();
    /** Starts the WeChat module (its tools, route and, when configured, the adapter) against the running life line. */
    async function startWechat(current: LifeRuntime): Promise<void> {
      if (wechat || !config.wechat) return;
      await wechatClosing;
        const groupSessions = createChannelSessions({ ctx: lifeCtx, host, store, roomDir: options.roomDir, roomTitle: roomTitle(names()), agentPreset: config.agentPreset });
        channels = groupSessions;
        wechat = createWechatModule({ ctx: lifeCtx, worldId: config.worldId, inWorld: inWorldSession, home: identity => identity.conversationType === 'group' ? groupSessions.open(identity) : current.home(), origin: () => host.origin(), file: join(worldDir, 'wechat.json'), incomingDir: join(worldDir, 'wechat-incoming'), allowedHosts: config.allowedHosts, settings: () => ({ contextMessages: power.wechatContext(), bufferSeconds: power.wechatBufferSeconds() }),
          ...createWechatRecorder(store, config.worldId, archiveSession) });
        wechat.start(); unregisterWechat = webServer.register(wechat.route);
        if (config.wechatAdapter?.python && config.wechatAdapter.config) { adapter = createAdapterSupervisor({ python: config.wechatAdapter.python, config: config.wechatAdapter.config, logFile: join(worldDir, 'wechat-adapter.log'), log: message => lifeCtx.logger.warn(message) }); adapter.start(); }
    }
    /** Takes the WeChat tools, route and adapter down; the adapter goes first because it exits when the module's connection file disappears. */
    function stopWechat(): Promise<void> {
      unregisterWechat?.(); unregisterWechat = undefined;
      const closingAdapter = adapter?.stop(); adapter = undefined;
      const closing = Promise.all([closingAdapter, wechat?.stop()]).then(() => {}); wechat = undefined;
      channels?.stop(); channels = undefined;
      return wechatClosing = closing;
    }
    /** QQ talks to her through the same home the WeChat channel uses; only the transport differs. */
    async function startQqNative(current: LifeRuntime): Promise<void> {
      const q = config.qqNative;
      if (qqNative || !q?.enabled || !power.qqEnabled()) return;
      try {
        if (qqSdk.needsRestart()) throw new Error('SDK 已安装，请重启 DSH 后启用 QQ');
        if (!sdkAvailable()) throw new Error('QQ 缺少 SnowLuma SDK，请关闭再开启 QQ，按需安装依赖');
        const { createQqNativeModule } = await import('./ecosystem/qq-native/index.ts');
        if (qqNative || life !== current || !power.running() || !power.qqEnabled()) return;
        const groupSessions = createChannelSessions({ ctx: lifeCtx, host, store, roomDir: options.roomDir, roomTitle: roomTitle(names()), agentPreset: config.agentPreset });
        qqChannels = groupSessions;
        qqNative = createQqNativeModule({
          ctx: lifeCtx,
          inWorld: inWorldSession,
          isHome: id => current.isHome(id),
          // `none` keeps private test traffic out of her real home, as groups are by default.
          home: identity => {
            const bind = q.bindHomeSession ?? 'owner';
            if (identity.conversationType === 'group') return bind === 'all' ? current.home() : groupSessions.open(identity);
            return bind === 'none' ? groupSessions.open(identity) : current.home();
          },
          logger: lifeCtx.logger,
          stateFile: join(options.roomDir, '..', 'qq-native.json'),
          config: () => ({
            enabled: q.enabled ?? false,
            wsUrl: q.wsUrl ?? 'ws://127.0.0.1:3003',
            accessToken: q.accessToken ?? '',
            allowPrivate: q.allowPrivate ?? [],
            ownerQQ: q.ownerQQ ?? '',
            allowGroups: q.allowGroups ?? [],
            autoReply: q.autoReply ?? true,
            contextMessages: q.contextMessages ?? 6,
            batchQuietMs: q.batchQuietMs ?? 10_000,
            groupTrigger: q.groupTrigger ?? 'mention',
            groupKeywords: q.groupKeywords ?? [],
            mutedUntil: q.mutedUntil ?? '',
            snowlumaHome: discoverSnowlumaHome(q.snowlumaHome ?? ''),
            supervise: q.supervise ?? true,
            bridge: {
              port: q.bridge?.port ?? 0,
              token: q.bridge?.token ?? '',
              title: q.bridge?.title ?? '阳台',
              contextMessages: q.bridge?.contextMessages ?? 6,
            },
            bindHomeSession: q.bindHomeSession ?? 'owner',
          }),
        });
        qqNative.start();
        faults.clear('qq');
      } catch (error) {
        stopQqNative();
        faults.set('qq', `QQ 模块没能启动：${errorText(error)}`); lifeCtx.logger.error(error);
      }
    }
    function stopQqNative(): void { qqNative?.stop(); qqNative = undefined; qqChannels?.stop(); qqChannels = undefined; faults.clear('qq'); }
    async function startLife(resumed: boolean): Promise<void> {
      if (!lifeStore || life) return;
      try {
        await lifeStop;
        const outlets = config.outlets.map(outlet => createOutlet(outlet, () => host.origin()));
        const notifier: Notifier = { ...(config.toast && toastSupported() ? { toast: windowsToast(config.toastAppId || undefined) } : {}), outlets };
        const current = createLifeRuntime({ ctx: lifeCtx, config: { ...config, companionName: names().companion }, options, store: lifeStore, host, notifier, dailyBudget: power.dailyBudget, inWorkspace, photos, alarmContext: now => wechat?.presence(now), afterReview: () => { if (power.compactAfterReview()) homeApply.request(); } });
        life = current; isHome = current.isHome;
        if (config.bridge) { bridge = createBridge({ ctx: lifeCtx, home: () => current.home(), inWorld: inWorldSession, outlets, origin: () => host.origin(), file: join(worldDir, 'bridge.json'), name: names().companion }); bridge.start(); }
        if (config.wechat && power.wechatEnabled()) await startWechat(current);
        if (config.qqNative?.enabled && power.qqEnabled()) await startQqNative(current);
        faults.clear('life');
        await current.start({ resumed });
        // ── 每日 B站打卡定时器（独立 setTimeout，不侵入 world 原 alarmTimer 引擎）──
        if (config.dailyBili?.enabled) {
          const biliOptions = config.dailyBili;
          const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
          const biliMjs = join(pluginRoot, 'tools', 'bili.mjs');
          const dataDir = join(worldDir, 'bili');
          // 数据目录/世界 ID 的进程环境已在 apply() 顶部统一设置（H-01），这里不再重复注入。
          dailyBili = createDailyBili({
            home: () => current.home(),
            flush: agent => lifeCtx.sessions.flush(agent.session),
            logger: lifeCtx.logger,
            timeZone: config.timeZone,
            options: {
              enabled: () => power.running() && !!life && !!config.dailyBili?.enabled,
              dailyTime: biliOptions.dailyTime ?? '20:00',
              dailyMaxVideos: biliOptions.dailyMaxVideos ?? 10,
              napcatHttp: biliOptions.napcatHttp ?? 'http://127.0.0.1:3000',
              ownerQQ: biliOptions.ownerQQ ?? config.qqNative?.allowPrivate?.[0],
              allowWrite: !!biliOptions.allowWrite,
              biliMjs,
              dataDir,
              wakeTime: power.wakeTime(),
              reviewTime: power.reviewTime(),
            },
          });
          dailyBili.start();
        }
      } catch (error) {
        // The console still opens and says why, instead of looking as if the life line were simply off.
        await stopLife();
        faults.set('life', `生活线没能启动：${errorText(error)}`); lifeCtx.logger.error(error);
      }
    }
    function stopLife(): Promise<void> {
      isHome = id => id === storedHome();
      dailyBili?.stop(); dailyBili = undefined;
      bridge?.stop(); life?.stop();
      const closingWechat = stopWechat();
      stopQqNative();
      bridge = undefined; life = undefined;
      return lifeStop = Promise.all([lifeStop, closingWechat, homeApply.cancel()]).then(() => {});
    }
    stopLifeLine = stopLife;
    lifeCtx.effect(() => () => stopLife(), 'dsh-world life line');
    // The host matches exact routes before the longest prefix, so this path never reaches the console.
    if (config.bridge) lifeCtx.effect(() => webServer.register(bridgeRoute(() => bridge, config.allowedHosts)), 'dsh-world bridge route');
    if (config.bridge) lifeCtx.effect(() => webServer.register(compactRoute(() => bridge, () => !power.running() || !life ? '请先启动世界生活线' : homeApply.request(), config.allowedHosts)), 'dsh-world compact route');

    // Her album lives in her room, so the console shows it whether or not the life line is running.
    const sources = consoleSources({ ctx: lifeCtx, config: memoryConfig, archive: store, longTerm: memoryService, names, ...(lifeStore ? { lifeStore } : {}), life: () => life, homeApply: homeApply.snapshot, compactAfterReview: power.compactAfterReview, ...(config.life ? { schedule: () => ({ review: power.reviewTime(), wake: power.wakeTime(), defaults: { review: DEFAULT_REVIEW_TIME, wake: config.fallbackWakeTime } }) } : {}), photos, diaryDir: options.diaryDir, running: power.running, dailyBudget: power.dailyBudget, memoryTurns: power.memoryTurns, coldHours: power.coldHours, selectedArchiveScope: power.selectedArchiveScope, workspacePermissions: permissions.snapshot, wechat: () => wechat ? { ...wechat.status(), adapter: adapter?.status() ?? null } : undefined, archiveSession, native: () => qqNative?.status() ?? null,
      bili: (): BiliStatus | undefined => {
        if (!config.dailyBili?.enabled) return undefined;
        const dataDir = join(worldDir, 'bili');
        let plan: Record<string, unknown> | null = null;
        try { plan = JSON.parse(readFileSync(join(dataDir, 'plan.json'), 'utf8')); } catch {}
        return {
          enabled: true,
          // 只表示「本次 fire 正在投递 prompt」（决定能不能再手动触发）；调度器是否排好下一次不在这里。
          running: dailyBili?.busy() ?? false,
          allowWrite: !!config.dailyBili.allowWrite,
          dataDir,
          plan,
        };
      },
      biliQuota: (): BiliQuota | undefined => { try { return getBiliQuota() } catch { return undefined } },
      biliMood: (): BiliMood | undefined => { try { return getBiliMood() } catch { return undefined } },
      biliComment: (): BiliCommentState | undefined => { try { return readBiliCommentState() } catch { return undefined } },
      modules: () => ({ wechat: { available: config.wechat, enabled: power.wechatEnabled(), running: wechat !== undefined }, qq: { available: Boolean(config.qqNative?.enabled), enabled: power.qqEnabled(), running: qqNative !== undefined, ...(qqSdk.needsRestart() ? { restartRequired: true } : {}) } }), faults: () => [...faults.list(), ...(adapter?.status().error ? [`微信适配器：${adapter.status().error}`] : []), ...(memory?.faults() ?? []), ...(bridge?.faults() ?? []), ...memoryHealth()] });
    const actions: ConsoleActions = {
      async start() {
        if (power.running()) return;
        power.set(true);
        try { await startMemory(true); await startLife(true); } finally { sources.invalidate(); }
      },
      async stop() {
        if (!power.running()) return;
        power.set(false);
        await stopLife();
        try { await stopMemory(); } finally { sources.invalidate(); }
      },
      applyHome: () => !power.running() || !life ? '请先启动世界生活线' : homeApply.request(),
      prompts: () => ({
        persona: readPersona(personaFile),
        worldPrompt: existsSync(worldPromptFile) ? (text => ({ text, custom: true, memory: { missing: memoryTemplateGaps(text), snippet: readFileSync(MEMORY_SNIPPET_FILE, 'utf8') } }))(readFileSync(worldPromptFile, 'utf8')) : { text: readFileSync(DEFAULT_TEMPLATE_FILE, 'utf8'), custom: false },
      }),
      savePersona: persona => { writePersona(personaFile, { ...readPersona(personaFile), ...persona }); sources.invalidate(); },
      setDailyBudget: yuan => { power.setDailyBudget(yuan); sources.invalidate(); },
      setMemoryTurns: turns => { power.setMemoryTurns(turns); sources.invalidate(); },
      setColdHours: hours => { power.setColdHours(hours); sources.invalidate(); },
      setWorkspacePermission: permission => { permissions.set(permission); sources.invalidate(); },
      setCompactAfterReview: on => { power.setCompactAfterReview(on); sources.invalidate(); },
      async triggerBiliNow(): Promise<string | undefined> {
        if (!config.dailyBili?.enabled) return 'dailyBili 未启用';
        if (!dailyBili) return 'dailyBili 未初始化（先启动世界）';
        if (!power.running()) return '世界还没启动，等启动后再触发';
        void dailyBili.triggerNow();
        return undefined;
      },
      replanBili(): void {
        dailyBili?.replan();
        sources.invalidate();
      },
      readBiliConfig(): unknown {
        const path = biliConfigPath_();
        const base = !existsSync(path)
          ? { guard: { dryRun: true }, bilibili: {} }
          : (() => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return { guard: { dryRun: true }, bilibili: {} }; } })();
        // 内置同义词以只读字段下发：词表在 tools/lib/synonyms.json（工具链与 UI 共用同一份，避免漂移）。
        let synonyms: Record<string, string[]> = {};
        try { synonyms = JSON.parse(readFileSync(new URL('../tools/lib/synonyms.json', import.meta.url), 'utf8')); } catch { /* 缺文件就不展示 */ }
        return { ...base, __builtins: { synonyms } };
      },
      saveBiliConfig(patch: Record<string, unknown>): string | undefined {
        try {
          const path = biliConfigPath_();
          let current: any = { guard: { dryRun: true }, bilibili: {} };
          if (existsSync(path)) { try { current = JSON.parse(readFileSync(path, 'utf8')); } catch {} }
          const merged = deepMerge_(current, patch);
          // preferences.synonyms 是「整表」语义：导入/清空要能删掉旧话题，而 deepMerge_ 只合并不删键。
          // 调用方（控制台的同义词卡、JSON 导入）提交的都是完整对象，所以这里直接替换。
          const nextSynonyms = (patch as { preferences?: { synonyms?: unknown } })?.preferences?.synonyms;
          if (nextSynonyms !== undefined) {
            merged.preferences = { ...(merged.preferences ?? {}), synonyms: nextSynonyms };
          }
          writeFileSync(path, JSON.stringify(merged, null, 2), 'utf8');
          return undefined;
        } catch (error) { return `保存 bili.config.json 失败：${error instanceof Error ? error.message : String(error)}`; }
      },
      readBiliCred(): unknown {
        const path = biliCredPath_();
        if (!existsSync(path)) return { SESSDATA: '', bili_jct: '', buvid3: '', _exists: false };
        try {
          const raw = JSON.parse(readFileSync(path, 'utf8'));
          return {
            SESSDATA: typeof raw.SESSDATA === 'string' ? raw.SESSDATA : '',
            bili_jct: typeof raw.bili_jct === 'string' ? raw.bili_jct : '',
            buvid3: typeof raw.buvid3 === 'string' ? raw.buvid3 : '',
            _exists: true,
            _updatedAt: existsSync(path) ? new Date(statSync(path).mtimeMs).toISOString() : undefined,
          };
        } catch { return { SESSDATA: '', bili_jct: '', buvid3: '', _exists: false }; }
      },
      saveBiliCred(patch: Record<string, unknown>): string | undefined {
        try {
          const dir = biliRoot_();
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
          const path = biliCredPath_();
          let current: any = {};
          if (existsSync(path)) { try { current = JSON.parse(readFileSync(path, 'utf8')); } catch {} }
          const merged = { ...current };
          for (const key of ['SESSDATA', 'bili_jct', 'buvid3']) {
            if (patch[key] !== undefined && typeof patch[key] === 'string') merged[key] = patch[key];
          }
          writeFileSync(path, JSON.stringify(merged, null, 2), 'utf8');
          return undefined;
        } catch (error) { return `保存 credentials.json 失败：${error instanceof Error ? error.message : String(error)}`; }
      },
      readBiliComment(): BiliCommentState { return readBiliCommentState(); },
      /** 评论记录页：读 jsonl（新的在前，只含真实发出的尝试）。 */
      readBiliCommentLog(days: string, limit: string) {
        return readCommentLog(worldDir, { days: Number(days) || 7, limit: Number(limit) || 100 });
      },
      /** 删除一条记录：先删 B 站评论，再删本地行；返回失败原因（成功 undefined）。 */
      async deleteBiliComment(id: string): Promise<string | undefined> {
        const result = await deleteCommentLogEntry(worldDir, id);
        sources.invalidate();
        return result.ok ? undefined : result.why;
      },
      async saveBiliComment(patch: { enabled?: boolean; allowWrite?: boolean; dailyMax?: number; skipChance?: number }): Promise<string | undefined> {
        const file = biliConfigPath_();
        let current: any = {};
        if (existsSync(file)) { try { current = JSON.parse(readFileSync(file, 'utf8')); } catch {} }
        const next = { ...(current.comment ?? {}) };
        const hard = Number(config.comment?.hardDailyMax ?? 5);
        // 两个开关都属于主配置：能拿到配置编辑器就改对应那一行（与设置页保存插件配置同一条路）
        if (patch.enabled !== undefined || patch.allowWrite !== undefined) {
          const entry = configEditor?.entries().find(row => row.options.name === 'dsh-world-bili');
          if (!configEditor || !entry) return '宿主没有配置编辑器：请手改 profile 的 cordis.patch.yml 里的 comment.enabled / dailyBili.allowWrite';
          try {
            await configEditor.edit(entry, raw => {
              const base = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
              const out: Record<string, unknown> = { ...base };
              if (patch.enabled !== undefined) out.comment = { ...((base.comment as Record<string, unknown> | undefined) ?? {}), enabled: patch.enabled };
              if (patch.allowWrite !== undefined) out.dailyBili = { ...((base.dailyBili as Record<string, unknown> | undefined) ?? {}), allowWrite: patch.allowWrite };
              return out;
            });
            if (patch.enabled !== undefined) next.enabled = patch.enabled;
            if (patch.allowWrite !== undefined) next.allowWrite = patch.allowWrite;
          } catch (error) { return `写主配置失败：${errorText(error)}`; }
        }
        // 条数被硬上限钳制；概率夹到 0–1
        if (patch.dailyMax !== undefined) next.dailyMax = hard > 0 ? Math.min(patch.dailyMax, hard) : patch.dailyMax;
        if (patch.skipChance !== undefined) next.skipChance = Math.max(0, Math.min(1, patch.skipChance));
        current.comment = next;
        try { writeFileSync(file, JSON.stringify(current, null, 2), 'utf8'); }
        catch (error) { return `保存 bili.config.json 失败：${errorText(error)}`; }
        sources.invalidate();
        return undefined;
      },
      readBiliHistory(days: string): unknown { return readBiliHistory(biliRoot_(), days); },
      setBiliMood(value: number): unknown {
        try { const r = setBiliMood(value); sources.invalidate(); return r; }
        catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
      },
      feedBili(level?: number): unknown {
        try { const r = feedBili(level); sources.invalidate(); return r; }
        catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
      },
      setSchedule: next => { power.setSchedule(next); life?.reschedule(); sources.invalidate(); },
      async setModules(patch) {
        if (patch.wechat !== undefined && !config.wechat) return '没有配置微信模块（配置里 wechat: true）';
        if (patch.qq !== undefined && !config.qqNative?.enabled) return '没有配置原生 QQ 通道（配置里 qqNative.enabled）';
        const change = patch.qq === undefined ? qqChange : ++qqChange;
        let restartRequired = false;
        if (patch.qq === true) {
          try { restartRequired = await qqSdk.ensure(); sdkAbort.signal.throwIfAborted(); faults.clear('qq-sdk'); }
          catch (error) { const message = `QQ 依赖安装失败：${errorText(error)}`; faults.set('qq-sdk', message); return message; }
          if (change !== qqChange) return 'QQ 开关已被更新，本次安装不会重新开启 QQ';
        }
        power.setModules(patch);
        try {
          if (patch.wechat === false) await stopWechat();
          if (patch.wechat === true && life) await startWechat(life);
          if (patch.qq === false) stopQqNative();
          if (patch.qq === true && life && !restartRequired) await startQqNative(life);
          if (patch.qq === true && life && !restartRequired && !qqNative) return 'QQ 模块没能启动，请查看健康状态';
        } catch (error) { faults.set('wechat', `微信模块没能切换：${errorText(error)}`); lifeCtx.logger.error(error); return `切换失败：${errorText(error)}`; }
        finally { sources.invalidate(); }
        faults.clear('wechat');
        if (restartRequired) return { restartRequired: true, message: 'SnowLuma SDK 已安装。请重启 DSH，QQ 会按已保存的开关启用。' };
        return undefined;
      },
      restartWechatAdapter: async () => { if (!adapter) return false; try { await adapter.restart(); } finally { sources.invalidate(); } return true; },
      setWechatSettings: next => { power.setWechat(next); sources.invalidate(); },
      setArchiveScope: scope => { power.setArchiveScope(scope); sources.invalidate(); return power.restartRequired(); },
      saveWorldPrompt: text => { if (text.trim()) durableWrite(worldPromptFile, text); else rmSync(worldPromptFile, { force: true }); },
    };
    lifeCtx.effect(() => webServer.register(consoleRoute(sources, actions, config.allowedHosts)), 'dsh-world console routes');
    if (power.running()) await startLife(false);
  });
}
