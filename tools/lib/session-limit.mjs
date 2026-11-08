// session-limit —— 单次 fire() 的 session 级配额 + 每日总上限 + 作息窗口。
//
// 【配额的三层漏斗】（feiyu/whale 只有日额度账本，我们加了上面两层）
//
//   Layer 1: world 主框架作息窗口    → [wakeTime, reviewTime] 自动推导，不让配
//                                          当前时刻不在里面？act dyn 直接拒绝
//   Layer 2: 每日总上限（dailyMaxVideos） → 跨 fire 持久化，自然日截止
//                                          今天已经发了 8 条，上限 10 → 最多还能发 2 条
//                                          上限用满后剩余 0 = 今天不能再发（不是「不限」）
//   Layer 3: 单次 fire session 上限     → 进程内临时，每次 fire reset
//                                          手动配 watch.sessionMin/Max 就用你的
//                                          没配？按窗口长度自动算：4h 窗口 → [2,6]
//
// 【额度 0 的语义】target 是一个数字就照数字执行：0 表示「这次一条都不许发」。
//   只有 target 缺失 / 不是数字（旧版 session.json、损坏）才当作「不限」。
//   以前 0 被当成不限，于是「今天硬上限已用满」和「随机到 0 条纯动态名额」都拦不住。
//
// 【为什么不让配 world 作息窗口】
//   bili.config.json 里原来的 night.windows 和 world 主框架的 review/wake 是两套独立配置，
//   用户改了 world 的回顾时间忘了改 bili.config.json，就出现"回顾到了 23:00 但 bili 还在 20:00-24:00 窗口里继续转发"的错位。
//   现在 world wake/review 作为唯一真相源（single source of truth），bili 读它就好。
//
// 【文件位置】
//   session.json           ← 进程内 session 临时状态（每次 fire 覆盖写）
//   bili-actions.json      ← 已有的日额度账本，dyn_share 计数同时算"今日已发"
import fs from 'node:fs'
import path from 'node:path'
import { dataPath } from './paths.mjs'

function sessionFile() { return dataPath('session.json') }
function dayFile() { return dataPath('bili-actions.json') }

const dayKey = () => new Date().toLocaleDateString('sv-SE')

function readDayBook() {
  try { return JSON.parse(fs.readFileSync(dayFile(), 'utf8')) } catch { return {} }
}

function read() { try { return JSON.parse(fs.readFileSync(sessionFile(), 'utf8')) } catch { return null } }
function write(j) {
  try { fs.mkdirSync(path.dirname(sessionFile()), { recursive: true }); fs.writeFileSync(sessionFile(), JSON.stringify(j, null, 2) + '\n') } catch {}
}

// ── HH:MM 解析 ──────────────────────────────────────────────────────────
function hmToMin(hm) {
  if (!hm || typeof hm !== 'string') return -1
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm.trim())
  if (!m) return -1
  const h = Number(m[1]), mm = Number(m[2])
  if (h < 0 || h > 24 || mm < 0 || mm > 59) return -1
  return h * 60 + mm
}

/** 当前时刻是否在 [startHHMM, endHHMM] 里。end < start 表示跨零点。 */
export function withinWindow(startHHMM, endHHMM, now = new Date()) {
  if (!startHHMM || !endHHMM) return true
  const s = hmToMin(startHHMM), e = hmToMin(endHHMM)
  if (s < 0 || e < 0) return true
  const cur = now.getHours() * 60 + now.getMinutes()
  if (s <= e) return cur >= s && cur < e
  return cur >= s || cur < e
}

// ── 自动推导 session 范围 ────────────────────────────────────────────────
// 窗口越长 → 允许的 session 次数越多（feiyu/whale 没有这层，我们自己加的）。
//
// 【系数说明】每小时实际能做的事：刷 1 条视频 + debrief + 写文案 ≈ 15-25 分钟，
// 所以 basePerHour 取 0.6（平均每小时能完成 0.6 次完整"看+转"），
// 再加 1 的安全垫（让小窗口也不至于只能刷 1 条）。
//
//   窗口 2h → min=1, max=2      午休刷两条
//   窗口 4h → min=1, max=3      晚上稍歇一会
//   窗口 8h → min=2, max=6      整个下班晚上段
//   窗口 15h → min=4, max=10    从早到晚的空闲
//
// 最终 watchTarget = min(自动推导值, 每日总上限剩余量)
// dailyMaxVideos（world 主配置）是硬上限，这里只是 session 内的分布建议。
export function deriveSessionFromWindow(startHHMM, endHHMM, basePerHour = 0.6) {
  const s = hmToMin(startHHMM), e = hmToMin(endHHMM)
  if (s < 0 || e < 0 || s === e) return { min: 2, max: 4 }
  const span = e > s ? e - s : (24 * 60 - s) + e
  const hours = span / 60
  const min = Math.max(1, Math.floor(hours * 0.25))
  const max = Math.max(min + 1, Math.floor(hours * basePerHour) + 1)
  return { min, max }
}

/**
 * 选本次 fire 的 session target。
 * 优先级：autoFromWindow=true（默认）→ 按窗口长度自动算
 *         autoFromWindow=false 且手动配了 sessionMin/Max → 用手动值
 */
export function pickSessionRange(cfg, wakeTime, reviewTime) {
  const w = cfg?.bilibili?.watch ?? {}
  // autoFromWindow=true（默认）→ 自动推导
  if (w.autoFromWindow !== false) {
    return deriveSessionFromWindow(wakeTime, reviewTime)
  }
  // autoFromWindow=false → 用手动值（null 也兜底）
  const manualMin = w.sessionMin
  const manualMax = w.sessionMax
  const lo = Number(manualMin ?? Math.max(0, (manualMax ?? 2) - 2))
  const hi = Math.max(lo, Number(manualMax ?? 6))
  return { min: lo, max: hi }
}

