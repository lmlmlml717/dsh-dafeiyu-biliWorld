// dailyBili —— 自由模式：用 night-plan 随机窗口唤醒 home session，
// 注入 mood（情绪+饥饿）+ stateBlock（当下状态）+ distract（走神），
// 让 agent 自己 focus 定 bilibili/rest，然后跑 feed → debrief → act dyn。
//
// 与 world 原定时器（alarmTimer.ts）的区别：
//   world 原定时器：固定时间 + 通用 prompt（"闹钟响了"）+ 指数退避重试 + 持久化到 life.json
//   dailyBili：night-plan 随机窗口 + skipChance 概率跳过 + mood 拟人化 + focus 自主活动
//              plan 状态持久化到 plan.json，进程重启无缝续上
//
// 复用：
//   tools/lib/night-plan.mjs —— dsh-feiyu / dsh-bili-whale（MIT，纯函数）
//   tools/lib/mood.mjs        —— dsh-feiyu（MIT，情绪状态机）
//   tools/lib/focus.mjs       —— dsh-feiyu（MIT，精简版只留 bilibili/rest）
//
//   src/bili/dailyBili.ts
//
// 导出：biliNightConfig / scheduleStillFits / biliPrompt 三个纯函数（可单测）与 createDailyBili 定时器工厂。
// 被谁调用：index.ts 组装 DailyBiliOptions/Deps 后创建，并把 triggerNow/replan/busy 暴露给控制台。
// 依赖：tools/lib 下的 night-plan/mood/focus/ledger/session-limit（动态 import，缺了会兜底）与 life/alarm.ts 的 nextLocalTime。
// 坑：工具链没装好时静默降级到固定 dailyTime；plan.json 写失败只吞掉，重启后会按“今天没计划”重排。
//
// 【链路位置】B 站这条链路的宿主侧最上游：世界主配置（dailyBili.enabled / dailyTime / dailyMaxVideos /
// dailyBili.allowWrite，以及 world.json 里的 wakeTime / reviewTime）由 index.ts 的 apply 读成
// DailyBiliOptions，再交给本文件的 createDailyBili；arm() 按 night-plan 在作息窗口里抽一个时刻，
// 到点 fire() 把 prompt 用 steer 投进家会话，之后由她在会话里跑 tools/bili.mjs。
// 上游调用方：index.ts（startLife 建、stopLife 停；控制台「立即触发 / 重排」经 triggerNow / replan 进来）。
// 下游：tools/lib 的 night-plan / mood / focus / ledger / session-limit（动态 import，缺了兜底）与
//      life/alarm.ts 的 nextLocalTime；prompt 点名 deps → feed → debrief → act dyn，额度闸与账本由 act 内部过。
// 读写：<world>/bili/plan.json（调度状态，读失败当空、写失败只吞）；mood.json 与账本简报只经 tools/lib 读写。
// 不在这一环：选题、深读、发布、额度闸都在 tools/ 里；本文件只决定「什么时候叫醒她、把哪些上下文拼进 prompt」。
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { formatLocalTime } from '../timeContext.ts'
import { nextLocalTime } from '../life/alarm.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = path.resolve(__dirname, '..', '..')
const TOOLS_LIB_DIR = path.join(PLUGIN_ROOT, 'tools', 'lib')

/** 每天最多触发几次：工具链 night-plan 的硬上限就是 12（单窗口与全天总量都被夹在 12），这里跟着一致。 */
export const MAX_WAKES_PER_DAY = 12
/** 最小间隔（分钟）的可用范围；工具链内部还会再兜一个“至少 1 分钟”。 */
export const MIN_GAP_MIN = 1
/** 最小间隔（分钟）的取值上限；再大就排不进一个夜晚窗口。 */
export const MIN_GAP_MAX = 240

