// B站 API 层：WBI 签名 + 24h 缓存 + 风控熔断 + 300ms 节流。
// 复用 dsh-bili-whale 的 tools/lib/bili-api.mjs（MIT）的完整实现 ——
// 这层是它被 B站 风控反复教育后的成果（缓存/退避/节流/playurl 的 -412 误伤判定），
// 别自己另写一套 ✗。改动：数据路径 → ~/.feiyu-ai，环境变量 → FEIYU_NO_CACHE，
// 并为 feed 增加 search/type 的 WBI 映射。
//
// 【模块卡片】
// 职责：B站 读接口的唯一出口 —— WBI 签名、24 小时缓存、风控熔断、300ms 节流、观看历史上报。
// 导出：signWbi / apiGet / makeHeaders / reportWatch / apiState。
// 调用方：tools/commands/feed.mjs、debrief.mjs、lib/bili-write.mjs、tools/bili.mjs。
// 数据文件：<bili 根>/api-cache.json、api-ban.json、api-requests.log（不含 cookie 与响应正文）。
// 坑：-412 是 IP 级限流，换接口救不了；playurl 的 -412 多半是内容受限，不能一并熔断；
//     缓存键必须在 WBI 改写路径之前算好，否则读用原始 view、写带 w_rid，永远命中不了。
// 【链路位置】
//   环节：B站 读接口的唯一出口 —— feed 的热门/搜索、debrief 的元信息/字幕/热评、bili-write 的 videoInfo 与 bvidToDynId、tools/bili.mjs 的 deps/nav 都经过它。
//   上游调用：tools/commands/{feed,debrief}.mjs、lib/bili-write.mjs、tools/bili.mjs。
//   下游调用：B站 读接口（nav、view、search/type 需 WBI、player/playurl、v2/reply、polymer 空间动态），以及观看历史的上报接口。
//   读写文件：<bili 根>/api-cache.json（元信息缓存，最多 400 条）、api-ban.json（熔断状态与 streak）、api-requests.log（只有 HIT/NET 与路径，不含 cookie 与响应正文）。
//   退出码：库不设退出码；失败一律返回 { code, message } 形状，由调用方决定这一路是必需还是可选。
//   上游参考：WBI 签名、缓存/退避/节流与 playurl 的 -412 误伤判定都来自 dsh-bili-whale 的 tools/lib/bili-api.mjs。
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { dataPath } from './paths.mjs'

// 【上游参考】MIXIN 是 B站 WBI 的固定混淆表（64 个下标）；取两段密钥文件名、按表重排、删 w_rid、排除 !'()* 的流程照 dsh-bili-whale 的实现。
// B站的固定混淆表：64 个下标，按它从密钥里重排出 32 位。表是常量，每次变的只是 nav 给的密钥。
const MIXIN = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52]
// img_url / sub_url 是带路径和扩展名的 URL，参与签名的只有最后一段文件名。
const keyOf = u => String(u).split('/').at(-1).split('.')[0]

// 【补充】调用方：apiGet 内部对 signedPaths 里的路径调用；测试可注入 now 固定签名时间。
//   参数：params 业务参数；images 是 nav 返回的 wbi_img；now 为毫秒时间戳（wts 取整秒）。
//   返回：可直接拼进 URL 的查询串（已含 w_rid）；密钥长度不对时抛 Error，由 apiGet 转成 { code: -1 } 返回。
//   失败：两段密钥拼起来不是 64 位就抛 —— 那说明未登录或 nav 接口异常，不硬签一个错签名出去。
/**
 * 按 B站 WBI 规则给查询参数签名。
 * @param {Object<string, string|number>} params 业务参数（w_rid 会被丢掉）。
 * @param {{img_url?: string, sub_url?: string}} images nav 返回的 wbi_img，两段各取文件名拼 64 位密钥。
 * @param {number} [now=Date.now()] 签名时间毫秒，wts 取整秒；测试可注入固定时间。
 * @returns {string} 可直接拼到 URL 的查询串（含 w_rid）。
 * @throws {Error} 两段密钥拼起来不是 64 位时抛出（未登录或 nav 接口异常）。
 */
