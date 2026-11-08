// 搜索种子的轮换：feed 每轮只搜 2 个种子，但按本地日期把窗口往后平移，
// 保证 n 个种子在 ⌈n/2⌉ 天内全部轮到（同一天里的多轮用同一对，便于对账）。
//
// 规则（feed / 控制台种子卡必须一致）：
//   offset = (dayIndex * SEEDS_PER_ROUND) % n
//   picked = seeds[offset], seeds[offset + 1]
// dayIndex 是「本地日历日序号」：同一本地日里所有轮次得到同一个值。

export const SEEDS_PER_ROUND = 2

/** 本地日历日序号（不是 UTC 日）：跨时区/夏令时变化时按本地 0 点切。 */
export function localDayIndex(date = new Date()) {
  const t = date instanceof Date ? date.getTime() : Number(date)
  const offsetMs = (date instanceof Date ? date.getTimezoneOffset() : new Date(t).getTimezoneOffset()) * 60_000
  return Math.floor((t - offsetMs) / 86_400_000)
}

/**
 * 按日期挑出本轮要搜的种子。
 * @param {string[]} seeds 已保存的搜索种子
 * @param {number} [dayIndex] 本地日序号，默认取当前时间
 * @returns {{ picked: string[], offset: number, daysToCover: number }}
 */
export function pickSeeds(seeds, dayIndex = localDayIndex()) {
  const list = [...new Set((Array.isArray(seeds) ? seeds : []).map((s) => String(s).trim()).filter(Boolean))]
  if (!list.length) return { picked: [], offset: 0, daysToCover: 0 }
  const per = Math.min(SEEDS_PER_ROUND, list.length)
  const offset = (((dayIndex % list.length) + list.length) % list.length) * SEEDS_PER_ROUND % list.length
  const picked = Array.from({ length: per }, (_, i) => list[(offset + i) % list.length])
  return { picked, offset, daysToCover: Math.ceil(list.length / SEEDS_PER_ROUND) }
}
