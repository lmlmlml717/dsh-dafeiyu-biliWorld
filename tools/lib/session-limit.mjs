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
//                                          手动配 watch.sessionMin/Max 就在这个区间里随机（0.9.1 起两端都生效）
//                                          相等就是固定值；没配就按窗口长度自动算：4h 窗口 → [2,6]
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
//
// 【模块卡片】
// 职责：单次 fire 的 session 配额 + 每日总上限 + 作息窗口这三层漏斗的读写与判定。
// 导出：withinWindow / deriveSessionFromWindow / pickSessionRange / pickRandomInt /
//       resetSession / readSession / checkSession / incSession。
// 调用方：tools/commands/act.mjs（checkSession/incSession）；宿主 src/bili/dailyBili.ts（resetSession）。
// 数据文件：<bili 根>/session.json（每次 fire 覆盖写）、bili-actions.json（读当日 dyn_share 计数）。
// 坑：target 是数字就照数字执行，0 表示「这次一条都不许发」；只有缺失/非数字才当不限。
//     每日总上限在 resetSession 里已合并进 target，checkSession 不再二次扣减。
// 【链路位置】
//   环节：单次 fire 的 session 名额闸 —— act dyn 第一步就查它，转发/纯动态两个桶分开；每日总上限也在 resetSession 里并进来。
//   上游调用：tools/commands/act.mjs（checkSession/incSession）；宿主 src/bili/dailyBili.ts（resetSession，每次 fire 开始时调用）。
//   下游调用：lib/paths.mjs（session.json / bili-actions.json）；不联网。
//   读写文件：<bili 根>/session.json（每次 fire 覆盖写）、bili-actions.json（只读当日 dyn_share 计数）。
//   退出码：库不设退出码；没有 session.json 时 checkSession 直接放行（{ ok: true }），交给 guard 与日额度。
//   上游参考：日额度账本来自 dsh-bili-whale / dsh-feiyu；上面两层（窗口 + session）是本仓库加的。
import fs from 'node:fs'
import path from 'node:path'
import { dataPath } from './paths.mjs'

function sessionFile() { return dataPath('session.json') }
function dayFile() { return dataPath('bili-actions.json') }

// 和账本、心情、历史同一口径（本地日历日）：跨时区时不要改成 UTC，否则「今天」会提前翻页。
const dayKey = () => new Date().toLocaleDateString('sv-SE')

function readDayBook() {
  // 读不到账本按空账处理：宁可让每日计数从 0 开始，也不能因为一次读失败卡死整条 fire。
  try { return JSON.parse(fs.readFileSync(dayFile(), 'utf8')) } catch { return {} }
}