export function signWbi(params, images, now = Date.now()) {
  const raw = keyOf(images?.img_url ?? '') + keyOf(images?.sub_url ?? '')
  if (raw.length !== 64) throw new Error('WBI 签名密钥缺失，请稍后重试或检查登录状态')
  const key = MIXIN.map(i => raw[i]).join('').slice(0, 32)
  const values = { ...params, wts: Math.floor(now / 1000) }
  // w_rid 是上一次的签名结果，必须先删掉，否则这次签名会把自己算进去。
  delete values.w_rid
  // 先排除 !'()* 再编码：B站 服务端按这个子集算，直接 encodeURIComponent 会得出不同的签名。
  const query = Object.keys(values).sort().map(k => `${encodeURIComponent(k)}=${encodeURIComponent(String(values[k]).replace(/[!'()*]/g, ''))}`).join('&')
  return `${query}&w_rid=${crypto.createHash('md5').update(query + key).digest('hex')}`
}

// 【上游参考】三层保护（24h 缓存 / 撞风控后指数退避封顶 30 分钟 / 两次请求至少 300ms）沿用 dsh-bili-whale 被风控反复教育后的实现，不是本地拍脑袋的阈值。
// ─────────────────────────────────────────────────────────────────────────────
// 三样保护（B站 的 412 是 IP 级限流，换接口救不了）：
//   ① 缓存    同一份元信息 24 小时内只问一次
//   ② 退避    撞到 412/风控码就熔断一段时间，不再硬闯（指数退避，封顶 30 分钟）
//   ③ 节流    两次请求之间至少隔 300ms
// ─────────────────────────────────────────────────────────────────────────────

function cacheFile() { return dataPath('api-cache.json') }
function banFile() { return dataPath('api-ban.json') }
function reqLogFile() { return dataPath('api-requests.log') }

const CACHE_TTL_MS = 24 * 3600 * 1000
const logReq = (hit, p) => {
  if (noCacheEnv()) return
  try { fs.appendFileSync(reqLogFile(), `${new Date().toISOString()} ${hit ? 'HIT ' : 'NET '} ${p}\n`) } catch {}
}

// 只缓存「静态一点的元信息」✗ 动态内容（评论/收件箱/动态流）绝不能缓存 ✓
const CACHEABLE = [
  /^\/x\/web-interface\/(wbi\/)?view$/,
  /^\/x\/space\/wbi\/acc\/info$/,
]
const NAV_TTL_MS = 10 * 60 * 1000
// 风控码：撞到就熔断
const BAN_CODES = new Set([-412, -352, -799, -509, -10403])
// playurl 上的 -412 多半是内容受限（大会员/地区/独播），不熔断 —— bili-whale 实测教训
const CONTENT_RESTRICTED = [/^\/x\/player\/(wbi\/)?playurl$/]
const isContentRestricted = (p) => CONTENT_RESTRICTED.some((re) => re.test(p))

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}
function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(value))
  } catch {}
}

// 缓存键：去掉每次都变的签名参数（wts / w_rid），按账号摘要隔离
function cacheKey(url, headers) {
  const u = new URL(url)
  // 把旧版 view 映射到 wbi 路径：两条路径返回同一份数据，键必须一致，否则缓存永远对不上。
  if (u.pathname === '/x/web-interface/view') u.pathname = '/x/web-interface/wbi/view'
  const params = [...u.searchParams.entries()]
    .filter(([k]) => k !== 'wts' && k !== 'w_rid')
    .sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv))
  const h = new Headers(headers)
  // 按账号隔离缓存：同一台机器换账号时，不能把上一个账号的可见结果当成她的缓存。
  const account = crypto.createHash('sha256').update(h.get('cookie') ?? '').update('\0').update(h.get('authorization') ?? '').digest('hex')
  return account + ':' + u.hostname + u.pathname + '?' + new URLSearchParams(params).toString()
}
const cacheable = (url) => {
  const u = new URL(url)
  return u.hostname === 'api.bilibili.com' && CACHEABLE.some((re) => re.test(u.pathname))
}
const isNav = (url) => {
  const u = new URL(url)
  return u.hostname === 'api.bilibili.com' && u.pathname === '/x/web-interface/nav'
}

// WORLD_BILI_NO_CACHE=1 → 关掉缓存与熔断（测试/排障用）
const noCacheEnv = () => process.env.WORLD_BILI_NO_CACHE === '1'

let lastRequestAt = 0
let requestQueue = Promise.resolve()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function throttle() {
  // 队列串行化：并发请求也按 300ms 间隔排队，不能指望各调用方自己 sleep。
  const turn = requestQueue.then(async () => {
    const gap = Date.now() - lastRequestAt
    if (gap < 300) await sleep(300 - gap)
    lastRequestAt = Date.now()
  })
  requestQueue = turn.catch(() => {})
  return turn
}

