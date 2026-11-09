// comment-kind —— 一条评论到底是"文字 / 只有 emoji / 图片 / 表情包 / 空"。
//
// 为什么要有这个文件（10-27 主人报的 bug）：
//   抖音那边她只回了主人的文字评论，别人发**表情包**的那条一直没反应。根因是上层一句
//   `if (!c.text) continue` —— 纯表情包评论的 text 是空串，整条被当成"没有内容"丢掉。
//   B站同理：图片评论（content.pictures）没有字、只有 `[大笑]` 的评论剥掉占位也没有字。
//   现在统一在这里判类型，两个平台都按 label/kind 交给 LLM，**任何类型都有话可说**。
//
// 约定：
//   kind = 'text'    有真文字（剥掉 [微笑] 这类占位后还剩字）
//        | 'emote'   只有 `[微笑]` 这种 emoji 占位
//        | 'sticker' 抖音表情包贴纸（有 sticker 名字，没有字）
//        | 'image'   图片评论（pictures > 0，没有字）
//        | 'empty'   什么都没有（只剩贴纸/被折叠）
//   label = 给她看的"这条评论说了什么"：文字原样，其余给一句人话描述。
//
// 【模块卡片】
// 职责：判定一条评论的内容类型（文字/表情/表情包/图片/空），并给出给她看的一句描述。
// 导出：plainText / classifyComment / replyable / stickerFallback。
// 调用方：当前仓库内没有直接 import（评论回复功能还没接进来），保留给接入评论时复用。
// 数据文件：不读写文件，全是纯函数。
// 坑：不能拿「剥掉占位后还剩不剩字」代表「有没有内容」—— 图片/表情包本来就没字但必须回；
//     hasSticker 与 sticker 名字要分开判断（抖音的贴纸名字常是哈希或 URL）。
// 【链路位置】
//   环节：评论内容分类纯函数 —— 判定一条评论是文字/表情/表情包/图片/空，给上层决定「怎么回」；当前工具链没有直接 import。
//   上游调用：暂无（评论回复功能还没接进来）；接入后由评论读取侧调用 classifyComment，再把 label 交给 LLM。
//   下游调用：无，纯函数，不读写文件、不联网。
//   读写文件：不读写。
//   退出码：库不设退出码；任何输入都返回一种 kind，不抛错。
//   上游参考：判型动机来自 10-27 的抖音表情包评论 bug（`if (!c.text)` 把没字的评论整条丢掉），B站图片评论同理。

// 只匹配 1–10 字的方括号占位（[微笑] 这类）；太长的不当占位，避免误伤正文里的方括号。
const EMOJI_PLACEHOLDER = /\[[^\]\n]{1,10}\]/g

// 【补充】调用方：classifyComment 判断「剥掉占位后还剩不剩真字」。
//   参数：s 评论原文。返回：去掉 [微笑] 这类占位、零宽字符与所有空白后的字符串；没字时为空串。
//   失败：不抛错；null/undefined 当空串。
/** 剥掉 `[微笑]` 这类占位、零宽字符和空白，看还剩不剩真字。 */
export function plainText(s) {
  // 零宽字符和变体选择符也要剥：纯表情评论的 text 经常只剩这些不可见字符，trim 后仍非空。
  return String(s ?? '')
    .replace(EMOJI_PLACEHOLDER, '')
    .replace(/[\u200b-\u200f\ufe0f]/g, '')
    .replace(/\s+/g, '')
}

// 【补充】调用方：评论读取侧（接入后）逐条判型；replyable() 用它决定是否值得回，stickerFallback 用 label。
//   参数：raw 兼容两平台字段名（text/message、sticker/sticker_name、pictures/pics、hasSticker/has_sticker）。
//   返回：{ kind, label, plain, text, sticker, pictures }；kind 一定是 text/emote/sticker/image/empty 之一。
//   失败：不抛错；字段缺失按空值处理，最终落到 empty。
/**
 * 判类型 + 给一句人话描述。两个平台的字段名不完全一样，这里统一收口。
 * @param {{text?:string, message?:string, sticker?:string, hasSticker?:boolean, pictures?:number|any[], emote?:object}} raw
 * @returns {{kind:string,label:string,plain:string,text:string,sticker:string,pictures:number}}
 */
