// 账本 —— 让她**自己**看得到今天吃了多少饭钱、还能吃多少、今天还能干几件事。
//
// 背景（10-26 主人报）：她记忆里反复问"账本/饭钱"，因为她根本读不到账本 ——
// 一个只把钱挂在嘴上、却查不了账的角色，只能一直问主人。把账本变成她能读的东西，
// 这个圈才闭上。
//
// 三个数据源，全部有据可查：
//   ① token 用量：DSH 自己的会话日志（~/.dsh/sessions/*/*/session.v4.jsonl.zstd）
//      每行一个 zstd 帧、用量在 type=assistant/message 的 data.usage 里 —— 见 ledger_usage.py
//   ② 饭钱折算：token × 单价（config.ledger.price，默认按 DeepSeek 档位估，标 ≈）
//   ③ 动作额度：她自己那几本账（quota.json / bili-actions.json / douyin-*.json / imggen.json）
//
// 余额（官方钱包）走可选接口：config.ledger.balanceUrl + apiKey 配了才查，
// 查不到就明确说"看不到余额"，绝不编一个 0（宁可让她去问主人，也不能骗她）。
//
// 【模块卡片】
// 职责：把 token 用量、饭钱、动作额度、钱包余额汇总成她能读的账本与一行摘要。
// 导出：pythonPath / usage / price / costOf / quotas / balance / report / brief /
//       refreshBrief / readBrief / startBriefRefresher / fmtTok。
// 调用方：宿主 src/bili/dailyBili.ts（readBrief/refreshBrief）；ledger_usage.py 负责实际扫描会话日志。
// 数据文件：<bili 根>/cache/ledger-usage.json、cache/ledger-brief.json（缓存）；
//           只读 ~/.dsh/sessions/*/*/session.v4.jsonl.zstd 与 bili-actions.json。
// 坑：python 扫描一次约 1.3 秒，同步提示语不能 await —— 所以有摘要缓存；
//     余额接口没配 url/key 一律返回 null，绝不编一个 0。
// 【链路位置】
//   环节：账本旁路 —— 宿主提示语里注入的一行账本摘要，不在 feed→debrief→act 主链上，但她每次唤醒都会读到。
//   上游调用：宿主 src/bili/dailyBili.ts（readBrief / refreshBrief / startBriefRefresher）；工具链主链没有调用点。
//   下游调用：外部 python tools/lib/ledger_usage.py 扫描 ~/.dsh/sessions/*/*/session.v4.jsonl.zstd；可选 DeepSeek 余额接口（config.ledger.balanceUrl + apiKey）。
//   读写文件：<bili 根>/cache/ledger-usage.json、cache/ledger-brief.json；只读会话日志与 bili-actions.json。
//   退出码：库不设退出码；python 失败以 Error 抛给调用方，refreshBrief 失败保留旧缓存并返回 null。
//   上游参考：token 用量口径与 zstd 帧扫描沿用 dsh-feiyu 的 ledger_usage.py；余额「所有币种都留下」照 dsh-pet 的教训。
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { config } from './config.mjs'
import { dataPath, getWorldId } from './paths.mjs'

const PY_TIMEOUT = 120_000
const USAGE_CACHE = () => dataPath('cache', 'ledger-usage.json')

// 【补充】调用方：usage() 起 python 时用；优先级 ledger.python → WORLD_BILI_PYTHON → 本机 venv → PATH 里的 python。
//   参数：cfg（默认读当前配置）。返回：第一个存在的可执行文件路径，都不存在时返回 'python' 兜底。
//   失败：不抛错；existsSync 的异常被吞，最终由 execFile 报「找不到解释器」。
/** 找 python：ledger.python → WORLD_BILI_PYTHON → GPT-SoVITS 自带 venv。 */
export function pythonPath(cfg = config()) {
  const cands = [
    cfg.ledger?.python,
    process.env.WORLD_BILI_PYTHON,
    'D:/GPT-SoVITS/.venv/Scripts/python.exe',
    'python',
  ].filter(Boolean)
  for (const c of cands) {
    try {
      if (fs.existsSync(c)) return c
    } catch {}
  }
  return cands[cands.length - 1]
}

function sessionsDir(cfg = config()) {
  const d = cfg.ledger?.sessionsDir
  if (d) return d
  const home = process.env.USERPROFILE || os.homedir()
  return path.join(home, '.dsh', 'sessions')
}

