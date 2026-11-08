// focus —— 她「此刻在做的那一件事」。
// 背景：完全自由 = 只负责"按时摇她起来"，不定她干什么。
// 一个人一次只能干一件事，干完歇一会儿再挑下一件。歇着（rest）也是正经选项。
//
// 复用 dsh-feiyu 的 tools/lib/focus.mjs（MIT），LOOP_ACTIVITIES 精简到只留 bilibili（world 不支持 web/douyin/binge）。
import fs from 'node:fs'
import path from 'node:path'
import { dataPath } from './paths.mjs'

const FOCUS_PATH = () => dataPath('focus.json')

/** 可以"占住一段时间"的常驻活动（world 版只留 B站相关 + rest）。 */
export const LOOP_ACTIVITIES = {
  bilibili: { label: '刷B站', hint: '看视频/深读/评论/发动态' },
}

/** 别名 → 规范名（她可能写 bili / B站 / 刷） */
export function normActivity(a) {
  const s = String(a ?? '').trim().toLowerCase()
  if (!s) return ''
  if (['bili', 'bilibili', 'b站', 'b站刷', 'bl', '刷b', '刷b站'].includes(s)) return 'bilibili'
  if (['rest', '歇', '歇着', '休息', 'idle', '躺'].includes(s)) return 'rest'
  if (['off', 'stop', '收工', '结束', 'none', '空'].includes(s)) return 'off'
  return s
}

export const isLoopActivity = (a) => Object.prototype.hasOwnProperty.call(LOOP_ACTIVITIES, String(a ?? ''))

export function labelOf(a) {
  const k = String(a ?? '')
  if (isLoopActivity(k)) return LOOP_ACTIVITIES[k].label
  if (k === 'rest') return '歇着'
  if (k === 'off') return '自由时间（没在做具体的）'
  return k || '没记录'
}

/** 读当下状态。文件不在 / 坏了都返回 null —— 不干预。 */
export function readFocus() {
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
export function writeFocus(activity, min = 0, note = '') {
  const now = Date.now()
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

export function clearFocus() {
  try { fs.rmSync(FOCUS_PATH(), { force: true }) } catch {}
}

/** 组装一份好用的快照（提示语里直接念给人听）。 */
export function focusSnapshot(now = Date.now()) {
  const f = readFocus()
  if (!f || !f.activity) return { activity: '', label: '', remainMin: 0, expired: false, note: '', setAgoMin: 0 }
  const until = Number(f.until || 0)
  const remainMin = until ? Math.max(0, Math.round((until - now) / 60_000)) : 0
  return {
    activity: String(f.activity),
    label: labelOf(f.activity),
    remainMin,
    expired: !!until && until <= now,
    note: String(f.note || ''),
    setAgoMin: Math.round((now - Number(f.setAt || now)) / 60_000),
    min: Number(f.min || 0),
  }
}

/** 把配置里的开关对齐到"当下只开一个"（world 精简版只判断 bilibili 的 freeRoam）。 */
export function syncSwitches(cfg, activity) {
  let changed = false
  const wantBili = activity === 'bilibili'
  if (!cfg.bilibili || typeof cfg.bilibili !== 'object') cfg.bilibili = {}
  const bilibili = cfg.bilibili
  const freeRoam = bilibili.freeRoam && typeof bilibili.freeRoam === 'object' ? bilibili.freeRoam : {}
  if ((freeRoam.enabled === true) !== wantBili) { bilibili.freeRoam = { ...freeRoam, enabled: wantBili }; changed = true }
  return changed
}
