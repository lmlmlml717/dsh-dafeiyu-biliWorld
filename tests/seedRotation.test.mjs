import assert from 'node:assert/strict'
import test from 'node:test'
import { localDayIndex, pickSeeds, SEEDS_PER_ROUND } from '../tools/lib/seed-rotation.mjs'

test('每轮取 2 个，同一天里同一对（多轮可对账）', () => {
  const seeds = ['a', 'b', 'c', 'd', 'e']
  const first = pickSeeds(seeds, 20000)
  const second = pickSeeds(seeds, 20000)
  assert.equal(first.picked.length, 2)
  assert.deepEqual(first.picked, second.picked)
})

test('n 个种子在 ⌈n/2⌉ 天内全部轮到', () => {
  for (let n = 1; n <= 9; n++) {
    const seeds = Array.from({ length: n }, (_, i) => `s${i}`)
    const days = Math.ceil(n / SEEDS_PER_ROUND)
    const seen = new Set()
    for (let d = 0; d < days; d++) for (const s of pickSeeds(seeds, 20000 + d).picked) seen.add(s)
    assert.equal(seen.size, n, `n=${n} 没在 ${days} 天内轮完`)
  }
})

test('跨天后窗口移动（种子多于 2 个时）', () => {
  const seeds = ['a', 'b', 'c', 'd']
  assert.notDeepEqual(pickSeeds(seeds, 20000).picked, pickSeeds(seeds, 20001).picked)
})

test('空列表 / 空串 / 重复种子', () => {
  assert.deepEqual(pickSeeds([]), { picked: [], offset: 0, daysToCover: 0 })
  assert.deepEqual(pickSeeds(['', '   ']), { picked: [], offset: 0, daysToCover: 0 })
  const dup = pickSeeds(['a', 'a', 'b'], 20000)
  assert.equal(dup.picked.length, 2)
  assert.notEqual(dup.picked[0], dup.picked[1], '去重后不会把同一个词搜两遍')
})

test('只有 1 个或 2 个种子时每天都搜全部', () => {
  assert.deepEqual(pickSeeds(['only'], 1).picked, ['only'])
  const two = pickSeeds(['x', 'y'], 12345).picked
  assert.deepEqual(new Set(two), new Set(['x', 'y']))
})

test('localDayIndex 同一本地日恒定、跨日加 1', () => {
  const noon = new Date(2026, 10, 8, 12, 0, 0)
  const evening = new Date(2026, 10, 8, 23, 30, 0)
  const nextDay = new Date(2026, 10, 9, 0, 30, 0)
  assert.equal(localDayIndex(noon), localDayIndex(evening))
  assert.equal(localDayIndex(nextDay) - localDayIndex(noon), 1)
})
