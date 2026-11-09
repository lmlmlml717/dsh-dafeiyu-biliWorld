// bili-write —— B站「活人感」写通道（核心版：纯文字动态 + 转发视频动态）。
//
// 【当前启用的写通道】
//   · postDynamic        —— 发一条纯文字动态（scene=1），agent 自己写文案
//   · shareVideoDynamic  —— 转发视频到动态（scene=4），带视频卡片 + agent 配文
//
// 【暂时注释掉的写通道】（按需启用，保留代码不删除）
//   · sendDanmaku        —— 弹幕（act danmaku 命令）
//   · likeVideo          —— 点赞（react.like 开了才动）
//   · coinVideo          —— 投币（gaia 风控闸，暂不可用）
//   · commentWithPicture —— 带图评论（图片贴纸/生图 → B站图床）
//   · followUser         —— 关注 UP（act follow 命令）
//   · postReply          —— 楼中楼回复（replies 命令）
//   · scanReplies        —— 扫描别人对我评论的回复
//   · listCommentsOf     —— 某视频下的评论
//   · listOwnVideos      —— 我自己的投稿（列表去重）
//   · replyVisibility    —— 评论匿名可见性核查
//   · commentExists      —— 评论存在性核查
//   · recordMyComment    —— 登记我发过的评论
//   · videoInfo          —— 视频 aid/cid/封面查询
//   · uploadImage        —— 图片上传到 B站图床
//
// 【风控保护链】
//   guard.dryRun       —— 默认干跑，--go 才真发
//   guard.clean        —— 清黑名单词 + 剥 markdown + 压空白
//   guard.dryBlocked   —— guard.dryRun=true 时直接 return dry: true
//   guard.capOk        —— 日额度检查（bili-actions.json，dyn_pure / dyn_share 分开计数）
//   guard.allow        —— 间隔 + 复读检测
//   guard.commit       —— 成功后记时间 + 内容到 sent-log / sent-at
//   guard.capRecord    —— 成功后记动作类型到 bili-actions.json
//
// 【额度计数】
//   bili-actions.json 按天计数，两种动态分开：
//     dyn_pure   —— postDynamic 记这里，上限 config.bilibili.dynamic.pureDailyMax
//     dyn_share  —— shareVideoDynamic 记这里，上限 0（不限，由外层 dailyBili.maxVideos 控制）
//
//   （视频的 like/coin/danmaku/imgComment/follow/reply 等暂时未启用，留空桶）
//
// 【模块卡片】
// 职责：B站「活人感」写通道 —— 纯文字动态、转发视频动态、给视频发顶层评论；写操作都过风控闸。
// 导出：capOk / capRecord / actStats / videoInfo / bvidToDynId / postDynamic / postReply /
//       shareVideoDynamic。
// 调用方：tools/commands/act.mjs、comment.mjs、debrief.mjs（动态 import）。
// 数据文件：<bili 根>/bili-actions.json（日额度）、bili-comments.jsonl（评论尝试）、
//           sent-log.json / sent-at.json（guard）、bili-outbox.md 与 bili-social.jsonl（记账）。
// 坑：干跑分支必须排在 dryRun/allowWrite 之前 —— 先让她看到「会发什么」，再决定拦不拦；
//     评论失败不回滚已发出的动态（B站没有撤销动态的公开接口）。
// 【链路位置】
//   环节：写通道本体 —— act dyn 的转发/纯动态、comment 的顶层评论都落在这里；commands/act.mjs 只是薄壳。
//   上游调用：tools/commands/act.mjs（postDynamic / shareVideoDynamic）、comment.mjs（postReply）、debrief.mjs 的动态 import（likeVideo，当前整段注释掉）。
//   下游调用：lib/bili-api.mjs（view / 空间动态）、lib/guard.mjs（dryRun/clean/allow/commit/lastSentAt）、lib/config.mjs（shareDailyLimit）、lib/social-log.mjs 与 lib/outbox.mjs 记账。
//   读写文件：bili-actions.json（dyn_pure/dyn_share/comment 日计数）、bili-comments.jsonl（评论尝试，2000 条截断）、sent-log.json / sent-at.json（风控）、bili-outbox.md、bili-social.jsonl。
//   闸门顺序（转发）：guard.dryRun → dynamic.enabled → 日额度 → 组 payload → create/dyn → 成功后 capRecord，再按 alsoComment 复用 postReply 发评论。
//   闸门顺序（评论）：comment.enabled → guard.clean → 干跑 → guard.dryRun → comment.allowWrite → 最小间隔 → 日额度 → guard.allow → POST /x/v2/reply/add → 成败都记流水。
//   上游参考：转发请求体照 PiliPlus 的 lib/http/dynamics.dart createDynamic（scene=5 + web_repost_src.revs_id，upload_id 以 0_ 开头，csrf 在 query）。
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { apiGet, makeHeaders } from './bili-api.mjs'
import { loadCred } from './cred.mjs'
import { config, shareDailyLimit } from './config.mjs'
import * as guard from './guard.mjs'
import { dataPath } from './paths.mjs'