// 配置值可能来自手改的 JSON：先转数字，非有限值用 fallback，再按整数夹到 [min, max]。
const clampInt = (value: unknown, min: number, max: number, fallback: number): number => {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

// 调用链：arm() 里 `biliNightConfig(libs.readConfig(), options.wakeTime, options.reviewTime)`，
// 其中 readConfig() 是 tools/lib/config.mjs 的 config()（内置默认值 + bili.config.json 深合并，不缓存）。
// 参数：cfg 可缺省（读失败传 {}），wakeTime / reviewTime 是世界主框架的 HH:MM，空串按 20:00 / 24:00。
// 返回：night-plan 要的 { windows, skipChance, minGapMin, maxVideos }；不做 IO、不抛错，非法值全部夹回默认。
// 【上游参考】dsh-bili-whale / dsh-feiyu 的 night-plan 只认 windows；这里把唯一窗口定成 world 的
// wakeTime → reviewTime，让「作息只在世界面板改一处」，bili.config.json 的 night.windows 不再是第二份真相。
/**
 * 从 `bili.config.json` 组装 night-plan 的窗口配置（可单测的纯函数）。
 *
 * - 窗口只有一条：world 主框架的 `wakeTime → reviewTime`（唯一真相源，不让 bili.config.json 覆盖）；
 * - `night.wakesPerDay`（默认 1，夹 1..12）决定这个窗口里最多排几次；
 * - `night.minGapMin`（默认 10，夹 1..240）决定两次触发之间最早隔多久；
 * - `skipChance` / `maxVideos` 照旧。
 */
export function biliNightConfig(cfg: any, wakeTime: string, reviewTime: string): {
  windows: { start: string; end: string; wakes: number }[]
  skipChance: number
  minGapMin: number
  maxVideos: number
} {
  return {
    windows: [{
      start: wakeTime || '20:00',
      end: reviewTime || '24:00',
      wakes: clampInt(cfg?.night?.wakesPerDay, 1, MAX_WAKES_PER_DAY, 1),
    }],
    skipChance: Number.isFinite(Number(cfg?.night?.skipChance)) ? Number(cfg?.night?.skipChance) : 0.3,
    minGapMin: clampInt(cfg?.night?.minGapMin, MIN_GAP_MIN, MIN_GAP_MAX, 10),
    // 保持原行为：这个值只是“候选池抓多少条”，代码里不夹（现有配置里有 200 这种值）。
    maxVideos: Number.isFinite(Number(cfg?.night?.maxVideos)) ? Math.max(1, Math.round(Number(cfg?.night?.maxVideos))) : 5,
  }
}

// 调用链：arm() 用它判断 plan.json 里那条计划还能不能沿用（`scheduleStillFits(...) && atMs > now`）。
// 参数：plan 是 plan.json 读出的对象（可能为 {}）、nightCfg 是 biliNightConfig 的返回、
//       now 是当前毫秒、nightPlan 是 tools/lib/night-plan.mjs（缺函数时这里返回 false，不抛错）。
// 返回：true 表示窗口与每天次数都没变、计划仍 pending 且落在当前窗口里；false 让 arm() 重排。
// 失败：nightPlan.occurrences 缺省时 keys 为空数组 → false；异常会冒泡到 arm() 的兜底分支。
/**
 * 已经写进 `plan.json` 的那条计划还能不能沿用：窗口没变、且“每天次数”没变。
 *
 * 不能沿用的三种情况：计划已触发/过期（`isPending` 为假）、用户把起床/回顾时间改了
 * （windowKey 不在当前配置的窗口里）、用户把每天次数改了（旧计划按旧次数排的）。
 * 这三种都要重排——否则会按旧窗口或旧次数跑完今天。
 * 另外 `arm()` 还要求 `atMs` 还没过；过了说明这次被错过（重启晚了/睡过头），也重排下一次。
 */
export function scheduleStillFits(
  plan: any,
  nightCfg: { windows: { start: string; end: string; wakes: number }[] },
  now: number,
  nightPlan: any,
): boolean {
  if (!plan || typeof nightPlan?.isPending !== 'function' || !nightPlan.isPending(plan, now)) return false
  if (Number(plan.wakesPerDay) !== nightCfg.windows[0]!.wakes) return false
  const keys: string[] = nightPlan.occurrences?.(nightCfg, now)?.map((w: any) => w.key) ?? []
  return keys.includes(plan.windowKey)
}

/** dailyBili 运行时配置（从 index.ts 组装）。 */
export interface DailyBiliOptions {
  /** 主开关：false 时 fire() 只重新排期，不投递 prompt。 */
  enabled: () => boolean
  /** 工具链模块加载失败时的兜底触发时刻（HH:MM）。 */
  dailyTime: string
  dailyMaxVideos: number             // world 主配置 dailyBili.dailyMaxVideos —— 每日硬上限，跨 fire 持久化
  /** NapCat 的 OneBot HTTP 根地址，用来把动态摘要发给主人。 */
  napcatHttp: string
  /** 主人 QQ；不配就不发 QQ。 */
  ownerQQ?: string
  /** 是否允许对外写；false 时 prompt 里明确让 agent 干跑。 */
  allowWrite: boolean
  /** 工具链入口 bili.mjs 的绝对路径，会拼进 prompt 交给 agent 执行。 */
  biliMjs: string
  /** plan.json 所在目录（世界的 data 目录）。 */
  dataDir: string
  wakeTime: string                   // world 主框架 "早上几点"（唯一真相源）
  reviewTime: string                 // world 主框架 "回顾几点"（唯一真相源）
}

/**
 * createDailyBili 的依赖：配置、家会话、投递后的 flush、日志与时钟。
 * 全部由 index.ts 注入；测试可以换 clock 和 home，不碰真实定时器。
 */
export interface DailyBiliDeps {
  options: DailyBiliOptions
  /** 取当前家会话；世界停止或会话未就绪时由调用方抛错。 */
  home: () => Promise<Agent>
  /** 投递后把会话刷到磁盘；定时器不关心它返回什么。 */
  flush: (agent: Agent) => Promise<unknown>
  /** 只要求 warn；info 可缺省，用来记录 plan/arm 轨迹。 */
  logger: { warn: (s: string) => void; info?: (s: string) => void }
  /** 世界时区（IANA 名），用于把本地时刻算成 Date。 */
  timeZone: string
  /** 可注入时钟；默认 new Date()，测试用它跳过真实等待。 */
  clock?: () => Date
}

/**
 * 定时器的对外接口：启动/停止、立即触发、按新配置重排、查询是否正在投递。
 * 方法本身不抛错：失败只记 warning，调度器继续活着。
 */
export interface DailyBili { start(): void; stop(): void; triggerNow(): Promise<void>; replan(): void; busy(): boolean }

type LazyLibs = {
  nightPlan: any
  mood: any
  focus: any
  sessionLimit: any
  readConfig: () => any
}

/**
 * 懒加载工具链模块。ESM 里不能用 require()，所以用动态 import()。
 * 工具链可能还没装好（tools/*.mjs 被人删了），所以 try-catch 兜底。
 */
let lazyPromise: Promise<LazyLibs | null> | null = null

// 动态 import 只成功一次：失败也缓存 null（重启后才会重新尝试），避免每次 arm 都重复撞同一批缺失文件。
async function loadLibs(): Promise<LazyLibs | null> {
  if (lazyPromise) return lazyPromise
  lazyPromise = (async () => {
    try {
      const baseUrl = pathToFileURL(TOOLS_LIB_DIR + path.sep).href
      const [np, md, fc, cf, sl] = await Promise.all([
        import(baseUrl + 'night-plan.mjs'),
        import(baseUrl + 'mood.mjs'),
        import(baseUrl + 'focus.mjs'),
        import(baseUrl + 'config.mjs'),
        import(baseUrl + 'session-limit.mjs'),
      ])
      return {
        nightPlan: np,
        mood: md,
        focus: fc,
        sessionLimit: sl,
        readConfig: () => cf.config(),
      } as LazyLibs
    } catch {
      return null
    }
  })()
  return lazyPromise
}

function planPath(dataDir: string) {
  return path.join(dataDir, 'plan.json')
}

// plan.json 是调度器的唯一持久状态；读失败按空对象处理，写失败只吞掉（下一次 arm 会重排）。
function readPlan(dataDir: string): any {
  try { return JSON.parse(fs.readFileSync(planPath(dataDir), 'utf8')) } catch { return {} }
}
function writePlan(dataDir: string, state: any): void {
  try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(planPath(dataDir), JSON.stringify(state, null, 2) + '\n') } catch {}
}

