// 作息计划：窗口内随机时刻醒来，跨零点/最小间隔/重启不重抽。
// 复用 dsh-bili-whale 的 tools/lib/night-plan.mjs（MIT）——纯函数，无文件依赖。
// 这些坑它都替我们踩过了：相邻唤醒挤在一起（硬下限 minGapMin）、skip 拉黑整个窗口、
// 配置保存清掉历史、跨午夜绝对时间戳。
//
// 0.8.10 起把“窗口内均匀随机”改成“按剩余次数等分，本次只落在第一段”（分层采样）：
// 8 次/天的窗口里，原写法第一次可能被扔到几小时后；等分后第一次被限制在剩余窗口的 1/8 内，
// 后续每次重新按“剩余窗口 ÷ 剩余次数”分段。仍然保留原来的“排不下就舍弃”（done）语义。
//
// 【模块卡片】
// 职责：作息计划的纯函数层 —— 把配置里的时间窗口展开成「今天还能在哪段时间里随机醒来」。
// 导出：dayOf / windowsOf / maxWakes / occurrences / inWindow / historyOf / isPending /
//       makePlan / completePlan。
// 调用方：宿主 src/bili/dailyBili.ts（按 world 作息组装配置后调用）；tests/nightPlan.test.mjs。
// 数据文件：本模块不读写文件；state 由调用方持久化（night 状态文件在宿主那边）。
// 坑：跨零点的窗口要拆成「昨天 + 今天」两次机会；历史按「日期|窗口」键保留 3 天，
//     保存配置时不能把已用次数清掉，否则同一天会重复醒来。
// 【链路位置】
//   环节：作息排期纯函数层 —— 宿主 arm() 用它算「下一次几点随机醒来」，算完写 plan.json 并 setTimeout；不参与 feed 打分。
//   上游调用：宿主 src/bili/dailyBili.ts 的 arm() 与 biliNightConfig()；tests/nightPlan.test.mjs。
//   下游调用：无（纯函数，不 import 本仓库任何模块、不读写文件）。
//   读写文件：不读写；state 由宿主持久化到 <数据根>/plan.json，历史键按「日期|窗口」保留 3 天。
//   退出码：库不设退出码；排不下时返回 action='done' 而不抛错，只有 completePlan 缺 windowKey 时抛。
//   上游参考：复用 dsh-bili-whale 的 tools/lib/night-plan.mjs（MIT）；0.8.10 起「窗口内均匀随机」改成按剩余次数等分的第一段。

// 【补充】调用方：historyOf()、occurrences()、makePlan() 都靠它切日期；宿主也用它判断跨天。
//   参数：时间戳、Date 或可被 Date 解析的字符串（默认现在）。
//   返回：本地时区的 YYYY-MM-DD（sv-SE 恰好是 ISO 形状）。
//   失败：无法解析时得到 Invalid Date 的字符串，调用方比较会失败但不抛错。
/**
 * 本地日期键（YYYY-MM-DD），跨天判断和历史键统一用它。
 * @param {number|string|Date} [value=Date.now()] 时间戳、Date 或可被 Date 解析的字符串。
 * @returns {string} 本地时区下的日期（sv-SE 恰好输出 ISO 形状）。
 */
export const dayOf = (value = Date.now()) => new Date(value).toLocaleDateString('sv-SE')
const stamp = (day, minutes) => {
  const d = new Date(`${day}T00:00:00`)
  d.setMinutes(minutes)
  return d.getTime()
}
const parse = (s) => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(s))
  if (!match) throw new Error(`无效作息时间：${s}`)
  const h = Number(match[1]), m = Number(match[2])
  if (h > 24 || m > 59 || (h === 24 && m !== 0)) throw new Error(`无效作息时间：${s}`)
  return h * 60 + m
}
/**
 * 把配置展开成可计算的窗口（分钟偏移 + 是否跨零点）。
 * @param {object} cfg night 段配置；缺 windows 时用 windowStart/windowEnd/maxWakesPerDay 兼容旧写法。
 * @returns {Array<{start:number, end:number, wrap:boolean, label:string, wakes:number}>}
 *   start/end 是当天 0 点起的分钟数（跨零点时 end 会大于 1440），wakes 被夹在 0–12。
 */
