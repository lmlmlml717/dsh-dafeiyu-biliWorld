// 控制台「历史账本」的数据源（CODE-AUDIT-2026-11-08 H-02）。
//
// 回归点：
//   · 旧实现把 bili-actions.json 当数组（Array.isArray），而工具链写的是对象 → 历史恒空；
//   · daysAgo 用 toISOString()（UTC），账本用本地日 → 东八区 00:00–08:00 整体错一天。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readBiliHistory, localDayKey } from '../src/bili/history.ts'

function withDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-world-bili-history-'))
  try { run(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

const now = new Date(2026, 10, 8, 12, 0, 0) // 2026-11-08 本地中午
const today = localDayKey(now)
const yesterdayDate = new Date(now)
yesterdayDate.setDate(yesterdayDate.getDate() - 1)
const yesterday = localDayKey(yesterdayDate)

function social(day: string, label: string): string {
  return JSON.stringify({ ts: `${day}T12:00:00.000Z`, day, kind: label, label, speak: true, text: 'x' })
}

test('按对象读账本 + 社交流水出跨天历史，空白天不占行', () => {
  withDir(dir => {
    writeFileSync(join(dir, 'bili-social.jsonl'), [
      social(today, '转发动态'),
      social(today, '评论'), // 会被今天的账本覆盖，不能重复计数
      social(yesterday, '转发动态'),
      social('2026-01-01', '评论'), // 窗口外
    ].join('\n') + '\n')
    // 工具链真实写法：对象，不是数组。
    writeFileSync(join(dir, 'bili-actions.json'), JSON.stringify({ day: today, dyn_share: 3, comment: 1 }))
    writeFileSync(join(dir, 'bili-outbox.md'), '# 发出的动态\n- 21:00 转发 …')

    const h = readBiliHistory(dir, 7, now)
    assert.equal(h.days[0], today)
    assert.equal(h.days[1], yesterday)
    assert.equal(h.days.length, 7)
    const todayEntry = h.recentActions.find(entry => entry.day === today)
    assert.ok(todayEntry, '今天必须有记录')
    // 账本比社交流水权威：3 条转发 + 1 条评论 = 4
    assert.equal(todayEntry!.total, 4)
    assert.deepEqual(todayEntry!.kinds, { 转发动态: 3, 评论: 1 })
    const yesterdayEntry = h.recentActions.find(entry => entry.day === yesterday)
    assert.equal(yesterdayEntry!.total, 1)
    assert.equal(h.totalActions, 5)
    assert.match(h.outboxPreview, /发出的动态/)
  })
})

test('账本缺失/损坏时只用社交流水，不抛错', () => {
  withDir(dir => {
    writeFileSync(join(dir, 'bili-actions.json'), '{ broken')
    writeFileSync(join(dir, 'bili-social.jsonl'), social(today, '转发动态') + '\n')
    const h = readBiliHistory(dir, 3, now)
    assert.equal(h.recentActions.length, 1)
    assert.equal(h.recentActions[0]!.total, 1)
  })
})

test('社交流水里的原始 kind 归一成人读标签', () => {
  withDir(dir => {
    // postDynamic 的 capRecord('dyn_pure') 没带 label，历史里只能是原始 kind。
    writeFileSync(join(dir, 'bili-social.jsonl'), JSON.stringify({ day: today, kind: 'dyn_pure' }) + '\n')
    const h = readBiliHistory(dir, 1, now)
    assert.deepEqual(h.recentActions[0]!.kinds, { 纯动态: 1 })
  })
})

test('日界用本地日：本地凌晨 00:30 仍算当天（UTC 会退到前一天）', () => {
  const midnight = new Date(2026, 10, 8, 0, 30, 0)
  assert.equal(localDayKey(midnight), '2026-11-08')
  withDir(dir => {
    const h = readBiliHistory(dir, 2, midnight)
    assert.deepEqual(h.days, ['2026-11-08', '2026-11-07'])
  })
})

test('days 参数夹到 1–90（非法值按 7）', () => {
  withDir(dir => {
    assert.equal(readBiliHistory(dir, 0, now).days.length, 7)
    assert.equal(readBiliHistory(dir, 'abc', now).days.length, 7)
    assert.equal(readBiliHistory(dir, 500, now).days.length, 90)
    assert.equal(readBiliHistory(dir, -3, now).days.length, 1)
  })
})
