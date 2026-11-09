// comment 写通道的回归测试：开关、干跑预览、DRY_RUN 拦截、日额度与硬上限钳制。
// 只测到「不联网就返回」为止 —— 真发（POST /x/v2/reply/add）留给手动验证。
// 跑法：npm test，或 node --test tools/commands/comment.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { postReply } from '../lib/bili-write.mjs'

const DAY = new Date().toLocaleDateString('sv-SE')
const BASE = { guard: { dryRun: true }, comment: { enabled: true, allowWrite: true, dailyMax: 0, hardDailyMax: 5, skipChance: 0.3 } }

/** 临时 world 目录：WORLD_BILI_CONFIG / WORLD_BILI_DATA_DIR 都指过去，测试之间互不影响。 */
function setup(t, cfg = {}, acts = undefined) {
  const dir = mkdtempSync(join(tmpdir(), 'bili-comment-'))
  t.after(() => {
    rmSync(dir, { recursive: true, force: true })
    delete process.env.WORLD_BILI_CONFIG
    delete process.env.WORLD_BILI_DATA_DIR
  })
  const configFile = join(dir, 'bili.config.json')
  writeFileSync(configFile, JSON.stringify({ ...BASE, ...cfg }), 'utf8')
  const dataDir = join(dir, 'bili')
  mkdirSync(dataDir, { recursive: true })
  if (acts !== undefined) writeFileSync(join(dataDir, 'bili-actions.json'), JSON.stringify(acts), 'utf8')
  process.env.WORLD_BILI_CONFIG = configFile
  process.env.WORLD_BILI_DATA_DIR = dataDir
  return dir
}

test('评论功能关着时直接拒绝，并说明两个开关都要开', async t => {
  setup(t, { comment: { ...BASE.comment, enabled: false } })
  const r = await postReply('BV1xx411c7mD', '想说两句', { go: false })
  assert.equal(r.ok, false)
  assert.match(r.why, /评论功能已关/)
})

test('干跑只打印预览：不查凭据、不联网、不占额度', async t => {
  setup(t)
  const r = await postReply('BV1xx411c7mD', '这条视频讲得挺好', { go: false })
  assert.equal(r.ok, true)
  assert.equal(r.dry, true)
  assert.match(r.why, /干跑/)
  assert.match(r.why, /BV1xx411c7mD/)
})

test('--go 也要过 guard.dryRun：默认干跑时明确拦截', async t => {
  setup(t)
  const r = await postReply('BV1xx411c7mD', '想说两句', { go: true })
  assert.equal(r.ok, false)
  assert.equal(r.dry, true)
  assert.match(r.why, /干跑/)
})

test('dailyBili.allowWrite 没开时 --go 也拒绝真发（不联网、不占额度）', async t => {
  setup(t, { guard: { dryRun: false }, comment: { ...BASE.comment, allowWrite: false } })
  const r = await postReply('BV1xx411c7mD', '想说两句', { go: true })
  assert.equal(r.ok, false)
  assert.equal(r.dry, true)
  assert.match(r.why, /allowWrite/)
})

test('两条评论的最小间隔（minIntervalSec）没到就拦住，不联网', async t => {
  const dir = setup(t, { guard: { dryRun: false }, comment: { ...BASE.comment, minIntervalSec: 3600 } })
  // 上一条评论是 1 分钟前发的 → 3600 秒的间隔还没到
  writeFileSync(join(dir, 'bili', 'sent-at.json'), JSON.stringify({ 'bilibili:comment': Date.now() - 60_000 }), 'utf8')
  const r = await postReply('BV1xx411c7mD', '想说两句', { go: true })
  assert.equal(r.ok, false)
  assert.equal(r.dry, true)
  assert.match(r.why, /还要等/)
})

test('日额度用完就拦住（dailyMax 钳制在硬上限内）', async t => {
  // dailyMax=1，今天已经发过 1 条；dryRun 关掉，让额度闸成为第一道拦截（不会联网）
  setup(t, { guard: { dryRun: false }, comment: { ...BASE.comment, dailyMax: 1, hardDailyMax: 5 } }, { day: DAY, comment: 1 })
  const r = await postReply('BV1xx411c7mD', '想说两句', { go: true })
  assert.equal(r.ok, false)
  // why 给她看（不提额度），数字在 detail 里
  assert.match(r.why, /评论发不出去/)
  assert.match(r.detail, /额度已用完（1\/1）/)
})

test('dailyMax=0 时按硬上限生效：硬上限 2、今天已发 2 条就拦住', async t => {
  setup(t, { guard: { dryRun: false }, comment: { ...BASE.comment, dailyMax: 0, hardDailyMax: 2 } }, { day: DAY, comment: 2 })
  const r = await postReply('BV1xx411c7mD', '想说两句', { go: true })
  assert.equal(r.ok, false)
  assert.match(r.detail, /额度已用完（2\/2）/)
})

test('面板条数超过硬上限也按硬上限算：dailyMax=9、硬上限 2 → 2', async t => {
  setup(t, { guard: { dryRun: false }, comment: { ...BASE.comment, dailyMax: 9, hardDailyMax: 2 } }, { day: DAY, comment: 2 })
  const r = await postReply('BV1xx411c7mD', '想说两句', { go: true })
  assert.equal(r.ok, false)
  assert.match(r.detail, /（2\/2）/)
})
