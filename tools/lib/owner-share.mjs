// owner-share —— 她「想给你看这条」的队列（只给她自己的主人，不是 B站 的公开发言）。
//
// 动机（0.8.25）：B站那一轮她说的话会被整轮转发到主人 QQ，但转发的是聊天文本 —— 她可能只说「刷到一个视频」，
// BV 就没带；也可能一轮里说了三件事，视频混在中间。这里给「分享一条视频」一条独立的、带标题和 BV 的路：
// CLI 只往队列里写一行 JSON，QQ 通道（src/ecosystem/qq-native/share.ts）轮询到这个文件、发一条带 BV 的消息给主人。
//
// 【模块卡片】
// 职责：拼/写/读 owner-outbox.jsonl 这一份「待发给主人」的队列，以及它该长什么样。
// 导出：OUTBOX_NAME / shareOutboxPath / shareStatePath / toBvid / videoUrl / formatShare / appendShare / readShares / deliveredIds。
// 调用方：tools/commands/share.mjs（写）、tests、以及宿主侧 qq-native 的 share.ts（读同一份文件）。
// 数据文件：<bili 根>/owner-outbox.jsonl（一行一条，只追加）；<bili 根>/owner-outbox.jsonl.sent.json（通道写回已发 id）。
// 坑：只追加、不改写 —— 通道那边按 id 去重，所以重复读同一个文件不会重复发；写失败要抛给调用方，让她知道没进队列。
// 【链路位置】
//   环节：B站 分享旁路 —— 她决定「这条要给他看」，CLI 把一条记录放进队列，宿主轮询后经 qqNative 私聊发给主人。
//   上游调用：tools/commands/share.mjs（唯一写入口）；宿主 src/ecosystem/qq-native/share.ts 只读同一个文件。
//   下游调用：lib/paths.mjs 的 dataPath；不发网络请求、不碰凭据。
//   读写文件：<bili 根>/owner-outbox.jsonl（追加写）；--list 时额外读 <bili 根>/owner-outbox.jsonl.sent.json。
//   退出码：库不设退出码；参数不合法由命令层判断，本模块只在写盘失败时抛错。
import fs from 'node:fs'
import path from 'node:path'
import { dataPath } from './paths.mjs'

/** 队列文件名；通道侧靠同一条规则拼 .sent.json，改这里两边一起改。 */
export const OUTBOX_NAME = 'owner-outbox.jsonl'

/**
 * 待发队列的绝对路径（跟着 WORLD_ID / WORLD_BILI_DATA_DIR 走）。
 *
 * 调用方：appendShare / readShares / commands/share.mjs 的 --list。
 * 宿主侧 `src/bili/shares.ts` 用同一条拼法（它不能 import 这个 .mjs），改目录规则要两边一起改。
 * @returns {string} 队列文件的绝对路径
 */
export function shareOutboxPath() { return dataPath(OUTBOX_NAME) }

/**
 * 通道写回的「已经发出去」的 id 清单；与队列同目录，方便一起清。
 *
 * 规则固定为「队列路径 + .sent.json」：宿主 `share.ts` 的默认 stateFile 也是这条规则，别单方面改。
 * @returns {string} 状态文件的绝对路径
 */
export function shareStatePath() { return dataPath(OUTBOX_NAME + '.sent.json') }

/**
 * 从一串文本里认出 BV 号：既接受裸 BV，也接受 B站 的各种链接形式。
 * @param {string} input 可能是 `BV1xx411c7mD`、`https://www.bilibili.com/video/BV1xx411c7mD`、`?bvid=BV…`
 * @returns {string|null} 规范化后的 BV（大小写保留原样），认不出返回 null
 * @throws 不抛错 —— 认不出就是 null，由调用方决定报用法（`commands/share.mjs` 会 exit 2）
 */
export function toBvid(input) {
  const text = String(input ?? '').trim()
  if (!text) return null
  // 裸 BV：BV 后面 8–12 位字母数字。容错到 8 位是为了老视频/手抄少一位时也能进队列，宁可多收不可丢。
  const bare = text.match(/^BV[0-9A-Za-z]{8,12}$/)
  if (bare) return bare[0]
  const inUrl = text.match(/\/video\/(BV[0-9A-Za-z]{8,12})/) || text.match(/[?&]bvid=(BV[0-9A-Za-z]{8,12})/)
  return inUrl ? inUrl[1] : null
}

/**
 * 视频的公开链接（给人点开用；QQ 消息里只发 BV，不发这个）。
 * @param {string} bvid 视频号
 * @returns {string} `https://www.bilibili.com/video/<bvid>`
 */
export function videoUrl(bvid) { return `https://www.bilibili.com/video/${bvid}` }