// ── 日额度账本 ───────────────────────────────────────────────────────────
// 两个桶：dyn_pure（纯动态）和 dyn_share（转发动态），分开计数。
// 转发动态的日上限由外层 dailyBili.maxVideos 控制（看一条转发一条），
// 这里默认 0 = 不限，agent 不会被内部额度拦住——外层会控制总数量。
const dayKey = () => new Date().toLocaleDateString('sv-SE')
function actFile() { return dataPath('bili-actions.json') }
function readActs() { try { return JSON.parse(fs.readFileSync(actFile(), 'utf8')) } catch { return {} } }
function actCount(kind) {
  const j = readActs()
  return j.day === dayKey() ? Number(j[kind] ?? 0) : 0
}

// 【补充】调用方：postDynamic（dyn_pure）、postReply（comment）、shareVideoDynamic（dyn_share）发送前各查一次。
//   参数：kind 桶名；max 上限（0 或非数字 = 不限）。
//   返回：true 还能发、false 已到上限；账本读不到时 actCount 返回 0，因此会放行（宁可放行不卡死发送）。
/**
 * 额度检查：kind 桶是否还能发。
 * @param {string} kind 桶名（dyn_pure / dyn_share）
 * @param {number} max 上限（0 = 不限）
 * @returns {boolean} true = 还能发
 * @throws 不抛错；账本读不到时 actCount 返回 0，因此会放行（宁可放行，不因为读盘失败卡住发送）
 */
export function capOk(kind, max) {
  const n = Number(max)
  if (!n || n <= 0) return true
  return actCount(kind) < n
}

// 【补充】调用方：三个写通道发送成功后各调一次；info 里的 kind/title/bvid/text 会转给 social-log 记流水。
//   参数：kind 桶名（dyn_pure/dyn_share/comment 等）；info 只用于流水，不参与计数。
//   返回：无；计数写 bili-actions.json，跨天整体重置成新一天的第一个桶。
//   失败：写盘失败被吞（不能让计账失败挡住已经发出去的动作）；social-log 异步 import 失败也吞。
/**
 * 记一次动作到账本。
 * @param {string} kind 桶名
 * @param {object} info 动作附加信息（kind/title/bvid/text —— 写入社交流水）
 */
export function capRecord(kind, info = {}) {
  const j = readActs()
  const fresh = j.day !== dayKey()
  // 跨天就整体重置成 { day, kind: 1 }：旧桶不能带进新的一天，否则昨天的计数会占今天的额度。
  const next = fresh
    ? { day: dayKey(), [kind]: 1 }
    : { ...j, day: dayKey(), [kind]: Number(j[kind] ?? 0) + 1 }
  try {
    fs.mkdirSync(path.dirname(actFile()), { recursive: true })
    fs.writeFileSync(actFile(), JSON.stringify(next))
  } catch {}
  // 0.9.0：这里**不再**写社交流水。以前 capRecord 和 outbox 的 recordBili 各写一条，
  // 于是每次动作在 bili-social.jsonl 里都有两行（其中动态那行还被记成"评论"）。
  // 现在只有一个写入口：outbox.mjs 的 recordBili（它同时写人读台账 bili-outbox.md）。
  // info 仍然收着 —— 调用方传的动作描述不影响计数，只为可读性保留。
}

/** 当天所有动作计数（给面板/账本概览用）。 */
export const actStats = () => {
  const j = readActs()
  return j.day === dayKey() ? j : {}
}

// ── outbox 记账（发出的动态流水，给历史面板展示）──────────────────────
let outboxRecordBili = null
// outbox 是可选依赖：动态 import 失败就退化成「只记结构化流水、不写 Markdown 台账」，
// 不能让整个写通道因为一个展示层模块起不来。
try {
  ({ recordBili: outboxRecordBili } = await import('./outbox.mjs'))
} catch {}

// ── 基础：表单 POST（B站的写接口全是 form 编码 + csrf）─────────────────────
// 【补充】调用方：postReply 发 /x/v2/reply/add 时用（B站 的评论写接口收 form 编码）。
//   参数：cred 提供 csrf；url 完整写接口；params 业务字段。
//   返回：接口 JSON；响应不是 JSON 时返回 { code:-1, message:'响应不是 JSON' }。
//   失败：网络异常会 throw 到调用方（postReply 不 catch，异常会冒到命令层）。
async function formPost(cred, url, params) {
  // B站 的表单写接口同时认 csrf 和 csrf_token，两个都带省得挑版本。
  const body = new URLSearchParams({ ...params, csrf: cred.bili_jct, csrf_token: cred.bili_jct })
  const r = await fetch(url, {
    method: 'POST',
    headers: makeHeaders(cred, { referer: 'https://www.bilibili.com/', 'content-type': 'application/x-www-form-urlencoded' }),
    body: body.toString(),
    signal: AbortSignal.timeout(20000),
  })
  return await r.json().catch(() => ({ code: -1, message: '响应不是 JSON' }))
}

// 【补充】调用方：postDynamic 与 shareVideoDynamic（create/dyn 两个动态接口）。
//   参数：cred 提供 csrf（拼在 URL query）；url 可已带 query，会按需用 & 连接；data 是 JSON 请求体。
//   返回：接口 JSON；响应不是 JSON 时返回 { code:-1, message:'响应不是 JSON' }，网络异常则 throw。
/**
 * JSON body POST —— 给 create/dyn 这类复杂动态接口用。
 * B站要求 csrf 在 URL query 里（publish.md 示例），body 是 application/json。
 */
