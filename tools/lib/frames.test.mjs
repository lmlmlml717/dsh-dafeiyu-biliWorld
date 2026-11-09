// frames.mjs 的缓存清理测试：不联网、不调 ffmpeg，只验证 pruneFrames 的删除顺序与上限。
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pruneCacheDir, pruneFrames } from './frames.mjs'

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'bili-frames-'))
  if (t) t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('pruneFrames：超过大小上限时从最旧的删起', () => {
  const dir = setup()
  const now = Date.now()
  const specs = [
    { name: 'old.mp4', bytes: 600, ageMin: 30 },
    { name: 'mid.jpg', bytes: 600, ageMin: 20 },
    { name: 'new.jpg', bytes: 600, ageMin: 10 },
  ]
  for (const spec of specs) {
    const file = join(dir, spec.name)
    writeFileSync(file, Buffer.alloc(spec.bytes))
    const at = (now - spec.ageMin * 60_000) / 1000
    utimesSync(file, at, at)
  }
  const r = pruneFrames(dir, { maxBytes: 700, maxAgeMs: 24 * 60 * 60_000, now })
  assert.equal(r.removed, 2, '删到只剩最新一份')
  assert.equal(r.keptBytes, 600)
  assert.doesNotThrow(() => statSync(join(dir, 'new.jpg')))
  assert.throws(() => statSync(join(dir, 'old.mp4')))
})

test('pruneFrames：过期文件先删，目录不存在也不抛错', (t) => {
  const dir = setup(t)
  const now = Date.now()
  writeFileSync(join(dir, 'stale.jpg'), Buffer.alloc(10))
  const old = (now - 10 * 24 * 60 * 60_000) / 1000
  utimesSync(join(dir, 'stale.jpg'), old, old)
  const r = pruneFrames(dir, { maxBytes: 1024, maxAgeMs: 24 * 60 * 60_000, now })
  assert.equal(r.removed, 1)
  assert.deepEqual(pruneFrames(join(dir, 'missing'), { now }), { removed: 0, keptBytes: 0 })
})

// 0.8.25：封面缓存（cache/covers）以前只增不减，用的就是这同一套规则。
test('pruneCacheDir：封面这类目录也按同一套规则清（刚从上限外拉回来）', (t) => {
  const dir = setup(t)
  const now = Date.now()
  for (const [name, ageMin] of [['old.jpg', 90], ['mid.jpg', 60], ['new.jpg', 30]]) {
    const file = join(dir, name)
    writeFileSync(file, Buffer.alloc(400))
    const at = (now - ageMin * 60_000) / 1000
    utimesSync(file, at, at)
  }
  const r = pruneCacheDir(dir, { maxBytes: 900, maxAgeMs: 24 * 60 * 60_000, now })
  assert.equal(r.removed, 1, '900 只装得下两张，从最旧的删')
  assert.equal(r.keptBytes, 800)
  assert.throws(() => statSync(join(dir, 'old.jpg')))
  assert.doesNotThrow(() => statSync(join(dir, 'new.jpg')))
})
