// feed —— 选题：从热门 + 关键词搜索里筛一批候选。
// 权重思路来自 bili-whale：偏好命中 + 弹幕密度，**不看播放量**（冷门但对的也可以看）。
//
//   node bili.mjs feed [--n 5] [--json]
// 【文件头】feed 的 CLI：热门榜随机一页 + 关键词搜索，按偏好与兴趣加权排序，端 n 条候选给 agent 挑。
// 参数：--n 条数（夹在 1-20，缺省取 night.maxVideos）、--json 输出结构化结果。
// 读写：读 bili.config.json（preferences/night/quota）、凭据、synonyms.json，以及 quota.json 或
//       bili-social.jsonl 做去重；只读不写 —— 记账发生在 act / comment 那边。
// 输出：人读版是编号列表（标题/UP/播放/弹幕/时长/来源/命中偏好/BV）；--json 是 { ok, n, seeds, items }。
// 退出码：0 正常（一条候选都没筛出来也是 0，只提示换搜索词）；抛异常时由 Node 退出 1。
// 坑：候选池靠随机翻页 + 种子轮换撑着，别为了"稳定"改回固定第一页，几天就会把候选发完。
// 【链路位置】
//   环节：链路第 1 步「选题」，prompt 里是 `node bili.mjs feed --json`。
//   上游调用：宿主 src/bili/dailyBili.ts 投递的 prompt；她拿 --json 的 items 当候选池，挑不超过 dailyMaxVideos 条交给 debrief。
//   下游调用：lib/bili-api.mjs 的 apiGet（热门榜 + 搜索，搜索需 WBI 签名）、lib/seed-rotation.mjs 的 pickSeeds、lib/config.mjs 的 config。
//   读写文件：只读 bili.config.json、credentials.json、tools/lib/synonyms.json；去重另外读 quota.json，读不到才退回 bili-social.jsonl。整个命令不写文件。
//   输出与退出码：人读列表或 { ok, n, seeds, items }；正常退出 0（一条候选都没有也是 0），抛异常时由 Node 退出 1。
//   上游参考：权重口径来自 dsh-bili-whale（偏好命中 + 弹幕密度，不看播放量）；口味与同义词来自 dsh-feiyu 的 preferences。
import { apiGet, makeHeaders } from '../lib/bili-api.mjs'
import { loadCred } from '../lib/cred.mjs'
import { config } from '../lib/config.mjs'
import { dataPath } from '../lib/paths.mjs'
import { pickSeeds } from '../lib/seed-rotation.mjs'
import fs from 'node:fs'

// world 可选：有 memory 模块（dsh-feiyu 才有）就拿兴趣加权，没有跳过
let memoryOpt = null
try { memoryOpt = await import('../lib/memory.mjs').catch(() => null) } catch { memoryOpt = null }

// 偏好词是"话题名"（美食 / 猫咪 / AI 与 Agent 工具），标题和简介里几乎不会原样出现。
// 只做整串 includes = 永远漏（10-23、10-24 连续两天把"康师傅桶面""现钓渔获做餐"判成无命中）。
// 这里把每条偏好拆成：话题名 + 内置同义词 + 主人可在 preferences.synonyms 里追加的词。
//
// 内置词表放在 tools/lib/synonyms.json：UI（控制台）也要展示同一份，放 JSON 两边读同一个源，避免漂移。
// 读不到这个文件会直接抛在模块顶层，整条 feed 起不来 —— 词表是硬依赖，不是可选材料。
const DEFAULT_SYNONYMS = JSON.parse(fs.readFileSync(new URL('../lib/synonyms.json', import.meta.url), 'utf8'))

