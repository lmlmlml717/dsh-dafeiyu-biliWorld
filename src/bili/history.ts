// B站操作历史 —— 控制台「历史账本」的数据源。
//
// 两个文件各有一半事实：
//   · bili-actions.json —— 工具链的实时日计数，**只保存当天**（{day, dyn_share, dyn_pure, comment…}），
//     所以它只能证明「今天做了什么」，不是历史。
//   · bili-social.jsonl —— append-only 流水，每条带 ts / day / label，是唯一保留跨天明细的账本。
//
// 这里按本地日（与账本、心情、session-limit 的 toLocaleDateString('sv-SE') 一致）汇总：
// 社交流水出历史，今天的计数再被 bili-actions.json 覆盖一次（它更权威，也避免两边叠加重复计数）。
import fs from 'node:fs'
import path from 'node:path'

export interface BiliHistoryDay {
  day: string
  total: number
  /** 「转发动态」「评论」…→ 当天条数。 */
  kinds: Record<string, number>
}
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
const KIND_LABEL: Record<string, string> = { dyn_share: '转发动态', dyn_pure: '纯动态', dynamic: '动态', video: '投稿' }

/** 本地日（与工具链账本同一套写法）。 */
export function localDayKey(date = new Date()): string {
  return date.toLocaleDateString('sv-SE')
}

/**
 * 读最近 `days` 天的 B站动作历史。
 * @param root   B站数据目录（worldDir/bili）
 * @param days   1–90，非法值按 7
 * @param now    当前时间（测试注入用）
 */
export function readBiliHistory(root: string, days: string | number, now = new Date()): BiliHistory {
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