function bannedUntilNow() {
  // 熔断状态落盘：CLI 每次都是新进程，内存里的时间戳带不过去。
  const b = readJson(banFile(), {})
  return Number(b.until ?? 0) > Date.now() ? Number(b.until) : 0
}
function setBan(ms, why) {
  writeJson(banFile(), { until: Date.now() + ms, why, at: new Date().toISOString() })
}

// 说明：读失败仍返回 {code, message} 形状，让调用方自己决定「必需」还是「可选」。
// cookie 和响应正文永远不会进日志。
// 【补充】调用方：feed/debrief/bili-write 的所有读请求；tools/bili.mjs 的 deps/nav 也直接调它。
//   参数：input 完整 URL（命中 signedPaths 会改写成 wbi 版本）；headers 通常来自 makeHeaders；opts 控制缓存与熔断。
//   返回：接口 JSON；失败也返回 { code, message }，并可能带 _cached/_stale/soft 标记，由调用方判断可否降级。
//   失败：网络超时、非 JSON、HTTP 4xx/5xx 都不抛错；风控码会写 api-ban.json 熔断并尽量退回 7 天内的旧缓存。
/**
 * 发一个 B站 GET 请求（自动补 WBI 签名、缓存、熔断、节流）。
 * @param {string} input 完整 URL；命中 signedPaths 的路径会被改写成 wbi 版本并签名。
 * @param {Object<string, string>} [headers={}] 请求头，通常来自 makeHeaders。
 * @param {{ttlMs?: number, noCache?: boolean, soft?: boolean}} [opts={}]
 *   ttlMs 缓存时长；noCache 跳过缓存；soft=true 时风控只影响本次、不熔断全局。
 * @returns {Promise<object>} 接口 JSON；失败也返回 {code, message} 形状，由调用方判断是否必需。
 *   副作用：写 api-cache.json / api-ban.json / api-requests.log，并可能等待节流。
 */
