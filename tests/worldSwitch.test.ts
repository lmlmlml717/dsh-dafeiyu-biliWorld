// world.json 容错（CODE-AUDIT-2026-11-08 H-04）。
//
// 旧实现直接在 apply() 主路径 JSON.parse 且没有 try/catch：world.json 被手改坏/写一半，
// 整个插件加载失败，控制台和全部路由一起消失。现在解析失败只当「没存过」，并上报 fault；
// 合法文件的读取语义保持不变。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorldSwitch } from '../src/worldSwitch.ts'

function withDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-world-switch-'))
  try { run(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('world.json 是坏 JSON：不抛错，按默认设置启动并上报原因', () => {
  withDir(dir => {
    writeFileSync(join(dir, 'world.json'), '{"running": tru')
    const faults: string[] = []
    const power = createWorldSwitch(dir, 'workspace', '09:00', { onFault: message => faults.push(message) })
    assert.equal(power.running(), false)
    assert.equal(faults.length, 1)
    assert.match(faults[0]!, /world\.json/)
  })
})

test('world.json 不是对象（例如 null/数组/字符串）：同样退回默认设置', () => {
  withDir(dir => {
    for (const text of ['null', '"oops"', '42']) {
      writeFileSync(join(dir, 'world.json'), text)
      const faults: string[] = []
      const power = createWorldSwitch(dir, 'workspace', '09:00', { onFault: message => faults.push(message) })
      assert.equal(power.running(), false, text)
      assert.equal(faults.length, 1, text)
    }
  })
})

test('合法 world.json 的读取语义不变，并且能继续写入', () => {
  withDir(dir => {
    writeFileSync(join(dir, 'world.json'), JSON.stringify({ running: true, memoryTurns: 50, wakeTime: '07:30', reviewTime: '22:15' }))
    const power = createWorldSwitch(dir, 'workspace', '09:00')
    assert.equal(power.running(), true)
    assert.equal(power.memoryTurns(), 50)
    assert.equal(power.wakeTime(), '07:30')
    assert.equal(power.reviewTime(), '22:15')
    power.set(false)
    const again = createWorldSwitch(dir, 'workspace', '09:00')
    assert.equal(again.running(), false)
  })
})
