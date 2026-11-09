// B 站今日额度：把配置里的每日上限与 bili-actions.json 的当天计数合成面板要的 BiliQuota。
//
// 导出：getBiliQuota（控制台 GET /console/bili-quota 经 snapshot.ts 再到 index.ts 调用）。
// 依赖：tools/lib/config.mjs 的 config()/shareDailyLimit()、tools/lib/paths.mjs 的 dataPath()。
// 坑：bili-actions.json 只保存当天，日期对不上时整份计数作废，否则昨天的用量会算进今天；文件缺失或损坏按“今天还没做”处理。
//     类型 BiliQuota 定义在 console/routes.ts，这里只消费它，额度形状不在两处各写一份。
//
// 【链路位置】控制台额度面板的数据源：index.ts 组装 ConsoleSources 时把 getBiliQuota 包成 `biliQuota()`，
// console/snapshot.ts 汇总进快照，console/routes.ts 用 GET /console/bili-quota 下发（不可用时 404）。
// 上游：上限读 bili.config.json（bilibili.dynamic.pureDailyMax、shareDailyLimit，
//       以及 bilibili.share 下的 likeDaily / coinDaily / dailyMax），已用条数读工具链写的 bili-actions.json（只存当天）。
// 下游：tools/lib/paths.mjs 的 dataPath()、tools/lib/config.mjs 的 config() / shareDailyLimit()。
// 读写：只读两个文件，不写；坏文件按「今天还没做」处理。
// 闸门里的位置：面板只负责展示，真正的额度闸在 tools/commands/quota.mjs 的 check()（发之前过），
//       两处共用 shareDailyLimit 这一个口径，避免面板说能发、工具链说不能发。
import fs from 'node:fs'
import path from 'node:path'
import { dataPath } from '../../tools/lib/paths.mjs'
import { config, shareDailyLimit } from '../../tools/lib/config.mjs'
import type { BiliQuota } from '../console/routes.ts'

function actsFile() { return dataPath('bili-actions.json') }

// 本地日键：sv-SE 的 toLocaleDateString 固定输出 YYYY-MM-DD，和账本、心情、history 用同一套写法。
function dayKey(d = new Date()): string { return d.toLocaleDateString('sv-SE') }

// 展示用 JSON 一律容错：读不到或解析失败就返回 fallback，额度面板不能因为一个坏文件整页 500。
function readJson<T>(p: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) as T } catch { return fallback }
}

// 调用方：index.ts 的 `biliQuota: () => { try { return getBiliQuota() } catch { return undefined } }`，
// 再由 console/snapshot.ts 放进快照、console/routes.ts 用 GET /console/bili-quota 下发。
// 参数：无（数据目录与配置由 dataPath() / config() 按 WORLD_ID、WORLD_BILI_DATA_DIR 解析）。
// 返回：{ day, limits, 今天已用的几项 }；已用项只在为正数时出现，缺省由前端按 0 显示。
// 失败/空值：bili-actions.json 缺失、不是 JSON、或 day 对不上今天时，整份计数作废，只返回 limits。
// 【上游参考】额度分桶（dyn_pure / dyn_share / like / coin / danmaku）与默认值沿用 bili-whale 的
// config 口径；转发额度只认 shareDailyLimit（shareDailyMax 优先，没配回落 quota.shareDaily）。
/**
 * 读今天的 B 站额度：上限来自配置，已用条数来自当天的 bili-actions.json。
 * 没有参数，数据目录与配置分别由 dataPath()/config() 定位。
 * @returns 今日额度；`limits` 是各项上限，`dyn_pure` 等字段只在今天已有计数且大于 0 时出现。
 *   文件缺失或 JSON 损坏不抛错，按“今天还没有动作”返回。
 */
export function getBiliQuota(): BiliQuota {
  const c = config()
  const bilibili = (c as any)?.bilibili || {}
  const dyn = bilibili.dynamic || {}
  const react = bilibili.react || {}
  const danmaku = bilibili.danmaku || {}
  // 各项默认值与工具链一致：纯动态 2、点赞 10、投币 1、弹幕 5（bili.config.json 没配时用）。
  // 0.9.0：点赞/投币/弹幕改成读 bilibili.react.* / bilibili.danmaku.* —— 与 bili-write 的闸门同一段配置。
  // 以前这里读 bilibili.share.likeDaily，而闸门读 react.likeDaily：面板显示的和实际拦的不是一个数。
  const limits = {
    dyn_pure: Number(dyn.pureDailyMax ?? 2),
    // 与 quota 闸、bili-write 同一口径（shareDailyLimit）：shareDailyMax 优先，没配回落 quota.shareDaily。
    dyn_share: shareDailyLimit(c),
    like: Number(react.likeDaily ?? 10),
    coin: Number(react.coinDaily ?? 1),
    danmaku: Number(danmaku.dailyMax ?? 5),
  }
  const acts = readJson<Record<string, any>>(actsFile(), {})
  const today = dayKey()
  const todayActs = acts.day === today ? acts : {}
  const result: BiliQuota = { day: today, limits }
  // 只认正数：0、负数和非数字都当“今天没有这项计数”，保留上面的默认上限。
  for (const k of ['dyn_pure', 'dyn_share', 'like', 'coin', 'danmaku'] as const) {
    const v = todayActs[k]
    if (typeof v === 'number' && v > 0) (result as any)[k] = v
  }
  return result
}