// 调用链：只由 fire() 调用，拼好的文本经 createUserMessage 交给 agent.steer。
// 参数：now 是投递时刻（取 HH:MM 用）；o 是 DailyBiliOptions（biliMjs / dailyMaxVideos / allowWrite /
//       ownerQQ / napcatHttp 都会写进正文）；tz 是世界时区；planState 是已兑现的 plan（action='skip' 时
//       正文改成「歇着吧」）；extraBlocks 是 mood / focus / 账本 / session 名额这些可选增强块。
// 返回：多行字符串；所有增强块都可缺省，extraBlocks 不传时只输出固定的流程说明。
// 失败：纯字符串拼接，不读盘、不请求网络，不会抛错。
// 【上游参考】分享标尺来自 bili-whale：低于 bilibili.share.minScore 的视频不值得转，分数不够不发也是合法结果，
// act dyn 的 --score 必须过这一关；---BILI_ACTION--- 打分块是本实现加的，debrief 输出、她填 0–20 的整数。
// 提示词里「先不带 --go 干跑、确认后再 --go」对应工具链的分层写闸：dailyBili.allowWrite（评论的真发总开关）、
// guard.dryRun（默认干跑）、额度（quota.check）、风控（最小间隔、复读、-412 熔断），具体次序见 tools/。
/** 她的专注只剩这么多分钟时，这一次唤醒直接跳过：快收工的人被叫，只会觉得在催她。 */
export const SKIP_FOCUS_LEFT_MIN = 5

