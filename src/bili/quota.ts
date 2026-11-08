import fs from 'node:fs'
import path from 'node:path'
import { dataPath } from '../../tools/lib/paths.mjs'
import { config } from '../../tools/lib/config.mjs'
import type { BiliQuota } from '../console/routes.ts'

function actsFile() { return dataPath('bili-actions.json') }

function dayKey(d = new Date()): string { return d.toLocaleDateString('sv-SE') }

function readJson<T>(p: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) as T } catch { return fallback }
}

export function getBiliQuota(): BiliQuota {
  const c = config()
  const bilibili = (c as any)?.bilibili || {}
  const dyn = bilibili.dynamic || {}
  const share = bilibili.share || {}
  const limits = {
    dyn_pure: Number(dyn.pureDailyMax ?? 2),
    dyn_share: Number(dyn.shareDailyMax ?? 0),
    like: Number(share.likeDaily ?? 10),
    coin: Number(share.coinDaily ?? 1),
    danmaku: Number(share.dailyMax ?? 5),
  }
  const acts = readJson<Record<string, any>>(actsFile(), {})
  const today = dayKey()
  const todayActs = acts.day === today ? acts : {}
  const result: BiliQuota = { day: today, limits }
  for (const k of ['dyn_pure', 'dyn_share', 'like', 'coin', 'danmaku'] as const) {
    const v = todayActs[k]
    if (typeof v === 'number' && v > 0) (result as any)[k] = v
  }
  return result
}