/**
 * 在 [min, max] 里随机取一个整数。random=false 或 min===max 时返回 max。
 */
export function pickRandomInt(min, max, random = true) {
  const lo = Math.max(0, Number(min) || 0)
  const hi = Math.max(lo, Number(max) || lo)
  if (!random || lo === hi) return hi
  return lo + Math.floor(Math.random() * (hi - lo + 1))
}

// ── 对外主 API ───────────────────────────────────────────────────────────

/**
 * 每次 fire() 开始时调用：reset 计数器，写入随机 target。
 *
 * @param {object} cfg           bili.config.json（DEFAULTS merge 后）
 * @param {object} opts          world 主框架作息（唯一真相源，不让配）
 * @param {string} opts.wakeTime      HH:MM —— world 的"早上几点"
 * @param {string} opts.reviewTime    HH:MM —— world 的"回顾几点"（通常就是睡前）
 * @param {number} opts.dailyMaxVideos  world 主配置 dailyBili.maxVideos（每日硬上限）
 * @returns {{ watchTarget: number, pureTarget: number, dailyRemaining: number }}
 */
export function resetSession(cfg, opts) {
  const { wakeTime, reviewTime, dailyMaxVideos = 0 } = opts || {}
  const range = pickSessionRange(cfg, wakeTime, reviewTime)
  const w = cfg?.bilibili?.watch ?? {}
  const autoFromWin = w.autoFromWindow !== false
  // 自动模式：推导范围 + 范围里随机（每次不同）
  // 手动模式：固定用 max（精确控制 = 精确执行）
  const watchTarget = pickRandomInt(range.min, range.max, autoFromWin)

  const d = cfg?.bilibili?.dynamic ?? {}
  const pureRange = {
    min: Number(d.pureSessionMin ?? 0) || 0,
    max: Math.max(Number(d.pureSessionMin ?? 0) || 0, Number(d.pureSessionMax ?? 1) || 0),
  }
  const pureTarget = pickRandomInt(pureRange.min, pureRange.max, true)

  // ── Layer 2: 每日总上限（和 session 取最小值）──
  // dailyMaxVideos=0 表示不限（null）；否则剩余额度可能是 0 —— 0 就是今天一条都不能再发。
  const todayBook = readDayBook()
  const today = todayBook.day === dayKey() ? todayBook : {}
  const todayShare = Number(today.dyn_share ?? 0) || 0
  const dailyRemaining = dailyMaxVideos > 0 ? Math.max(0, dailyMaxVideos - todayShare) : null
  const finalWatch = dailyRemaining === null ? watchTarget : Math.min(watchTarget, dailyRemaining)

  const state = {
    version: 2,
    fireId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    window: { start: wakeTime, end: reviewTime },
    target: { watch: finalWatch, pure: pureTarget },
    counts: { watch: 0, pure: 0, share: 0 },
    daily: { max: dailyMaxVideos, today: todayShare, remaining: dailyRemaining },
    resetAtMs: Date.now(),
  }
  write(state)
  return { watchTarget: finalWatch, pureTarget, dailyRemaining }
}

/** 读当前 session 状态（不存在返回 null）。 */
export function readSession() { return read() }

/**
 * 硬检查：本次 session 还能不能执行 kind 类型的动作。
 *
 * 检查顺序：Layer 1 时间窗口 → Layer 3 session target
 *         （Layer 2 每日总上限在 resetSession 里已经和 session target 合并了，不用再查）
 *
 * @param {'share'|'pure'} kind  动作类型
 * @returns {{ ok: boolean, why?: string, current?: number, target?: number, outsideWindow?: boolean, dailyExhausted?: boolean }}
 */
export function checkSession(kind) {
  const state = read()
  if (!state) return { ok: true }

  // ── Layer 1: 时间窗口（world wake/review，唯一真相源）──
  const win = state.window || {}
  if (win.start && win.end && !withinWindow(win.start, win.end)) {
    return { ok: false, why: `不在作息窗口 ${win.start}–${win.end} 里，现在不能发动态`, outsideWindow: true }
  }

  // ── Layer 3: session target（已经和每日总上限合并过）──
  // target 是数字就执行（含 0 = 这次禁止）；缺失/非数字才是「不限」（兼容旧版 state）。
  const countKey = kind === 'share' ? 'share' : 'pure'
  const capKey = kind === 'share' ? 'watch' : 'pure'
  const current = Number(state.counts?.[countKey] ?? 0)
  const rawTarget = state.target?.[capKey]
  const target = typeof rawTarget === 'number' && Number.isFinite(rawTarget) ? rawTarget : null
  const daily = state.daily
  if (target !== null && current >= target) {
    const dailyExhausted = !!daily && Number(daily.max) > 0 && Number(daily.remaining) <= current
    const msg = dailyExhausted
      ? `今日已达总上限 ${daily.max} 条（已发 ${daily.today}）`
      : `本次 session ${kind === 'share' ? '转发' : '纯动态'} 已达上限 ${current}/${target}`
    return { ok: false, why: msg, current, target, dailyExhausted }
  }
  return { ok: true, current, target }
}

/** 执行成功后记一次计数。 */
export function incSession(kind) {
  const state = read()
  if (!state) return
  const k = kind === 'share' ? 'share' : kind === 'pure' ? 'pure' : 'watch'
  state.counts = state.counts || {}
  state.counts[k] = Number(state.counts[k] ?? 0) + 1
  if (kind === 'share') state.counts.watch = Number(state.counts.watch ?? 0) + 1
  write(state)
}