async function jsonPost(cred, url, data) {
  const sep = url.includes('?') ? '&' : '?'
  // 新版 create/dyn 要求 csrf 在 URL query 里（body 是 JSON），塞进 body 会被判参数错误。
  const fullUrl = url + sep + 'csrf=' + encodeURIComponent(cred.bili_jct)
  const r = await fetch(fullUrl, {
    method: 'POST',
    headers: makeHeaders(cred, { referer: 'https://t.bilibili.com/', origin: 'https://t.bilibili.com', 'content-type': 'application/json' }),
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(20000),
  })
  return await r.json().catch(() => ({ code: -1, message: '响应不是 JSON' }))
}

/** 一个校验通过的回复码（code 0 才算成功）。 */
// 统一成 { ok, code, message }：调用方不用再各自写 Number(j?.code) === 0。
function okOf(j) { return { ok: Number(j?.code) === 0, code: j?.code, message: j?.message ?? '' } }

// 【补充】调用方：postReply / shareVideoDynamic / bvidToDynId（当前文件内）；act follow 的注释代码也用它。
//   参数：bvid 一个 BV 号；不传 cid/aid。
//   返回：{ aid, cid, duration, title, ownerMid, owner, pic, cover, tname, pubdate }。
//   失败：读不到视频直接 throw（后面的 aid/cid 都是必需参数，硬发只会得到更晦涩的接口报错）。
/**
 * 视频基础信息（aid/cid/title/封面/分区/发布时间）。
 * 转发动态和点赞/弹幕都要这几条字段。
 * @param {string} bvid BV 号
 * @returns {Promise<{aid:number, cid:number, duration:number, title:string, ownerMid:number, owner:string, pic:string, tname:string, pubdate:number}>}
 */
export async function videoInfo(bvid) {
  const cred = loadCred()
  const v = await apiGet('https://api.bilibili.com/x/web-interface/view?bvid=' + bvid, makeHeaders(cred))
  // 读不到就直接抛：后面的 aid/cid 都是必需的，硬着头皮发只会得到更晦涩的参数错误。
  if (Number(v?.code) !== 0) throw new Error('读不到视频：' + (v?.message || bvid))
  return {
    aid: v.data.aid,
    cid: v.data.cid,
    duration: v.data.duration,
    title: v.data.title,
    ownerMid: v.data.owner?.mid,
    owner: v.data.owner?.name ?? '',
    pic: v.data.pic || '',
    cover: v.data.pic || '',
    tname: v.data.tname || '',
    pubdate: v.data.pubdate || 0,
  }
}

// 【补充】调用方：当前没有调用点（act follow 的注释代码里用过）；保留给「按 UP 主的动态时间线找 dyn_id」的旧路径。
//   参数：bvid；返回：dyn_id 字符串。
//   失败：视频没有 owner mid、空间接口非 0、最近动态里找不到该 bvid 都 throw（转错视频比不发更糟）。
/**
 * 通过 UP 主的空间动态时间线，把 bvid 翻译成 dyn_id（动态 ID）。
 *
 * B 站 Web 端转发视频到动态（scene=5）需要的是目标视频对应的"视频动态 ID"，
 * 而不是 aid 或 bvid。但 view API 不返回 dyn_id，所以要多走一步：
 *   1) videoInfo 拿 UP 主 mid
 *   2) 调 /x/polymer/web-dynamic/v1/feed/space 拉 UP 主最近动态
 *   3) 在 items 里找 archive.bvid 匹配的那条，取 id_str
 *
 * 为什么用 polymer API 而不是旧版 dynamic_svr：
 *   新版 polymer 是 Web 端目前实际在用的，返回结构更清晰，
 *   且直接给出 id_str（就是我们要的 dyn_id）。
 *
 * @param {string} bvid BV 号
 * @returns {Promise<string>} dyn_id_str（如果找不到抛错）
 */
export async function bvidToDynId(bvid) {
  const cred = loadCred()
  const h = makeHeaders(cred)

  // ① 先拿 UP 主 mid
  const info = await videoInfo(bvid)
  if (!info.ownerMid) throw new Error(`视频 ${bvid} 没有 owner mid，无法查动态`)

  // ② 拉 UP 主空间动态时间线（polymer 新版 API）
  const url = `https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?host_mid=${info.ownerMid}&timezone_offset=-480&platform=web&web_location=1550101`
  const j = await apiGet(url, h)
  if (Number(j?.code) !== 0) {
    throw new Error(`查 UP 主动态失败 code=${j?.code} ${j?.message || ''}`)
  }

  // ③ 在 items 里找 archive.bvid 匹配的那条
  // 只认 bvid 完全相等：标题相似不算，转错视频比不发更糟。
  const items = j.data?.items || []
  for (const item of items) {
    const archive = item.modules?.module_dynamic?.major?.archive
    if (archive?.bvid === bvid) {
      const idStr = item.id_str
      if (!idStr) continue
      console.log(`  [bvidToDynId] ${bvid} → dyn_id=${idStr}`)
      return idStr
    }
  }

  throw new Error(`在 UP 主 ${info.owner}(${info.ownerMid}) 的最近 ${items.length} 条动态里没找到 ${bvid}`)
}

