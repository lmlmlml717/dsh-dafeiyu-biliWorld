// 情绪状态机 —— dafeiyu 骨架 brain/persona.py 的 JS 移植（tick_mood + state_block）。
//
// 「活」的来源：情绪会自己漂移；饭点会饿；饿过头心情掉；偶尔无理由波动。
// 状态持久化在 ~/.feiyu-ai/mood.json —— CLI（每次新进程）与宿主生物钟共用同一份 ✓
//
// ⚠️ 10-27 大修（主人报"中午到下午连问十次吃没吃饭、整下午[[困倦]]"）：
//   旧版 `饭点 +7 / 非饭点 -0.5` + `饿过头每 tick 心情 -4`，而 tick 是**每次推送前都跑**
//   （推送一分钟摇一次）。于是 11:00-13:00 十几次 tick 把饥饿打满 100，下午每小时只退 0.5，
//   整天卡在 >60 → 每一轮提示词都写着「饿（82/100），满脑子都是吃的」，
//   同时心情被每 tick 砍 4 分 clamp 到底 0 → 「不太想说话」。
//   现在：① 饭点也封顶（hungerCap）② 非饭点按次衰减（默认 -6）③ 吃到饭直接归零
//   ④ 心情不再随饥饿每 tick 掉，改成**跨天软回归**（回到 moodBase）。
//
// 【模块卡片】
// 职责：情绪/饥饿状态机 —— 每次唤醒 tick 一次，会饿、会回落、跨天软回归，并把当下状态拼成提示语。
// 导出：tickMood / fed / mood / stateBlock / distract。
// 调用方：宿主 src/bili/mood.ts（mood/fed）、src/bili/dailyBili.ts（动态 import）。
// 数据文件：<bili 根>/mood.json（value/hunger/updatedAt/day 一个对象）。
// 坑：tick 是「每次推送前都跑」的，饭点增益必须封顶、非饭点必须按次衰减，
//     否则一天十几次 tick 会把饥饿打满，整天的提示词都写着「饿」。
// 【链路位置】
//   环节：情绪/饥饿状态机，宿主每次唤醒 tick 一次，把【当下状态】拼进提示语；不在 feed→debrief→act 主链里。
//   上游调用：宿主 src/bili/mood.ts（mood/fed）、src/bili/dailyBili.ts（动态 import tickMood/stateBlock/distract）、控制台的 bili-mood 路由。
//   下游调用：lib/paths.mjs（mood.json）、lib/config.mjs（mood 段热读）；不联网。
//   读写文件：<bili 根>/mood.json（value / hunger / updatedAt / day）。
//   退出码：库不设退出码；读坏/写失败都吞掉，按默认情绪继续。
//   上游参考：dafeiyu 骨架 brain/persona.py 的 tick_mood + state_block；10-27 的封顶与按次衰减沿用 dsh-feiyu 的修正。
import fs from 'node:fs'
import { dataPath } from './paths.mjs'
import { config } from './config.mjs'

function moodFile() { return dataPath('mood.json') }

/** 饭点：到点了坐不住（与 dafeiyu 一致：午饭 11-12 点、晚饭 17-18 点）。 */
// 只按小时判断、不做到分钟级闹钟：提示语里写「快吃饭了」就够了，精确到分钟反而机械。
const HUNGRY_HOURS = new Set([11, 12, 17, 18])

/** 默认参数（config.mood 可覆盖）。 */
const DEFAULTS = {
  hungerCap: 70,        // 饭点最多饿到这个数（不再打满 100）
  mealGain: 7,          // 饭点每次 tick +7
  decayPerTick: 6,      // 非饭点每次 tick -6（旧版 0.5，等于永不下降）
  moodBase: 62,         // 心情软回归的目标
  hungryMoodPenalty: 1, // 饿的时候每 tick 掉 1（旧版 4）
}

function opts() {
  // 参数从 feiyu.config.json 的 `mood` 段热读（config() 每次重新读文件，改完不用重启）
  try {
    return { ...DEFAULTS, ...(config()?.mood || {}) }
  } catch { return { ...DEFAULTS } }
}

function readState() {
  // 读不到就回到 62 分（默认基线）：宁可当「正常」，也别因为文件损坏让她一整天低落。
  try {
    const j = JSON.parse(fs.readFileSync(moodFile(), 'utf8'))
    return {
      value: Number.isFinite(Number(j.value)) ? Number(j.value) : 62,
      hunger: Number.isFinite(Number(j.hunger)) ? Number(j.hunger) : 0,
      updatedAt: j.updatedAt ?? null,
      day: j.day ?? '',
    }
  } catch { return { value: 62, hunger: 0, updatedAt: null, day: '' } }
}

