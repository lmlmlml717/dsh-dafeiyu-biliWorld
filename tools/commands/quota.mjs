// quota —— 额度账本：分享每天 ≤ shareDaily、同一视频 sameVideoDays 天只发一次。
// 复用 dsh-bili-whale / dsh-feiyu 的账本思路（quota.json + check/record），克制是活下来的前提。
//
//   node bili.mjs quota check  --type share --target BV1xxxx
//   node bili.mjs quota record --type share --target BV1xxxx --note "…"
//   node bili.mjs quota show
//
// 纯函数（check / record）供 act 等写通道直接 import：CLI 的 run() 只是薄壳。
import fs from 'node:fs'
import { dataPath } from '../lib/paths.mjs'
import { config } from '../lib/config.mjs'

/** 每次调用都重新解析路径：测试里换 WORLD_BILI_DATA_DIR 也拿得到对的目录。 */
const quotaFile = () => dataPath('quota.json')
const dayOf = (v = Date.now()) => new Date(v).toLocaleDateString('sv-SE')

function read() {
  try {
    const j = JSON.parse(fs.readFileSync(quotaFile(), 'utf8'))
    return j && typeof j === 'object' ? j : { log: [] }
  } catch { return { log: [] } }
}
function write(q) {
  fs.mkdirSync(dataPath(), { recursive: true })
  const temp = quotaFile() + '.' + process.pid + '.tmp'
  fs.writeFileSync(temp, JSON.stringify(q, null, 1) + '\n')
  fs.renameSync(temp, quotaFile())
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

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
export function check({ type = 'share', target = '', cfg, now = Date.now() } = {}) {
  const c = cfg || config()
  const sharesToday = read().log.filter(x => x.share && dayOf(x.at) === dayOf(now)).length
  const limit = Number(c.quota?.shareDaily ?? 3)
  if (limit > 0 && sharesToday >= limit) return { ok: false, why: `今天已分享 ${sharesToday}/${limit} 条 —— 额度用完，明天再来` }
  if (target) {
    const days = Number(c.quota?.sameVideoDays ?? 7)
    if (days > 0) {
      const cutoff = now - days * 86400_000
      const dup = read().log.find(x => x.target === target && new Date(x.at).getTime() >= cutoff)
      if (dup) return { ok: false, why: `这条视频 ${dayOf(dup.at)} 已发过 —— ${days} 天内同一视频只发一次` }
    }
  }
  return { ok: true, why: `可发（今天 ${sharesToday}/${limit > 0 ? limit : '∞'}）` }
}

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
    q.log = q.log.slice(-400)
    write(q)
    return true
  })
}

function arg(argv, name) {
  const i = argv.indexOf(name)
  return i >= 0 ? String(argv[i + 1] ?? '') : ''
}

export function run(argv = []) {
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
  const limit = Number(c.quota?.shareDaily ?? 3)
  console.log(`今天：记账 ${today.length} 条，其中分享 ${shares}/${limit > 0 ? limit : '∞'} 条`)
  for (const x of today.slice(-10)) console.log(`  ${new Date(x.at).toLocaleTimeString('sv-SE')} ${x.share ? '[分享]' : '[回复]'} ${x.target || ''} ${x.note ?? ''}`)
  if (!today.length) console.log('  （今天还没发过 —— 安静是美德）')
}
