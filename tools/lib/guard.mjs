// 风控闸门 —— dafeiyu 骨架 ops/guard.py 的 JS 移植。
//
// 所有外发消息都必须过这里：
//   · DRY_RUN   默认开（第一周只打印不真发 —— dafeiyu 的铁律）
//   · 清洗      banned 词（"作为AI"…）+ 剥 markdown
//   · 限速      同一 chat 两条消息最小间隔
//   · 去重      3-gram Jaccard 超阈值判复读，宁可沉默不刷屏
// 状态持久化（sent-log.json / sent-at.json）：CLI 每次都是新进程，内存态没有意义 ✗
//
// 【模块卡片】
// 职责：所有对外发送前的统一闸门 —— 干跑、清洗、限速、复读检测，以及成功后的记账。
// 导出：grams / clean / dupOk / dryBlocked / DRY_WHY / allow / commit / lastSentAt。
// 调用方：lib/bili-write.mjs（评论/动态）、tools/bili.mjs（deps 状态检查）。
// 数据文件：<bili 根>/sent-log.json（每个 chat 最近 50 条正文）、sent-at.json（上次成功时间）。
// 坑：CLI 每次都是新进程，状态只能落盘；写文件用「临时文件 + rename」防止读到写一半的 JSON。
// 【链路位置】
//   环节：所有对外发送前的统一闸门 —— 评论/动态（lib/bili-write.mjs）先过这里；tools/bili.mjs 的 deps 只读 dryBlocked 做提示。
//   上游调用：lib/bili-write.mjs 的 postDynamic / postReply / shareVideoDynamic；tools/bili.mjs（deps 第 ⑤ 项）。
//   下游调用：lib/config.mjs（guard.dryRun / minGapSec / dupThreshold / banned）、lib/paths.mjs（sent-log.json / sent-at.json）。
//   读写文件：sent-log.json（每个 chatId 最近 50 条正文）、sent-at.json（上次成功时间）；写文件用临时文件 + rename。
//   退出码：库不设退出码，判定结果以 { ok, why } 返回，由写通道转成「没发」的原因。
//   上游参考：整层是 dafeiyu 骨架 ops/guard.py 的 JS 移植（干跑铁律、3-gram 复读、最小间隔）。
import fs from 'node:fs'
import { dataPath } from './paths.mjs'
import { config } from './config.mjs'

function sentLogFile() { return dataPath('sent-log.json') }
function sentAtFile() { return dataPath('sent-at.json') }

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}
function writeJson(file, value) {
  fs.mkdirSync(dataPath(), { recursive: true })
  const temp = file + '.' + process.pid + '.tmp'
  fs.writeFileSync(temp, JSON.stringify(value))
  fs.renameSync(temp, file)
}

// 【补充】调用方：dupOk()（判重）与 commit()（记账）之外，测试也直接用它验指纹。
//   参数：s 任意文本（会先去掉所有空白）；n 是 gram 长度，默认 3。
//   返回：Set<string>，字符不足 n 时为空集。
//   失败：不抛错；null/undefined 当空串。
/** 3-gram 集合（dafeiyu guard.py _grams）。 */
export function grams(s, n = 3) {
  // 去掉所有空白再切：中文没有词边界，空白只会把同一句话切成不同指纹。
  s = String(s ?? '').replace(/\s+/g, '')
  const out = new Set()
  for (let i = 0; i < Math.max(0, s.length - n + 1); i++) out.add(s.slice(i, i + n))
  return out
}

/** 清洗：去黑名单词、剥 markdown、压空白。 */
// 【上游参考】AI_TONE 的句式表与 dafeiyu ops/guard.py 的清洗规则同源；3-gram 复读阈值与最小间隔沿用同一套默认值。
// 客服/AI 腔，真人不会这么说。宁可删掉，也别让她像个助手。
const AI_TONE = [
  /希望(这|以上|我的回答)?(能|可以)?(对你)?(有|有所)?(帮助|帮到你|帮上忙)[。！!~～]?/g,
  /(总的来说|综上所述|总而言之)[，,：:]?/g,
  /作为一个?(AI|人工智能|语言模型)[，,]?/gi,
  /(首先|其次|另外|最后)[，,]/g,
  /如果你(还)?(有|需要)(其他|别的)?(问题|需要)[，,]?[^。！？\n]*[。！？]?/g,
  /(以上|就这些)[。，,]?(希望|祝)[^。\n]*[。！]?/g,
  /^(AI|人工智能)[，,]\s*/,
]