// 【补充】调用方：maxWakes()、occurrences()、宿主 biliNightConfig() 组装配置后调用。
//   参数：cfg 是 night 段；缺 windows 时按 windowStart/windowEnd/maxWakesPerDay 兼容旧写法。
//   返回：窗口数组，start/end 是当天 0 点起的分钟数，wrap 表示跨零点，wakes 夹在 0–12。
//   失败：时间格式非法时 parse() 抛 Error（中文），由调用方决定是否兜底。
export function windowsOf(cfg) {
  const list = Array.isArray(cfg.windows) ? cfg.windows : [{ start: cfg.windowStart ?? '20:00', end: cfg.windowEnd ?? '24:00', wakes: cfg.maxWakesPerDay ?? 1 }]
  return list.map(w => {
    const start = parse(w.start), rawEnd = parse(w.end)
    // 结束时间不晚于开始时间就当作跨零点（20:00–02:00），加一天再比较。
    const end = rawEnd <= start ? rawEnd + 1440 : rawEnd
    // 单窗口次数封顶 12：再多就不像「随机醒来」，而像排班了。
    return { start, end, wrap: end > 1440, label: `${w.start}–${w.end}`, wakes: Math.min(12, Math.max(0, Math.floor(Number(w.wakes ?? 1) || 0))) }
  })
}
/**
 * 全天最多醒来几次。
 * @param {object} cfg 同 windowsOf。
 * @returns {number} 所有窗口次数之和，但整体封顶 12（和宿主 dailyBili 的上限一致）。
 */
export const maxWakes = cfg => Math.min(12, windowsOf(cfg).reduce((n, w) => n + w.wakes, 0))
/**
 * 列出「还没结束」的窗口实例（跨零点窗口会同时给出昨天和今天两份）。
 * @param {object} cfg 同 windowsOf。
 * @param {number} [now=Date.now()] 当前时间毫秒。
 * @returns {Array<{start:number, end:number, wrap:boolean, label:string, wakes:number, key:string, startsAt:number, endsAt:number}>}
 *   key 是「日期|窗口」，用作历史计数的主键；只保留 endsAt 在 now 之后的窗口。
 */
// 【补充】调用方：inWindow()、makePlan()（挑窗口时用 key 与起止时刻）。
//   参数：cfg 同上；now 当前时间毫秒。
//   返回：还没结束的窗口实例数组；跨零点窗口会同时给出昨天和今天两份，每份带 key / startsAt / endsAt。
//   失败：不抛错（时间非法由 windowsOf 抛）。
export function occurrences(cfg, now = Date.now()) {
  const today = dayOf(now), yesterday = new Date(`${today}T00:00:00`)
  yesterday.setDate(yesterday.getDate() - 1)
  // 跨零点窗口的「昨天那份」可能还没结束（00:30 时 20:00–02:00 仍有效），所以要一起给出。
  return windowsOf(cfg).flatMap(w => (w.wrap ? [dayOf(yesterday), today] : [today]).map(day => ({
    ...w, key: `${day}|${w.label}`, startsAt: stamp(day, w.start), endsAt: stamp(day, w.end),
  }))).filter(w => w.endsAt > now)
}
/**
 * 当前时刻是否落在任一窗口内（含已开始但未结束的跨零点窗口）。
 * @param {object} cfg 同 windowsOf。
 * @param {number} [now=Date.now()] 当前时间毫秒。
 * @returns {boolean}
 */
export const inWindow = (cfg, now = Date.now()) => occurrences(cfg, now).some(w => w.startsAt <= now)

// 按日期化的窗口保留历史：配置保存不清掉已用次数。
/**
 * 把任意旧版状态整理成 schema 2 的历史账：按「日期|窗口」保留已用次数，只留最近 3 天。
 * @param {object} [state={}] 上次保存的计划/历史状态（可能是没有 schema 字段的旧版）。
 * @param {number} [now=Date.now()] 当前时间毫秒，用来算保留截止日。
 * @returns {{schema: 2, date: string, wakes: number, wokeAt: string|null, usedCount: Object<string, number>, skippedWindows: string[]}}
 *   纯函数，不写文件；调用方负责持久化。
 */
