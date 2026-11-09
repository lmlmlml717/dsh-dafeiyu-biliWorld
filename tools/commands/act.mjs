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
// 【文件头】act 的 CLI 薄壳：只做子命令分发、参数解析和闸门顺序，发送逻辑全在 lib/bili-write.mjs。
// 参数：argv[0] 是子命令（dyn/comment/help）；--text 文案、--bvid 目标视频、--score 0-20 打分、--go 真发（缺省干跑）、
//       --also-comment / --no-comment 覆盖配置里"转发时同时评论"的开关。
// 读写：读 bili.config.json、session.json、bili-actions.json、quota.json、凭据；成功真发时写 quota.json 与 session.json，
//       B站那边由 bili-write 负责；干跑不写任何账。
// 输出：结果说明一行打到 stdout，用法错误打 stderr。
// 退出码：0 成功或干跑通过；1 被闸门/接口拒绝；2 参数缺失（纯动态没给 --text）。
// 坑：闸门顺序不能换 —— session 检查在额度之前，额度又在真发之前；先发后记账漏一次，额度就永远少算一条。
// 【链路位置】
//   环节：链路第 3 步「动作」，prompt 里先干跑 `act dyn --bvid ... --score ...`，确认后加 --go 真发。
//   上游调用：debrief 输出里的 SCORE 填进 --score，feed 选的 BV 填进 --bvid；prompt 要求她把 act dyn 的返回原文贴回给主人。
//   下游调用：lib/session-limit.mjs（checkSession/incSession）、commands/quota.mjs（check/record）、lib/bili-write.mjs（postDynamic / shareVideoDynamic）。
//   读写文件：读 bili.config.json、session.json、bili-actions.json、quota.json、凭据；真发成功写 quota.json 与 session.json，评论另写 bili-comments.jsonl。
//   闸门顺序（不能换）：session 窗口 → minScore → quota.check → bili-write 内的 guard.dryRun / dynamic.enabled / 日额度 / 风控 → 真发 → 记账。
//   退出码：0 成功或干跑通过；1 被闸门或接口拒绝；2 参数缺失（纯动态没给 --text）。
//   上游参考：转发同时评论的请求体照 PiliPlus 的 lib/http/dynamics.dart createDynamic；评论走 /x/v2/reply/add。
import * as w from '../lib/bili-write.mjs'
import { config } from '../lib/config.mjs'
import * as sessionLimit from '../lib/session-limit.mjs'
import * as quota from './quota.mjs'

// 参数解析只认「--name value」这一种写法（仓库里所有命令统一）；同名参数重复出现取第一次。
// 值缺失时返回 d，调用方靠它区分"没给"和"给了空串"。
// 【补充】调用方：run() 解析 dyn 的 --bvid / --text / --score；只认「--name value」，同名参数取第一次。
//   参数：argv 全文、name 参数名、d 缺值时的兜底值（调用方靠它区分「没给」和「给了空串」）。
//   返回：字符串值，或 d（参数不存在 / 后面没有值）。
//   失败：不抛错、不校验语义；语义校验在 run() 里各自做。
function arg(argv, name, d) { const i = argv.indexOf(name); return i >= 0 ? String(argv[i + 1] ?? d) : d }
const has = (argv, name) => argv.includes(name)

// 【补充】调用方：tools/bili.mjs 动态 import 后调 run(process.argv.slice(3))；argv[0] 是子命令。
//   参数：dyn 的 --bvid / --text / --score / --go / --also-comment / --no-comment；comment 子命令整体转交 comment.mjs。
//   返回：无返回值；结果打 stdout，用法错误打 stderr，被闸门拦下的原因也打 stdout（她能读到）。
// 返回：没有返回值；被闸门拦下或调用方式不对时设 process.exitCode（1 拦截 / 2 参数错），不把异常抛给入口。
/**
 * act 子命令统一入口。
 * @param {string[]} argv CLI 参数
 */
