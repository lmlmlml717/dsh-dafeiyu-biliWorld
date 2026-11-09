// 风控记账的护栏：写不进去只返回 false，绝不让「已经发出去」变成「失败」。
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const good = mkdtempSync(join(tmpdir(), 'bili-guard-good-'))
const broken = mkdtempSync(join(tmpdir(), 'bili-guard-broken-'))
// 让 sent-log.json 变成一个目录：writeJson 最后那步 rename 必然失败，模拟只读沙箱/磁盘满。
mkdirSync(join(broken, 'sent-log.json'))
process.env.WORLD_BILI_DATA_DIR = good
const guard = await import('./guard.mjs')

test.after(() => {
  rmSync(good, { recursive: true, force: true })
  rmSync(broken, { recursive: true, force: true })
  delete process.env.WORLD_BILI_DATA_DIR
})

test('commitQuietly：写得进去就返回 true，内容和时间都落盘', () => {
  process.env.WORLD_BILI_DATA_DIR = good
  assert.equal(guard.commitQuietly('bilibili:comment', '这条已经发出去了'), true)
  assert.match(readFileSync(join(good, 'sent-log.json'), 'utf8'), /这条已经发出去了/)
  assert.equal(guard.lastSentAt('bilibili:comment') > 0, true)
})

test('commitQuietly：写不进去只返回 false，不抛（已经发出去的不能报失败）', () => {
  process.env.WORLD_BILI_DATA_DIR = broken
  // 原来的 commit 会抛 —— 证明兜底不是把错误藏起来，而是调用方选了「不因此报失败」。
  assert.throws(() => guard.commit('bilibili:comment', '一条评论'))
  assert.equal(guard.commitQuietly('bilibili:comment', '一条评论'), false)
})