/**
 * 一条记录在 QQ 里长什么样：标题、BV、她想说的那句话，各占一行。
 *
 * 只给 BV 不给链接：主人要的是能自己贴进 B站 的号（`BV` 是它的主键），一条 `https://…` 太长。
 * 三行之间**不留空行**：QQ 通道按空行把一段话拆成多条消息（见 qq-native/replies.ts），
 * 留空行会变成「标题一条、BV 一条、话一条」，看着像刷屏。
 * @param {{title?: string, bvid?: string, url?: string, say?: string}} record
 * @returns {string} 每条记录都带 BV；没有 bvid 的老记录才退回 url
 * @throws 不抛错；三个字段全空时返回空串（调用方据此跳过这条）
 */
export function formatShare(record) {
  const lines = []
  const title = String(record?.title ?? '').trim()
  if (title) lines.push(`《${title}》`)
  const bvid = String(record?.bvid ?? '').trim()
  const url = String(record?.url ?? '').trim()
  if (bvid) lines.push(bvid)
  else if (url) lines.push(url)
  const say = String(record?.say ?? '').trim()
  if (say) lines.push(say)
  return lines.join('\n')
}

/** 队列最多留多少条：再多就把最旧的丢掉（只增不清会一直长）。 */
export const OUTBOX_MAX_RECORDS = 200

/**
 * 把队列压到上限内：保留最新的一批，丢掉更早的。
 *
 * 通道按 id 去重、只取「还没发过的」，所以丢掉早已发出/早于 200 条前的记录不会让谁收不到；
 * 唯一会受影响的是「通道离线期间积了 200 条以上」——那种情况本来就该由人来看了。
 */
function compactOutbox(file) {
  try {
    const records = readShares(file)
    if (records.length <= OUTBOX_MAX_RECORDS) return
    const keep = records.slice(-OUTBOX_MAX_RECORDS)
    fs.writeFileSync(file, keep.map(record => JSON.stringify(record)).join('\n') + '\n', 'utf8')
  } catch { /* 压实失败不影响这条已经进了队列 */ }
}

/**
 * 往队列里追加一条「想给你看这条」。
 *
 * 同一条视频、同一句话在 10 分钟内重复递进来时直接返回上一条，不再追加一遍 ——
 * 她一轮里连叫两次 share 很常见，重复的会在 QQ 上变成两条一模一样的消息。
 * @param {{bvid: string, title?: string, say?: string, now?: number}} input
 * @returns {{record: object, duplicate: boolean}} 落盘的记录；duplicate 为真时是命中已有的那条
 * @throws {Error} 写盘失败时抛出（调用方要让她知道没进队列）
 */
export function appendShare({ bvid, title = '', say = '', now = Date.now() }) {
  const record = {
    // id 由时间 + 随机段拼成：通道按 id 去重，不能依赖数组下标（文件只追加，行号会变）。
    id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date(now).toISOString(),
    bvid,
    title: String(title ?? '').trim(),
    say: String(say ?? '').trim(),
  }
  const file = shareOutboxPath()
  const duplicate = readShares(file).find(old => old.bvid === record.bvid && old.say === record.say && now - Date.parse(old.at) < 10 * 60_000)
  if (duplicate) return { record: duplicate, duplicate: true }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  // 追加写：一条一行。用 \n 结尾，通道按行 parse，不需要额外分隔符。
  fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8')
  // 0.8.25：队列只增不清会一直长（一天几条，一年也是几千行），顺手压到上限内。
  compactOutbox(file)
  return { record, duplicate: false }
}

/**
 * 读出队列里的全部记录（文件不存在就是空的，正常的第一次）。
 *
 * 坏行（手改坏了、写了一半）直接跳过：一条坏行不该让整条分享通道停摆。
 * @param {string} [file] 队列路径，默认 shareOutboxPath()
 * @returns {Array<{id: string, at: string, bvid: string, title: string, say: string, url: string}>}
 * @throws 不抛错；文件不存在返回空数组（第一次跑的正常状态）
 */
export function readShares(file = shareOutboxPath()) {
  let raw = ''
  try { raw = fs.readFileSync(file, 'utf8') } catch { return [] }
  const out = []
  for (const line of raw.split('\n')) {
    const text = line.trim()
    if (!text) continue
    try {
      const record = JSON.parse(text)
      // id 是去重的唯一依据：没有 id 的行发出去就无法记账，宁可当成坏行丢掉。
      if (record && typeof record.id === 'string' && record.id) out.push(record)
    } catch { /* 坏行跳过 */ }
  }
  return out
}

/**
 * 通道已经发出去的 id（命令行的 --list 用它区分「在排队」和「已发出」）。
 * @param {string} [file] 状态文件路径，默认 shareStatePath()
 * @returns {Set<string>} id 集合；文件缺失或写坏了返回空集合（最坏是 --list 把已发的显示成排队）
 */
export function deliveredIds(file = shareStatePath()) {
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'))
    return new Set(Array.isArray(state?.ids) ? state.ids.map(String) : [])
  } catch { return new Set() }
}
