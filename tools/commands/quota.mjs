// quota —— 额度账本：分享每天 ≤ shareDaily、同一视频 sameVideoDays 天只发一次。
// 复用 dsh-bili-whale / dsh-feiyu 的账本思路（quota.json + check/record），克制是活下来的前提。
//
//   node bili.mjs quota check  --type share --target BV1xxxx
//   node bili.mjs quota record --type share --target BV1xxxx --note "…"
//   node bili.mjs quota show
//
// 纯函数（check / record）供 act 等写通道直接 import：CLI 的 run() 只是薄壳。
// 【文件头】quota 的 CLI 与纯函数：额度账本的 check / record / show；act、comment 等写通道直接 import 这两个函数。
// 参数：argv[0] 子命令（check/record/show，缺省 show）；--type share|comment、--target BV 号或会话 id、
//       --note 备注（进账本，截 60 字）。
// 读写：只读写 <world 数据目录>/quota.json，原子写（先写 .tmp 再 rename）；不联网、不读凭据。
// 输出：check 打结果与理由，record 打记没记上，show 打今日汇总与最近 10 条。
// 退出码：0 正常；check 判定不可发时 exit(1)（本命令没有挂起的网络句柄，可以直接退）。
// 坑：日志只留最近 400 条 —— 按条数截断而不是按天，长期不跑会把更老的账一起挤掉。
// 【链路位置】
//   环节：链路第 4 步「额度与账本」；发之前 act 先调 check，发成功后再调 record，收工时 `quota show` 对账。
//   上游调用：tools/commands/act.mjs 直接 import check/record；宿主 src/bili/quota.ts 与控制台只读同一份 quota.json。
//   下游调用：lib/paths.mjs 的 dataPath、lib/config.mjs 的 config/shareDailyLimit；不联网、不读凭据。
//   读写文件：<数据根>/quota.json —— 原子写（先写 .tmp 再 rename），日志只留最近 400 条；record 期间另有一个 quota.json.lock。
//   退出码：0 正常；check 判定不可发时 process.exit(1)（本命令不挂网络句柄，可以直接退）。
//   口径：shareDailyLimit(cfg) 是唯一额度口径 —— 面板 bilibili.dynamic.shareDailyMax 优先，缺省回落 quota.shareDaily。
import fs from 'node:fs'
import { dataPath } from '../lib/paths.mjs'
import { config, shareDailyLimit } from '../lib/config.mjs'

// 【补充】调用方：read()/write()/withLock() 用来定位账本与锁文件；测试改 WORLD_BILI_DATA_DIR 后每次都能拿到新目录。
//   参数：无。返回：<数据根>/quota.json 的绝对路径。
//   失败：不抛错；dataPath 只拼字符串，不检查文件是否存在。
/** 每次调用都重新解析路径：测试里换 WORLD_BILI_DATA_DIR 也拿得到对的目录。 */
const quotaFile = () => dataPath('quota.json')
// 用 sv-SE 的日期格式当"本地日"的键：它恰好是 YYYY-MM-DD，跨平台、跨时区都不用自己拼。
const dayOf = (v = Date.now()) => new Date(v).toLocaleDateString('sv-SE')

