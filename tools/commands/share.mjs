// share —— 把「想给你看这条视频」放进队列，宿主那条 QQ 线会带着标题和 BV 发给他。
//
//   node bili.mjs share --bvid BV1xx411c7mD --say "这个笑得我停不下来"
//   node bili.mjs share --bvid BV1xx411c7mD --title "手写标题" --say "…"
//   node bili.mjs share --url "https://www.bilibili.com/video/BV1xx411c7mD" --say "…"
//   node bili.mjs share --list          # 看队列里有什么、哪些已经发出去了
// 【文件头】share 的 CLI：把一条视频分享写进 owner-outbox.jsonl，别的什么都不做。
// 参数：--bvid / --url 二选一（都没给就报用法）；--title 缺省时现查一次 B站 元信息（查不到就用 BV 兜着）；
//       --say 是她想说的那句话（可省）；--list 只看队列；--json 给 agent 拿结构化结果。
// 读写：只追加 <数据根>/owner-outbox.jsonl；--list 另读 owner-outbox.jsonl.sent.json；不碰凭据以外的配置。
// 输出：一行中文说明打 stdout；--json 时打一条 JSON。
// 退出码：0 已进队列；1 进队列失败（写盘错）；2 参数不合法（没有 BV）。
// 坑：这条命令**不往外发任何东西** —— 真发由宿主的 QQ 通道做，所以不需要 --go，也不受 guard.dryRun 管。
// 【链路位置】
//   环节：B站 分享旁路的第一段：她决定分享 → CLI 落一条记录 → 宿主 qq-native 轮询到 → 私聊发给主人。
//   上游调用：她的会话里按 prompt 的提示执行；也用于人工排查（share --list 看积压）。
//   下游调用：lib/owner-share.mjs（拼记录/写文件）、lib/bili-api.mjs（只在缺标题时查元信息）、lib/cred.mjs。
//   读写文件：<数据根>/owner-outbox.jsonl（追加）；<数据根>/owner-outbox.jsonl.sent.json（--list 只读）。
//   输出与退出码：0 进队列 / 1 写盘失败 / 2 参数不合法；不发网络写操作。
import { appendShare, deliveredIds, readShares, toBvid } from '../lib/owner-share.mjs'

// 【补充】调用方：run() 解析 --bvid / --url / --title / --say；只取「--name value」。
//   参数：argv 全文、参数名。返回：字符串值或 undefined（参数不存在 / 后面没跟值）。
function arg(argv, name) {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

// 【补充】调用方：run() 在缺 --title 时调一次。
//   参数：bvid。返回：标题字符串；查不到返回 ''（不抛错 —— 没有标题也要能进队列）。
//   失败：凭据缺失、接口不通、风控熔断都吞掉，只是少一个标题。
async function fetchTitle(bvid) {
  try {
    const { loadCred } = await import('../lib/cred.mjs')
    const { apiGet, makeHeaders } = await import('../lib/bili-api.mjs')
    const url = new URL('https://api.bilibili.com/x/web-interface/view')
    url.searchParams.set('bvid', bvid)
    const view = await apiGet(url.href, makeHeaders(loadCred()))
    return Number(view?.code) === 0 ? String(view?.data?.title ?? '') : ''
  } catch { return '' }
}

// 【补充】调用方：--list。读队列 + 通道写回的已发 id，打最近 10 条。
//   返回：无。输出到 stdout：每行「✓ 已发出 / · 在排队 + 时间 + 标题 + 她的话」。
function list() {
  const records = readShares()
  if (!records.length) { console.log('队列是空的：还没有哪条视频在等他看。'); return }
  const sent = deliveredIds()
  for (const record of records.slice(-10)) {
    const mark = sent.has(record.id) ? '✓ 已发出' : '· 在排队'
    const time = String(record.at ?? '').slice(11, 16)
    const title = record.title ? `《${record.title}》` : record.bvid
    console.log(`${mark}  ${time}  ${title}${record.say ? ` —— ${record.say}` : ''}`)
  }
}

// 【补充】调用方：tools/bili.mjs 动态 import 后调 run(process.argv.slice(3))。
//   参数：--bvid / --url / --title / --say / --list / --json。
//   返回：无返回值；结果打 stdout，进队列刷新在 status 行里。
//   失败：没有 BV 报用法并 exitCode=2；写盘失败 exitCode=1。用 exitCode 而不是 process.exit（本命令可能查过元信息）。
/**
 * share 入口：把一条视频分享放进「等他看」的队列。
 * @param {string[]} argv --bvid/--url（二选一）、--title、--say、--list、--json
 * @returns {Promise<void>} 结果直接打印，不返回数据。
 */
export async function run(argv = []) {
  const json = argv.includes('--json')
  if (argv.includes('--list') || argv[0] === 'list') { list(); return }

  // 认 BV：--bvid 优先，其次从 --url 里抠。两个都没有就别猜，直接报用法。
  const bvid = toBvid(arg(argv, '--bvid')) ?? toBvid(arg(argv, '--url'))
  if (!bvid) {
    console.error('用法：node bili.mjs share --bvid BV1xx411c7mD [--title "…"] [--say "你想说的那句话"]')
    console.error('      node bili.mjs share --list      # 看队列里有什么')
    process.exitCode = 2
    return
  }

  const say = String(arg(argv, '--say') ?? '').trim()
  // 标题给了就用给的；没给才查一次接口 —— 她多半不会记得标题，但链接本身还是能点开。
  const title = String(arg(argv, '--title') ?? '').trim() || await fetchTitle(bvid)

  let result
  try {
    result = appendShare({ bvid, title, say })
  } catch (error) {
    const message = String(error?.message ?? error).slice(0, 120)
    if (json) console.log(JSON.stringify({ ok: false, error: message }))
    else console.log(`✗ 没能放进队列：${message}`)
    process.exitCode = 1
    return
  }

  const record = result.record
  if (json) {
    console.log(JSON.stringify({ ok: true, duplicate: result.duplicate, ...record }))
    return
  }
  console.log(result.duplicate
    ? `已经在队列里了：《${record.title || record.bvid}》${record.bvid}`
    : `已经放好了：《${record.title || record.bvid}》${record.bvid}`)
  if (!record.title) console.log('（没查到标题，BV 照样能用。）')
}