export function classifyComment(raw = {}) {
  const text = String(raw.text ?? raw.message ?? '').trim()
  const sticker = String(raw.sticker ?? raw.sticker_name ?? '').trim()
  // 「有没有贴纸」和「贴纸叫什么」是两件事：抖音的贴纸名字常是哈希，剥完就空了，
  // 但这条评论**确实是**表情包（10-27 实测：靠名字判会把整条又判成空评论）。
  const hasSticker = Boolean(raw.hasSticker ?? raw.has_sticker ?? sticker)
  let pictures = raw.pictures ?? raw.pics ?? 0
  // pictures 在不同平台可能是数字、数组或对象，统一折算成张数，后面只比较数字。
  if (Array.isArray(pictures)) pictures = pictures.length
  else if (pictures && typeof pictures === 'object') pictures = Object.keys(pictures).length
  pictures = Number(pictures) || 0
  const plain = plainText(text)
  if (plain) return { kind: 'text', label: text, plain, text, sticker, pictures }
  if (hasSticker) {
    // 抖音贴纸的 display_name 有时是 URL/哈希文件名 —— 别把链接或乱码念给她听
    const nice = /^https?:/i.test(sticker) || /^[A-Za-z0-9_\-~.]{12,}$/.test(sticker) ? '' : sticker
    return { kind: 'sticker', label: nice ? `（发了张表情包：${nice}）` : '（发了张表情包，没有文字）', plain: '', text, sticker, pictures }
  }
  if (pictures) return { kind: 'image', label: `（发了 ${pictures} 张图，没有文字）`, plain: '', text, sticker, pictures }
  if (text) return { kind: 'emote', label: text, plain: '', text, sticker, pictures }
  return { kind: 'empty', label: '（空评论，可能只有贴纸或已被折叠）', plain: '', text, sticker, pictures }
}

// 【补充】调用方：评论读取侧决定「这条要不要回」。
//   参数：classifyComment 返回的 kind。返回：false 仅当 kind === 'empty'。
//   失败：不抛错；未知 kind 当作可回（宁可多说一句，也不把没字的评论丢掉）。
/** 这条能不能回（现在什么类型都能回，只有完全空的才不建议硬凑）。 */
// 只有 empty 才不建议硬回；文字/表情/图片/贴纸都算有内容，别让「没字」变成不回的理由。
export function replyable(kind) {
  return kind !== 'empty'
}

// 【补充】调用方：评论读取侧在「LLM 也没憋出话」时用；按 label 里的关键词选语气组。
//   参数：label 是 classifyComment 给的人话描述；seed 决定组内第几句（同一条评论重试时保持同一句）。
//   返回：一句中文兜底回复。
//   失败：不抛错；label 缺失用最后一组通用话术。
/** 表情包/图片这种"没字"的评论，LLM 万一也憋不出话时的兜底回复（轮换，别老一句）。 */
export function stickerFallback(label = '', seed = 0) {
  const s = String(label)
  // 按 label 里的关键词选语气：图/照、表情/贴纸各一组，其余兜底；中英混排也不影响。
  const pool = /图|照/.test(s)
    ? ['这张图我存了，笑死', '图收下了，谢谢你的图', '哈哈这图不错，本鱼收藏了']
    : /表情|贴纸/.test(s)
      ? ['这个表情包赏你了，回你一个', '表情包收到了，笑死我了', '哈哈这个表情好可爱']
      : ['看到了，说不出话是吧', '你这条我收到了，笑死', '不会说话就用表情，懂的都懂']
  // 用 seed 轮换而不是纯随机：同一条评论重试时给同一句兜底，避免反复变话像精神分裂。
  return pool[Math.abs(Number(seed) || 0) % pool.length]
}