// ── ① 纯文字动态 ────────────────────────────────────────────────────────
// 【补充】调用方：act.mjs 的纯文字分支（不带 --bvid 时）。
//   参数：rawText 配文（清洗后截 1000 字）；opts.go=false 时只干跑预览。
//   返回：{ ok, dry?, why, code? }；干跑是 ok:true + dry:true，不算失败。
//   失败：正文为空、dynamic.enabled 未开、日额度用完、接口非 0 都返回 ok:false（不抛）；-400 的 CDP 降级当前未接。
/**
 * 发一条纯文字动态（scene=1）。
 * agent 写的潜水日志、心情分享、日常碎碎念都走这里。
 *
 * @param {string} rawText 动态正文（guard.clean 后 <=1000 字）
 * @param {{go?: boolean}} opts go=false 时干跑（只打印不真发）
 * @returns {Promise<{ok:boolean, dry?:boolean, why?:string}>}
 */
export async function postDynamic(rawText, { go = false } = {}) {
  const cfg = config().bilibili?.dynamic ?? {}
  // 1000 字是 B站 动态正文上限，超了会被接口截断或直接拒绝。
  const text = guard.clean(String(rawText || ''), config()).trim().slice(0, 1000)
  if (!text) return { ok: false, why: '动态内容为空' }
  // 干跑放在所有真发闸门之前：预览永远可看，不占额度、不写账本。
  if (!go) return { ok: true, dry: true, why: `【干跑】纯动态 → ${text.slice(0, 80)}` }
  if (guard.dryBlocked()) return { ok: false, dry: true, why: guard.DRY_WHY }
  if (cfg.enabled !== true) return { ok: false, why: 'bilibili.dynamic.enabled 是关的' }
  const pureMax = Number(cfg.pureDailyMax ?? 2)
  if (!capOk('dyn_pure', pureMax)) return { ok: false, why: '今天发不出去了', detail: `今日纯动态额度已用完（${actCount('dyn_pure')}/${pureMax}）` }
  const cred = loadCred()

  const payload = {
    dyn_req: {
      scene: 1,
      content: {
        contents: [{ raw_text: text, type: 1, biz_id: '' }],
      },
      meta: { app_meta: { from: 'create.dynamic.web', mobi_app: 'web' } },
    },
  }
  const j = await jsonPost(cred, 'https://api.bilibili.com/x/dynamic/feed/create/dyn', payload)
  const res = okOf(j)
  if (res.ok) {
    capRecord('dyn_pure')
    if (outboxRecordBili) outboxRecordBili({ kind: '纯动态', text })
    return { ...res, why: '纯动态已发' }
  }
  // 直连被 -400 拦（B站对脚本直连有风控）→ 自动降级（暂不支持 CDP，按需启）
  // 注：feiyu 版本这里有 bili_act_cdp.py 兜底 —— 等需要时再注释启用
  return { ...res, why: `纯动态失败 code=${res.code} ${res.message}` }
}

// ── ③ 给视频发一条顶层评论（不回复任何人）───────────────────────────────
// 【补充】调用方：postReply 计算当日评论上限时调它；面板与控制台只展示 hardDailyMax，钳制发生在这里。
//   参数：comment 段配置（dailyMax 面板值、hardDailyMax 主配置镜像）。
//   返回：生效条数；两边都 0 返回 0（0 = 不限）。
/**
 * 生效条数：面板的 dailyMax 被主配置的 hardDailyMax 钳制；两边 0 都表示不限。
 * @param {{dailyMax?: number, hardDailyMax?: number}} cfg comment 配置
 */
function commentCap(cfg) {
  const hard = Number(cfg?.hardDailyMax ?? 0)
  const ui = Number(cfg?.dailyMax ?? 0)
  // 面板值和硬上限都有时取小：UI 可以调小，但不能越过主人定的硬上限（0 表示不限）。
  if (ui > 0 && hard > 0) return Math.min(ui, hard)
  return ui > 0 ? ui : hard
}

/**
 * 评论尝试流水（控制台「评论记录」页用，一行一条 JSON）。
 *
 * v2 起每条带 `id`（删除时按它定位）、`kind`（`comment` = 只评论 / `share-comment` = 转发时同时评论）、
 * `aid`（删 B 站评论要用）和完整正文（≤1000，旧版只存 200）。
 * 只记录**真实发出的尝试**（成功或失败）；干跑和被闸门拦下的不进列表。
 */
// 【补充】调用方：postReply 在 POST 之后调一次（成败都记）；控制台「评论记录」页读同一个文件。
//   参数：entry 至少含 ok/bvid/aid/title/rpid/text/code/why；kind 区分 comment 与 share-comment。
//   返回：无；追加一行 JSON 后按 2000 条截断。
//   失败：任何异常都吞掉 —— 流水只是记录，不能让「已经发出去的评论」被报成失败。
function recordCommentLog(entry) {
  try {
    const file = dataPath('bili-comments.jsonl')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const record = { v: 2, id: randomUUID(), kind: 'comment', ...entry }
    fs.appendFileSync(file, JSON.stringify(record) + '\n')
    trimCommentLog(file)
  } catch {}
}

/** 流水只留最近 2000 条：超过就整体重写一次；失败不影响本次记录。 */
function trimCommentLog(file) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
    // 只留 2000 条：流水是给人翻的，再长既难查也拖慢每次追加后的重写。
    if (lines.length <= 2000) return
    const temporary = `${file}.${randomUUID().slice(0, 8)}.tmp`
    fs.writeFileSync(temporary, lines.slice(-2000).join('\n') + '\n', 'utf8')
    fs.renameSync(temporary, file)
  } catch {}
}

