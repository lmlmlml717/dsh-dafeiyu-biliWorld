// 搜索种子的轮换：feed 每轮只搜 2 个种子，但按本地日期把窗口往后平移，
// 保证 n 个种子在 ⌈n/2⌉ 天内全部轮到（同一天里的多轮用同一对，便于对账）。
//
// 规则（feed / 控制台种子卡必须一致）：
//   offset = (dayIndex * SEEDS_PER_ROUND) % n
//   picked = seeds[offset], seeds[offset + 1]
// dayIndex 是「本地日历日序号」：同一本地日里所有轮次得到同一个值。
//
// 【模块卡片】
// 职责：把「今天第几天」换算成「今天该搜哪两个种子」，只做纯计算，不读环境变量、不碰文件。
// 导出：SEEDS_PER_ROUND / localDayIndex / pickSeeds。
// 调用方：tools/commands/feed.mjs 选搜索词；控制台种子卡按同一公式复算，两边必须一致。
// 数据文件：无 —— 种子来自 bili.config.json 的 preferences.keywords，由调用方传进来。
// 坑：日序号必须按本地日切（东八区凌晨不能用 UTC 的日）；负的 dayIndex 也要能取模。

// 【链路位置】
//   环节：feed 选题里的「今天该搜哪两个种子」，纯计算、不碰网络。
//   上游调用：tools/commands/feed.mjs 的 pickSeeds；控制台 client/index.js 的种子卡按同一公式复算展示。
//   下游调用：无（纯函数，不 import 任何模块）。
//   读写文件：不读写；种子来自 bili.config.json 的 preferences.keywords，由调用方传入。
//   退出码：库不设退出码；种子为空返回 { picked: [], offset: 0, daysToCover: 0 }。
//   一致性：公式有两份实现 —— 这里与 client/index.js 的 seedDayIndex / seedWindowToday，改一处必须同时改另一处。

/**
 * 每轮并行搜索的种子个数。
 * 改这个值要同步 client/index.js 的种子卡，否则面板显示的「今天搜哪两个」会与 feed 实际不符。
 * @type {number}
 */
export const SEEDS_PER_ROUND = 2

// 【补充】调用方：pickSeeds() 的默认参数；控制台种子卡用同一公式自己算一遍。
//   参数：Date 或毫秒数。返回：本地日历日序号（东八区按本地 0 点切，不是 UTC 日）。
//   失败：非法日期得到 NaN，pickSeeds 里的取模会得到 NaN → 取不到种子（配置错时宁可空，不乱搜）。
/** 本地日历日序号（不是 UTC 日）：跨时区/夏令时变化时按本地 0 点切。 */
export function localDayIndex(date = new Date()) {
  // 同时接受 Date 和毫秒数：调用方有时手里只有时间戳，没必要再包一层。
  const t = date instanceof Date ? date.getTime() : Number(date)
  // getTimezoneOffset() 返回「UTC 减本地」的分钟数，东八区是 -480（符号与直觉相反）；
  // 先换成毫秒再用 t - offsetMs，才能得到「本地 0 点切日」的序号。
  const offsetMs = (date instanceof Date ? date.getTimezoneOffset() : new Date(t).getTimezoneOffset()) * 60_000
  return Math.floor((t - offsetMs) / 86_400_000)
}

// 【补充】调用方：feed.mjs 的 run()（kws = seedPlan.picked + 随机口味词）。
//   参数：seeds 配置里的搜索词数组；dayIndex 可注入（测试用，默认当前本地日）。
//   返回：{ picked, offset, daysToCover }；picked 最多 SEEDS_PER_ROUND 个，种子比名额少时只取现有的。
//   失败：不抛错；空种子返回空 picked，由 feed 决定「这轮只搜口味词」。
/**
 * 按日期挑出本轮要搜的种子。
 * @param {string[]} seeds 已保存的搜索种子
 * @param {number} [dayIndex] 本地日序号，默认取当前时间
 * @returns {{ picked: string[], offset: number, daysToCover: number }}
 */
export function pickSeeds(seeds, dayIndex = localDayIndex()) {
  // 去重并去掉空白：配置里手写重复项时，不能同一轮把同一个词搜两遍。
  const list = [...new Set((Array.isArray(seeds) ? seeds : []).map((s) => String(s).trim()).filter(Boolean))]
  if (!list.length) return { picked: [], offset: 0, daysToCover: 0 }
  // 种子比每轮名额少时只取现有的，避免把 undefined 当成搜索词发出去。
  const per = Math.min(SEEDS_PER_ROUND, list.length)
  // 先取「天数对种子数的余数」，再乘每轮个数并对 n 取模：负的 dayIndex 先加一圈，
  // 否则 JS 的 % 会留下负数，list[-2] 拿到 undefined。
  const offset = (((dayIndex % list.length) + list.length) % list.length) * SEEDS_PER_ROUND % list.length
  const picked = Array.from({ length: per }, (_, i) => list[(offset + i) % list.length])
  // daysToCover 是「全部种子轮一遍要几天」，n 不是每轮个数的整数倍时向上取整。
  return { picked, offset, daysToCover: Math.ceil(list.length / SEEDS_PER_ROUND) }
}