export async function apiGet(input, headers = {}, opts = {}) {
  const url = new URL(input)
  const ttl = opts.ttlMs ?? CACHE_TTL_MS
  const noCache = opts.noCache === true
  // ⚠️ 缓存键必须在【改写路径之前】算好（读用原始 view，写完带 w_rid 就永远命中不了）
  const key = cacheKey(url.href, headers)
  const canCache = cacheable(url.href) || isNav(url.href)
  const biliHost = url.hostname === 'bilibili.com' || url.hostname.endsWith('.bilibili.com')
  const stale = () => {
    if (noCache || noCacheEnv() || !cacheable(url.href)) return null
    const hit = readJson(cacheFile(), {})[key]
    // 熔断期间允许用 7 天内的旧缓存：有旧数据比直接失败强，但必须标记 _stale 让调用方知道。
    return hit?.data?.code === 0 && Date.now() - Number(hit.at ?? 0) < 7 * CACHE_TTL_MS
      ? { ...hit.data, _cached: true, _stale: true } : null
  }

  // ① 熔断中：不再打网络
  const banned = noCacheEnv() || !biliHost ? 0 : bannedUntilNow()
  if (banned) {
    const mins = Math.max(1, Math.round((banned - Date.now()) / 60000))
    const hit = stale()
    if (hit) return hit
    return { code: -412, message: `HTTP 412 —— 本机被 B站 限流了，约 ${mins} 分钟后自动恢复（期间用缓存过日子）` }
  }

  // ② 缓存命中
  if (!noCache && canCache && !noCacheEnv()) {
    const hit = readJson(cacheFile(), {})[key]
    const useTtl = isNav(url.href) ? NAV_TTL_MS : ttl
    if (hit && Date.now() - Number(hit.at ?? 0) < useTtl) { logReq(true, url.pathname); return { ...hit.data, _cached: true } }
  }

  try {
    const signedPaths = {
      '/x/web-interface/view': '/x/web-interface/wbi/view',
      '/x/player/playurl': '/x/player/wbi/playurl',
      '/x/web-interface/search/type': '/x/web-interface/wbi/search/type',   // feed 选题的搜索源
      // 自己的投稿列表（10-27 「回自己作品下面的评论」要先知道自己投了哪些）
      '/x/space/wbi/arc/search': '/x/space/wbi/arc/search',
    }
    if (url.hostname === 'api.bilibili.com' && signedPaths[url.pathname]) {
      const nav = await apiGet('https://api.bilibili.com/x/web-interface/nav', headers, { noCache })
      if (!nav.data?.wbi_img) return { code: -1, message: `WBI 签名不可用：${nav.message || 'nav 未返回密钥'}` }
      url.pathname = signedPaths[url.pathname]
      url.search = signWbi(Object.fromEntries(url.searchParams), nav.data.wbi_img)
    }

    // ③ 节流：两次请求至少隔 300ms
    await throttle()
    if (biliHost && !noCacheEnv() && bannedUntilNow()) return stale() ?? { code: -412, message: 'B站风控退避中，请稍后重试' }

    logReq(false, url.pathname)
    const response = await fetch(url.href, { headers, signal: AbortSignal.timeout(30000) })

    // HTTP 412/429：平台级风控 → 熔断（默认 5 分钟，指数退避封顶 30 分钟）
    // opts.soft：可选接口（如"列我的投稿"用的 space 接口）吃了 412 **不要**牵连整条通道 ——
    // 10-27 实测：`/x/space/wbi/arc/search` 一次 412 就把 apiGet 熔断 20 分钟，别人正在跑的
    // B站 任务（回评/发弹幕）全被堵住。可选接口失败就该安静返回，别动全局账单。
    if (biliHost && (response.status === 412 || response.status === 429)) {
      if (!opts.soft) {
        const prev = readJson(banFile(), {})
        const streak = Number(prev.streak ?? 0) + 1
        // 指数退避 5 → 10 → 20 → 封顶 30 分钟：连续被风控说明打得太频繁，先停久一点。
        const mins = Math.min(30, 5 * 2 ** (streak - 1))
        if (!noCacheEnv()) setBan(mins * 60_000, `HTTP ${response.status}`)
        if (!noCacheEnv()) writeJson(banFile(), { ...readJson(banFile(), {}), streak, endpoint: url.pathname })
        const hit = stale()
        if (hit) return hit
        return { code: -412, message: `HTTP ${response.status}（B站 风控）—— 已熔断 ${mins} 分钟，别再打了` }
      }
      return { code: -412, soft: true, message: `HTTP ${response.status}（这个接口被风控了，不影响别处）` }
    }
    if (!response.ok) return { code: -1, message: `HTTP ${response.status}（B站风控或接口异常，请稍后重试）` }

    const text = await response.text()
    let data
    try {
      data = JSON.parse(text)
      if (!data || typeof data !== 'object') throw new Error('invalid JSON payload')
    } catch {
      return { code: -1, message: `非 JSON 响应（HTTP ${response.status}），可能是风控或接口变更` }
    }

    // 接口层风控码：同样熔断（B站 有时 HTTP 200 但 code=-412）
    if (biliHost && BAN_CODES.has(Number(data.code))) {
      if (Number(data.code) === -412 && isContentRestricted(url.pathname)) {
        return { ...data, message: `${data.message ?? ''}（这条播放地址受限：大会员专属/地区限制，不是限流）` }
      }
      if (opts.soft) return { ...data, soft: true, message: `${data.message ?? ''}（可选接口风控 ${data.code}，不影响别处）` }
      const prev = readJson(banFile(), {})
      const streak = Number(prev.streak ?? 0) + 1
      const mins = Math.min(30, 5 * 2 ** (streak - 1))
      if (!noCacheEnv()) writeJson(banFile(), { until: Date.now() + mins * 60_000, why: `code=${data.code}`, at: new Date().toISOString(), streak, endpoint: url.pathname })
      return { ...data, message: `${data.message ?? ''}（B站 风控 ${data.code}）—— 已熔断 ${mins} 分钟` }
    }
    // 成功了：清退避计数，写缓存
    if (Number(data.code) === 0) {
      const b = readJson(banFile(), {})
      if (!noCacheEnv() && b.streak && b.endpoint === url.pathname) writeJson(banFile(), { ...b, streak: 0 })
      if (!noCache && canCache && !noCacheEnv()) {
        const store = readJson(cacheFile(), {})
        store[key] = { at: Date.now(), data }
        const keys = Object.keys(store)
        if (keys.length > 400) {
          keys.sort((a, b2) => Number(store[a].at ?? 0) - Number(store[b2].at ?? 0))
          for (const k of keys.slice(0, keys.length - 400)) delete store[k]
        }
        writeJson(cacheFile(), store)
      }
    }
    return data
  } catch (error) {
    return { code: -1, message: error.name === 'TimeoutError' ? '请求超时（30 秒）' : '请求失败（网络异常或 WBI 签名密钥无效）' }
  }
}