// 【补充】调用方：comment.mjs（只评论）、shareVideoDynamic（转发后同时评论，kind='share-comment'）。
//   参数：bvid 目标视频；rawMessage 正文（清洗后截 1000 字）；kind 决定流水里的标记；info 可传入已查好的 videoInfo，省一次 view 请求。
//   返回：成功 { ok:true, rpid, title, aid }；干跑/被闸门拦下 { ok:false|true, dry:true, why }；失败带 code 与接口 message。
//   失败：所有拒绝都靠返回值表达（不抛错）；评论失败不回滚已发出的动态。
/**
 * 给视频发一条**顶层**评论：不带 root/parent，不回复任何人。
 * 闸门：功能开关 → 清洗 → 干跑 → guard.dryRun → allowWrite（真发总开关）→ 最小间隔 → 额度 → guard（间隔/复读）→ POST → 记账。
 * allowWrite 以前只出现在提示词和面板文案里；现在代码里也拦，否则面板写着「只干跑」而命令行照样发得出去。
 * @param {string} bvid BV 号
 * @param {string} rawMessage 评论正文
 * @param {{go?: boolean, kind?: 'comment'|'share-comment', info?: object}} opts
 *   go=false 时干跑；kind 决定记录里标记（转发时同时评论 = share-comment）；
 *   info 可传入已查好的视频信息，避免转发流程重复请求一次 view 接口。
 * @returns {Promise<{ok:boolean, dry?:boolean, why?:string, code?:number, rpid?:string, title?:string}>}
 */
export async function postReply(bvid, rawMessage, { go = false, kind = 'comment', info: knownInfo } = {}) {
  const cfg = config().comment ?? {}
  if (cfg.enabled !== true) return { ok: false, why: '评论功能已关（world 主配置 comment.enabled 与 bili.config.json 的 comment.enabled 都要开）' }
  const text = guard.clean(String(rawMessage || ''), config()).trim().slice(0, 1000)
  if (!text) return { ok: false, why: '评论内容为空' }
  if (!go) return { ok: true, dry: true, why: `【干跑】评论 ${bvid} → ${text.slice(0, 80)}` }
  if (guard.dryBlocked()) return { ok: false, dry: true, why: guard.DRY_WHY }
  // 真发总开关：world 主配置 dailyBili.allowWrite 由宿主镜像到 comment.allowWrite。
  // 缺了这道闸，面板写着「allowWrite 未开、只会干跑」，命令行却能直接发出去。
  if (cfg.allowWrite !== true) {
    return { ok: false, dry: true, why: 'dailyBili.allowWrite 未开（world 主配置的真发总开关）：这次不真发 —— 去控制台「评论」页打开，或改 profile 的 cordis.patch.yml 后重启' }
  }
  // 两条评论之间的最小间隔（主配置 comment.minIntervalSec 镜像过来；0 = 不限制）。
  // 以前只镜像不校验，现在按 sent-at.json 里 'bilibili:comment' 的上次成功时间算。
  const minInterval = Math.max(0, Number(cfg.minIntervalSec ?? 0))
  if (minInterval > 0) {
    const last = guard.lastSentAt('bilibili:comment')
    const waitMs = minInterval * 1000 - (Date.now() - last)
    if (last > 0 && waitMs > 0) {
      return { ok: false, dry: true, why: `距上一条评论还不到 ${Math.ceil(minInterval / 60)} 分钟（还要等 ${Math.max(1, Math.ceil(waitMs / 60000))} 分钟）` }
    }
  }
  const cap = commentCap(cfg)
  if (!capOk('comment', cap)) return { ok: false, why: '这次评论发不出去', detail: `今日评论额度已用完（${actCount('comment')}/${cap}）` }
  const gate = guard.allow('bilibili:comment', text, config())
  if (!gate.ok) return { ok: false, why: `被风控闸门拦下：${gate.why}` }
  const info = knownInfo ?? await videoInfo(bvid)
  const cred = loadCred()
  const j = await formPost(cred, 'https://api.bilibili.com/x/v2/reply/add', {
    type: '1', oid: String(info.aid), message: text, plat: '1',
  })
  const res = okOf(j)
  const rpid = j?.data?.rpid_str !== undefined ? String(j.data.rpid_str) : (j?.data?.rpid !== undefined ? String(j.data.rpid) : '')
  // 成败都记：失败原因也是主人想知道的（到底是额度、风控还是平台拒绝）。
  recordCommentLog({ at: new Date().toISOString(), ok: res.ok, kind, bvid, aid: info.aid, title: info.title, rpid, text: text.slice(0, 1000), code: res.code, why: res.message })
  if (!res.ok) return { ...res, why: `评论失败 code=${res.code} ${res.message || ''}`, title: info.title }
  capRecord('comment', { kind: 'comment', bvid, title: info.title, text })
  // 0.9.2：风控记账（sent-log / sent-at）是本地状态，写不进去不该把已经发出去的评论报成失败。
  // 只读沙箱、磁盘满、权限被拒时都会走到这里 —— 以前它会抛，act 那层就显示「这条没发出去」。
  guard.commitQuietly('bilibili:comment', text)
  if (outboxRecordBili) outboxRecordBili({ kind: '评论', title: info.title, bvid, text })
  return { ...res, why: '评论已发', rpid, title: info.title, aid: info.aid }
}

