// media —— debrief 六路里"不需要网络"的那几个纯函数：时间格式化、弹幕解析/分桶、抽帧时间点挑选。
//
// 为什么拆出来：debrief 要一次拉六路（元信息/封面/字幕/弹幕/热评/抽帧），逻辑一多就没法单测。
// 把纯函数放这里，debrief 只负责发请求、拼输出；这些函数可以在没有网络、没有 ffmpeg 的机器上跑测试。
//
// 【上游参考】
//   · 弹幕 XML 的解析、"刷屏波"归一化聚类、按桶取峰值：dsh-bili-whale 的 tools/commands/debrief.mjs（MIT）。
//   · 抽帧时间点"等间隔骨架 + 吸附画面变化点"：dsh-bili-whale 的 tools/commands/bili-watch.mjs（MIT）。
//   这里只是把两段逻辑提成可测的纯函数，阈值与注释保持原实现的口径。
//
// 【模块卡片】
// 职责：debrief 里「不需要网络」的纯函数 —— 时间格式化、弹幕 XML 解析 / 刷屏剔除 / 分桶取峰值、抽帧时间点挑选。
// 导出：fmtClock / parseDanmakuXml / normDanmaku / summarizeDanmaku / pickFrameTimes。
// 调用方：tools/commands/debrief.mjs（字幕对齐 + 弹幕热区）、tools/lib/frames.mjs（时间点与时钟格式）、各测试。
// 数据文件：不读不写；不联网。
// 坑：① 弹幕 XML 只是**采样集**（实测标称 12.9 万条只给 3600 条），绝对条数不能当全集说；
//     ② 纯符号弹幕归一化后是空串，必须单独记成一个键，否则「???」×500 这种刷屏会被漏判。
// 【链路位置】
//   环节：debrief 的③字幕对齐 / ④弹幕热区 / ⑥抽帧时间点，三处共用这里的纯函数。
//   上游调用：debrief.mjs（解析 XML、分桶取峰值、把峰值对到字幕）、frames.mjs（挑抽帧时间点）。
//   下游调用：无（纯函数，不 import 其它 lib）。
//   读写文件：无。退出码：库不设退出码，输入再怪也不抛错（返回空结果）。