/**
 * 这次唤醒要不要跳过 —— 只因为「她正在专注、且快结束了」。
 * @param snap focus.focusSnapshot() 的结果；没有专注、已过期或没数字都放行
 * @param threshold 剩多少分钟内算「快结束」，默认 SKIP_FOCUS_LEFT_MIN
 * @returns 跳过原因（写日志用）；不该跳过时返回 null
 */
export function shouldSkipWake(
  snap: { activity?: string; expired?: boolean; remainMin?: number } | null | undefined,
  threshold = SKIP_FOCUS_LEFT_MIN,
): string | null {
  if (!snap?.activity || snap.expired) return null
  const left = Number(snap.remainMin)
  if (!Number.isFinite(left)) return null
  return left <= threshold ? `她的专注还剩 ${left} 分钟` : null
}

/** 构造"到点了，今天你自己挑事"的完整 prompt（纯同步，不依赖工具链模块）。 */
// 提示词只给「做什么」和「怎么说」，不给窗口/名额/账本这类机器数字：数字一旦进来，她就会当台词念给主人听。
export function biliPrompt(now: Date, o: DailyBiliOptions, tz: string, planState: any, extraBlocks?: {
  stateBlock?: string; distract?: string; focusLine?: string
}): string {
  const time = formatLocalTime(now, tz).slice(11, 16)
  const dry = o.allowWrite ? '' : '\n（注意：当前是干跑，对外发的操作只打印不真发。确认没问题后把 bili.config.json 的 guard.dryRun 改 false，或 dailyBili.allowWrite 改 true。）'
  // QQ 段只在她有主人 QQ 时出现。0.8.23：删掉 NapCat POST。0.8.25（方案 B）：分享这类东西有了自己的命令
  // —— `share` 把「标题 + BV + 你想说的那句」放进队列，宿主 qqNative 私聊发出去，比「靠最后一句转发」确定。
  // 整轮转发那条线还在：0.9.3 之后只转 B 站唤醒这一种（正是这一轮），所以还是「她的话」+「那条视频」两条，
  // 互不冲突；闹钟、回顾那些轮次不再转发。
  const qq = o.ownerQQ
    ? `\n（想让我也看这条：\`node ${o.biliMjs} share --bvid <BV> --say "<你想说的那句>"\` 递给我——我收到的是标题和 BV。`
      + `怎么想的照常说，别为了分享把话变成汇报。纯文字动态不用发我，你自己记着就行。）`
    : ''

  const stateBlock = extraBlocks?.stateBlock ? extraBlocks.stateBlock + '\n\n' : ''
  const distract = extraBlocks?.distract ?? ''
  const focusLine = extraBlocks?.focusLine ?? ''

  // 计划明确说跳过时才提一句；正常情况下不报「第几次/窗口」，那是调度器的内部状态。
  const planLine = planState?.action === 'skip'
    ? `（今天不想刷就歇着，不用真的去刷 B站。）\n\n`
    : ''

  return [
    `现在 ${time}。想起来就看一眼，不想看就继续手上的事。${focusLine}${planLine}${stateBlock}`,
    distract,
    // 操作备忘压成一小段：命令还在，但不做成「1) 2) 3)」的工单，念出来不像在交作业。
    // 开头先声明「不是任务清单」：世界提示词写着「有话说才发、不凑数」，这里不能又变成「每条都要处理」。
    `（操作备忘，不是任务清单：不用每条都发、不用汇报、不用把命令返回贴出来，有感觉才写。`,
    ` 想刷就先 \`node ${o.biliMjs} focus bilibili --min 40 --note "今天想看看什么"\`；`,
    ` 然后 \`feed --json\` 选题、\`debrief --bvid <BV>\` 看一眼，觉得值得就 \`act dyn --bvid <BV> --text "<文案>" --score <0-20>\`，`,
    ` 先不带 --go 干跑一遍，确认再 --go；纯文字动态用 \`act dyn --text "<文案>"\`。`,
    ` 发不出去就跳过，不用管为什么。）`,
    // 0.8.19：把「看」和「发」拆开。以前第 5 步要求发完再讲，等于看到什么都得先发一条动态；
    // 现在只看不发也成立——看是输入，发是输出，两件事。
    `（只看不发也行：不想发动态就直接回来说；发 B站动态和跟我分享是两件事，不用绑在一起。）`,
    dry,
    '',
    `看完回来要是想说话，就像跟朋友讲一样：先说哪条视频（标题或 UP），再说你看到的那一下和当时的反应。`,
    `两三句，不用列 BV、不用报今天做了几件事；不想说就歇着，也没关系。`,
    '',
    `像这样：「刷到一个叫〈XX〉的视频（UP：YYY），他把整只鸡塞进烤箱，最后端出一只鞋。我笑到呛住。」`,
    `不要这样：「这个我也看了，挺有意思的。」——只说"这个"，我这边根本不知道是哪条。`,
    qq,
  ].filter(Boolean).join('\n')
}

