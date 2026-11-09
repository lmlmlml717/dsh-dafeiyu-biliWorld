// outbox —— 她的公开发言台账（B站）：评论/回评/弹幕/动态/图片评论，主人随时翻。
// 动机（10-25 用户）：她在 B站 说了什么、回了谁，主人很难自己去翻 —— 一个文件看尽她的社交进化。
// 位置 ~/.feiyu-ai/bili-outbox.md，按天分组、最新在上，带视频链接点进去就看得到上下文。
//
// 【模块卡片】
// 职责：把她的公开言行写进人读的 Markdown 台账，并顺手转给 social-log 记一条机器可查的流水。
// 导出：recordBili（唯一入口，记一条）。
// 调用方：lib/bili-write.mjs（评论/动态成功后调用）；主人直接看 bili-outbox.md。
// 数据文件：<bili 根>/bili-outbox.md（读-改-写）；另异步追加 bili-social.jsonl。
// 坑：台账写失败必须吞掉 —— 不能因为她社交已成功、只是记账失败而误报发送失败。
// 【链路位置】
//   环节：人读台账旁路 —— 评论/动态/回评成功后由 bili-write 调 recordBili，写 bili-outbox.md 并顺手转 social-log。
//   上游调用：lib/bili-write.mjs（发送成功后调用；用动态 import 拿 recordBili，失败就退化成只记 JSONL）。
//   下游调用：lib/social-log.mjs 的 append（动态 import）、lib/paths.mjs。
//   读写文件：<bili 根>/bili-outbox.md（整文件读改写，按天分组、最新在上）。
//   退出码：库不设退出码；台账写失败必须吞掉，不能把已成功的发送误报成失败。
//   上游参考：bili-outbox.md 的散文格式同时是 social-log.backfillFromOutbox 的输入，两份记录共用同一套 kind 词表。
import fs from 'node:fs'
import path from 'node:path'
import { dataPath } from './paths.mjs'

const MD = () => dataPath('bili-outbox.md')
// 0.9.0：抬头不再写死「大肥鱼」—— 这个名字属于另一个角色，换成世界时台账标题就错了。
// 判断"这是我们的台账"只看这句话，不看抬头长什么样，免得旧文件被当成换了头而清空。
const HEADER = '# B站发言台账\n\n> 她在 B站 公开说的每一句话，按天记录（最新在上）。点链接看视频和评论上下文。\n\n'
const HEADER_MARK = 'B站发言台账'

// 只有"她公开说了话"才进人读台账：点赞/投币/关注/投稿不是发言，写进去只会把散文台账弄脏。
const SPEECH_KINDS = new Set(['评论', '分享评论', '回评', '弹幕', '动态', '转发动态', '纯动态', '图片评论'])

// 【补充】调用方：lib/bili-write.mjs 的 postDynamic / postReply / shareVideoDynamic 成功后，
//   以及点赞、投币成功后（0.9.0：动作类只记 JSONL，不写人读台账）。
//   参数：kind 是中文台账词（评论/分享评论/回评/弹幕/动态/图片评论/转发动态/纯动态/点赞/投币）；
//         title/bvid/to/text/extra 进流水。
//   返回：无；流水异步转给 social-log，发言类另外写 bili-outbox.md。
//   失败：所有异常吞掉（记账失败绝不改变「已经发出去」这个事实）。
/**
 * 记一条公开发言：写人读台账（只收发言类）+ 追加一条机器可查的社交流水。
 * @param {{kind: string, title?: string, bvid?: string, to?: string, text?: string, extra?: string}} o
 *   kind 用中文台账词；`id` 由 social-log 生成，这里不需要。
 * @returns {void} 无返回值；写盘失败静默（不影响已经发出去的动作）
 */
export function recordBili({ kind, title = '', bvid = '', to = '', text = '', extra = '' }) {
  // ① 结构化流水（第 17 轮）：主人要能筛、能统计、能收到摘要
  // 流水是附加品：动态 import 或 append 失败也只丢流水，不影响台账和已经发出去的评论。
  try {
    const KIND_MAP = {
      评论: 'comment', 分享评论: 'share', 回评: 'reply', 弹幕: 'danmaku',
      动态: 'dynamic',
      // 0.9.0：以前「转发动态 / 纯动态 / 点赞 / 投币」没有映射，全部落到 || 'comment' ——
      // 于是每发一条动态，社交流水里都会多一条假的「评论」。这里一张表把中文台账词收全。
      转发动态: 'dyn_share', 纯动态: 'dyn_pure', 点赞: 'like', 投币: 'coin',
      图片评论: 'imgComment', 关注: 'follow', 投稿: 'video',
    }
    import('./social-log.mjs').then((s) => s.append({ kind: KIND_MAP[kind] || 'comment', bvid, title, to, text, extra })).catch(() => {})
  } catch {}
  // ② 人读台账只收"发言"：点赞/投币这类动作写进《B站发言台账》会把散文弄脏（0.9.0）。
  if (!SPEECH_KINDS.has(kind)) return
  try {
    const now = new Date()
    const day = now.toLocaleDateString('sv-SE')
    const time = now.toTimeString().slice(0, 5)
    const md = MD()
    let content = ''
    // 台账是整文件读改写、没有加锁：这里只求「主人能看」，不追求并发下的严格一致。
    try { content = fs.readFileSync(md, 'utf8') } catch {}
    // 文件被清空或换了头就重置成标准头，避免把旧格式内容顶到新头下面。
    if (!content.includes(HEADER_MARK)) content = HEADER
    // 旧文件的抬头带着写死的名字：只把这一行换掉，正文一行不动。
    content = content.replace(/^#[^\n]*B站发言台账[^\n]*/, '# B站发言台账')
    // 当天小节不存在才插一个；已存在就复用，保证同一天只有一段。
    if (!content.includes(`## ${day}\n`)) {
      // 抬头认得出就插在抬头后面；认不出（手改过格式）就补一整块标准抬头，绝不把内容顶丢。
      content = content.includes(HEADER) ? content.replace(HEADER, HEADER + `## ${day}\n\n`) : HEADER + `## ${day}\n\n` + content
    }
    // 标题截 24 字：台账一行太长会把正文挤没，完整标题点链接看。
    const link = bvid ? `[《${String(title || bvid).slice(0, 24)}》](https://www.bilibili.com/video/${bvid})` : (title ? `《${String(title).slice(0, 24)}》` : '')
    const toPart = to ? ` →回应「${String(to).slice(0, 24)}」` : ''
    const extraPart = extra ? ` _(${extra})_` : ''
    // 正文截 160 字：台账是索引不是全文存档，更长的正文在 social-log 的 JSONL 里。
    const line = `- ${time} **${kind}** ${link}${toPart}：${String(text).slice(0, 160)}${extraPart}\n`
    // 最新插到当天小节最上（当天的从上往下 = 从新到旧）
    // 插在标题后的空行之后，所以顺序是「最新在上」而不是按写入时间往下堆。
    const at = content.indexOf(`## ${day}\n`) + `## ${day}\n\n`.length
    content = content.slice(0, at) + line + content.slice(at)
    fs.mkdirSync(path.dirname(md), { recursive: true })
    fs.writeFileSync(md, content)
  } catch { /* 台账失败绝不影响发评本身 */ }
}