/** 会话日志的指纹（路径+大小+修改时间），变了才重算 —— 21MB 全量扫一次约 1.3 秒。 */
// 只取「路径 + 大小 + 修改时间」：不用读内容就能判断有没有新会话，成本接近 0。
function usageSignature(dir) {
  const parts = []
  try {
    for (const ws of fs.readdirSync(dir)) {
      const wsDir = path.join(dir, ws)
      let inner
      try { inner = fs.readdirSync(wsDir) } catch { continue }
      for (const s of inner) {
        const f = path.join(wsDir, s, 'session.v4.jsonl.zstd')
        let st
        try { st = fs.statSync(f) } catch { continue }
        parts.push(`${ws}/${s}:${st.size}:${Math.round(st.mtimeMs)}`)
      }
    }
  } catch {}
  return createHash('sha1').update(parts.sort().join('|')).digest('hex')
}

// 【补充】调用方：report()、refreshBrief()、宿主定时刷新。
//   参数：opts.fresh 跳过缓存；opts.sessionsDir 换会话目录；opts.python 换解释器。
//   返回：{ days, lifetime, sessions, cached }；days 是逐日聚合，mine = 她自己花的、other = 主人花的。
//   失败：python 缺失/超时/输出非 JSON 抛 Error（带 stderr 片段）；缓存写失败只丢缓存，不影响本次结果。
/**
 * token 用量（她 / 主人分开）。
 * @returns {Promise<{days:Array, lifetime:object, sessions:number, cached:boolean, error?:string}>}
 */
export async function usage(opts = {}) {
  const cfg = config()
  const dir = opts.sessionsDir || sessionsDir(cfg)
  const sig = usageSignature(dir)
  const cacheFile = USAGE_CACHE()
  if (!opts.fresh) {
    try {
      const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
      // 命中缓存直接返回并标记 cached：账本要能说明这份数字不是刚算的。
      if (c.signature === sig && c.data) return { ...c.data, cached: true }
    } catch {}
  }
  const py = opts.python || pythonPath(cfg)
  // 用 fileURLToPath 拼脚本路径：Windows 上 import.meta.url 带盘符和中文/空格路径，
  // 直接切字符串会拼出 /D:/… 这种 python 不认的路径
  const here = path.dirname(fileURLToPath(import.meta.url))
  // --mine 决定哪些会话算「她自己吃的」；默认 <worldId>-work，和配置的 mineWorkspace 同口径。
  const args = [path.join(here, 'ledger_usage.py'),
    '--sessions', dir, '--mine', cfg.ledger?.mineWorkspace || getWorldId() + '-work']
  const data = await new Promise((resolve, reject) => {
    // 32MB 上限：输出是逐日聚合的 JSON，正常远小于这个数，留足余量防截断。
    execFile(py, args, { timeout: PY_TIMEOUT, maxBuffer: 32 * 1024 * 1024, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(String(stderr || err.message).slice(0, 400)))
        try { resolve(JSON.parse(String(stdout))) } catch (e) { reject(new Error('账本 python 输出不是 JSON：' + String(stdout).slice(0, 200))) }
      })
  })
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true })
    fs.writeFileSync(cacheFile, JSON.stringify({ signature: sig, at: Date.now(), data }, null, 0))
  } catch {}
  // 缓存写失败不影响本次结果：下次重算即可，不能因为落盘失败让她看不到账本。
  return { ...data, cached: false }
}

// ── 饭钱折算 ────────────────────────────────────────────────────────────────
/** 单价（元/百万 token）。默认值按 DeepSeek 档位估，可在 config.ledger.price 覆盖。 */
export function price(cfg = config()) {
  const p = cfg.ledger?.price || {}
  return {
    input: num(p.inputPerM, 2),
    cache: num(p.cachePerM, 0.2),
    output: num(p.outputPerM, 3),
  }
}

function num(v, d) {
  // null / '' / 非数字都落回默认值 —— 别让 `cachePerM: null` 变成 0：
  // 缓存单价算成 0 会把饭钱算少，账本少报钱比多报更坑
  if (v === null || v === undefined || v === '') return d
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}