// 调用链：index.ts 的 startLife 在生活线 start() 之后调用它，把返回的 DailyBili 存进闭包；stopLife 调 stop()，
// 控制台走 triggerNow() / replan()，状态卡读 busy()。
// 参数 deps：options 见 DailyBiliOptions；home 取家会话（世界没起或会话未就绪时由它抛错）；
//       flush 把会话刷盘；logger 只需 warn；timeZone 用于本地时刻；clock 可注入（测试用）。
// 返回：DailyBili 的五个方法，方法本身不主动抛错（失败只记 warning，调度器继续活着）。
// 空值：不传 clock 时用 new Date()；logger.info 缺省时所有轨迹日志静默跳过。
/**
 * 创建 B 站自由模式定时器：按 night-plan 随机窗口唤醒家会话，投递 prompt 后由 agent 自己决定刷还是歇。
 * @param deps 配置、家会话、flush、日志、时区与可注入时钟
 * @returns 定时器接口；start() 后才开始排期，stop() 可重复调用
 */
export function createDailyBili(deps: DailyBiliDeps): DailyBili {
  const { options, home, flush, logger, timeZone } = deps
  const clock = deps.clock ?? (() => new Date())
  let timer: NodeJS.Timeout | null = null
  let stopped = false
  let running = false
  /** 下一次到点只是“重新排期”，不投递 prompt（今天的次数已经用完时）。 */
  let rearmOnly = false

  // 调用链：start() 首次进入；fire() 结束时再排下一次；replan()（控制台改完次数/间隔）带 force 重抽；
  // 算出的时刻已过去时 5 秒后自调一次；stop() 之后直接返回，不再排期。
  // 副作用：读写 plan.json；正常路径最后把下一次 setTimeout 挂到 timer 上（rearmOnly 时只重排、不投递），
  // 算出的时刻已过去时只排一次 5 秒后的重算。失败：缺工具链记 warning 并用固定 dailyTime；plan 抛错同样兜底。
  /**
   * arm：算出下一次时刻。
   *
   * - `force = true`（控制台改完次数/间隔后）：丢掉还没触发的 pending 计划，重抽一个时刻；
   * - 正常情况：`plan.json` 里那条计划仍然适用（窗口没变、每天次数没变）就沿用，否则重排；
   * - 今天次数用完（makePlan 返回 done）：不再用 dailyTime 兜一次 fire，而是排到次日 00:01 只重新 arm。
   */
  async function arm(force = false): Promise<void> {
    if (stopped || timer) return
    let at: Date
    rearmOnly = false
    try {
      // 工具链没装好时静默降级：下面的 else 用固定 dailyTime，保证世界每天至少被叫一次。
      const libs = await loadLibs()
      if (libs) {
        // 【上游参考】night-plan 的采样方式（bili-whale / dsh-feiyu 原样复用）：窗口内按剩余次数等分，
        // 只在第一段里随机落点，skipChance 决定这次是 wake 还是 skip；minGapMin 保证两次之间隔开。
        // ── nightCfg 构造：窗口从 world 主框架 wakeTime/reviewTime 推导（不再读 bili.config.json 的 night.windows）──
        let nightCfg: ReturnType<typeof biliNightConfig> = { windows: [{ start: '20:00', end: '24:00', wakes: 1 }], skipChance: 0.3, minGapMin: 10, maxVideos: 5 }
        try {
          nightCfg = biliNightConfig(libs.readConfig(), options.wakeTime, options.reviewTime)
        } catch {}

        // plan.json 里可能留着上一次进程的计划；能不能沿用由 scheduleStillFits 判断。
        const now = clock().getTime()
        const currentPlan = readPlan(options.dataDir)
        // 计划时间已经过去但还没触发（DSH 重启晚了/机器睡过头）也算“不能沿用”：重排下一次。
        // 旧代码只看 isPending（endsAt 还没到）就沿用，会 setTimeout 一个负数，之后每 5 秒空转。
        const reusable = scheduleStillFits(currentPlan, nightCfg, now, libs.nightPlan) && Number(currentPlan.atMs) > now
        if (!force && reusable) {
          at = new Date(currentPlan.atMs)
        } else {
          // 重排：还没触发的旧计划先标记成已处理，保留今天的 usedCount / wakes，再让 makePlan 重抽。
          const base = libs.nightPlan.isPending(currentPlan, now) ? { ...currentPlan, fired: true } : currentPlan
          const plan: any = libs.nightPlan.makePlan(nightCfg, base, now)
          if (plan.done) {
            // 今天排不下了（次数用完 / 窗口放不下）：次日 00:01 重新算，不投递 prompt。
            at = nextLocalTime(clock(), '00:01', timeZone)
            rearmOnly = true
            logger.info?.(`[dailyBili] 今天不再触发（${plan.reason}），明天 ${formatLocalTime(at, timeZone).slice(11, 16)} 重排`)
          } else {
            writePlan(options.dataDir, { ...plan, wakesPerDay: nightCfg.windows[0]!.wakes })
            at = new Date(plan.atMs)
            logger.info?.(`[dailyBili] plan → ${plan.atText}（${plan.action}，${plan.withinWindow ?? ''}）`)
          }
        }
      } else {
        logger.warn('[dailyBili] 工具链模块加载失败，兜底 dailyTime')
        at = nextLocalTime(clock(), options.dailyTime, timeZone)
      }
    } catch (err) {
      logger.warn(`[dailyBili] plan 算失败，兜底 dailyTime：${String((err as Error).message ?? err).slice(0, 80)}`)
      at = nextLocalTime(clock(), options.dailyTime, timeZone)
    }

    const ms = at.getTime() - clock().getTime()
    // 算出来的时刻已经过去（时钟回拨或重排太慢）：5 秒后再算，不能 setTimeout 负数（会被当成 0 立即触发）。
    if (ms < 0) { setTimeout(() => { void arm() }, 5_000); return }
    // rearmOnly 的定时只重新排期、不投递；这样今天次数用完也不会在 dailyTime 多 fire 一次。
    timer = setTimeout(() => { timer = null; if (rearmOnly) { rearmOnly = false; void arm() } else { void fire() } }, ms)
    logger.info?.(`[dailyBili] arm → ${formatLocalTime(at, timeZone).slice(11, 16)}${rearmOnly ? '（仅重排）' : ''}`)
  }

  // 调用链：setTimeout 到期（arm 里挂的）或控制台的 triggerNow() 直接调；收尾时自己再 arm()。
  // 参数：无；要用的东西都在 deps 与 plan.json 里。返回：Promise<void>，失败只记 warning。
  // 时序：running 置真 → 取家会话 → 兑现 plan（completePlan 写回）→ 依次尝试 mood / focus / 账本简报 /
  // session 名额（每项独立 try，失败只跳过该项）→ 拼 prompt → agent.steer → flush → 排下一次。
  // 空值/边界：上一轮还没投完时 60 秒后再排；enabled() 为假时只 arm 不投递；home() 抛错按投递失败记。
  /** 投递 prompt → home session → flush。 */
  async function fire(): Promise<void> {
    if (stopped) return
    // 上一轮还没投递完（正常只会持续几百毫秒）：别把调度器停在“没有 timer”的状态。
    if (running) { setTimeout(() => { if (!stopped && !timer) void arm() }, 60_000); return }
    // 关掉时也继续排下一次：用户可能中途打开，不能把调度器停在“没有 timer”的状态。
    if (!options.enabled()) { await arm(); return }
    running = true
    try {
      const agent = await home()

      // 完成这次 plan + 注入 mood/focus 块
      // 这一整段都是增强信息：mood/focus 任何一项失败都只跳过该项，不挡住唤醒。
      let planState: any = {}
      const extra: { stateBlock?: string; distract?: string; focusLine?: string } = {}
      // 0.8.18：如果她正处在"快收工的专注"里，这次不投递（原因写进日志），但 finally 照常排下一次。
      let skipBecause = ''
      try {
        const libs = await loadLibs()
        if (libs) {
          // 0.8.25 修：先看她是不是快收工，**再**兑现计划。
          // 以前先 completePlan 再判 shouldSkipWake，于是"不打断她"的那一次照样被记成用掉一次唤醒——
          // 当天实际叫醒次数会比配置少，而且少的那几次没有任何痕迹。
          try {
            const snap = libs.focus.focusSnapshot()
            const skip = shouldSkipWake(snap)
            if (skip) skipBecause = skip
            // 不写"还剩 N 分钟 / 到点了"：倒计时会把"窗口自己亮了"读成"你在催我"。
            else if (snap.activity && !snap.expired) {
              extra.focusLine = `（你上次说要${snap.label}，还没做完也没关系${snap.note ? `：「${snap.note}」` : ''}。）`
            }
          } catch {}

          // 跳过的这一次不兑现、也不动心情：计划保持 pending，arm() 会重排，次数留给后面。
          if (skipBecause) {
            logger.info?.(`[dailyBili] 本次跳过：${skipBecause}（不打断她，这次不算用掉）`)
          } else {
            const current = readPlan(options.dataDir)
            if (!current.fired && libs.nightPlan.isPending(current, clock().getTime())) {
              const done = libs.nightPlan.completePlan(current, clock().getTime())
              writePlan(options.dataDir, done)
              planState = done
            } else {
              planState = current
            }

            // 【上游参考】mood / focus 都来自 dsh-feiyu 的 tools/lib：tickMood 每次 fire 推进一步心情与饥饿度，
            // stateBlock 输出状态块，distract 给一句走神；focus 是她自己上一次用 `focus bilibili` 定的活动。
            try {
              libs.mood.tickMood()
              extra.stateBlock = libs.mood.stateBlock(0, 'bilibili')
              extra.distract = libs.mood.distract()
            } catch {}

            // 账本不再进提示词：她读不到数字就不会把「今天花了多少 / 额度还剩几条」当台词说给我听。
            // 对账留在 CLI（quota show / ledger report）和控制台「历史账本」里，是主人看的东西。

            try {
              const cfg = libs.readConfig()
              // 只借 resetSession 的副作用：它把本次可用条数写进 session.json，act 的 checkSession 靠这份状态拦超发。
              // 数字本身不再进提示词 —— 她看不到「本次 N 条」，也就不会把额度当台词。
              libs.sessionLimit?.resetSession?.(cfg, {
                wakeTime: options.wakeTime,
                reviewTime: options.reviewTime,
                dailyMaxVideos: options.dailyMaxVideos,
              })
            } catch {}
          }
        } else {
          planState = readPlan(options.dataDir)
        }
      } catch {
        planState = readPlan(options.dataDir)
      }

      // 她快收工了：不投递，计划也没兑现（上面跳过分支不写 plan.json），下一次 arm 会重排。
      if (skipBecause) return

      // 用 steer 而不是新开 turn：家会话正在跑时也能把这条提醒插进当前对话。
      const prompt = biliPrompt(clock(), options, timeZone, planState, extra)
      const message = createUserMessage({ source: { kind: 'dsh-world-life', lifeKind: 'bili-wake' }, content: [{ type: 'text', text: prompt }] })
      agent.steer(message)
      await flush(agent)
      logger.info?.(`[dailyBili] prompt 已投递（${planState.action ?? 'wake'}），等 agent 开始跑`)
    } catch (err) {
      logger.warn(`[dailyBili] 投递失败：${String((err as Error).message ?? err).slice(0, 120)}`)
    } finally {
      running = false
      await arm()
    }
  }

  // 对外接口：start 只排期（不立即投递）；stop 幂等，停掉后不再排；triggerNow 复用 fire 的整条链路；
  // busy 只表示本次 fire 是否还在投递，调度器排没排下一次不在其中；replan 丢掉 pending 计划按新配置重抽。
  return {
    start() { void arm() },
    stop() {
      stopped = true
      if (timer) { clearTimeout(timer); timer = null }
    },
    triggerNow() { return fire() },
    /** 本次 fire 是否还在投递（控制台据此禁用「立即触发」）；调度器是否排好下一次不在这里。 */
    busy() { return running },
    /** 控制台改完「每天次数 / 最小间隔」后调用：丢掉 pending 计划，立刻按新配置重抽时刻。 */
    replan() {
      if (stopped) return
      if (timer) { clearTimeout(timer); timer = null }
      void arm(true)
    },
  }
}