/** 秒 → mm:ss（超过一小时也只按分计，和 whale 的输出一致）。 */
export function fmtClock(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

/** XML 文本里的五个实体；弹幕正文里出现 &amp; 时不能原样吐给模型。 */
function unescapeXml(text) {
  return String(text)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

/**
 * 解析 B站弹幕 XML（comment.bilibili.com/<cid>.xml）。
 * 每条形如 <d p="时间,模式,字号,色,时间戳...">正文</d>，只取 p 的第一段（秒）和正文。
 * @param {string} xml XML 全文
 * @returns {{ t: number, text: string }[]} 按出现顺序；时间不是数字的条目丢弃
 */
export function parseDanmakuXml(xml) {
  const out = []
  for (const m of String(xml || '').matchAll(/<d p="([^"]*)">([^<]*)<\/d>/g)) {
    const t = Number(m[1].split(',')[0])
    const text = unescapeXml(m[2]).trim()
    if (Number.isFinite(t) && text) out.push({ t, text })
  }
  return out
}

/**
 * 弹幕归一化：去掉空白、标点与符号，用来识别"刷屏波"（同一句被复制很多遍）。
 * 实测仪式弹幕连带变体能吃掉 87% 的条数，所以峰值必须按"剔刷屏后"排序。
 */
export function normDanmaku(text) {
  return String(text || '').replace(/[\s\p{P}\p{S}]/gu, '')
}

/**
 * 弹幕分桶 + 峰值 + 高频词。
 * 规则（沿用 whale 的实测口径）：
 *   · 按 --bucket（默认 30 秒）分桶；
 *   · 归一化后同一句占全片 >30% 且 ≥20 条 → 判刷屏波，整句剔除（含它的变体）；
 *   · 峰值按"剔刷屏后"的有效条数排序，避免开场仪式弹幕把真正的名场面挤下去。
 * @param {{t:number,text:string}[]} list parseDanmakuXml 的结果
 * @param {{bucket?:number, top?:number, subtitleAt?:(t:number)=>string|null}} [opts]
 * @returns {{ buckets:number, total:number, realTotal:number, avgReal:number, spam:{key:string,count:number}[], spamHits:number, peaks:{from:number,to:number,raw:number,real:number,hot:boolean,lines:{text:string,count:number}[],subtitle:string|null}[], topAll:{text:string,count:number}[] }}
 */
export function summarizeDanmaku(list, opts = {}) {
  const bucket = Math.max(1, Number(opts.bucket) || 30)
  const top = Math.max(1, Number(opts.top) || 5)
  const subtitleAt = opts.subtitleAt || (() => null)
  const items = Array.isArray(list) ? list : []

  // ① 先数"归一化后同一句"出现多少次：够多又够集中，就是刷屏波。
  const keyCounts = new Map()
  for (const x of items) {
    const key = normDanmaku(x.text) || '<纯符号>'
    keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1)
  }
  const spam = [...keyCounts.entries()]
    .filter(([, count]) => count >= 20 && count / Math.max(1, items.length) > 0.3)
    .map(([key, count]) => ({ key, count }))
  const isSpam = (text) => {
    const key = normDanmaku(text)
    return key.length === 0 || spam.some((s) => key.includes(s.key))
  }

  // ② 分桶；raw 保留原始条数，real 只留剔刷屏后的，便于对照"某段是真热还是刷的"。
  const map = new Map()
  for (const x of items) {
    const from = Math.floor(x.t / bucket) * bucket
    if (!map.has(from)) map.set(from, { raw: [], real: [] })
    const b = map.get(from)
    b.raw.push(x)
    if (!isSpam(x.text)) b.real.push(x)
  }
  const realTotal = [...map.values()].reduce((n, b) => n + b.real.length, 0)
  const avgReal = realTotal / Math.max(1, map.size)

  // ③ 峰值：按有效条数排序；≥ 平均 1.5 倍标 hot（🔥）。
  const peaks = [...map.entries()]
    .sort((a, b) => b[1].real.length - a[1].real.length)
    .slice(0, top)
    .map(([from, b]) => {
      const counts = new Map()
      for (const x of b.real) counts.set(x.text, (counts.get(x.text) ?? 0) + 1)
      return {
        from,
        to: from + bucket,
        raw: b.raw.length,
        real: b.real.length,
        hot: b.real.length >= avgReal * 1.5,
        lines: [...counts.entries()].sort((a, b2) => b2[1] - a[1]).slice(0, 6).map(([text, count]) => ({ text, count })),
        subtitle: subtitleAt(from + bucket / 2),
      }
    })

  // ④ 全程高频：去掉刷屏、太短的（单字基本是语气词），取前 12。
  const all = new Map()
  for (const x of items) {
    if (isSpam(x.text) || x.text.length < 2) continue
    all.set(x.text, (all.get(x.text) ?? 0) + 1)
  }
  const topAll = [...all.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([text, count]) => ({ text, count }))

  return {
    buckets: map.size,
    total: items.length,
    realTotal,
    avgReal,
    spam,
    spamHits: items.filter((x) => isSpam(x.text)).length,
    peaks,
    topAll,
  }
}

/**
 * 抽帧时间点：等间隔当骨架保证覆盖，再把每帧吸附到 ±半格内最近的"画面变化点"。
 * 为什么不是二选一（whale 实测踩过两次）：
 *   · 只按变化点挑 → 转场全挤在开头，中段几十秒一帧没有，叙事线断掉；
 *   · 只按等间隔挑 → 会漏掉只闪一两秒的关键画面。
 * @param {{duration:number, count:number, sceneTimes?:number[]}} input
 * @returns {{ times:number[], how:string, snapped:number }}
 */
export function pickFrameTimes({ duration, count, sceneTimes = [] }) {
  const dur = Math.max(0, Number(duration) || 0)
  const n = Math.max(1, Math.floor(Number(count) || 1))
  const uniform = Array.from({ length: n }, (_, i) => ((i + 0.5) * dur) / n)
  const scenes = [...new Set((sceneTimes || []).map(Number).filter((t) => Number.isFinite(t) && t > 0.2))]
  if (!scenes.length || dur <= 0) {
    return { times: uniform, how: `等间隔（每 ${(dur / n).toFixed(1)} 秒一帧）`, snapped: 0 }
  }
  const half = dur / n / 2
  let snapped = 0
  const times = uniform.map((u) => {
    const near = scenes.filter((s) => Math.abs(s - u) <= half)
    if (!near.length) return u
    snapped++
    return near.reduce((best, s) => (Math.abs(s - u) < Math.abs(best - u) ? s : best), near[0])
  })
  return { times, how: `等间隔骨架（保覆盖）+ 吸附画面变化点（检出 ${scenes.length} 处；${snapped}/${n} 帧吸到了变化点）`, snapped }
}