// 【补充】调用方：feed/debrief/bili-write 每次读请求前拼一次；返回的对象可直接当 fetch headers。
//   参数：cred 来自 loadCred（SESSDATA/bili_jct/buvid3）；extra 覆盖或追加同名请求头。
//   返回：{ user-agent, referer, cookie, ...extra }。
//   失败：不校验 cred 字段；缺字段会拼出 SESSDATA=undefined，接口回 -101（由 loadCred 提前拦）。
/** 请求头：cookie 从凭据拼（B站 的接口对 UA/referer 都挑食）。 */
export function makeHeaders(cred, extra = {}) {
  return {
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    referer: 'https://www.bilibili.com/',
    // 凭据文件里的字段名是 SESSDATA（大写），这里以前写成 cred.sessdata，发出去的是 SESSDATA=undefined，
    // B站一律回 -101「账号未登录」。两种写法都认，旧文件/新文件都不会再踩。
    cookie: `SESSDATA=${cred.SESSDATA ?? cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3}`,
    ...extra,
  }
}

// 【补充】调用方：debrief.mjs 第 ④ 步（bilibili.reportHistory !== false 时）。
//   参数：aid/cid/bvid 定位视频；cred 用于 csrf 与 cookie；playedSec 是本次上报的已播秒数。
//   返回：{ ok: true } 或 { ok: false, why }（why 里同时带 click 与 heartbeat 的返回码）。
//   失败：全程 try/catch，网络/解析失败只返回 ok:false；观看历史记不上不影响「看懂」这件事。
/** 把一次"看视频"记进账号的观看历史（web 播放器的 click + heartbeat 上报）。
 *  B站历史只认播放器上报——纯 API 读元信息/字幕/热评永远不进历史，
 *  手机端就表现为"她明明看了视频却没有浏览记录"。best-effort：失败不抛，别影响主流程。
 *  @returns {Promise<{ok: boolean, why?: string}>}
 */
export async function reportWatch(aid, cid, bvid, cred, playedSec = 60) {
  try {
    const H = makeHeaders(cred, {
      'content-type': 'application/x-www-form-urlencoded',
      referer: `https://www.bilibili.com/video/${bvid}/`,
    })
    const csrf = cred?.bili_jct ?? ''
    const startTs = Math.floor(Date.now() / 1000)
    // ① click：播放器点开视频时的第一声上报
    // 先 click 再 heartbeat：只发 heartbeat 不会真正落进历史，B站 要求成对上报。
    const click = new URLSearchParams({ aid: String(aid), cid: String(cid), bvid: String(bvid), csrf })
    const c = await fetch('https://api.bilibili.com/x/click-interface/web/click', {
      method: 'POST', headers: H, body: click.toString(), signal: AbortSignal.timeout(10000),
    })
    const cj = await c.json().catch(() => ({}))
    // ② heartbeat：带进度的上报，played_time 超过阈值才真正落进历史
    const hb = new URLSearchParams({
      aid: String(aid), cid: String(cid), bvid: String(bvid), csrf,
      played_time: String(playedSec), realtime: String(playedSec),
      start_ts: String(startTs), type: '3', dt: String(playedSec), ts: String(startTs + playedSec),
    })
    const r = await fetch('https://api.bilibili.com/x/click-interface/web/heartbeat', {
      method: 'POST', headers: H, body: hb.toString(), signal: AbortSignal.timeout(10000),
    })
    const hj = await r.json().catch(() => ({}))
    const ok = Number(hj?.code) === 0
    logReq(false, '/x/click-interface/web/heartbeat' + (ok ? '' : '?fail'))
    return ok ? { ok: true } : { ok: false, why: `click=${cj?.code}/${cj?.message ?? ''} heartbeat=${hj?.code}/${hj?.message ?? ''}` }
  } catch (e) {
    // 尽力而为：历史没记上不影响「她看过视频」这件事，返回值里说明原因即可。
    return { ok: false, why: String(e?.message ?? e) }
  }
}

/** 给「依赖体检 / 排障」用的现状。 */
export function apiState() {
  const ban = readJson(banFile(), {})
  const cache = readJson(cacheFile(), {})
  const until = Number(ban.until ?? 0)
  return {
    banned: until > Date.now(),
    banMinutesLeft: until > Date.now() ? Math.ceil((until - Date.now()) / 60000) : 0,
    banWhy: ban.why ?? null,
    cacheEntries: Object.keys(cache).length,
  }
}