function read() {
  try {
    const j = JSON.parse(fs.readFileSync(quotaFile(), 'utf8'))
    return j && typeof j === 'object' ? j : { log: [] }
  } catch { return { log: [] } }
}
// 先写临时文件再 rename：并发读到半截 JSON 会让账本整体退回空账，比丢一条记录严重得多。
function write(q) {
  fs.mkdirSync(dataPath(), { recursive: true })
  const temp = quotaFile() + '.' + process.pid + '.tmp'
  fs.writeFileSync(temp, JSON.stringify(q, null, 1) + '\n')
  fs.renameSync(temp, quotaFile())
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

// 【补充】调用方：check()/record()/show 三处；并发 record 用 .lock 文件互斥，最多试 3 次、每次等 120ms。
//   参数：work 是一个同步函数，拿锁期间执行；返回 work 的返回值。
//   失败：抛错直接透传；拿不到锁 3 次后仍然执行 work（宁可少一条账，也不让记账失败挡住已发出的动作）。
/**
 * 同一份账本的低成本互斥：并发 fire（定时 + 手动触发）可能同时 record。
 * 拿不到锁就等 120ms 重试；实在拿不到也照记 —— 全量写最多丢一条，别让记账失败挡已经发出去的动作。
 */
function withLock(work) {
  const lock = quotaFile() + '.lock'
  for (let attempt = 0; attempt < 3; attempt++) {
    let fd
    try { fd = fs.openSync(lock, 'wx') } catch (e) { if (e && e.code === 'EEXIST') { sleep(120); continue } throw e }
    try { return work() }
    finally { try { fs.closeSync(fd) } catch {}; try { fs.rmSync(lock, { force: true }) } catch {} }
  }
  return work()
}

/**
 * 发之前过闸。返回 { ok, why }；ok=false 时 why 是可念给人听的理由。
 * @param {{type?:string, target?:string, cfg?:any, now?:number}} o
 */
// 【上游参考】「每日分享上限 + 同一视频 sameVideoDays 天只发一次」这两条规则来自 dsh-bili-whale / dsh-feiyu 的 quota.json 账本；
//   本仓库只把日上限的口径统一到 lib/config.mjs 的 shareDailyLimit。
// 【补充】调用方：act.mjs 的转发闸、quota 命令的 check、show 里的额度汇总；测试可注入 cfg 与 now。
//   参数：type 目前只区分 share 与其它（只有 share 计入分享额度）；target 为空表示不按视频去重；now 用于测试固定时间。
//   返回：{ ok, why }；ok=false 时 why 是能念给人听的中文理由。
//   失败：不抛错；账本读不到按空账处理（read() 的兜底），宁可放行也不因读盘失败卡死发送。
export function check({ type = 'share', target = '', cfg, now = Date.now() } = {}) {
  const c = cfg || config()
  const sharesToday = read().log.filter(x => x.share && dayOf(x.at) === dayOf(now)).length
  // 与 bili-write / 面板同一口径：UI 的 shareDailyMax 优先，没配才回落 quota.shareDaily。
  const limit = shareDailyLimit(c)
  if (limit > 0 && sharesToday >= limit) return { ok: false, why: '今天发不出去了', detail: `今天已分享 ${sharesToday}/${limit} 条 —— 额度用完，明天再来` }
  if (target) {
    const days = Number(c.quota?.sameVideoDays ?? 7)
    if (days > 0) {
      // 滚动窗口而不是自然日，和 feed 的去重口径保持一致（86400_000 = 一天的毫秒数）。
      const cutoff = now - days * 86400_000
      const dup = read().log.find(x => x.target === target && new Date(x.at).getTime() >= cutoff)
      if (dup) return { ok: false, why: '这条已经发过了', detail: `这条视频 ${dayOf(dup.at)} 已发过 —— ${days} 天内同一视频只发一次` }
    }
  }
  return { ok: true, why: '可以发', detail: `可发（今天 ${sharesToday}/${limit > 0 ? limit : '∞'}）` }
}

// 入参 { type, target, note, cfg }：target 为空表示不按视频去重，cfg 给测试用。
// 【补充】调用方：act.mjs 真发成功后（`r.ok && !r.dry`）、quota record 子命令。
//   参数：target 为空表示不按视频去重；note 截 60 字进账本；cfg 给测试用。
//   返回：true = 记上了；false = 同一 target 在 sameVideoDays 窗口内已有记录（并发火的后到者会看到先到者的账）。
//   失败：withLock 抛错会透传；写盘失败也会抛 —— 记账失败宁可让调用方看到，不吞。
/**
 * 发成功之后记账。同一目标在窗口内已有记录就不重复记（并发火的后到者会看到先到者的账）。
 * @returns {boolean} true = 记上了；false = 已在这笔账里。
 */
export function record({ type = 'share', target = '', note = '', cfg } = {}) {
  return withLock(() => {
    if (target) {
      const days = Number((cfg || config()).quota?.sameVideoDays ?? 7)
      if (days > 0) {
        const cutoff = Date.now() - days * 86400_000
        if (read().log.some(x => x.target === target && new Date(x.at).getTime() >= cutoff)) return false
      }
    }
    const q = read()
    q.log.push({ at: new Date().toISOString(), type, target, note: String(note).slice(0, 60), share: type === 'share' })
    // 只留最近 400 条：账本要长期活着，但没人会翻那么久以前的记录，留多了只是让读写变慢。
    q.log = q.log.slice(-400)
    write(q)
    return true
  })
}

function arg(argv, name) {
  const i = argv.indexOf(name)
  return i >= 0 ? String(argv[i + 1] ?? '') : ''
}

/**
 * quota 子命令入口（薄壳）：解析参数后交给 check / record / show。
 * @param {string[]} argv CLI 参数
 * @returns {void}
 */
export function run(argv = []) {
  // 不带子命令默认 show：先看清今天还剩多少额度，再决定要不要发。
  const cmd = argv[0] ?? 'show'

  if (cmd === 'check') {
    const result = check({ type: arg(argv, '--type') || 'share', target: arg(argv, '--target') })
    console.log(`${result.ok ? '✓' : '✗'} ${result.why}`)
    if (!result.ok) process.exit(1)
    return
  }
  if (cmd === 'record') {
    const added = record({ type: arg(argv, '--type') || 'share', target: arg(argv, '--target'), note: arg(argv, '--note') })
    console.log(added ? '✓ 已记账' : '（已在这笔账里，不重复记）')
    return
  }

  // show
  const q = read()
  const today = q.log.filter(x => dayOf(x.at) === dayOf())
  const shares = today.filter(x => x.share).length
  const c = config()
  const limit = shareDailyLimit(c)
  console.log(`今天：记账 ${today.length} 条，其中分享 ${shares}/${limit > 0 ? limit : '∞'} 条`)
  for (const x of today.slice(-10)) console.log(`  ${new Date(x.at).toLocaleTimeString('sv-SE')} ${x.share ? '[分享]' : '[回复]'} ${x.target || ''} ${x.note ?? ''}`)
  if (!today.length) console.log('  （今天还没发过 —— 安静是美德）')
}