// 【补充】调用方：costOf()、report() 的 week/today 汇总。
//   参数：u 形如 { input, cache, output } 的 token 数；cfg 可注入。
//   返回：元（未取整）；u 为空返回 0。
//   失败：不抛错；缺字段按 0 算，单价用 price() 的默认值兜底。
/** token 用量 → 元。 */
export function costOf(u, cfg = config()) {
  if (!u) return 0
  const p = price(cfg)
  return (u.input || 0) / 1e6 * p.input + (u.cache || 0) / 1e6 * p.cache + (u.output || 0) / 1e6 * p.output
}

// ── 动作额度 ────────────────────────────────────────────────────────────────
function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

function dayKey(d = new Date()) {
  // 账本文件用的是本地日期（quota.mjs 的 dayKey 同口径）
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// 【补充】调用方：report() 拼账本、brief() 摘要、面板概览。
//   参数：cfg 可注入；today 是本地日 YYYY-MM-DD；dir 是数据目录（测试用）。
//   返回：数组，每项 { key, label, used, limit, left }；left 为 null 表示不限。
//   失败：读不到 bili-actions.json 按 0 算；只有 dyn_pure / dyn_share 两个桶进入这里。
/**
 * 今天的账：她自己那几本（0 = 不限，所以余量显示"不限"）。
 * 核心链路只有两种动态：dyn_pure（纯文字动态）和 dyn_share（转发视频动态）。
 * 其他桶（danmaku/like/coin/replies 等）保留在 bili-actions.json 里计数，
 * 但 quotas() 里不展示（按需启用）。
 */
export function quotas(cfg = config(), today = dayKey(), dir = dataPath()) {
  const act = readJson(path.join(dir, 'bili-actions.json'), {})
  const a = act?.day === today ? act : {}
  const biliCfg = cfg.bilibili?.dynamic ?? {}
  const list = [
    { key: 'dyn_pure', label: 'B站 纯动态', used: Number(a.dyn_pure ?? 0), limit: Number(biliCfg.pureDailyMax ?? 0) },
    { key: 'dyn_share', label: 'B站 转发动态', used: Number(a.dyn_share ?? 0), limit: Number(biliCfg.shareDailyMax ?? 0) },
  ]
  // ════════════════════════════════════════════════════════════════════════
  // 以下桶暂时不在 quotas 里展示（按需启用，保留代码不删除）：
  // { key: 'share', label: 'B站 分享', used: …, limit: … },
  // { key: 'reply', label: 'B站 回评', used: …, limit: 0 },
  // { key: 'danmaku', label: 'B站 弹幕', used: …, limit: … },
  // { key: 'like', label: 'B站 点赞', used: …, limit: … },
  // { key: 'coin', label: 'B站 投币', used: …, limit: … },
  // { key: 'douyin-share', label: '抖音 分享', used: …, limit: … },
  // { key: 'douyin-comment', label: '抖音 评论', used: …, limit: … },
  // { key: 'douyin-produce', label: '抖音 作品', used: …, limit: … },
  // { key: 'img', label: '表情包生成', used: …, limit: … },
  // ════════════════════════════════════════════════════════════════════════
  return list.map((x) => ({
    ...x,
    left: x.limit > 0 ? Math.max(0, x.limit - x.used) : null,   // null = 不限
  }))
}

// 【补充】调用方：report()（默认会查一次，传 { balance:false } 可跳过）。
//   参数：cfg 读 ledger.balanceUrl / apiKey；opts 当前没有别的开关。
//   返回：{ currency, total, granted, toppedUp, wallets } 或 null（没配 url/key、请求失败、响应没有余额都返回 null）。
//   失败：绝不抛错；超时由 balanceTimeoutMs 控制，失败时返回 null 让上层说「看不到余额」。
/**
 * 可选：官方钱包余额（配了 url+key 才查，其它一律返回 null，不编数字）。
 *
 * 口径照 dsh-pet 的教训：`balance_infos` 里**所有币种都要留下** ——
 * 只取首条会让后面的币种凭空消失（余额看起来比实际少）。金额原样透传，
 * 不按"赠送+充值"重算（官方给的 total 就是总数）。
 */
export async function balance(cfg = config(), opts = {}) {
  const url = cfg.ledger?.balanceUrl
  const key = cfg.ledger?.apiKey || process.env.DEEPSEEK_API_KEY
  if (!url || !key) return null
  const timeoutMs = Number(cfg.ledger?.balanceTimeoutMs ?? 8000)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, signal: ctrl.signal })
    if (!r.ok) return null
    const j = await r.json()
    const infos = j?.balance_infos
    if (!Array.isArray(infos) || !infos.length) return null
    const wallets = infos.map((w) => ({
      currency: String(w?.currency || 'CNY'),
      total: Number(w?.total_balance),
      granted: w?.granted_balance ?? null,
      toppedUp: w?.topped_up_balance ?? null,
    })).filter((w) => Number.isFinite(w.total))
    if (!wallets.length) return null
    const head = wallets.find((w) => w.currency === 'CNY') || wallets[0]
    return { ...head, wallets }
  } catch {
    // 网络/解析失败一律 null：宁可说「看不到余额」，也不能给一个假的 0。
    return null
  } finally {
    clearTimeout(timer)
  }
}