// ── ② 转发视频到动态 ────────────────────────────────────────────────────
// 【补充】调用方：act.mjs 的转发分支（带 --bvid）；干跑/真发共用，真发成功后由 act 再记 quota 与 session。
//   参数：bvid 目标视频；rawText 配文（清洗后截 1000 字，可为空 = 纯转发）；alsoComment 省略时读 bilibili.dynamic.alsoComment（默认关）。
//   返回：成功 { ok:true, why, comment? }；干跑 { ok:true, dry:true, why }；被闸门/接口拒绝 { ok:false, why }。
//   失败：评论失败只体现在 why 与 comment 字段里，动态已发不回滚（B站没有撤销动态的公开接口）。
/**
 * 把一条视频转发到自己的动态（scene=5，web_repost_src 格式），带 agent 配文。
 *
 * 【API 格式说明】
 *   B 站 2026 年 Web 端转发视频用 scene=5 + web_repost_src.revs_id，
 *   不是 scene=4 + attach_card（那是旧格式，已报 410001 参数错误）。
 *
 *   rid 直接用视频 aid，dyn_type=8（UP 主投稿视频类型）。
 *   参考：PiliPlus（Flutter B站客户端）lib/http/dynamics.dart createDynamic()。
 *
 * @param {string} bvid BV 号
 * @param {string} rawText agent 生成的配文（可以为空，就是纯转发）
 * @param {{go?: boolean, alsoComment?: boolean}} opts
 *   go=false 时干跑；alsoComment 省略时读 `bili.config.json` 的 `bilibili.dynamic.alsoComment`（默认关）。
 * @returns {Promise<{ok:boolean, dry?:boolean, why?:string, comment?:object}>}
 */
export async function shareVideoDynamic(bvid, rawText, { go = false, alsoComment } = {}) {
  const root = config()
  const cfg = root.bilibili?.dynamic ?? {}
  const shareCfg = root.bilibili?.share ?? {}
  if (!bvid) return { ok: false, why: '缺少 --bvid' }
  // 0.9.0：shareMode='forwardOnly' 时真的丢掉配文（以前这个键没有任何代码读，面板开关是假的）。
  const wanted = String(shareCfg.shareMode) === 'forwardOnly' ? '' : String(rawText || '')
  const text = guard.clean(wanted.trim().slice(0, 1000), root)
  // 转发时是否同时把同一段文案发到视频评论区：显式参数优先，否则读配置（默认关）。
  const wantComment = alsoComment !== undefined ? alsoComment === true : cfg.alsoComment === true

  // 干跑：只预览。标题能取到就带上，取不到（没凭据/断网/风控）也照样返回，绝不把预览变成报错。
  if (!go) {
    let title = ''
    try { title = (await videoInfo(bvid)).title } catch { /* 预览不依赖它 */ }
    const also = wantComment ? '｜同时评论：是' : ''
    const body = text ? '｜' + text.slice(0, 30) : '｜（只转发，不配文）'
    return { ok: true, dry: true, why: `【干跑】转发动态 → ${bvid}${title ? `《${title.slice(0, 20)}》` : ''}${body}${also}` }
  }

  // 0.9.0：守门全部提到联网之前。以前先 loadCred/videoInfo 再判开关，功能关着或没配凭据时
  // 直接抛错 —— 命令层只看到一屏堆栈，而不是"这条为什么没发"。
  if (guard.dryBlocked()) return { ok: false, dry: true, why: guard.DRY_WHY }
  if (root.share?.enabled === false) return { ok: false, why: '分享已关（bili.config.json 的 share.enabled）' }
  if (cfg.shareEnabled === false) return { ok: false, why: '转发已关（bilibili.dynamic.shareEnabled）' }
  // 日上限与额度闸同一口径（config.mjs 的 shareDailyLimit）：UI 的 shareDailyMax 优先，没配才回落 quota.shareDaily。
  const shareMax = shareDailyLimit(root)
  if (shareMax > 0 && !capOk('dyn_share', shareMax)) return { ok: false, why: '这次没发出去', detail: `今日转发动态额度已用完（${actCount('dyn_share')}/${shareMax}）` }

  const info = await videoInfo(bvid)
  const cred = loadCred()

  const nowSec = Math.floor(Date.now() / 1000)
  const rand = Math.floor(Math.random() * 9000) + 1000
  // upload_id 必须是 0_ 开头（PiliPlus rid!=null 时就是 0_ 开头）
  const uploadId = `0_${nowSec}_${rand}`

  // web_repost_src 在 body 顶层，和 dyn_req 平级 —— 之前错塞在 dyn_req 内部导致 410001
  const payload = {
    dyn_req: {
      scene: 5,
      upload_id: uploadId,
      content: text
        ? { contents: [{ raw_text: text, type: 1, biz_id: '' }] }
        : { contents: [] },
      meta: { app_meta: { from: 'create.dynamic.web', mobi_app: 'web' } },
    },
    web_repost_src: {
      revs_id: { dyn_type: 8, rid: info.aid },
    },
  }

  // 【上游参考】platform / x-bili-device-req-json / x-bili-web-req-json 三个 query 是 B站 Web 端 create/dyn 的固定要求，少了会回 410001 参数错误。
  // Web 端 create/dyn 除了 csrf 还要这三个 query，少了照样 410001
  const q = new URLSearchParams({
    platform: 'web',
    'x-bili-device-req-json': '{"platform": "web", "device": "pc"}',
    'x-bili-web-req-json': '{"spm_id": "333.999"}',
  })
  const url = `https://api.bilibili.com/x/dynamic/feed/create/dyn?${q}`

  console.log(`  [shareVideoDynamic] payload=${JSON.stringify(payload).slice(0, 250)}`)
  const j = await jsonPost(cred, url, payload)
  const res = okOf(j)
  if (res.ok) {
    capRecord('dyn_share', { kind: '转发动态', title: info.title, bvid, text })
    if (outboxRecordBili) outboxRecordBili({ kind: '转发动态', title: info.title, bvid, text })
    // 同时评论：动态发成功之后，把同一段文案发到原视频评论区。
    // 复用 postReply 的全部闸门（评论开关 / allowWrite / dryRun / 最小间隔 / 额度 / 风控），
    // 并把 kind 记成 share-comment，控制台才能在列表里区分「转发+评论」和「只评论」。
    // 评论失败不回滚动态：B 站没有撤销动态的公开接口。
    let comment
    // 没有配文就没什么可评论的（forwardOnly 或她只转发不说话）。
    if (wantComment && text) comment = await postReply(bvid, text, { go: true, kind: 'share-comment', info })
    // 没有配文时不说"评论未发"：那本来就没打算评论（forwardOnly 或只转发）。
    const commentNote = !wantComment || !text ? ''
      : comment?.ok ? '（并已评论）'
      : `（评论未发：${comment?.why || '未知原因'}）`
    return { ...res, why: `转发动态已发：《${info.title.slice(0, 24)}》${commentNote}`, ...(comment ? { comment } : {}) }
  }
  // 直连被 -400 拦（B站对脚本直连有风控）→ 自动降级（暂不支持 CDP，按需启）
  return { ...res, why: `转发动态失败 code=${res.code} ${res.message}` }
}