export function historyOf(state = {}, now = Date.now()) {
  const usedCount = { ...(state.usedCount ?? {}) }
  const skippedWindows = new Set(state.skippedWindows ?? [])
  if (state.schema !== 2 && state.date) {
    for (const [label, count] of Object.entries(usedCount)) {
      if (!label.includes('|')) {
        // 旧版把「已经 wake 但还没 fired」的次数先记上了；迁移时要减掉这 1 次，否则会少醒一次。
        const reserved = state.action === 'wake' && !state.fired && !state.woke && label === state.window ? 1 : 0
        usedCount[`${state.date}|${label}`] = Math.max(0, Number(count) - reserved)
        delete usedCount[label]
      }
    }
    if (state.action === 'skip' && state.fired && state.window) skippedWindows.add(`${state.date}|${state.window}`)
  }
  const cutoff = new Date(now); cutoff.setDate(cutoff.getDate() - 3)
  // 只留 3 天：跨零点最多回看昨天，再久的历史没有判断价值，留着只会撑大状态文件。
  for (const key of Object.keys(usedCount)) if (key.slice(0, 10) < dayOf(cutoff)) delete usedCount[key]
  return { schema: 2, date: dayOf(now), wakes: state.date === dayOf(now) ? Number(state.wakes ?? 0) : 0,
    wokeAt: state.wokeAt ?? null, usedCount, skippedWindows: [...skippedWindows].filter(key => key.slice(0, 10) >= dayOf(cutoff)) }
}
/**
 * 判断状态里是否有一个「还没兑现、窗口也还没结束」的计划。
 * @param {object} state makePlan 保存下来的状态。
 * @param {number} [now=Date.now()] 当前时间毫秒。
 * @returns {boolean} schema=2、action 为 wake/skip、未 fired/woke 且 endsAt 未过才算。
 */
export function isPending(state, now = Date.now()) {
  return state?.schema === 2 && ['wake', 'skip'].includes(state.action) && !state.fired && !state.woke &&
    Number.isFinite(state.atMs) && Number.isFinite(state.endsAt) && state.endsAt > now
}
/**
 * 生成（或复用）下一次唤醒计划：分层采样、最小间隔、次数上限都在这里定。
 * @param {object} cfg night 段配置（windows / minGapMin / skipChance / maxVideos）。
 * @param {object} [state={}] 上次的状态；仍有有效的 pending 计划且窗口还在时原样返回。
 * @param {number} [now=Date.now()] 当前时间毫秒。
 * @param {() => number} [random=Math.random] 注入随机源，测试用。
 * @returns {object} 新状态；排不下时返回 action='done'（不抛错，调用方据此安静收工）。
 */
