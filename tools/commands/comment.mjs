// comment —— 给视频发一条顶层评论（不回复任何人、不做楼中楼）。
//
//   node bili.mjs comment --bvid BV1xx --message "…"               # 干跑：只打印不真发
//   node bili.mjs comment --bvid BV1xx --message "…" --go          # 真发（还要评论开关、dailyBili.allowWrite、guard.dryRun=false）
//   node bili.mjs comment --bvid BV1xx --message "…" --go --force  # 跳过概率抽签，强制发
//
// 闸门顺序（开关/清洗/干跑/dryRun/allowWrite/额度/风控/发送/记账）都在 lib/bili-write.mjs 的 postReply 里；
// 本文件只负责：参数、开关提示、概率抽签（语义同 night.skipChance）。
//
// 退出码用 process.exitCode 而不是 process.exit()：真发之后进程里还挂着 fetch
// 的连接，Windows + Node 24 立刻 process.exit() 会 libuv 断言崩溃（-1073740791），
// 让已经发出去的评论看起来像失败。自然退出即可。
import { config } from '../lib/config.mjs'
import * as w from '../lib/bili-write.mjs'

function arg(argv, name, d) { const i = argv.indexOf(name); return i >= 0 ? String(argv[i + 1] ?? d) : d }

export async function run(argv = []) {
  const bvid = arg(argv, '--bvid', '')
  const message = arg(argv, '--message', '')
  const go = argv.includes('--go')
  const force = argv.includes('--force')
  if (!bvid || !message) {
    console.error('用法：comment --bvid <BV> --message "…" [--go] [--force]')
    process.exitCode = 2
    return
  }

  const cfg = config().comment ?? {}
  // 干跑永远可看，不抽签、不占额度
  if (!go) {
    const r = await w.postReply(bvid, message, { go: false })
    console.log(r.why || '?')
    process.exitCode = r.ok ? 0 : 1
    return
  }

  // 概率抽签：skipChance 与作息同一语义（0.3 = 30% 概率这次不动手）
  const skip = Number(cfg.skipChance ?? 0.3)
  if (!force && Number.isFinite(skip) && skip > 0 && Math.random() < Math.min(1, skip)) {
    console.log(`🎲 本轮按跳过概率跳过（skipChance=${skip}）—— 真想发就加 --force`)
    process.exitCode = 0
    return
  }

  const r = await w.postReply(bvid, message, { go: true })
  console.log(r.why || (r.ok ? 'ok' : '失败'))
  process.exitCode = r.ok ? 0 : 1
}