// 【补充】调用方：postDynamic / postReply / shareVideoDynamic 发送前各调一次。
//   参数：text 原文；cfg 可注入（默认读当前配置）。返回：清洗后的文本（可能为空串，调用方据此判「内容为空」）。
//   失败：不抛错；清洗只做删除与压空白，不截长度（截断由各写通道自己做）。
export function clean(text, cfg = config()) {
  let t = String(text ?? '')
  // 黑名单词直接删掉而不是替换成星号：星号会暴露「这里有敏感词」，还破坏句子结构。
  for (const bad of cfg.guard?.banned ?? []) t = t.split(bad).join('')
  t = t.replace(/\*\*(.+?)\*\*/g, '$1')
  t = t.replace(/`{1,3}/g, '')
  t = t.replace(/\n{3,}/g, '\n\n')
  // 先剥 markdown 再删 AI 腔：否则 `**希望这对你有帮助**` 这种加粗会躲过后面的正则。
  for (const re of AI_TONE) t = t.replace(re, '')
  t = t.replace(/[ \t]{2,}/g, ' ')
  return t.trim()
}

// 【补充】调用方：allow() 的第三步检查；写通道不直接调它。
//   参数：chatId 用于分账（评论固定 'bilibili:comment'）；text 待发正文；cfg 可注入。
//   返回：true = 不算复读、false = 与最近 20 条里某一条的 3-gram Jaccard 超过阈值。
//   失败：不抛错；正文不足 3 个字符直接放行（短句本来就容易撞）。
/** 复读检测：与最近 20 条输出的 3-gram Jaccard 超过阈值即判重。 */
export function dupOk(chatId, text, cfg = config()) {
  const thr = Number(cfg.guard?.dupThreshold ?? 0.6)
  const g1 = grams(text)
  // 没有 3-gram（输入不足 3 个字符）就不判重：短句本来就容易撞，拦了会让她没法正常回应。
  if (!g1.size) return true
  const log = readJson(sentLogFile(), {})[chatId] ?? []
  // 只和最近 20 条比：更早的复读已经沉底，全量比较会让长会话越来越容易被误判。
  for (const old of log.slice(-20)) {
    const g2 = grams(old)
    if (!g2.size) continue
    let inter = 0
    for (const g of g1) if (g2.has(g)) inter++
    const j = inter / (g1.size + g2.size - inter)
    if (j > thr) return false
  }
  return true
}

// 【补充】调用方：lib/bili-write.mjs 三个写通道的干跑判断、tools/bili.mjs 的 deps 状态提示。
//   参数：cfg 可注入（默认读当前配置）。返回：true = 现在是干跑，写操作应直接返回 dry:true。
//   失败：不抛错；字段缺失按 false 处理（但 DEFAULTS 里默认是 true）。
/** 干跑闸（10-25 统一）：所有"对外真发"的写操作都必须先过这里。
 *  以前只有 B站评论 / QQ 秒回主链 / 主动搭话查了 dryRun，
 *  弹幕·动态·点赞·投币·图片评论·关注·群插话·空间说说·唱歌发音频全都照发 —— 干跑形同虚设。 */
export function dryBlocked(cfg = config()) {
  return !!cfg.guard?.dryRun
}

// 所有写通道共用这一句，保证「为什么没发」在 CLI、日志、提示语里是同一个说法。
/**
 * 干跑拦截时返回给调用方看的统一原因文案。
 * @type {string}
 */
export const DRY_WHY = '干跑（guard.dryRun 开着）：这次不真发 —— 想真发先把 bili.config.json 的 guard.dryRun 改成 false'

// 【补充】调用方：postReply 在额度检查之后调它（评论还要先过 minIntervalSec，这里的 minGapSec 是第二道间隔）。
//   参数：chatId 分账键；text 待发正文；cfg 可注入；opts.checkDryRun=false 可跳过干跑（目前没有调用点这么传）。
//   返回：{ ok, why }；ok=false 时 why 是三种原因之一（干跑 / 间隔不足 / 复读）。
//   失败：不抛错；读不到 sent-at.json 当作从没发过。
/**
 * 统一判定入口（发送前）。
 * @returns {{ok: boolean, why: string}} ok=false 时 why 说明原因。
 */
export function allow(chatId, text, cfg = config(), opts = {}) {
  if (opts.checkDryRun !== false && cfg.guard?.dryRun) return { ok: false, why: `DRY_RUN（干跑：只打印不真发；确认没问题后把 bili.config.json 的 guard.dryRun 改 false）` }
  // 默认 25 秒：比人打字快一点的节奏，既能连着聊，又不至于被平台当成脚本刷屏。
  const gap = Math.max(0, Number(cfg.guard?.minGapSec ?? 25))
  const at = readJson(sentAtFile(), {})[chatId] ?? 0
  if (Date.now() - at < gap * 1000) return { ok: false, why: `间隔不足 ${gap}s` }
  if (!dupOk(chatId, text, cfg)) return { ok: false, why: '复读检测（3-gram 相似度过高）—— 换个说法再发' }
  return { ok: true, why: '' }
}

// 【补充】调用方：postReply 发送成功后（guard.allow 已通过、接口返回 code=0）。
//   参数：chatId 分账键；text 已发出的正文。返回：无。
//   失败：写盘失败会抛（两条 writeJson 都不吞）—— 记账失败不该被当成发送失败，但也不会静默。
/** 发送成功后记账（时间 + 内容）。 */
export function commit(chatId, text) {
  const log = readJson(sentLogFile(), {})
  const list = log[chatId] ?? []
  list.push(String(text))
  // 每个 chat 只留最近 50 条：复读检测用不到更早的，文件也不至于无限长。
  log[chatId] = list.slice(-50)
  writeJson(sentLogFile(), log)
  const at = readJson(sentAtFile(), {})
  at[chatId] = Date.now()
  writeJson(sentAtFile(), at)
}

// 【补充】调用方：lib/bili-write.mjs 的 postReply —— 消息**已经发出去之后**才调它。
//   参数：chatId 分账键；text 已发出的正文。
//   返回：true = 记账写成；false = 没写成（只读沙箱、磁盘满、权限被拒）。
//   失败：不抛错。这里写失败只代表本地的风控状态旧了，绝不代表那条消息没发出去 ——
//         以前它直接抛，于是已经发出去的评论被报成「评论失败」。
/** 发送成功后的记账，失败只吞掉（返回 false），不改变「已经发出去了」这个事实。 */
export function commitQuietly(chatId, text) {
  try { commit(chatId, text); return true }
  catch (error) {
    // stderr 不进她读到的材料：这条是给排障用的，不该变成她的台词。
    try { process.stderr.write(`[guard] 风控记账没写成（不影响已发出的消息）：${String(error?.message ?? error).slice(0, 120)}\n`) } catch {}
    return false
  }
}

// 【补充】调用方：postReply 算评论最小间隔（comment.minIntervalSec）时读它。
//   参数：chatId 分账键（评论固定 'bilibili:comment'）。返回：上次成功的毫秒时间戳，没发过返回 0。
//   失败：读不到/坏 JSON 返回 0，等同于「从没发过」。
/** 上一次在这个 chatId 发送成功的毫秒时间戳；没发过返回 0（评论的 minIntervalSec 用）。 */
export function lastSentAt(chatId) {
  return Number(readJson(sentAtFile(), {})[chatId] ?? 0) || 0
}
