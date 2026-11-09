// B站操作历史 —— 控制台「历史账本」的数据源。
//
// 两个文件各有一半事实：
//   · bili-actions.json —— 工具链的实时日计数，**只保存当天**（{day, dyn_share, dyn_pure, comment…}），
//     所以它只能证明「今天做了什么」，不是历史。
//   · bili-social.jsonl —— append-only 流水，每条带 ts / day / label，是唯一保留跨天明细的账本。
//
// 这里按本地日（与账本、心情、session-limit 的 toLocaleDateString('sv-SE') 一致）汇总：
// 社交流水出历史，今天的计数再被 bili-actions.json 覆盖一次（它更权威，也避免两边叠加重复计数）。
//
// 导出：readBiliHistory（控制台 GET /console/bili-history 经 ConsoleActions 调用）与 localDayKey。
// 依赖：只读 bili-social.jsonl / bili-actions.json / bili-outbox.md，不写任何文件。
// 坑：日期一律按本地日（sv-SE）切，跨时区/夏令时不能用“减 86400000 天”代替 setDate；
//     坏行、缺失文件都按“没有这条”跳过，历史页不能因为一条坏记录整页失败。
//
// 【链路位置】控制台「历史账本」卡的数据源：index.ts 的 ConsoleActions.readBiliHistory(days) 调这里，
// 由 console/routes.ts 的 GET /console/bili-history?days=N 下发。
// 上游：工具链的写通道（act / comment / bili-write）把每条动作追加到 bili-social.jsonl，并把当天计数写进
//       bili-actions.json；本文件只读这两份，外加 bili-outbox.md。
// 下游：只读 node:fs，不请求网络、不写文件。
// 时序：先按社交流水铺出跨天明细，再用 bili-actions.json 覆盖「今天」这一格，避免同一条动作算两次。
// 与 src/bili/quota.ts 的区别：那边只看今天、给闸门与额度卡用；这边回看最近 N 天、给历史页用。
import fs from 'node:fs'
import path from 'node:path'

/** 一天的 B 站动作汇总。 */
export interface BiliHistoryDay {
  day: string
  total: number
  /** 「转发动态」「评论」…→ 当天条数。 */
  kinds: Record<string, number>
}
/** 控制台历史账本页的数据：最近 N 天、有动作的日子、outbox 预览与总数。 */
export interface BiliHistory {
  /** 最近 N 天，从今天往前（本地日，YYYY-MM-DD）。 */
  days: string[]
  recentActions: BiliHistoryDay[]
  outboxPreview: string
  totalActions: number
}

/** bili-actions.json 的桶名 → 人读标签。 */
const LEDGER_LABEL: Record<string, string> = {
  dyn_share: '转发动态',
  dyn_pure: '纯动态',
  comment: '评论',
  like: '点赞',
  coin: '投币',
  danmaku: '弹幕',
}

/** 社交流水里的原始 kind（未带 label 时）→ 人读标签。 */
// 两套标签分开：账本用桶名（dyn_share…），社交流水用 kind；查不到就原样显示。
const KIND_LABEL: Record<string, string> = { dyn_share: '转发动态', dyn_pure: '纯动态', dynamic: '动态', video: '投稿' }

/** 本地日（与工具链账本同一套写法）。 */
export function localDayKey(date = new Date()): string {
  return date.toLocaleDateString('sv-SE')
}

// 调用方：index.ts 的 readBiliHistory(biliRoot_(), days)（days 来自查询串，缺省 '7'）。
// 参数：root 是 <world>/bili；days 取 1–90，非法值按 7；now 可注入（测试用）。
// 返回：{ days, recentActions, outboxPreview, totalActions }；没有动作的日子不出现在 recentActions 里，
//       由前端按 days 补「—」。
// 空值：三份文件都可以缺失，缺哪份就少哪份来源，不抛错。
// 【上游参考】账本口径沿用 bili-whale：本地日（sv-SE 的 YYYY-MM-DD）切天、流水 append-only、只留最近若干条。
/**
 * 读最近 `days` 天的 B站动作历史。
 * @param root   B站数据目录（worldDir/bili）
 * @param days   1–90，非法值按 7
 * @param now    当前时间（测试注入用）
 */
export function readBiliHistory(root: string, days: string | number, now = new Date()): BiliHistory {
  // days 夹在 1–90；非数字或 0 按 7 天处理。
  const n = Math.max(1, Math.min(90, Number(days) || 7))
  const daysAgo: string[] = []
  for (let i = 0; i < n; i++) {
    // 用本地日期回退（setDate 而不是减 86400000）：跨夏令时也不会错一天。
    const d = new Date(now)
    d.setHours(12, 0, 0, 0)
    d.setDate(d.getDate() - i)
    daysAgo.push(localDayKey(d))
  }
  const wanted = new Set(daysAgo)
  const byDay = new Map<string, BiliHistoryDay>()
  // 只统计 wanted 里的日子，count<=0 直接忽略；同一天同一标签累加。
  const touch = (day: string, label: string, count = 1): void => {
    if (!wanted.has(day) || count <= 0) return
    const entry = byDay.get(day) ?? { day, total: 0, kinds: {} }
    entry.kinds[label] = (entry.kinds[label] ?? 0) + count
    entry.total += count
    byDay.set(day, entry)
  }

  // ① 社交流水：历史明细。
  try {
    const raw = fs.readFileSync(path.join(root, 'bili-social.jsonl'), 'utf8')
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        const rec = JSON.parse(line) as { day?: unknown; label?: unknown; kind?: unknown }
        if (typeof rec?.day !== 'string') continue
        const rawLabel = String(rec.label ?? rec.kind ?? '动作')
        touch(rec.day, KIND_LABEL[rawLabel] ?? rawLabel)
      } catch { /* 坏行跳过，不拖垮整页历史 */ }
    }
  } catch { /* 没有流水文件 = 没有历史 */ }

  // ② 今天的日计数：覆盖 ①（同一份动作，两边都记过时只算一次）。
  try {
    const acts = JSON.parse(fs.readFileSync(path.join(root, 'bili-actions.json'), 'utf8')) as Record<string, unknown>
    const day = typeof acts?.day === 'string' ? acts.day : ''
    if (wanted.has(day)) {
      const entry: BiliHistoryDay = { day, total: 0, kinds: {} }
      for (const [key, label] of Object.entries(LEDGER_LABEL)) {
        const count = Number(acts[key] ?? 0)
        if (Number.isFinite(count) && count > 0) {
          entry.kinds[label] = count
          entry.total += count
        }
      }
      if (entry.total > 0) byDay.set(day, entry)
    }
  } catch { /* 账本缺失/损坏就只用社交流水 */ }

  let outbox = ''
  try { outbox = fs.readFileSync(path.join(root, 'bili-outbox.md'), 'utf8') } catch { /* 没发过就没有 */ }

  // 按 daysAgo 顺序输出（今天的在前），空白天不占行（前端会遍历 days 补「—」）。
  const recentActions = daysAgo.flatMap(day => {
    const entry = byDay.get(day)
    return entry ? [entry] : []
  })
  return {
    days: daysAgo,
    recentActions,
    outboxPreview: outbox.slice(0, 2000),
    totalActions: recentActions.reduce((sum, entry) => sum + entry.total, 0),
  }
}