// 【补充】调用方：宿主 arm() 在需要重排时调它；宿主把返回的 state 写进 plan.json。
//   参数：cfg 含 windows/minGapMin/skipChance/maxVideos；state 是上次计划（可沿用则原样返回）；random 可注入。
//   返回：含 action（wake/skip/done）、atMs/atText、windowKey 等的状态对象；done 表示今天排不下，不抛错。
//   失败：时间非法时抛；其余情况一律用 done 表达「今天没有下一次」。
export function makePlan(cfg, state = {}, now = Date.now(), random = Math.random) {
  // 关键修复：isPending 只查"有没有未完成的计划"，不查"这个计划的窗口还是不是当前配置的窗口"。
  // 用户把作息从 20:00 改成 17:00 后，旧的 pending 计划（20:00–24:00）会被直接复用，导致新窗口不生效。
  // 这里补一条：pending 计划的 windowKey 必须仍在当前配置的 occurrences 里，否则作废重算。
  if (isPending(state, now) && occurrences(cfg, now).some(w => w.key === state.windowKey)) return state
  const history = historyOf(state, now)
  const done = reason => ({ ...history, action: 'done', done: true, reason })
  if (history.wakes >= maxWakes(cfg)) return done('今天醒来次数已用完（或所有窗口为零次）')
  const pool = occurrences(cfg, now).filter(w => w.wakes > (history.usedCount[w.key] ?? 0))
    .sort((a, b) => a.endsAt - b.endsAt || a.startsAt - b.startsAt)
  if (!pool.length) return done('今天可用窗口已结束或已经处理')

  const lastWoke = Number.isFinite(Date.parse(state.wokeAt ?? '')) ? Date.parse(state.wokeAt) : 0
  // 下限 1 分钟：配置成 0 会让相邻两次唤醒挤在一起，和「随机作息」的本意相反。
  const minGapMs = Math.max(
    60_000,
    Math.floor((Number.isFinite(Number(cfg.minGapMin)) ? Number(cfg.minGapMin) : 10) * 60_000),
  )
  let picked = null
  for (const cand of pool) {
    const gap = minGapMs
    const used = history.usedCount[cand.key] ?? 0
    const remaining = Math.max(1, cand.wakes - used)   // 含本次
    const earliest = Math.max(now, cand.startsAt, lastWoke + gap)
    // 提前 30 秒收口：留出执行唤醒的时间，避免计划刚生成就已经过期。
    if (earliest >= cand.endsAt - 30_000) continue   // 这个窗口放不下了

    // 等分采样：把“剩余可行区间”按剩余次数切成 remaining 段，本次只落在第一段。
    // 上界 latest 先给后面 remaining-1 次各留一个 minGap；留不下（窗口太短/次数太多）就退回
    // “只保证这一次”的老行为——后续 arm 会走 done，不补跑，这就是保留的尾部舍弃。
    const reserve = Math.max(0, remaining - 1) * gap
    const latest = Math.min(cand.endsAt - 30_000, cand.endsAt - reserve)
    if (latest <= earliest) {
      picked = { cand, from: earliest, to: cand.endsAt - 30_000 }
      break
    }
    const band = Math.max(1, Math.floor((latest - earliest) / remaining))
    picked = { cand, from: earliest, to: earliest + band }
    break
  }
  if (!picked) return done('今天可用窗口里已经排不下下一次（间隔不够）')
  const w = picked.cand
  const from = picked.from
  const atMs = from + Math.floor(random() * Math.max(1, picked.to - from))
  const atDate = new Date(atMs), at = atDate.getHours() * 60 + atDate.getMinutes()
  // 默认 30% 跳过：她也有权利今天不想刷，这比强行凑一条更真实。
  const skip = random() < Math.min(1, Math.max(0, Number(cfg.skipChance ?? 0.3)))
  return { ...history, action: skip ? 'skip' : 'wake', fired: false, atMs, at,
    atText: `${dayOf(atMs)} ${String(atDate.getHours()).padStart(2, '0')}:${String(atDate.getMinutes()).padStart(2, '0')}`,
    window: w.label, windowKey: w.key, startsAt: w.startsAt, endsAt: w.endsAt,
    withinWindow: `${w.label} 第 ${(history.usedCount[w.key] ?? 0) + 1}/${w.wakes} 次`,
    maxVideos: cfg.maxVideos ?? 5, createdAt: new Date(now).toISOString(),
    ...(skip ? { reason: '本次计划跳过看视频，仍写日记' } : { roll: 'watch' }) }
}
/**
 * 兑现计划：把这次计入「日期|窗口」的已用次数与当天总次数，并标记 fired/woke。
 * @param {object} state makePlan 产出的状态。
 * @param {number} [now=Date.now()] 兑现时间毫秒（写进 wokeAt）。
 * @returns {object} 更新后的状态；已 fired 的原样返回（幂等）。不写文件。
 * @throws {Error} state 缺少 windowKey 时抛出 —— 旧版/损坏的计划没法归账，只能让人重新 plan。
 */
// 【补充】调用方：宿主在真正触发投递前调它，把这次计入「日期|窗口」的已用次数。
//   参数：state 是 makePlan 的产出；now 兑现时间（写进 wokeAt）。
//   返回：更新后的状态；已 fired 的原样返回（幂等，宿主重试不会多记一次）。
//   失败：state 缺 windowKey（旧版/损坏计划）时抛 Error；其余不抛。
export function completePlan(state, now = Date.now()) {
  if (state.fired) return state
  const h = historyOf(state, now)
  if (!state.windowKey) throw new Error('计划缺少窗口标识，请重新 plan')
  if (state.action === 'skip' || state.action === 'wake') {
    h.usedCount[state.windowKey] = (h.usedCount[state.windowKey] ?? 0) + 1
    h.wakes += 1
  }
  return { ...state, ...h, fired: true, woke: state.action === 'wake', wokeAt: new Date(now).toISOString() }
}