// 【补充】调用方：宿主刷新摘要、CLI/面板要完整账本时；refreshBrief 是它的定时包装。
//   参数：opts.days 目前只影响 usage 的调用；opts.fresh 跳过用量缓存；opts.balance=false 跳过余额查询。
//   返回：{ today, me, master, week, lifetime, balance, runwayDays, quotas, price, usageCached, sessions }。
//   失败：usage 抛错会向上抛；余额失败只让 balance 为 null，不影响其余字段。
/**
 * 完整账本。
 * @param {{days?:number, fresh?:boolean}} opts
 */
export async function report(opts = {}) {
  const cfg = config()
  const today = dayKey()
  const u = await usage(opts)
  const days = Array.isArray(u.days) ? u.days : []
  const find = (d) => days.find((x) => x.day === d)
  const todayRow = find(today) || { day: today, mine: emptyTok(), all: emptyTok() }
  const last7 = days.slice(-7)
  const mine7 = last7.reduce((a, r) => addTok(a, r.mine), emptyTok())
  const daysWithUse = last7.filter((r) => (r.mine?.total || 0) > 0).length || 1
  const avgMineCost = costOf(mine7, cfg) / daysWithUse
  const budget = num(cfg.ledger?.dailyBudget, 0)          // 0 = 没设预算
  const todayCost = costOf(todayRow.mine, cfg)
  const bal = opts.balance === false ? null : await balance(cfg)
  return {
    today,
    me: {
      tokens: todayRow.mine,
      cost: round2(todayCost),
      budget: budget > 0 ? budget : null,
      leftOfBudget: budget > 0 ? round2(budget - todayCost) : null,
      overBudget: budget > 0 ? todayCost > budget : false,
    },
    master: { tokens: todayRow.other || emptyTok(), cost: round2(costOf(todayRow.other || emptyTok(), cfg)) },
    week: { days: last7.length, mine: mine7, cost: round2(costOf(mine7, cfg)), avgPerDay: round2(avgMineCost) },
    lifetime: {
      mineTokens: u.lifetime?.mine?.total ?? 0,
      mineCost: round2(costOf(u.lifetime?.mine, cfg)),
    },
    balance: bal,
    // 按最近 7 天日均饭钱估算还能撑几天；没有余额或没花过钱时为 null（不硬算）。
    runwayDays: bal && avgMineCost > 0 ? Math.floor(bal.total / avgMineCost) : null,
    quotas: quotas(cfg, today),
    price: price(cfg),
    usageCached: !!u.cached,
    sessions: u.sessions ?? 0,
  }
}

function emptyTok() {
  return { input: 0, output: 0, cache: 0, total: 0, calls: 0 }
}

function addTok(a, b) {
  const o = { ...a }
  for (const k of Object.keys(emptyTok())) o[k] = (a?.[k] || 0) + (b?.[k] || 0)
  return o
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100
}

// 【补充】调用方：宿主拼提示语时同步读它；refreshBrief 定时调用 refreshBrief 落盘。
//   参数：r 是 report() 的返回；空值返回空串（提示语里就干脆不提账本）。
//   返回：一行中文摘要（token、预算、额度、余额与还能撑几天），没有余额/额度时自动省略对应片段。
//   失败：不抛错；字段缺失按 0 或跳过处理。
/** 一行摘要（给提示语注入用，别塞太长）。 */
export function brief(r) {
  if (!r) return ''
  const p = []
  p.push(`今天吃了 ${fmtTok(r.me.tokens.total)} token ≈ ¥${r.me.cost}`)
  if (r.me.budget != null) {
    p.push(r.me.overBudget ? `超了预算 ¥${Math.abs(r.me.leftOfBudget)}（预算 ¥${r.me.budget}/天）` : `预算 ¥${r.me.budget}/天，还剩 ¥${r.me.leftOfBudget}`)
  }
  const q = (r.quotas || []).filter((x) => x.limit > 0).map((x) => `${x.label} ${x.left}/${x.limit}`)
  if (q.length) p.push('额度：' + q.join(' · '))
  if (r.balance) p.push(`钱包余额 ¥${r.balance.total}（按这个花法还能撑 ${r.runwayDays} 天）`)
  return p.join(' ； ')
}