export async function run(argv = []) {
  // 不带子命令时当 help：只打用法，不当成错误。
  const sub = argv[0] || 'help'
  // --go 只决定真发还是干跑；干跑同样要先过 session 与 minScore，好让人提前看到"--go 也会被拒"。
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
    // 空串转 NaN 而不是 0：下面靠 Number.isFinite 区分"根本没给分"和"给了 0 分"，这两种处理不同。
    const score = scoreRaw ? Number(scoreRaw) : NaN
    // 带 bvid 就是转发视频动态，不带就是纯文字动态 —— 两条路共用同一份 session 配额。
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
      // 【口径】额度闸直接 import commands/quota.mjs 的 check，与 `quota show` 读同一份 quota.json；日上限只有 lib/config.mjs 的 shareDailyLimit 一处定义。
      // ── ③ 额度闸：今天发了几条 / 这条视频 N 天内发过没有（与 feed 去重同源 quota.json）──
      const gate = quota.check({ type: 'share', target: bvid })
      if (!gate.ok) { console.log(gate.why || '额度闸未过'); process.exitCode = 1; return }
      // 是否同时评论：--also-comment / --no-comment 覆盖配置；都不写就按 bili.config.json 的
      // bilibili.dynamic.alsoComment（默认关）。
      const also = has(argv, '--also-comment') ? true : has(argv, '--no-comment') ? false : undefined
      // 【上游参考】转发动态走 /x/dynamic/feed/create/dyn（scene=5 + web_repost_src.revs_id），请求体照 PiliPlus 的 createDynamic；
      //   勾了 --also-comment 时，bili-write 在动态成功后按同一段文案再调 /x/v2/reply/add 发一条顶层评论。
      let r
      try {
        r = await w.shareVideoDynamic(bvid, text, { go, ...(also === undefined ? {} : { alsoComment: also }) })
      } catch (error) {
        // 0.9.0：写通道里的异常（读不到视频、没凭据、网络断）在这里收成一句人话，
        // 不要把堆栈直接吐给她 —— 命令层崩掉和"这条没发出去"是两回事。
        console.log(`这条没发出去：${String(error?.message ?? error).slice(0, 120)}`)
        process.exitCode = 1
        return
      }
      // ── ④ 成功后记账：日额度 + sameVideoDays 去重都进 quota.json（发成功才算，干跑不记）──
      if (r.ok && !r.dry) {
        sessionLimit.incSession('share')
        // 记账失败不能把已经发出去的那条变成"失败"：它已经发出去了，只是本地少记一笔。
        try { quota.record({ type: 'share', target: bvid }) } catch { console.log('（本地账本没写成，不影响刚才发出去的那条）') }
      }
      console.log(r.why || (r.ok ? 'ok' : '失败'))
      if (r.comment) {
        console.log(r.comment.ok
          ? `  评论：已发（rpid=${r.comment.rpid || '?'}）`
          : `  评论：未发 — ${r.comment.why || (r.comment.code !== undefined ? 'code=' + r.comment.code : '未知原因')}`)
      }
      process.exitCode = r.ok ? 0 : 1; return
    } else {
      // 2 表示"调用方式不对"，与 1（被闸门或接口拒绝）分开，失败原因不混。
      if (!text) { console.error('用法：act dyn --text "…" [--score N] [--go]  或  act dyn --bvid <BV> --text "…" --score N [--go]'); process.exitCode = 2; return }
      let r
      try {
        r = await w.postDynamic(text, { go })
      } catch (error) {
        // 和转发那条一样：网络/凭据异常收成一句人话，不吐堆栈。
        console.log(`这条没发出去：${String(error?.message ?? error).slice(0, 120)}`)
        process.exitCode = 1
        return
      }
      // ── ④ 成功后记 session 计数 ──
      // 0.8.24 修：干跑（postDynamic 返回 ok:true + dry:true）不能占名额。
      // 之前只判 r.ok，于是「先干跑一遍再真发」会白吃一条纯动态名额；转发那条本来就有 !r.dry，这里漏了。
      if (r.ok && !r.dry) sessionLimit.incSession('pure')
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

  // 未识别的子命令（含上面被注释掉的 danmaku/like/coin/pic/follow）都走到这里：只打用法，不改退出码。
  console.log('用法：act dyn --text "…" [--score N] [--go]  或  act dyn --bvid <BV> --text "…" --score N [--go]')
}
