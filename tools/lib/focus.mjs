// focus —— 她「此刻在做的那一件事」。
// 背景：完全自由 = 只负责"按时摇她起来"，不定她干什么。
// 一个人一次只能干一件事，干完歇一会儿再挑下一件。歇着（rest）也是正经选项。
//
// 复用 dsh-feiyu 的 tools/lib/focus.mjs（MIT），LOOP_ACTIVITIES 精简到只留 bilibili（world 不支持 web/douyin/binge）。
//
// 【模块卡片】
// 职责：记录并读取她「此刻占着的那件事」（bilibili / rest / off），供提示语念给她听。
// 导出：LOOP_ACTIVITIES / normActivity / isLoopActivity / labelOf / readFocus / writeFocus /
//       clearFocus / focusSnapshot / syncSwitches。
// 调用方：tools/commands/focus.mjs（CLI）；宿主 src/bili/dailyBili.ts 动态 import 读快照。
// 数据文件：<bili 根>/focus.json（activity/until/setAt/min/note 一个对象）。
// 坑：文件缺失或损坏一律返回 null，不抛错也不替她编状态；到点后 remainMin 归零，
//     是否收工由她自己决定（expired 只是提示，不自动清）。
// 【链路位置】
//   环节：focus 的库实现 —— 记录/读取她「此刻占着的那件事」，CLI（tools/commands/focus.mjs）与宿主提示语共用。
//   上游调用：tools/commands/focus.mjs（read/write/clear）；宿主 src/bili/dailyBili.ts 动态 import 读快照拼 focusLine。
//   下游调用：lib/paths.mjs（focus.json）。
//   读写文件：<bili 根>/focus.json（activity / until / setAt / min / note）。
//   退出码：库不设退出码；文件缺失/损坏返回 null，不抛也不替她编状态。
//   上游参考：复用 dsh-feiyu 的 tools/lib/focus.mjs（MIT），LOOP_ACTIVITIES 精简到只留 bilibili。
import fs from 'node:fs'
import path from 'node:path'
import { dataPath } from './paths.mjs'

const FOCUS_PATH = () => dataPath('focus.json')

/** 可以"占住一段时间"的常驻活动（world 版只留 B站相关 + rest）。 */
export const LOOP_ACTIVITIES = {
  bilibili: { label: '刷B站', hint: '看视频/深读/评论/发动态' },
}

// 【补充】调用方：tools/commands/focus.mjs 的 run()（白名单校验）；宿主提示语不调它。
//   参数：任意活动名（大小写、中英文混写都认）。返回：规范名 bilibili/rest/off；认不出时原样返回。
//   失败：不抛错；空值返回空串 —— 调用方必须再白名单一遍，不能把任意输入写进 focus.json。
/** 别名 → 规范名（她可能写 bili / B站 / 刷） */
export function normActivity(a) {
  const s = String(a ?? '').trim().toLowerCase()
  if (!s) return ''
  if (['bili', 'bilibili', 'b站', 'b站刷', 'bl', '刷b', '刷b站'].includes(s)) return 'bilibili'
  if (['rest', '歇', '歇着', '休息', 'idle', '躺'].includes(s)) return 'rest'
  if (['off', 'stop', '结束', 'none', '空'].includes(s)) return 'off'
  return s
}

/**
 * 这个活动名是不是「占一段时间的常驻活动」。
 * @param {string} a 活动名（建议先过 normActivity）。
 * @returns {boolean} true 表示该名在 LOOP_ACTIVITIES 里（当前只有 bilibili）。
 */
export const isLoopActivity = (a) => Object.prototype.hasOwnProperty.call(LOOP_ACTIVITIES, String(a ?? ''))

/**
 * 活动名 → 给她/主人看的中文标签。
 * @param {string} a 活动名（规范名或别名均可）。
 * @returns {string} 未知活动原样返回；没有记录时返回「没记录」。
 */
export function labelOf(a) {
  const k = String(a ?? '')
  if (isLoopActivity(k)) return LOOP_ACTIVITIES[k].label
  if (k === 'rest') return '歇着'
  if (k === 'off') return '自由时间（没在做具体的）'
  return k || '没记录'
}

