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
export const MIN_GAP_MAX = 240

const clampInt = (value: unknown, min: number, max: number, fallback: number): number => {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

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
  enabled: () => boolean
  dailyTime: string
  dailyMaxVideos: number             // world 主配置 dailyBili.dailyMaxVideos —— 每日硬上限，跨 fire 持久化
  napcatHttp: string
  ownerQQ?: string
  allowWrite: boolean
  biliMjs: string
  dataDir: string
  wakeTime: string                   // world 主框架 "早上几点"（唯一真相源）
  reviewTime: string                 // world 主框架 "回顾几点"（唯一真相源）
}

export interface DailyBiliDeps {
  options: DailyBiliOptions
  home: () => Promise<Agent>
  flush: (agent: Agent) => Promise<unknown>
  logger: { warn: (s: string) => void; info?: (s: string) => void }
  timeZone: string
  clock?: () => Date
}

export interface DailyBili { start(): void; stop(): void; triggerNow(): Promise<void>; replan(): void; busy(): boolean }

type LazyLibs = {
  nightPlan: any
  mood: any
  focus: any
  ledger: any
  sessionLimit: any
  readConfig: () => any
}

/**
 * 懒加载工具链模块。ESM 里不能用 require()，所以用动态 import()。
 * 工具链可能还没装好（tools/*.mjs 被人删了），所以 try-catch 兜底。
 */
let lazyPromise: Promise<LazyLibs | null> | null = null

