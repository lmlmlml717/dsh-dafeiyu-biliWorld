// quota 账本的回归测试：shareDaily 日上限 + sameVideoDays 去重 + 记账幂等 + 损坏账本兜底。
// 跑法：npm test（node --test 会自动发现 *.test.mjs），或 node --test tools/commands/quota.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { check, record } from './quota.mjs'

const CFG = { quota: { shareDaily: 3, sameVideoDays: 7 } }
const DAY = 86400_000

function setup(t, files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bili-quota-'))
  t.after(() => { rmSync(dir, { recursive: true, force: true }); delete process.env.WORLD_BILI_DATA_DIR })
  process.env.WORLD_BILI_DATA_DIR = dir
  mkdirSync(dir, { recursive: true })
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text, 'utf8')
  return dir
}
const logJson = (log) => JSON.stringify({ log })

test('a missing ledger passes the check and record creates the file', t => {
  const dir = setup(t)
  const ok = check({ type: 'share', target: 'BV1', cfg: CFG })
  assert.equal(ok.ok, true)
  assert.equal(ok.why, '可以发')
  assert.equal(ok.detail, '可发（今天 0/3）')
  assert.equal(record({ type: 'share', target: 'BV1', note: '测试', cfg: CFG }), true)
  const q = JSON.parse(readFileSync(join(dir, 'quota.json'), 'utf8'))
  assert.equal(q.log.length, 1)
  assert.equal(q.log[0].target, 'BV1')
  assert.equal(q.log[0].share, true)
  assert.equal(q.log[0].note, '测试')
})

test('the same video is refused within sameVideoDays', t => {
  const dir = setup(t, { 'quota.json': logJson([{ at: new Date().toISOString(), type: 'share', target: 'BV1', share: true }]) })
  const r = check({ type: 'share', target: 'BV1', cfg: CFG })
  assert.equal(r.ok, false)
  assert.match(r.why, /已经发过了/)
})

test('shareDaily cap blocks the next share today', t => {
  const dir = setup(t, { 'quota.json': logJson([0, 1, 2].map(i => ({ at: new Date().toISOString(), type: 'share', target: `BV${i}`, share: true }))) })
  const r = check({ type: 'share', target: 'BV9', cfg: CFG })
  assert.equal(r.ok, false)
  assert.match(r.detail, /3\/3/)
})

test('record does not double-log the same target', t => {
  const dir = setup(t)
  assert.equal(record({ type: 'share', target: 'BV1', cfg: CFG }), true)
  assert.equal(record({ type: 'share', target: 'BV1', cfg: CFG }), false, '并发/重复 fire 时第二条不再记')
  const q = JSON.parse(readFileSync(join(dir, 'quota.json'), 'utf8'))
  assert.equal(q.log.filter(x => x.target === 'BV1').length, 1)
})

test('a corrupted ledger is treated as empty and rewritten on record', t => {
  const dir = setup(t, { 'quota.json': '{ 这不是 json' })
  assert.equal(check({ type: 'share', target: 'BV1', cfg: CFG }).ok, true)
  assert.equal(record({ type: 'share', target: 'BV1', cfg: CFG }), true)
  const q = JSON.parse(readFileSync(join(dir, 'quota.json'), 'utf8'))
  assert.equal(q.log.length, 1)
})

test('entries older than sameVideoDays no longer block', t => {
  const dir = setup(t, { 'quota.json': logJson([{ at: new Date(Date.now() - 8 * DAY).toISOString(), type: 'share', target: 'BV1', share: true }]) })
  assert.equal(check({ type: 'share', target: 'BV1', cfg: CFG }).ok, true)
})

// 0.8.11：额度闸与 bili-write / 面板统一口径 —— UI 的 shareDailyMax 优先，quota.shareDaily 只是回落值。
const today = (n) => logJson(Array.from({ length: n }, (_, i) => ({ at: new Date().toISOString(), type: 'share', target: `BV${i}`, share: true })))

test('the UI shareDailyMax wins over quota.shareDaily when it is set', t => {
  setup(t, { 'quota.json': today(4) })
  const cfg = { quota: { sameVideoDays: 7 }, bilibili: { dynamic: { shareDailyMax: 10 } } }
  const r = check({ type: 'share', target: 'BV9', cfg })
  assert.equal(r.ok, true, '第 5 条在 UI 设 10 时仍可发')
  assert.match(r.detail, /4\/10/)
})

test('with no shareDailyMax it falls back to quota.shareDaily', t => {
  setup(t, { 'quota.json': today(2) })
  const r = check({ type: 'share', target: 'BV9', cfg: { quota: { shareDaily: 2, sameVideoDays: 7 } } })
  assert.equal(r.ok, false)
  assert.match(r.detail, /2\/2/)

  // shareDailyMax 显式写 0 = 不启用 UI 值，继续回落 quota.shareDaily（5）
  const fallback = check({ type: 'share', target: 'BV8', cfg: { quota: { shareDaily: 5, sameVideoDays: 7 }, bilibili: { dynamic: { shareDailyMax: 0 } } } })
  assert.equal(fallback.ok, true)
  assert.match(fallback.detail, /2\/5/)
})