function writeState(st) {
  try {
    fs.mkdirSync(dataPath(), { recursive: true })
    fs.writeFileSync(moodFile(), JSON.stringify(st, null, 2) + '\n')
  } catch {}
}

const dayKey = (d = new Date()) => d.toLocaleDateString('sv-SE')

/**
 * 情绪 tick。每次唤醒/对话前调用一次。
 * ① 饭点 hunger +mealGain（封顶 hungerCap）② 非饭点 -decayPerTick
 * ③ 饿过头（>60）心情 -hungryMoodPenalty ④ 6% 概率无理由波动 {-9,-4,+5,+8} ⑤ clamp 0-100
 * ⑥ 跨天：心情朝 moodBase 软回归（新的一天不背着昨天的低谷）
 */
// 【补充】调用方：宿主 src/bili/dailyBili.ts 每次唤醒前调一次（推送一分钟摇一次，所以参数必须封顶）。
//   参数：random 注入随机源（测试用，默认 Math.random）。返回：tick 后的 { value, hunger, updatedAt, day }。
//   失败：不抛错；读不到 mood.json 从默认基线 62 开始，写盘失败只影响下一次 tick 的起点。
// 【上游参考】tick_mood 的「饭点增益 + 非饭点衰减 + 6% 无理由波动」照 dafeiyu 骨架；跨天软回归是本仓库 10-27 的修正。
export function tickMood(random = Math.random) {
  const o = opts()
  const st = readState()
  const now = new Date()
  const hour = now.getHours()
  const today = dayKey(now)
  // 跨天软回归：只做一次（靠 day 字段判定），不随 tick 反复拉
  // 若改成每次 tick 都拉，一天几十次会把当天的情绪轨迹抹平，等于没有情绪。
  if (st.day && st.day !== today) {
    st.value = Math.round((st.value + o.moodBase) / 2)
    st.hunger = Math.max(0, st.hunger - 20)
  }
  st.day = today
  if (HUNGRY_HOURS.has(hour)) st.hunger = Math.min(o.hungerCap, st.hunger + o.mealGain)
  else st.hunger = Math.max(0, st.hunger - o.decayPerTick)
  // 60 是「饿到影响情绪」的门槛，和 stateBlock 措辞分档共用同一个数。
  if (st.hunger > 60) st.value -= o.hungryMoodPenalty
  // 不饿的时候心情自己往回爬（旧版只有"往下掉"的路径 → 一旦被打到底就整天 0，永远[[困倦]]）
  else if (st.hunger <= 30 && st.value < o.moodBase) st.value += 2
  // 6% 概率的无理由波动：模拟情绪的自然抖动；幅度有正有负，不让她只往下掉。
  if (random() < 0.06) st.value += [-9, -4, 5, 8][Math.floor(random() * 4)]
  st.value = Math.max(0, Math.min(100, st.value))
  st.updatedAt = new Date().toISOString()
  writeState(st)
  return st
}

// 【补充】调用方：宿主 src/bili/mood.ts 的喂饭入口、控制台 POST bili-mood 的 feed 分支。
//   参数：level 目标饥饿度（会夹在 0–20，留一点余量给下一个饭点）。返回：写回后的状态对象。
//   失败：不抛错；文件损坏时从默认状态起步。
/**
 * 吃到饭 / 主人说了他吃了 → 饥饿直接掉下来（10-27）。
 * 这是"连问十次吃没吃饭"的止血点：他答过一次，她就该真的不饿了。
 */
export function fed(level = 20) {
  const st = readState()
  const o = opts()
  // 上限 20：吃饱也不归到绝对 0，留一点余量给下一个饭点自然回升。
  st.hunger = Math.max(0, Math.min(Number(level) || 0, 20))
  // 吃到东西本来就该心情好一点（不许一路 0 到底）
  st.value = Math.min(100, st.value + 8)
  st.updatedAt = new Date().toISOString()
  st.day = st.day || dayKey()
  writeState(st)
  // o 目前没用到；保留 opts() 调用是为了让 fed 与 tickMood 吃同一份参数来源，后续要用直接取。
  void o
  return st
}

// 【补充】调用方：控制台 GET bili-mood（src/bili/mood.ts）与测试；只读，不推进状态。
//   参数：无。返回：{ value, hunger, updatedAt, day }，文件缺失/损坏时返回默认值。
//   失败：不抛错，也不写文件。
/**
 * 读当前情绪状态（不 tick、不写文件）。
 * @returns {{value:number, hunger:number, updatedAt:string|null, day:string}} 文件缺失/损坏时返回默认值。
 */
export function mood() { return readState() }

