/** feed 每轮固定搜 2 个种子；按本地日期轮换，n 个种子 ⌈n/2⌉ 天轮完。 */
export declare const SEEDS_PER_ROUND: number

/** 本地日历日序号（同一本地日里恒定）。 */
export declare function localDayIndex(date?: Date | number): number

/** 按日期挑本轮要搜的种子；空列表返回 picked: []。 */
export declare function pickSeeds(
  seeds: readonly string[],
  dayIndex?: number,
): { picked: string[]; offset: number; daysToCover: number }