async function loadLibs(): Promise<LazyLibs | null> {
  if (lazyPromise) return lazyPromise
  lazyPromise = (async () => {
    try {
      const baseUrl = pathToFileURL(TOOLS_LIB_DIR + path.sep).href
      const [np, md, fc, cf, ld, sl] = await Promise.all([
        import(baseUrl + 'night-plan.mjs'),
        import(baseUrl + 'mood.mjs'),
        import(baseUrl + 'focus.mjs'),
        import(baseUrl + 'config.mjs'),
        import(baseUrl + 'ledger.mjs'),
        import(baseUrl + 'session-limit.mjs'),
      ])
      return {
        nightPlan: np,
        mood: md,
        focus: fc,
        ledger: ld,
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

function readPlan(dataDir: string): any {
  try { return JSON.parse(fs.readFileSync(planPath(dataDir), 'utf8')) } catch { return {} }
}
function writePlan(dataDir: string, state: any): void {
  try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(planPath(dataDir), JSON.stringify(state, null, 2) + '\n') } catch {}
}

/** 构造"到点了，今天你自己挑事"的完整 prompt（纯同步，不依赖工具链模块）。 */
export function biliPrompt(now: Date, o: DailyBiliOptions, tz: string, planState: any, extraBlocks?: {
  stateBlock?: string; distract?: string; focusLine?: string; ledgerBrief?: string;
  sessionTarget?: { watch: number; pure: number }
}): string {
  const time = formatLocalTime(now, tz).slice(11, 16)
  const dry = o.allowWrite ? '' : '\n（注意：当前是干跑，对外发的操作只打印不真发。确认没问题后把 bili.config.json 的 guard.dryRun 改 false，或 dailyBili.allowWrite 改 true。）'
  const qq = o.ownerQQ
    ? `\n\n6) 发完把动态的 1-2 句核心内容通过 QQ 发给主人（${o.ownerQQ}）：NapCat OneBot HTTP，POST ${o.napcatHttp}/send_private_msg`
    : ''

  const stateBlock = extraBlocks?.stateBlock ? extraBlocks.stateBlock + '\n\n' : ''
  const distract = extraBlocks?.distract ?? ''
  const focusLine = extraBlocks?.focusLine ?? ''
  const ledgerBrief = extraBlocks?.ledgerBrief ? `账本：${extraBlocks.ledgerBrief}\n\n` : ''

  const st = extraBlocks?.sessionTarget
  const stLine = st
    ? `（今天这次随机给了 ${st.watch} 条刷视频名额 + ${st.pure} 条纯动态名额；刷一条转一条，超了程序会拦。）\n\n`
    : ''

  const planLine = planState?.action === 'skip'
    ? `（${planState.reason ?? '今天 plan 跳过了'}\n不用真的去刷 B站，歇着吧。）\n\n`
    : `（今天这次是 ${planState?.withinWindow ?? ''}。）\n\n`

  return [
    `【B 站自由模式】现在 ${time}，到点了。${focusLine}${planLine}${stLine}${stateBlock}${ledgerBrief}`,
    distract,
    `做之前先定一下你现在要干嘛：`,
    `  · 想刷 B站：node ${o.biliMjs} focus bilibili --min 40 --note "今天想看看什么"`,
    `  · 想歇着：node ${o.biliMjs} focus rest`,
    `不用问我，自己挑。`,
    '',
    `如果挑了 bilibili，按这个流程做：`,
    '',
    `1) 自检：node ${o.biliMjs} deps`,
    `   有红的就只做读（feed/debrief），不对外发（act 别带 --go），把红的那段原文贴给我`,
    dry,
    '',
    `2) 选题：node ${o.biliMjs} feed --json`,
    `   挑 ≤${o.dailyMaxVideos} 条打算刷的，直接往下走，不用先告诉我`,
    '',
    `3) 每条深读：node ${o.biliMjs} debrief --bvid <BV>`,
    `   debrief 输出末尾有 BILI_ACTION 块，里面 SCORE 填 0-20 的整数——分数不够 minScore 的别转`,
    '',
    `4) 发动态（转发模式优先）：`,
    `   对每条刷过的视频（bvid）写一段短文案 + 你自己打的 score：`,
    `   先干跑：node ${o.biliMjs} act dyn --bvid <BV> --text "<文案>" --score <0-20>`,
    `   确认没问题再真发：node ${o.biliMjs} act dyn --bvid <BV> --text "<文案>" --score <0-20> --go`,
    `   （如果不想转发某条、想发纯文字动态：act dyn --text "<文案>"）`,
    `   发完把 act dyn 的返回原文贴给我`,
    '',
    `5) 收工后把今天刷了哪几条 BV、写了什么，简短 3-5 行列给我`,
    qq,
    '',
    `收工。`,
  ].join('\n')
}

export function createDailyBili(deps: DailyBiliDeps): DailyBili {
  const { options, home, flush, logger, timeZone } = deps
  const clock = deps.clock ?? (() => new Date())
  let timer: NodeJS.Timeout | null = null
  let stopped = false
  let running = false
  /** 下一次到点只是“重新排期”，不投递 prompt（今天的次数已经用完时）。 */
  let rearmOnly = false

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
      const libs = await loadLibs()
      if (libs) {
        // ── nightCfg 构造：窗口从 world 主框架 wakeTime/reviewTime 推导（不再读 bili.config.json 的 night.windows）──
        let nightCfg: ReturnType<typeof biliNightConfig> = { windows: [{ start: '20:00', end: '24:00', wakes: 1 }], skipChance: 0.3, minGapMin: 10, maxVideos: 5 }
        try {
          nightCfg = biliNightConfig(libs.readConfig(), options.wakeTime, options.reviewTime)
        } catch {}

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
    if (ms < 0) { setTimeout(() => { void arm() }, 5_000); return }
    timer = setTimeout(() => { timer = null; if (rearmOnly) { rearmOnly = false; void arm() } else { void fire() } }, ms)
    logger.info?.(`[dailyBili] arm → ${formatLocalTime(at, timeZone).slice(11, 16)}${rearmOnly ? '（仅重排）' : ''}`)
  }

  /** 投递 prompt → home session → flush。 */
  async function fire(): Promise<void> {
    if (stopped) return
    // 上一轮还没投递完（正常只会持续几百毫秒）：别把调度器停在“没有 timer”的状态。
    if (running) { setTimeout(() => { if (!stopped && !timer) void arm() }, 60_000); return }
    if (!options.enabled()) { await arm(); return }
    running = true
    try {
      const agent = await home()

      // 完成这次 plan + 注入 mood/focus/sessionTarget 块
      let planState: any = {}
      const extra: { stateBlock?: string; distract?: string; focusLine?: string; ledgerBrief?: string; sessionTarget?: { watch: number; pure: number } } = {}
      try {
        const libs = await loadLibs()
        if (libs) {
          const current = readPlan(options.dataDir)
          if (!current.fired && libs.nightPlan.isPending(current, clock().getTime())) {
            const done = libs.nightPlan.completePlan(current, clock().getTime())
            writePlan(options.dataDir, done)
            planState = done
          } else {
            planState = current
          }

          try {
            libs.mood.tickMood()
            extra.stateBlock = libs.mood.stateBlock(0, 'bilibili')
            extra.distract = libs.mood.distract()
          } catch {}

          try {
            const snap = libs.focus.focusSnapshot()
            if (snap.activity && !snap.expired) {
              extra.focusLine = `（你上一次说要${snap.label}，还剩 ${snap.remainMin} 分钟${snap.note ? `：「${snap.note}」` : ''}。到点了可以收工，挑新的。）`
            }
          } catch {}

          try {
            const brief = libs.ledger?.readBrief?.()
            if (brief?.line) {
              extra.ledgerBrief = brief.line
              if (brief.stale) {
                libs.ledger?.refreshBrief?.().catch(() => {})
              }
            } else {
              const fresh = await libs.ledger?.refreshBrief?.()
              if (fresh?.line) extra.ledgerBrief = fresh.line
            }
          } catch {}

          // ── session_limit reset（每次 fire 随机新 target + world 作息作为唯一真相源）──
          try {
            const cfg = libs.readConfig()
            const st = libs.sessionLimit?.resetSession?.(cfg, {
              wakeTime: options.wakeTime,
              reviewTime: options.reviewTime,
              dailyMaxVideos: options.dailyMaxVideos,
            })
            if (st) extra.sessionTarget = st
          } catch {}
        } else {
          planState = readPlan(options.dataDir)
        }
      } catch {
        planState = readPlan(options.dataDir)
      }

      const prompt = biliPrompt(clock(), options, timeZone, planState, extra)
      const message = createUserMessage({ source: { kind: 'dsh-world-life' }, content: [{ type: 'text', text: prompt }] })
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