// ── 给提示语用的缓存 ──────────────────────────────────────────────────────
// 唤醒/聊天提示都是同步拼字符串，不能在里面 await 一次 python（1.3 秒）。
// 所以由 tick 定时刷一份到 cache，提示语只读这一份。
const BRIEF_CACHE = () => dataPath('cache', 'ledger-brief.json')
const BRIEF_TTL_MS = 30 * 60_000

/** 重算并落盘账本摘要（scheduler 每 5 分钟调一次）。失败不抛，保留旧缓存。 */
export async function refreshBrief(opts = {}) {
  try {
    const r = await report(opts)
    const payload = { at: Date.now(), today: r.today, line: brief(r), report: { me: r.me, week: r.week, balance: r.balance, runwayDays: r.runwayDays, quotas: r.quotas } }
    const f = BRIEF_CACHE()
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, JSON.stringify(payload, null, 0))
    return payload
  } catch (e) {
    // 失败保留旧缓存：定时刷新失败不该把上一份可用的账本摘要清掉。
    return null
  }
}

// 【补充】调用方：宿主提示语拼装（同步、不能 await python）；refreshBrief 负责写这份缓存。
//   参数：无。返回：{ at, today, line, report, stale }，没有缓存返回 null。
//   失败：读不到/格式坏返回 null；超过 30 分钟只标 stale，仍然返回旧数字。
/** 读缓存（同步，给提示语注入）。没缓存返回 null —— 提示语里就干脆不提账本。 */
export function readBrief() {
  try {
    const j = JSON.parse(fs.readFileSync(BRIEF_CACHE(), 'utf8'))
    if (!j || typeof j.line !== 'string' || !j.line) return null
    // 超过 30 分钟标记 stale，但仍返回 —— 有旧数字比什么都没有强。
    return { ...j, stale: Date.now() - Number(j.at || 0) > BRIEF_TTL_MS }
  } catch {
    return null
  }
}

// 【补充】调用方：常驻进程（qq-server / douyin-dm-server / scheduler）启动时开一次。
//   参数：minutes 刷新间隔（至少 1 分钟）；log 回调只用于把摘要写进日志。
//   返回：已 unref 的定时器，不会拖住宿主进程退出。
//   失败：刷新失败只保留旧缓存，不抛错、不清空上一份可用摘要。
/**
 * 常驻进程（qq-server / douyin-dm-server / scheduler）开一次就行：
 * 立刻刷一版，然后每 minutes 分钟刷一版。返回 unref 过的 timer，不挡进程退出。
 */
export function startBriefRefresher(minutes = 10, log = () => {}) {
  const go = () => {
    refreshBrief()
      .then((p) => { if (p) log('账本已刷新：' + p.line.slice(0, 90)) })
      .catch(() => {})
  }
  go()
  const t = setInterval(go, Math.max(1, minutes) * 60_000)
  // unref：定时器不能拖住宿主进程退出（CLI/测试尤其明显）。
  if (typeof t.unref === 'function') t.unref()
  return t
}

// 【补充】调用方：brief() 与面板展示；只做数位压缩，不改单位换算口径。
//   参数：n token 数（可传字符串，内部 Number 兜底 0）。返回：如 12345 → "1.2 万"、230000000 → "2.30 亿"。
//   失败：非数字按 0 处理，返回 "0"。
/**
 * 把 token 数压成人话（亿/万）。
 * @param {number} n token 数。
 * @returns {string} 例如 12345 → "1.2 万"，230000000 → "2.30 亿"。
 */
export function fmtTok(n) {
  const v = Number(n) || 0
  if (v >= 1e8) return (v / 1e8).toFixed(2) + ' 亿'
  if (v >= 1e4) return (v / 1e4).toFixed(1) + ' 万'
  return String(Math.round(v))
}