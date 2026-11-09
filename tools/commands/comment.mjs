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
// 【文件头】comment 的 CLI 薄壳：参数检查 → 概率抽签 → 交给 lib/bili-write.mjs 的 postReply 过全部闸门。
// 参数：--bvid 目标视频、--message 评论正文、--go 真发（缺省干跑）、--force 跳过 skipChance 抽签。
// 读写：读 bili.config.json 的 comment 段与凭据；真发时由 bili-write 写 B站，并追加 bili-comments.jsonl、
//       bili-actions.json 计数与 sent-log/sent-at 的风控记录；干跑不写任何文件。
// 输出：结果说明一行打到 stdout，用法错误打 stderr。
// 退出码：0 成功或按概率跳过；1 被闸门/接口拒绝；2 缺少 --bvid 或 --message。
// 坑：抽签排在闸门之前 —— 抽中跳过就直接返回，不会去问额度，也不消耗当日尝试次数。
// 【链路位置】
//   环节：评论支线；act dyn --also-comment 时由 lib/bili-write.mjs 的 shareVideoDynamic 用同一段文案直接调 postReply，不经过本文件。
//   上游调用：她手动跑 `comment --bvid --message`，或 `act comment ...`（act 把子命令之后的参数原样转过来）。
//   下游调用：lib/bili-write.mjs 的 postReply —— 开关/清洗/干跑/dryRun/allowWrite/最小间隔/额度/风控/POST/记账全在那边。
//   读写文件：读 bili.config.json 的 comment 段与凭据；真发时由 bili-write 追加 bili-comments.jsonl、sent-log/sent-at.json、bili-actions.json，并转给 bili-social.jsonl 与 bili-outbox.md。
//   退出码：0 成功或按概率跳过；1 被闸门/接口拒绝；2 缺少 --bvid 或 --message。
//   上游参考：评论接口 /x/v2/reply/add（type=1、oid=aid、plat=1），与 B站 Web 端顶层评论同一条通道。
import { config } from '../lib/config.mjs'
import * as w from '../lib/bili-write.mjs'

// 参数解析与其它命令同一种写法：只认「--name value」，缺值返回空串。
// 【补充】调用方：run() 解析 --bvid / --message / --go / --force；只认「--name value」，缺值返回空串。
//   参数：argv 全文、name 参数名、d 缺值兜底值。
//   返回：字符串值，或 d（参数不存在 / 后面没有值）；不做任何语义校验。
//   失败：不抛错；空串由 run() 判成「参数缺失」并设退出码 2。
function arg(argv, name, d) { const i = argv.indexOf(name); return i >= 0 ? String(argv[i + 1] ?? d) : d }

// 【补充】调用方：tools/bili.mjs 的 comment 命令、act.mjs 的 comment 子命令（argv 已去掉子命令）。
//   参数：--bvid 目标视频、--message 正文、--go 真发、--force 跳过概率抽签。
//   返回：无返回值；结果打 stdout，用法错误打 stderr。
//   失败：设 process.exitCode（0 成功或跳过 / 1 被拒 / 2 参数缺失），不抛异常。
/**
 * comment 子命令入口：参数检查 → 干跑或抽签 → 交给 postReply 发送。
 * @param {string[]} argv CLI 参数
 * @returns {Promise<void>} 结果写 process.exitCode（0 成功或跳过，1 失败，2 参数缺失）。
 */
export async function run(argv = []) {
  const bvid = arg(argv, '--bvid', '')
  const message = arg(argv, '--message', '')
  const go = argv.includes('--go')
  const force = argv.includes('--force')
  // 2 = 调用方式不对，和 1（发送失败）分开，调用方不用去猜失败原因。
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
  // 缺省 0.3 与 night.skipChance 的默认值对齐：没配置时她也该有三成机会选择不开口。
  const skip = Number(cfg.skipChance ?? 0.3)
  // Math.min(1, skip)：配成 2 之类的越界值只当 100%，否则抽签永远不中、--force 也就失去意义。
  if (!force && Number.isFinite(skip) && skip > 0 && Math.random() < Math.min(1, skip)) {
    console.log(`🎲 本轮按跳过概率跳过（skipChance=${skip}）—— 真想发就加 --force`)
    process.exitCode = 0
    return
  }

  const r = await w.postReply(bvid, message, { go: true })
  console.log(r.why || (r.ok ? 'ok' : '失败'))
  process.exitCode = r.ok ? 0 : 1
}