function read() { try { return JSON.parse(fs.readFileSync(sessionFile(), 'utf8')) } catch { return null } }
function write(j) {
  // session.json 是进程内临时状态：写失败只影响本次配额，不该抛错打断主流程。
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
// 【补充】调用方：checkSession()（Layer 1）、resetSession() 的窗口字段、测试。
//   参数：startHHMM/endHHMM 形如 HH:MM，end < start 表示跨零点；now 可注入。
//   返回：true = 在窗口内；任一时刻缺失/非法返回 true（宁可放行，不因配置写错锁死她）。
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
// 【补充】调用方：pickSessionRange()（autoFromWindow=true 时）；测试直接验证窗口长度→区间。
//   参数：起止 HH:MM；basePerHour 每小时能完成几次完整「看+转」（默认 0.6，含 1 的安全垫）。
//   返回：{ min, max }，min 至少 1、max 至少比 min 大 1；窗口算不出时返回 { min: 2, max: 4 } 兜底。
//   失败：不抛错。
export function deriveSessionFromWindow(startHHMM, endHHMM, basePerHour = 0.6) {
  const s = hmToMin(startHHMM), e = hmToMin(endHHMM)
  // 起止相同（含配置写错）时给 [2,4] 兜底：不能因为窗口算不出来就让她一次都动不了。
  if (s < 0 || e < 0 || s === e) return { min: 2, max: 4 }
  const span = e > s ? e - s : (24 * 60 - s) + e
  const hours = span / 60
  // min 取窗口时长的四分之一、max 按每小时 0.6 次，且至少 1 次、max 至少比 min 大 1。
  const min = Math.max(1, Math.floor(hours * 0.25))
  const max = Math.max(min + 1, Math.floor(hours * basePerHour) + 1)
  return { min, max }
}

/**
 * 选本次 fire 的 session target。
 * 优先级：autoFromWindow=true（默认）→ 按窗口长度自动算
 *         autoFromWindow=false 且手动配了 sessionMin/Max → 在 [最少, 最多] 之间随机
 *
 * 0.9.1：手动模式以前是「固定用最多」，于是面板上的「最少」填了也没用（只有 min>max 时
 * 充当一次下限修正）。现在区间两端都生效：填 2 和 6 就是这次 2–6 条随机；想固定就填成相等。
 * @param {object} cfg 合并后的配置（读 cfg.bilibili.watch）
 * @param {string} wakeTime world 的起床时间（自动模式用它推区间）
 * @param {string} reviewTime world 的回顾时间
 * @returns {{min: number, max: number}} 本次唤醒的区间；min 可能为 0（纯动态那边允许 0 条）
 * @throws 不抛错；窗口算不出走 deriveSessionFromWindow 的兜底，手动值写坏就回默认
 */
export function pickSessionRange(cfg, wakeTime, reviewTime) {
  const w = cfg?.bilibili?.watch ?? {}
  // autoFromWindow=true（默认）→ 自动推导
  if (w.autoFromWindow !== false) {
    return deriveSessionFromWindow(wakeTime, reviewTime)
  }
  // autoFromWindow=false → 用手动值（null 也兜底）
  // 注意：Number(null) 是 0、Number('') 也是 0，都会被当"填了 0 条"。所以先把空值判成 NaN，
  // 再决定用不用它 —— 否则清空输入框就等于「这次一条都不许发」。
  const num = value => (value === null || value === undefined || value === '' ? NaN : Number(value))
  const manualMin = num(w.sessionMin)
  const manualMax = num(w.sessionMax)
  // 只配了 max 时往前推 2 作 min；只配了 min 时 max 至少等于 min，避免出现负区间。
  const lo = Number.isFinite(manualMin) ? Math.max(0, Math.round(manualMin)) : Math.max(0, (Number.isFinite(manualMax) ? Math.round(manualMax) : 2) - 2)
  const hi = Math.max(lo, Number.isFinite(manualMax) ? Math.round(manualMax) : 6)
  return { min: lo, max: hi }
}

/**
 * 在 [min, max] 里随机取一个整数。random=false 或 min===max 时返回 max。
 * @param {number} min 下限（负数/非数字按 0 处理）
 * @param {number} max 上限（小于 min 时按 min 处理）
 * @param {boolean} [random=true] false = 固定返回 max（给「这次必须正好 N 条」的调用方）
 * @returns {number} 取到的条数；两个参数都坏掉时返回 0
 */
export function pickRandomInt(min, max, random = true) {
  const lo = Math.max(0, Number(min) || 0)
  const hi = Math.max(lo, Number(max) || lo)
  // random=false 固定返回 hi：给「这次必须正好 N 条」的调用方留的口子（0.9.1 起 resetSession 不再用它）。
  // 手动模式要固定就填 min === max，这里仍会走 lo === hi 的固定分支。
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
// 【补充】调用方：宿主 src/bili/dailyBili.ts 每次 fire 开始时；宿主把返回的 target 写进 prompt 的「今天这次随机给了 N 条」。
//   参数：cfg 合并后的配置；opts.wakeTime/reviewTime 是 world 主框架作息，dailyMaxVideos 是每日硬上限。
//   返回：{ watchTarget, pureTarget, dailyRemaining }，其中 watchTarget 已与每日剩余量取小；dailyRemaining 为 null 表示不限。
//   失败：不抛错；窗口算不出走 deriveSessionFromWindow 的兜底；session.json 写失败被吞（只影响本次配额）。
export function resetSession(cfg, opts) {
  const { wakeTime, reviewTime, dailyMaxVideos = 0 } = opts || {}
  const range = pickSessionRange(cfg, wakeTime, reviewTime)
  // 0.9.1：自动模式和手动模式都在区间里随机 —— 手动模式填 2/6 就是「这次 2–6 条」。
  // 想精确控制就填成相等（min === max 时 pickRandomInt 直接返回那个数）。
  const watchTarget = pickRandomInt(range.min, range.max, true)

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
  // 和每日剩余量取小：session 想要 5 条，但今天只剩 2 条，就只能发 2 条。
  const finalWatch = dailyRemaining === null ? watchTarget : Math.min(watchTarget, dailyRemaining)

  // 每次 fire 覆盖写：旧的 session 计数没有保留价值，新 state 直接落盘。
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
// 【补充】调用方：tools/commands/act.mjs 的 dyn 分支（转发传 'share'、纯动态传 'pure'），在 minScore 与额度之前。
//   参数：kind = 'share' | 'pure'。返回：{ ok, why?, current?, target?, outsideWindow?, dailyExhausted? }。
//   失败：不抛错；没有 session.json 时返回 { ok: true } 放行，拦不拦交给 guard 与日额度。
export function checkSession(kind) {
  const state = read()
  // 没有 session.json（手动命令、旧版、刚清过）→ 不在这里拦，交给 guard / 每日账本。
  if (!state) return { ok: true }

  // ── Layer 1: 时间窗口（world wake/review，唯一真相源）──
  const win = state.window || {}
  if (win.start && win.end && !withinWindow(win.start, win.end)) {
    // why 是给她看的话：不提「窗口/时段」这类词，也不报时间，免得她当成台词转述给主人；
    // 真正的原因放 detail，CLI 与控制台照旧能查。
    return { ok: false, why: '现在发不出去，等会儿再说', detail: `不在作息窗口 ${win.start}–${win.end} 里`, outsideWindow: true }
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
    // 区分「本次 session 用完」和「今天总量用完」：两种原因对应的下一步动作不一样。
    // 但给她的话统一不说数字（数字进 detail），避免「0/0」「15 条」被当成她的台词。
    const dailyExhausted = !!daily && Number(daily.max) > 0 && Number(daily.remaining) <= current
    const detail = dailyExhausted
      ? `今日已达总上限 ${daily.max} 条（已发 ${daily.today}）`
      : `本次 session ${kind === 'share' ? '转发' : '纯动态'} 已达上限 ${current}/${target}`
    const msg = dailyExhausted
      ? '今天这个号发不出去了'
      : `这次发不了${kind === 'share' ? '转发' : '纯文字动态'}`
    return { ok: false, why: msg, detail, current, target, dailyExhausted }
  }
  return { ok: true, current, target }
}

/** 执行成功后记一次计数。 */
// 【补充】调用方：act.mjs 在转发/纯动态真发成功后（干跑不算）各调一次。
//   参数：kind = 'share' | 'pure'。返回：无；转发同时把 watch 计数 +1（转发也占一次视频名额）。
//   失败：不抛错；没有 session.json 时直接返回（手动命令没有 session 概念）。
export function incSession(kind) {
  const state = read()
  if (!state) return
  const k = kind === 'share' ? 'share' : kind === 'pure' ? 'pure' : 'watch'
  state.counts = state.counts || {}
  state.counts[k] = Number(state.counts[k] ?? 0) + 1
  // 转发同时占 watch 名额：转发也是「看 + 转」的一次，不能借它绕过 session 的视频上限。
  if (kind === 'share') state.counts.watch = Number(state.counts.watch ?? 0) + 1
  write(state)
}
