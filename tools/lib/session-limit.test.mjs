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
/** 自动推导关掉 + 手动范围写成相等，让 resetSession 的结果可断言。 */
function cfg(overrides = {}) {
  return {
    bilibili: {
      watch: { autoFromWindow: false, sessionMin: 2, sessionMax: 2 },
      dynamic: { pureSessionMin: 1, pureSessionMax: 1 },
      ...overrides,
    },
  }
}

/** 在指定随机值下跑一次 resetSession（0.9.1：手动区间也是随机的，测试要把随机源钉住）。 */
function withRandom(value, run) {
  const original = Math.random
  Math.random = () => value
  try { return run() } finally { Math.random = original }
}
const sessionOpts = { wakeTime: '00:00', reviewTime: '23:59', dailyMaxVideos: 0 }

test.after(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  delete process.env.WORLD_BILI_DATA_DIR
})

test('手动区间两端都生效：填 2 和 6，这次就是 2–6 里随机（0.9.1）', () => {
  const manual = cfg({ watch: { autoFromWindow: false, sessionMin: 2, sessionMax: 6 } })
  assert.deepEqual(sl.pickSessionRange(manual, '09:00', '23:00'), { min: 2, max: 6 });

  // 钉住随机源，证明「最少」不再是个装饰：0 → 取下限，0.999 → 取上限。
  clearData()
  assert.equal(withRandom(0, () => sl.resetSession(manual, sessionOpts).watchTarget), 2);
  clearData()
  assert.equal(withRandom(0.999, () => sl.resetSession(manual, sessionOpts).watchTarget), 6);
});

test('手动填相等 = 固定值；最少大于最多时抬到最少', () => {
  clearData()
  const fixed = cfg({ watch: { autoFromWindow: false, sessionMin: 5, sessionMax: 5 } });
  assert.deepEqual(sl.pickSessionRange(fixed, '09:00', '23:00'), { min: 5, max: 5 });
  assert.equal(withRandom(0.5, () => sl.resetSession(fixed, sessionOpts).watchTarget), 5);

  const reversed = cfg({ watch: { autoFromWindow: false, sessionMin: 6, sessionMax: 3 } });
  assert.deepEqual(sl.pickSessionRange(reversed, '09:00', '23:00'), { min: 6, max: 6 }, '写反了也不给出负区间，直接抬到最少');
});

test('手动值清空（null / ""）不会被算成 0 条', () => {
  const empty = cfg({ watch: { autoFromWindow: false, sessionMin: null, sessionMax: null } });
  assert.deepEqual(sl.pickSessionRange(empty, '09:00', '23:00'), { min: 0, max: 6 }, '没填最少就从「最多-2」推，最多缺省 6');
  const halfFilled = cfg({ watch: { autoFromWindow: false, sessionMin: 4, sessionMax: null } });
  assert.deepEqual(sl.pickSessionRange(halfFilled, '09:00', '23:00'), { min: 4, max: 6 });
});

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
  // 给她的话不带数字；「今天已达总上限 N 条」在 detail 里
  assert.doesNotMatch(check.why, /总上限/)
  assert.match(check.detail, /总上限/)
})

test('纯动态名额随机到 0：checkSession 拒绝，0 不再等于不限', () => {
  clearData()
  const c = cfg({ dynamic: { pureSessionMin: 0, pureSessionMax: 0 } })
  const r = sl.resetSession(c, { wakeTime: '00:00', reviewTime: '23:59', dailyMaxVideos: 0 })
  assert.equal(r.pureTarget, 0)
  const check = sl.checkSession('pure')
  assert.equal(check.ok, false)
  assert.equal(check.target, 0)
  // 给她的话不提数字；真正原因在 detail 里
  assert.doesNotMatch(check.why, /0\/0/)
  assert.match(check.detail, /0\/0/)
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
