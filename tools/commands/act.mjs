// act —— B站「活人感」动作统一入口（核心版：只保留动态）。
//
// 【当前启用的子命令】
//   dyn  —— 动态入口：带 --bvid 走转发视频动态（scene=4），否则走纯文字动态（scene=1）
//
// 【执行顺序（硬拦截链）】
//   ① sessionLimit.checkSession() —— 时间窗口 + session target（本次 fire 上限）
//   ② minScore 硬检查              —— 转发视频必须带 --score，过不了 minScore 拒绝
//   ③ bili-write.postDynamic / shareVideoDynamic —— 日额度账本 + guard 风控 + 真发
//   ④ sessionLimit.incSession()    —— 成功后记 session 计数
//
// 【暂时注释掉的子命令】（按需启用，保留代码不删除）
//   danmaku / like / coin / pic / follow —— 全部注释在文件末尾
//
//   node bili.mjs act dyn --text "…" --score 15 [--go]             # 纯文字动态
//   node bili.mjs act dyn --bvid BV1xx --text "…" --score 17 [--go] [--also-comment|--no-comment]
//                                                                  # 转发视频到动态；--also-comment 同时评论
import * as w from '../lib/bili-write.mjs'
import { config } from '../lib/config.mjs'
import * as sessionLimit from '../lib/session-limit.mjs'
import * as quota from './quota.mjs'

function arg(argv, name, d) { const i = argv.indexOf(name); return i >= 0 ? String(argv[i + 1] ?? d) : d }
const has = (argv, name) => argv.includes(name)

/**
 * act 子命令统一入口。
 * @param {string[]} argv CLI 参数
 */
export async function run(argv = []) {
  const sub = argv[0] || 'help'
  const go = has(argv, '--go')
  const cfg = config()

  // 评论统一走 commands/comment.mjs（带概率抽签与评论专用闸门）
  if (sub === 'comment') {
    const { run: runComment } = await import('./comment.mjs')
    return runComment(argv.slice(1))
  }

  if (sub === 'dyn') {
    const bvid = arg(argv, '--bvid', '')
    const text = arg(argv, '--text', '')
    const scoreRaw = arg(argv, '--score', '')
    const score = scoreRaw ? Number(scoreRaw) : NaN
    const isShare = Boolean(bvid)

    // ── ① session 硬检查（时间窗口 + 本次 fire 上限 + 每日总上限，一次性查完）──
    const sCheck = sessionLimit.checkSession(isShare ? 'share' : 'pure')
    if (!sCheck.ok) { console.log(sCheck.why || 'session 检查未过'); process.exitCode = 1; return }

    if (isShare) {
      // ── ② minScore 硬检查（转发必须过线）──
      const minScore = Number(cfg.bilibili?.share?.minScore ?? 0)
      if (minScore > 0) {
        if (!Number.isFinite(score)) {
          console.log(`act dyn --bvid 需要 --score <0-20> 参数。先跑 debrief --bvid 看 BILI_ACTION 块打分。`); process.exitCode = 1; return
        }
        if (score < minScore) {
          console.log(`score=${score} < minScore=${minScore}，这条不值得转发。`); process.exitCode = 1; return
        }
      }
      // ── ③ 额度闸：今天发了几条 / 这条视频 N 天内发过没有（与 feed 去重同源 quota.json）──
      const gate = quota.check({ type: 'share', target: bvid })
      if (!gate.ok) { console.log(gate.why || '额度闸未过'); process.exitCode = 1; return }
      // 是否同时评论：--also-comment / --no-comment 覆盖配置；都不写就按 bili.config.json 的
      // bilibili.dynamic.alsoComment（默认关）。
      const also = has(argv, '--also-comment') ? true : has(argv, '--no-comment') ? false : undefined
      const r = await w.shareVideoDynamic(bvid, text, { go, ...(also === undefined ? {} : { alsoComment: also }) })
      // ── ④ 成功后记账：日额度 + sameVideoDays 去重都进 quota.json（发成功才算，干跑不记）──
      if (r.ok && !r.dry) { sessionLimit.incSession('share'); quota.record({ type: 'share', target: bvid }) }
      console.log(r.why || (r.ok ? 'ok' : '失败'))
      if (r.comment) {
        console.log(r.comment.ok
          ? `  评论：已发（rpid=${r.comment.rpid || '?'}）`
          : `  评论：未发 — ${r.comment.why || (r.comment.code !== undefined ? 'code=' + r.comment.code : '未知原因')}`)
      }
      process.exitCode = r.ok ? 0 : 1; return
    } else {
      if (!text) { console.error('用法：act dyn --text "…" [--score N] [--go]  或  act dyn --bvid <BV> --text "…" --score N [--go]'); process.exitCode = 2; return }
      const r = await w.postDynamic(text, { go })
      // ── ④ 成功后记 session 计数 ──
      if (r.ok) sessionLimit.incSession('pure')
      console.log(r.why || (r.ok ? 'ok' : '失败')); process.exitCode = r.ok ? 0 : 1; return
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // 以下子命令暂时注释掉，保留代码不删除。需要时把注释解开即可。
  // ════════════════════════════════════════════════════════════════════════
  /*
  if (sub === 'danmaku') {
    const bvid = arg(argv, '--bvid'); const text = arg(argv, '--text')
    if (!bvid || !text) { console.error('用法：act danmaku --bvid <BV> --text "…" [--at 秒] [--go]'); process.exit(2) }
    const r = await w.sendDanmaku(bvid, text, { go, atSec: Number(arg(argv, '--at', 0)) || 0 })
    console.log(r.why || (r.ok ? 'ok' : '失败')); process.exit(r.ok ? 0 : 1)
  }

  if (sub === 'like') {
    const bvid = arg(argv, '--bvid')
    if (!bvid) { console.error('用法：act like --bvid <BV> [--go]'); process.exit(2) }
    const r = await w.likeVideo(bvid, { go }); console.log(r.why || '?'); process.exit(r.ok ? 0 : 1)
  }

  if (sub === 'coin') {
    const bvid = arg(argv, '--bvid')
    if (!bvid) { console.error('用法：act coin --bvid <BV> [--num 1] [--go]'); process.exit(2) }
    const r = await w.coinVideo(bvid, { go, num: Math.min(2, Number(arg(argv, '--num', 1)) || 1) })
    console.log(r.why || '?'); process.exit(r.ok ? 0 : 1)
  }

  if (sub === 'pic') {
    const bvid = arg(argv, '--bvid'); const message = arg(argv, '--message'); const image = arg(argv, '--image')
    if (!bvid || !message || !image) { console.error('用法：act pic --bvid <BV> --message "…" --image <图片路径> [--go]'); process.exit(2) }
    const r = await w.commentWithPicture(bvid, message, image, { go })
    console.log(r.why || '?'); process.exit(r.ok ? 0 : 1)
  }

  if (sub === 'follow') {
    const bvid = arg(argv, '--bvid'); const mid = arg(argv, '--mid')
    if (!bvid && !mid) { console.error('用法：act follow --bvid <BV> 或 --mid <数字mid> [--go]'); process.exit(2) }
    const target = mid || (await w.videoInfo(bvid)).ownerMid
    const r = await w.followUser(target, { go }); console.log(r.why || '?'); process.exit(r.ok ? 0 : 1)
  }
  */

  console.log('用法：act dyn --text "…" [--score N] [--go]  或  act dyn --bvid <BV> --text "…" --score N [--go]')
}