/** 时段 phase —— 同一句话在 7 点和 2 点必须不一样（dafeiyu 的核心设计）。 */
function phaseText(now = new Date()) {
  const h = now.getHours()
  if (h >= 6 && h < 10) return '刚醒，脑子还没转，回答会很短'
  if (h >= 10 && h < 11) return '上午，正常'
  if (h >= 11 && h < 13) return '快吃饭了，可以顺口提一句吃的，但别追着问'
  if (h >= 13 && h < 17) return '下午，正常过日子（别老是喊困，该干嘛干嘛）'
  if (h >= 17 && h < 20) return '到晚饭点了'
  if (h >= 20 && h < 24) return '晚上精神最好，话多'
  return '半夜，有点困但不想睡'
}

/**
 * 注入提示的【当下状态】块 —— dafeiyu persona.py state_block 的移植。
 * @returns {string}
 */
const PLATFORM_STATE = {
  qq: 'QQ 私聊（只有你和他个人；这里才该叫他、才聊私事）',
  wechat: '微信私聊（一句一句聊，别写成一大段）',
  bilibili: 'B站评论区/动态（允许碎碎念，但别刷屏）',
  douyin: '抖音评论区（一句话接住梗就够）',
}

// 【补充】调用方：宿主 prompt 拼装（dailyBili.ts 的 extraBlocks.stateBlock）。
//   参数：turnsToday 今天聊了几轮/几句；platform 平台名；isGroup 是否群聊。
//   返回：多行字符串，以「【当下状态】」开头；饥饿措辞按 60 / 75 两档分。
//   失败：不抛错；读不到状态时用默认值，平台名未知时原样显示。
export function stateBlock(turnsToday = 0, platform = 'bilibili', isGroup = false) {
  const now = new Date()
  const m = readState()
  // 状态只给感觉、不给数字：她看到「情绪 62/100」就会把分数说给主人听（0.8.15）。
  const style = m.value < 30 ? '有点提不起劲，句子短一点'
    : m.value > 75 ? '挺高兴，可以主动闹一点'
    : '还行，按平时说话'
  // 饥饿措辞分档（10-27）：旧版 >60 就写"满脑子都是吃的"，一整天挂在提示词里 → 她开口就是饿。
  // 现在 75 以上才算"很饿"，60-75 只是"有点饿"，而且明确"别追着问主人吃了没"。
  const hunger = m.hunger > 75 ? '很饿。'
    : m.hunger > 60 ? '有点饿，可以提一句吃的，但别追着问主人吃了没。'
    : ''
  // 群聊必须**明说**在群里（10-26）：原来写"QQ（私聊或群聊，按上下文判断）"，
  // 等于让她自己猜，猜错就把群友当主人。轮数同理 —— 群里的 34 条不是"跟他聊了 34 轮"。
  const platformText = isGroup ? 'QQ 群（群里好几个人在，说话的是群友，不是只有主人）'
    : (PLATFORM_STATE[platform] || platform)
  // 轮数只作为累了的信号，不写具体条数 —— 数字会被她当成台词念出来。
  const turnLine = isGroup
    ? (turnsToday > 20 ? '这个群今天没少聊，累了就少说两句。' : '')
    : (turnsToday > 40 ? '今天聊得有点多，有点累了，敷衍一点。' : '')
  const lines = [
    `现在是 ${now.toLocaleString('sv-SE', { hour12: false })}（${phaseText(now)}）。`,
    `这会儿${style}。`,
    hunger,
    turnLine,
    `当前平台：${platformText}。`,
  ].filter(Boolean)
  return '【当下状态】\n' + lines.join('\n')
}

/**
 * 走神注入 —— 8% 概率嘀咕一句，多了就成噪音（dafeiyu：别超过 10%）。
 * ⚠️ 10-27：原来三条**全是吃的**，等于每天几十次给她"想想吃的"的心理暗示，
 * 跟"连问吃没吃饭"是一条绳上的。现在只有三分之一跟吃有关，其余是别的生活小事。
 */
// 【补充】调用方：宿主 dailyBili.ts 拼 prompt 时调一次；返回空串表示这次不走神（大多数时候）。
//   参数：random 注入随机源（测试用）。返回：以换行开头的句子，或空串。
//   失败：不抛错。
export function distract(random = Math.random) {
  if (random() >= 0.08) return ''
  const lines = [
    '（这次先在心里嘀咕一句跟吃有关的，再干活，不要解释为什么。）',
    '（干活中途允许走神一次，想一件跟吃无关的小事，别解释。）',
    '（先想想今天 token 饭钱花了几块，再干活，别解释。）',
    '（走神一下：想起刚才看的那个视频，再回来干活，别解释。）',
  ]
  return '\n' + lines[Math.floor(random() * lines.length)]
}