// 用零宽断言而不是 \b：\b 把下划线与数字都算词字符，边界口径和这里要的"前后不能是 ASCII 字母或数字"并不一致。
// 【补充】调用方：matchPreference 打分循环、dislike 剔除也用同一个判断；参数 hay 已转小写、term 已转小写。
//   返回：命中 true、没命中 false；空词直接 false（配置里手写空项不会把整条判成命中）。
//   失败：不抛错，正则只由转义后的词拼出，不会把配置里的特殊字符当语法。
/** 词命中判断：纯 ASCII 词按词边界匹配（避免 ai 命中 said / wait），中文按子串。 */
function matches(hay, term) {
  if (!term) return false
  if (/^[\x00-\x7f]+$/.test(term)) {
    const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(?<![a-z0-9])${esc}(?![a-z0-9])`).test(hay)
  }
  return hay.includes(term)
}

// 【补充】调用方：run() 的候选打分循环，每条 like 词调一次。
//   参数：hay = 标题+UP 名+简介（小写，强命中用）；hayCore = 标题+简介（小写，单字命中用）；
//         pref = 配置里的一条偏好；synonyms = preferences.synonyms，按话题追加主人自己的词。
//   返回：{ term, weight }（weight 2 = 多字强命中，1 = 单字弱命中）或 null。
//   空值：pref 为空返回 null；内置词表用「话题名」匹配，带解释的写法按前缀找到内置键。
/** 一条偏好是否命中；命中返回 { term, weight }（方便在 feed 输出里看清是哪个词中的）。
 *  多字词算强命中（2 分）；单字词（吃/猫/汤…）太容易撞车，只在标题+简介里算 1 分。
 *  同义词是**追加**：内置词表 + preferences.synonyms 里主人补的词，一起用（以前是后者整表替换前者）。 */
function matchPreference(hay, hayCore, pref, synonyms = {}) {
  const key = pref.trim()
  // 内置词表按"话题名"索引；像「美食（尤其是白饭相关）」这种带解释的写法，用前缀找得到「美食」。
  const builtinKey = Object.prototype.hasOwnProperty.call(DEFAULT_SYNONYMS, key)
    ? key
    : Object.keys(DEFAULT_SYNONYMS).find(name => key.startsWith(name))
  const builtin = builtinKey === undefined ? [] : DEFAULT_SYNONYMS[builtinKey]
  const mine = Array.isArray(synonyms[key]) ? synonyms[key] : []
  const extra = [...new Set([...builtin, ...mine].map(s => String(s).trim()).filter(Boolean))]
  const terms = [...new Set([key, ...extra].map(s => String(s).toLowerCase()).filter(Boolean))]
  for (const t of terms) {
    if (t.length >= 2 && matches(hay, t)) return { term: t, weight: 2 }
  }
  for (const t of terms) {
    if (t.length === 1 && matches(hayCore, t)) return { term: t, weight: 1 }
  }
  return null
}

// 【补充】调用方：人读版输出时把 duration 折成分钟；搜索接口给 "mm:ss" 或 "h:mm:ss"，热门接口给秒数。
//   返回：整数分钟；空值/无法解析返回 0（宁可显示 0 分钟，也不让整行输出崩掉）。
/** 时长统一成分分钟：热门接口给秒数，搜索接口给 "mm:ss" 字符串。 */
function fmtMinutes(d) {
  if (typeof d === 'number' && Number.isFinite(d)) return Math.round(d / 60)
  const s = String(d ?? '').trim()
  if (!s) return 0
  if (/^\d+$/.test(s)) return Math.round(Number(s) / 60)
  const p = s.split(':').map(Number)
  if (p.length === 2 && p.every(Number.isFinite)) return Math.round(p[0] + p[1] / 60)
  if (p.length === 3 && p.every(Number.isFinite)) return Math.round(p[0] * 60 + p[1] + p[2] / 60)
  return 0
}

// 【补充】调用方：tools/bili.mjs 动态 import 后调 run(process.argv.slice(3))。
//   参数：--n 候选条数（夹在 1–20，缺省取 night.maxVideos）、--json 输出结构化结果；其余参数忽略。
//   返回：无返回值；结果打 stdout，去重告警打 stderr（stderr 不进 agent 读到的材料）。
//   失败：凭据缺失/词表缺失会在模块顶层或 loadCred 抛错，退出码交给 Node；没候选是正常结果，不设退出码。
/**
 * feed 入口：抓热门与搜索 → 剔除不喜欢的、打分 → 去掉近期发过的 → 排序取前 n 条输出。
 * @param {string[]} argv CLI 参数
 * @returns {Promise<void>}
 */
export async function run(argv = []) {
  const cfg = config()
  const json = argv.includes('--json')
  const nIdx = argv.indexOf('--n')
  // 上限 20：一轮铺太多候选反而挑不动；--n 给 0 或非数字时回落到配置里的 maxVideos。
  const n = Math.min(20, Math.max(1, nIdx >= 0 ? Number(argv[nIdx + 1]) || cfg.night.maxVideos : cfg.night.maxVideos))

  const cred = loadCred()
  const H = makeHeaders(cred)

  const candidates = new Map()   // bvid -> item

  // 【上游参考】两个候选源：热门榜 /x/web-interface/popular、搜索 /x/web-interface/search/type（后者需 WBI，bili-api 统一签名）。
  // ① 热门榜（随机翻 1-3 页 —— 固定第一页会让候选很快发完陷入枯竭）
  const pn = 1 + Math.floor(Math.random() * 3)
  const popular = await apiGet(`https://api.bilibili.com/x/web-interface/popular?ps=20&pn=${pn}`, H)
  for (const v of popular?.data?.list ?? []) {
    if (v?.bvid) candidates.set(v.bvid, {
      bvid: v.bvid, aid: v.aid, title: v.title?.replace(/<[^>]+>/g, '') ?? '',
      owner: v.owner?.name ?? '', ownerMid: v.owner?.mid ?? '', desc: (v.desc ?? '').replace(/<[^>]+>/g, ''), play: v.stat?.view ?? 0, danmaku: v.stat?.danmaku ?? 0,
      duration: v.duration ?? 0, source: 'popular',
    })
  }

  // ② 关键词搜索（要 WBI 签名，bili-api 已处理）：
  //    种子按本地日期轮换（tools/lib/seed-rotation.mjs）：每轮 2 个，n 个种子 ⌈n/2⌉ 天全部轮到，
  //    同一天里的多轮用同一对，便于对着账本看「今天到底搜了哪些」。
  //    再加每轮随机抽 2 个偏好词（like 池轮换）—— 内容源源不断，候选不枯竭
  //    鱼圈社交：fishCircle 开了就把「大肥鱼」也当关键词搜 —— 同类鱼聚集地的视频进候选
  const likePool = (cfg.preferences?.like ?? []).filter(Boolean)
  // 每轮只随机 2 个偏好词：搜索请求数直接顶着接口风控，词一多就容易把整轮拖慢甚至被拦。
  const randLikes = [...likePool].sort(() => Math.random() - 0.5).slice(0, 2)
  const seedPlan = pickSeeds(cfg.preferences?.keywords ?? [])
  const kws = [...new Set([...seedPlan.picked, ...randLikes])]
  if (cfg.bilibili?.fishCircle?.enabled === true) kws.push('大肥鱼')
  for (const kw of kws) {
    const u = new URL('https://api.bilibili.com/x/web-interface/search/type')
    u.searchParams.set('search_type', 'video')
    u.searchParams.set('keyword', String(kw))
    u.searchParams.set('page', '1')
    const res = await apiGet(u.href, { ...H, referer: 'https://search.bilibili.com/' })
    for (const v of res?.data?.result ?? []) {
      if (v?.bvid && !candidates.has(v.bvid)) {
        const f = (v.description ?? '').replace(/<[^>]+>/g, '')
        candidates.set(v.bvid, {
          bvid: v.bvid, aid: v.aid, title: (v.title ?? '').replace(/<[^>]+>/g, '') || f.slice(0, 40),
          owner: v.author ?? '', ownerMid: v.mid ?? '', desc: f, play: v.play ?? 0, danmaku: v.video_review ?? 0,
          duration: v.duration ?? 0, source: kw === '大肥鱼' ? 'fish:大肥鱼' : `search:${kw}`,
        })
      }
    }
  }

  // 【上游参考】口味与同义词的两层结构来自 dsh-feiyu：内置词表 + 主人追加词，命中按多字/单字分档；兴趣加权是本地 lore 闭环。
  // ③ 打分：偏好命中加权；dislike 命中剔除；弹幕密度做次级信号；
  //    兴趣加权 —— 她在 lore 里养成的口味（"想再看美食"这类记忆）反哺选题，
  //    静态 preferences 是主人给的起点，口味由她自己长（进化闭环）。
  const like = cfg.preferences?.like ?? []
  const dislike = cfg.preferences?.dislike ?? []
  const synonyms = cfg.preferences?.synonyms ?? {}   // 主人可以在这里按话题追加自己的词
  const grams = memoryOpt?.interestGrams?.() ?? new Set()
  const out = []
  for (const it of candidates.values()) {
    const hay = (it.title + ' ' + it.owner + ' ' + (it.desc ?? '')).toLowerCase()
    const hayCore = (it.title + ' ' + (it.desc ?? '')).toLowerCase()
    // 命中 dislike 就整条丢掉，不做"降权但仍出现"：不喜欢的东西端上来只是白耗注意力。
    if (dislike.some(w => matches(hay, String(w).toLowerCase()))) continue
    let hit = 0
    const why = []
    for (const w of like) {
      const m = matchPreference(hay, hayCore, String(w), synonyms)
      if (m) { hit += m.weight; why.push(m.term === w ? w : `${w}（${m.term}）`) }
    }
    const iHit = grams.size && memoryOpt?.interestScore ? memoryOpt.interestScore(hay, grams) : 0
    // 3 分起算、最多加 6 分：她的兴趣是锦上添花，不该压过主人写死的偏好词。
    if (iHit >= 3) { hit += Math.min(iHit, 6); why.push(`她养成的兴趣(${iHit})`) }
    const density = Number(it.play) > 0 ? it.danmaku / it.play : 0   // 弹幕密度：互动质量信号
    out.push({ ...it, hit, density: Number(density.toFixed(4)), why: why.join('、') || '无偏好命中（靠密度入选）' })
  }
  // 已发过的不再端上来（sameVideoDays 天内的 BV）。
  // 主账本 quota.json（quota record 写）；账本缺失/损坏时退回 bili-social.jsonl（每次 dyn_share 都记了 bvid+时间）。
  // 以前这里 readFileSync 抛错被 catch {} 静默吞掉，去重形同虚设 —— 10-25 实测同一条视频被反复推。
  let usable = out
  {
    const days = Number(config().quota?.sameVideoDays ?? 7)
    if (days > 0) {
      // 0.8.26：两个账本都不在时（刚重置过世界、或这台机器第一次跑），先拿人读台账 bili-outbox.md
      // 把 bili-social.jsonl 补录回来，再谈去重 —— 不然头几次 feed 会把同一批视频反复端上来。
      try {
        if (!fs.existsSync(dataPath('quota.json')) && !fs.existsSync(dataPath('bili-social.jsonl'))) {
          const { backfillFromOutbox } = await import('../lib/social-log.mjs')
          const rebuilt = backfillFromOutbox()
          if (rebuilt) console.warn(`（账本重建：从 bili-outbox.md 补录了 ${rebuilt} 条历史发言）`)
        }
      } catch { /* 补录失败不影响选题，只是这次没有历史可去重 */ }
      // 86400_000 是一天的毫秒数；按滚动 24 小时算而不是按自然日，跨零点时不会出现"刚发过又能发"的空洞。
      const cutoff = Date.now() - days * 86400_000
      const used = new Set()
      let source = ''
      try {
        const q = JSON.parse(fs.readFileSync(dataPath('quota.json'), 'utf8'))
        for (const x of q.log || []) if (x.target && new Date(x.at).getTime() >= cutoff) used.add(x.target)
        source = 'quota.json'
      } catch {
        try {
          const file = dataPath('bili-social.jsonl')
          if (fs.existsSync(file)) {
            for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
              try {
                const r = JSON.parse(line)
                if (r && (r.kind === 'dyn_share' || r.kind === 'share') && r.bvid && new Date(r.ts).getTime() >= cutoff) used.add(r.bvid)
              } catch {}
            }
            source = 'bili-social.jsonl'
          }
        } catch {}
      }
      if (used.size) {
        const kept = out.filter((v) => !used.has(v.bvid))
        if (kept.length !== out.length) console.warn(`（已剔除 ${out.length - kept.length} 条 ${days} 天内发过的，剩 ${kept.length} 条；账本来源 ${source}）`)
        usable = kept
      } else if (!source) {
        console.warn('（去重账本不可用：quota.json 与 bili-social.jsonl 都没读到 —— 本次不去重）')
      }
    }
  }
  usable.sort((a, b) => b.hit - a.hit || b.density - a.density)
  const picked = usable.slice(0, n)

  if (json) { console.log(JSON.stringify({ ok: true, n: picked.length, seeds: seedPlan.picked, items: picked }, null, 2)); return }

  if (!picked.length) { console.log('（没筛出候选 —— 试试在 preferences.keywords 里加几个搜索词）'); return }
  console.log(`本轮种子（按本地日轮换）：${seedPlan.picked.length ? seedPlan.picked.join('、') : '（未设置）'}`)
  console.log(`筛出 ${picked.length} 条（偏好命中在前，同分按弹幕密度）：\n`)
  for (const [i, v] of picked.entries()) {
    console.log(`${i + 1}. ${v.title}`)
    console.log(`   UP：${v.owner} · 播放 ${v.play} · 弹幕 ${v.danmaku} · ${fmtMinutes(v.duration)} 分钟 · 来源 ${v.source}`)
    console.log(`   偏好：${v.why}`)
    console.log(`   BV：${v.bvid}\n`)
  }
  console.log('下一步：挑 2–3 条深读 —— node bili.mjs debrief --bvid <BV>')
}
