// debrief 的取值优先级：命令行 > bili.config.json 的 debrief 段 > 内置默认。
// 纯函数测试，不联网、不碰凭据。
import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveDebriefOptions } from './debrief.mjs'

const MB = 1024 * 1024
const DAY = 86400_000

test('什么都不配时就是原来的默认值', () => {
  const o = resolveDebriefOptions([], {})
  assert.equal(o.comments, 5)
  assert.equal(o.frames, true)
  assert.equal(o.bucket, 30)
  assert.equal(o.top, 5)
  assert.equal(o.grid, '3x3')
  assert.equal(o.tile, 720)
  assert.deepEqual(o.cache, { framesBytes: 300 * MB, framesAgeMs: 7 * DAY, coversBytes: 100 * MB, coversAgeMs: 7 * DAY })
})

test('配置里改了就用配置的（面板上的那几个数字走这条）', () => {
  const o = resolveDebriefOptions([], {
    debrief: { comments: 12, frames: false, cache: { framesMaxMB: 50, framesMaxDays: 3, coversMaxMB: 20, coversMaxDays: 2 } },
  })
  assert.equal(o.comments, 12)
  assert.equal(o.frames, false, '面板上关掉抽帧就是真的不抽')
  assert.deepEqual(o.cache, { framesBytes: 50 * MB, framesAgeMs: 3 * DAY, coversBytes: 20 * MB, coversAgeMs: 2 * DAY })
})

test('命令行永远优先：她的老习惯命令不会因为面板改了默认值而失效', () => {
  const cfg = { debrief: { comments: 12, frames: false } }
  assert.equal(resolveDebriefOptions(['--comments', '3'], cfg).comments, 3)
  assert.equal(resolveDebriefOptions(['--frames'], cfg).frames, true, '面板关着也能临时跑一次')
  assert.equal(resolveDebriefOptions(['--no-frames'], { debrief: { frames: true } }).frames, false)
  assert.equal(resolveDebriefOptions(['--bucket', '60', '--top', '3'], cfg).bucket, 60)
})

test('配置写坏了就回默认值，不会变成「不清理」或「热评 0 条」', () => {
  const o = resolveDebriefOptions([], { debrief: { comments: 'abc', frames: 'yes', cache: { framesMaxMB: 0, framesMaxDays: -3 } } })
  assert.equal(o.comments, 5)
  assert.equal(o.frames, true, '只有明确的 false 才算关')
  assert.equal(o.cache.framesBytes, 300 * MB)
  assert.equal(o.cache.framesAgeMs, 7 * DAY)
  // 越界的数字被夹回合理范围，而不是原样传进清理函数。
  assert.equal(resolveDebriefOptions(['--comments', '999'], {}).comments, 20)
  assert.equal(resolveDebriefOptions(['--comments', '-2'], {}).comments, 5, '非正数当没传')
})
