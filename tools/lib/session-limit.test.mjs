// session-limit —— 额度 0 的语义、窗口、每日总上限。
//
// 回归点（CODE-AUDIT-2026-11-08 H-05）：
//   旧实现 `if (target > 0 && current >= target)` 把 0 当成「不限」，
//   于是「今天硬上限已用满」和「随机到 0 条纯动态名额」都拦不住。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-session-limit-'))
process.env.WORLD_BILI_DATA_DIR = dir
// eslint-disable-next-line import/no-unresolved -- path 在调用时解析 env，写在 import 之后也生效
const sl = await import('./session-limit.mjs')

const dayKey = () => new Date().toLocaleDateString('sv-SE')
const sessionPath = () => path.join(dir, 'session.json')

function clearData() {
  for (const name of ['session.json', 'bili-actions.json']) {
    try { fs.rmSync(path.join(dir, name), { force: true }) } catch {}
  }
}
function writeSession(state) {
  fs.writeFileSync(sessionPath(), JSON.stringify(state))
}
function writeLedger(day, share) {
  fs.writeFileSync(path.join(dir, 'bili-actions.json'), JSON.stringify({ day, dyn_share: share }))
}
/** 自动推导关掉 + 手动范围固定，让 resetSession 的结果可断言。 */
function cfg(overrides = {}) {
  return {
    bilibili: {
      watch: { autoFromWindow: false, sessionMin: 2, sessionMax: 2 },
      dynamic: { pureSessionMin: 1, pureSessionMax: 1 },
      ...overrides,
    },
  }
}

test.after(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  delete process.env.WORLD_BILI_DATA_DIR
})

test('每日上限 0 = 不限：target 按窗口给，dailyRemaining 记为 null', () => {
  clearData()
  const r = sl.resetSession(cfg(), { wakeTime: '00:00', reviewTime: '23:59', dailyMaxVideos: 0 })
  assert.equal(r.watchTarget, 2)
  assert.equal(r.dailyRemaining, null)
  const state = sl.readSession()
  assert.equal(state.target.watch, 2)
  assert.equal(state.daily.remaining, null)
  assert.equal(sl.checkSession('share').ok, true)
})

test('每日上限用满：target 变成 0，checkSession 拒绝并标 dailyExhausted', () => {
  clearData()
  writeLedger(dayKey(), 10)
  const r = sl.resetSession(cfg(), { wakeTime: '00:00', reviewTime: '23:59', dailyMaxVideos: 10 })
  assert.equal(r.watchTarget, 0)
  assert.equal(r.dailyRemaining, 0)
  const check = sl.checkSession('share')
  assert.equal(check.ok, false)
  assert.equal(check.target, 0)
  assert.equal(check.dailyExhausted, true)
  assert.match(check.why, /总上限/)
})

test('纯动态名额随机到 0：checkSession 拒绝，0 不再等于不限', () => {
  clearData()
  const c = cfg({ dynamic: { pureSessionMin: 0, pureSessionMax: 0 } })
  const r = sl.resetSession(c, { wakeTime: '00:00', reviewTime: '23:59', dailyMaxVideos: 0 })
  assert.equal(r.pureTarget, 0)
  const check = sl.checkSession('pure')
  assert.equal(check.ok, false)
  assert.equal(check.target, 0)
  assert.match(check.why, /0\/0/)
})

test('不在作息窗口：拒绝（保留原有窗口语义）', () => {
  clearData()
  const now = new Date()
  const cur = now.getHours() * 60 + now.getMinutes()
  const hm = minutes => `${String(Math.floor((minutes % 1440) / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
  writeSession({
    version: 2,
    window: { start: hm(cur + 60), end: hm(cur + 120) },
    target: { watch: 5, pure: 5 },
    counts: { watch: 0, pure: 0 },
    daily: { max: 0, today: 0, remaining: null },
  })
  const check = sl.checkSession('share')
  assert.equal(check.ok, false)
  assert.equal(check.outsideWindow, true)
})

test('旧版/损坏 state 没有 target：仍按不限放行（兼容，不改变手工 CLI 行为）', () => {
  clearData()
  writeSession({ counts: {} })
  assert.equal(sl.checkSession('share').ok, true)
  assert.equal(sl.checkSession('pure').ok, true)
})

test('incSession 累计到 target 后拒绝', () => {
  clearData()
  writeSession({ version: 2, target: { watch: 1, pure: 0 }, counts: { watch: 0, pure: 0 }, daily: { max: 0, today: 0, remaining: null } })
  assert.equal(sl.checkSession('share').ok, true)
  sl.incSession('share')
  const check = sl.checkSession('share')
  assert.equal(check.ok, false)
  assert.equal(check.current, 1)
})

test('window 判断：普通窗口与跨零点窗口', () => {
  const at = (h, m) => new Date(2026, 10, 8, h, m, 0)
  assert.equal(sl.withinWindow('09:00', '18:00', at(10, 0)), true)
  assert.equal(sl.withinWindow('09:00', '18:00', at(8, 59)), false)
  assert.equal(sl.withinWindow('23:00', '02:00', at(23, 30)), true)
  assert.equal(sl.withinWindow('23:00', '02:00', at(1, 30)), true)
  assert.equal(sl.withinWindow('23:00', '02:00', at(12, 0)), false)
})