// ════════════════════════════════════════════════════════════════════════
// 以下写通道暂时注释掉，保留代码不删除。需要时把注释解开即可。
//
// 弹幕（③）为什么还关着：发送接口 /x/v1/dm/post.so 的返回码与风控行为没有实测过，
// 而 `bilibili.danmaku.*` 那段配置已经按「将来要用」写进了 DEFAULTS —— 也就是说
// **配置在、闸门在、通道不通**，改之前不要以为打开开关就能发弹幕。
// ════════════════════════════════════════════════════════════════════════

/*
// ── ③ 弹幕 ─────────────────────────────────────────────────────────────
// 发一条弹幕（看视频的"在场感"）。atSec：出现在第几秒。
export async function sendDanmaku(bvid, rawText, { go = false, atSec = 0 } = {}) {
  const cfg = config().bilibili?.danmaku ?? {}
  const text = guard.clean(String(rawText || ''), config()).slice(0, 30)
  if (!text) return { ok: false, why: '弹幕清洗后为空' }
  if (!go) return { ok: true, dry: true, why: `【干跑】弹幕 → ${bvid} 第 ${atSec || '随机'}s：${text}` }
  const info = await videoInfo(bvid)
  const at = Math.max(0, Math.min(Math.round(atSec) || Math.floor(Math.random() * Math.max(1, info.duration - 5)), Math.max(0, info.duration - 1)))
  if (guard.dryBlocked()) return { ok: false, dry: true, why: guard.DRY_WHY }
  if (!cfg.enabled) return { ok: false, why: 'bilibili.danmaku.enabled 是关的' }
  if (!capOk('danmaku', Number(cfg.dailyMax ?? 5))) return { ok: false, why: `今日弹幕额度已用完` }
  const cred = loadCred()
  const j = await formPost(cred, 'https://api.bilibili.com/x/v1/dm/post.so', {
    type: 1, oid: String(info.aid), cid: String(info.cid), bvid, mid: '', msg: text,
    progress: String(at * 1000), fontsize: '25', pool: '0', mode: '1', color: '16777215', rnd: String(Date.now()).slice(0, -3), plat: '1',
  })
  const res = okOf(j)
  if (res.ok) { capRecord('danmaku'); if (outboxRecordBili) outboxRecordBili({ kind: '弹幕', title: info.title, bvid, text, extra: `第${at}s` }) }
  if (Number(res.code) === -1 || Number(res.code) === -400) {
    // 被拦 → CDP 兜底（需要 bili_act_cdp.py）
    try {
      const { execFile } = await import('node:child_process')
      const py = config().douyin?.python || 'D:/social-auto-upload/.venv/Scripts/python.exe'
      const out = await new Promise((resolve) => {
        execFile(py, ['D:/social-auto-upload/bili_act_cdp.py', 'dm', bvid, text, String(info.aid), String(info.cid), String(at)],
          { encoding: 'utf8', timeout: 180000, windowsHide: true }, (e2, so, se) => resolve(String((so || se || e2?.message) || '')))
      })
      if (out.includes('SEND_DM') && /"code"\s*:\s*0/.test(out)) { capRecord('danmaku'); return { ok: true, why: `弹幕已发（CDP 通道）` } }
      if (out.includes('NEED_LOGIN')) return { ok: false, why: '需要先在 CDP Chrome 里登录一次B站' }
      return { ok: false, why: '弹幕失败：' + out.slice(-120) }
    } catch (e2) { return { ok: false, why: 'CDP 弹幕失败：' + String(e2?.message ?? e2).slice(0, 120) } }
  }
  return { ...res, why: `弹幕失败 code=${res.code} ${res.message}` }
}

*/