/** 读当下状态。文件不在 / 坏了都返回 null —— 不干预。 */
export function readFocus() {
  // 解析失败也当作没有状态：focus.json 是缓存不是账本，坏了不该让整条命令挂掉。
  try {
    const j = JSON.parse(fs.readFileSync(FOCUS_PATH(), 'utf8'))
    if (!j || typeof j !== 'object') return null
    return j
  } catch { return null }
}

/**
 * 写下"我现在在干什么"。
 * @param {string} activity bilibili|rest|off
 * @param {number} min 打算干多久（分钟，0 = 不设时限，靠她自己收工）
 * @param {string} note 一句话（写给自己/给主人看的由头）
 */
// 【补充】调用方：tools/commands/focus.mjs 的 run()（写完打一行确认）。
//   参数：activity 规范名（调用方已白名单）；min 分钟（0 = 不设时限）；note 一句话由头（截 200 字）。
//   返回：落盘的那个对象 { activity, until, setAt, min, note }。
//   失败：写盘失败被吞，仍返回对象 —— 她说「在干什么」比文件是否写成更重要。
export function writeFocus(activity, min = 0, note = '') {
  const now = Date.now()
  // 负数和乱码都归 0（0 = 不设时限），避免写出一个落在过去的 until。
  const mins = Math.max(0, Math.round(Number(min) || 0))
  const obj = {
    activity: String(activity),
    until: mins > 0 ? now + mins * 60_000 : 0,
    setAt: now,
    min: mins,
    note: String(note || '').slice(0, 200),
  }
  try {
    fs.mkdirSync(path.dirname(FOCUS_PATH()), { recursive: true })
    fs.writeFileSync(FOCUS_PATH(), JSON.stringify(obj, null, 2))
  } catch {}
  return obj
}

/**
 * 清掉当前活动（收工）。
 * @returns {void} 文件不存在也算成功；删除失败被吞掉，不阻塞命令。
 */
export function clearFocus() {
  try { fs.rmSync(FOCUS_PATH(), { force: true }) } catch {}
}

// 【补充】调用方：tools/commands/focus.mjs（看现状）、宿主 dailyBili.ts（拼 focusLine）。
//   参数：now 当前时间毫秒（测试可注入）。返回：{ activity, label, remainMin, expired, note, setAgoMin, min }；没记录时 activity 为空串。
//   失败：不抛错；文件坏/缺都返回空快照，不替她编一个「在刷B站」。
/** 组装一份好用的快照（提示语里直接念给人听）。 */
export function focusSnapshot(now = Date.now()) {
  const f = readFocus()
  if (!f || !f.activity) return { activity: '', label: '', remainMin: 0, expired: false, note: '', setAgoMin: 0, until: 0 }
  const until = Number(f.until || 0)
  const remainMin = until ? Math.max(0, Math.round((until - now) / 60_000)) : 0
  return {
    activity: String(f.activity),
    label: labelOf(f.activity),
    remainMin,
    // 0 表示「没设时限、靠她自己收工」：remainMin 这时恒为 0，但绝不能读成「还剩 0 分钟」。
    // 宿主 shouldSkipWake 靠 until 区分这两种情况（0.9.5）。
    until,
    expired: !!until && until <= now,
    note: String(f.note || ''),
    setAgoMin: Math.round((now - Number(f.setAt || now)) / 60_000),
    min: Number(f.min || 0),
  }
}

// 【补充】调用方：当前工具链没有调用点；保留给「切到某个活动时顺手关掉其它开关」的旧调用方（feiyu 有）。
//   参数：cfg 会被就地修改；activity 是规范名。返回：true 表示这次真的改了 cfg。
//   失败：不抛错；cfg.bilibili 缺失时自动补一个空对象。
/** 把配置里的开关对齐到"当下只开一个"（world 精简版只判断 bilibili 的 freeRoam）。 */
export function syncSwitches(cfg, activity) {
  let changed = false
  const wantBili = activity === 'bilibili'
  if (!cfg.bilibili || typeof cfg.bilibili !== 'object') cfg.bilibili = {}
  const bilibili = cfg.bilibili
  const freeRoam = bilibili.freeRoam && typeof bilibili.freeRoam === 'object' ? bilibili.freeRoam : {}
  // 返回值 changed 表示这次真的改了配置，调用方可以据此决定是否写回文件。
  if ((freeRoam.enabled === true) !== wantBili) { bilibili.freeRoam = { ...freeRoam, enabled: wantBili }; changed = true }
  return changed
}