// ── ④ 点赞 / 投币 ───────────────────────────────────────────────────────
// 0.9.0：这两个函数以前整段在 /* */ 里 —— debrief 的「顺手点赞」调的是 w.likeVideo，
// 那是个不存在的导出，TypeError 被 debrief 的 catch 吞掉，等于永远点不了赞。
// 现在放出来：闸门是 bilibili.react.like/coin（默认关）+ guard.dryRun + 日额度。
// 【补充】调用方：tools/commands/debrief.mjs（react.like 为 true 时顺手点赞）。
//   参数：bvid 目标视频；go=false 只返回干跑预览。
//   返回：{ ok, dry?, why, ...接口字段 }；「已赞过」（code 65006）按成功算。
//   失败：被闸门拒绝或接口失败都只返回 ok:false，不抛错（异常只在读凭据/网络层可能冒泡）。
/**
 * 给视频点个赞。重复点赞（65006 / 含「重复」）当成功处理，不重复记账。
 * @param {string} bvid 目标视频
 * @param {{go?: boolean}} [opts] go=false 时只预览
 * @returns {Promise<{ok: boolean, dry?: boolean, why?: string, code?: number}>}
 */
export async function likeVideo(bvid, { go = false } = {}) {
  const cfg = config().bilibili?.react ?? {}
  if (!go) return { ok: true, dry: true, why: `【干跑】点赞 → ${bvid}` }
  // 0.9.0：守门在联网之前（和转发、投币一致）。以前先读视频信息，没凭据就直接抛。
  if (guard.dryBlocked()) return { ok: false, dry: true, why: guard.DRY_WHY }
  // 0.9.0：和投币一样要求显式打开。以前写的是 `=== false`，配置里没有这一段时就默认放行。
  if (cfg.like !== true) return { ok: false, why: 'bilibili.react.like 是关的（点赞要显式开）' }
  if (!capOk('like', Number(cfg.likeDaily ?? 10))) return { ok: false, why: '今日点赞额度已用完' }
  const info = await videoInfo(bvid)
  const cred = loadCred()
  const j = await formPost(cred, 'https://api.bilibili.com/x/web-interface/archive/like', { aid: String(info.aid), like: '1' })
  const dup = Number(j?.code) === 65006 || /重复/.test(String(j?.message ?? ''))
  const res = { ...okOf(j), ok: Number(j?.code) === 0 || dup }
  if (res.ok && !dup) {
    capRecord('like', { bvid, title: info.title })
    // 社交流水只有 recordBili 一个写入口（0.9.0）：点赞这类"动作"也走它，不再由 capRecord 代写。
    if (outboxRecordBili) outboxRecordBili({ kind: '点赞', title: info.title, bvid })
  }
  return { ...res, why: res.ok ? (dup ? '已赞过（幂等）' : '已点赞') : `点赞失败 ${res.message}` }
}

// 【补充】调用方：tools/commands/debrief.mjs（react.coin 为 true 时顺手投币）；act coin 子命令仍是注释状态。
//   参数：bvid 目标视频；num 投几枚（1–2）；go=false 只预览。
//   返回：{ ok, dry?, why, ...接口字段 }。
//   失败：gaia 风控（-401 / 非法访问）单独给一句「去 App 手动投」；其余失败返回 ok:false，不抛错。
/**
 * 给视频投币。B 站对脚本投币有 gaia 风控，被拦时返回一句人话而不是堆栈。
 * @param {string} bvid 目标视频
 * @param {{go?: boolean, num?: number}} [opts] num 默认 1（B 站上限 2）
 * @returns {Promise<{ok: boolean, dry?: boolean, why?: string, code?: number}>}
 */
export async function coinVideo(bvid, { go = false, num = 1 } = {}) {
  const cfg = config().bilibili?.react ?? {}
  if (!go) return { ok: true, dry: true, why: `【干跑】投币 x${num} → ${bvid}` }
  // 0.9.0：守门在联网之前，理由同点赞。
  if (guard.dryBlocked()) return { ok: false, dry: true, why: guard.DRY_WHY }
  if (cfg.coin !== true) return { ok: false, why: 'bilibili.react.coin 是关的（投币要显式开）' }
  if (!capOk('coin', Number(cfg.coinDaily ?? 1))) return { ok: false, why: '今日投币额度已用完' }
  const info = await videoInfo(bvid)
  const cred = loadCred()
  const j = await formPost(cred, 'https://api.bilibili.com/x/web-interface/coin/add', { aid: String(info.aid), multiply: String(num), select_like: '0' })
  if (Number(j?.code) === -401 || /非法访问/.test(String(j?.message ?? ''))) {
    return { ok: false, why: '投币暂不可用：B站 gaia 风控闸（接口/页内/UI 三层都拦），去 App 手动投吧' }
  }
  const res = okOf(j)
  if (res.ok) {
    capRecord('coin', { bvid, title: info.title, extra: num + ' 枚' })
    if (outboxRecordBili) outboxRecordBili({ kind: '投币', title: info.title, bvid, extra: num + ' 枚' })
  }
  return { ...res, why: res.ok ? `已投 ${num} 枚` : `投币失败 ${res.message}` }
}

/*
// ── ⑤ 图片评论 / 关注 / 回复 ────────────────────────────────────────────
// （按需启用，参考 feiyu 的 bili-write.mjs 实现）
*/
