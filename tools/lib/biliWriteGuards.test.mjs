// 0.9.0 的写通道护栏：社交流水只记一条、守门在联网之前、死开关真的生效。
//
// 这些用例都只碰临时目录：不联网、不读真实凭据（没有凭据文件时正好验证"不该联网的路径不会抛"）。
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 每个用例一套独立的数据根 + 配置；返回 dir 与写配置的小工具。 */
function setup(t, cfg = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bili-write-'))
  const dataDir = join(dir, 'bili')
  const configFile = join(dir, 'bili.config.json')
  const prevData = process.env.WORLD_BILI_DATA_DIR
  const prevCfg = process.env.WORLD_BILI_CONFIG
  process.env.WORLD_BILI_DATA_DIR = dataDir
  process.env.WORLD_BILI_CONFIG = configFile
  writeFileSync(configFile, JSON.stringify(cfg))
  t.after(() => {
    if (prevData === undefined) delete process.env.WORLD_BILI_DATA_DIR; else process.env.WORLD_BILI_DATA_DIR = prevData
    if (prevCfg === undefined) delete process.env.WORLD_BILI_CONFIG; else process.env.WORLD_BILI_CONFIG = prevCfg
    rmSync(dir, { recursive: true, force: true })
  })
  return { dir, dataDir, configFile, writeConfig: (next) => writeFileSync(configFile, JSON.stringify(next)) }
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

test('一次转发在社交流水里只记一条，而且 kind 是 dyn_share（不再是假评论）', async (t) => {
  const { dataDir } = setup(t, { guard: { dryRun: false }, bilibili: { dynamic: { enabled: true } } })
  const { recordBili } = await import('./outbox.mjs')
  const write = await import('./bili-write.mjs')

  recordBili({ kind: '转发动态', bvid: 'BV1xx411c7mD', title: '测试', text: '配文' })
  write.capRecord('dyn_share', { kind: '转发动态', title: '测试', bvid: 'BV1xx411c7mD', text: '配文' })
  await sleep(250)

  const lines = readFileSync(join(dataDir, 'bili-social.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.equal(lines.length, 1, 'capRecord 不再补记第二条')
  assert.equal(lines[0].kind, 'dyn_share')
  assert.equal(lines[0].label, '转发动态')
  assert.equal(lines[0].speak, true, '转发带配文也算她公开发的话')
})

test('capRecord 自己不再写社交流水（只有一个写入口）', async (t) => {
  const { dataDir } = setup(t, { guard: { dryRun: false } })
  const write = await import('./bili-write.mjs')
  write.capRecord('comment', { kind: 'comment', bvid: 'BV1xx411c7mD', text: '评论' })
  await sleep(250)
  assert.throws(() => readFileSync(join(dataDir, 'bili-social.jsonl'), 'utf8'), /ENOENT/)
  assert.ok(readFileSync(join(dataDir, 'bili-actions.json'), 'utf8').includes('comment'))
})

test('转发：开关关着就拒绝，而且不碰凭据（不该抛错）', async (t) => {
  const { writeConfig } = setup(t, { guard: { dryRun: false }, bilibili: { dynamic: { enabled: true } } })
  const write = await import('./bili-write.mjs')

  writeConfig({ guard: { dryRun: false }, bilibili: { dynamic: { shareEnabled: false } } })
  const off = await write.shareVideoDynamic('BV1xx411c7mD', '配文', { go: true })
  assert.equal(off.ok, false)
  assert.match(off.why, /shareEnabled/)

  writeConfig({ guard: { dryRun: false }, share: { enabled: false } })
  const master = await write.shareVideoDynamic('BV1xx411c7mD', '配文', { go: true })
  assert.equal(master.ok, false)
  assert.match(master.why, /share\.enabled/)
})

test('转发干跑：没凭据也返回预览，不抛错', async (t) => {
  setup(t, { guard: { dryRun: false }, bilibili: { dynamic: { shareEnabled: true } } })
  const write = await import('./bili-write.mjs')
  const preview = await write.shareVideoDynamic('BV1xx411c7mD', '配文', { go: false })
  assert.equal(preview.ok, true)
  assert.equal(preview.dry, true)
  assert.match(preview.why, /【干跑】转发动态/)
})

test("shareMode='forwardOnly' 真的丢掉配文（以前这个键没人读）", async (t) => {
  setup(t, { guard: { dryRun: false }, bilibili: { share: { shareMode: 'forwardOnly' } } })
  const write = await import('./bili-write.mjs')
  const preview = await write.shareVideoDynamic('BV1xx411c7mD', '这段配文不该被带上', { go: false })
  assert.match(preview.why, /只转发，不配文/)
  assert.doesNotMatch(preview.why, /这段配文不该被带上/)
})

test('点赞要显式打开：没配 react.like 时连凭据都不读', async (t) => {
  setup(t, { guard: { dryRun: false } })
  const write = await import('./bili-write.mjs')
  const refused = await write.likeVideo('BV1xx411c7mD', { go: true })
  assert.equal(refused.ok, false)
  assert.match(refused.why, /react\.like/)
})

test('发言台账抬头不再写死别人的名字；旧文件只换抬头一行，正文不丢', async (t) => {
  const { dataDir } = setup(t, { guard: { dryRun: false } })
  const { recordBili } = await import('./outbox.mjs')
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, 'bili-outbox.md'),
    '# 大肥鱼 · B站发言台账\n\n> 她在 B站 公开说的每一句话，按天记录（最新在上）。点链接看视频和评论上下文。\n\n## 2026-11-08\n\n- 10:00 **评论**：旧的一条\n')

  recordBili({ kind: '评论', bvid: 'BV1xx411c7mD', title: '测试', text: '新的一条' })
  const md = readFileSync(join(dataDir, 'bili-outbox.md'), 'utf8')
  assert.match(md, /^# B站发言台账/, '抬头换成中性标题')
  assert.doesNotMatch(md, /大肥鱼/)
  assert.match(md, /旧的一条/, '旧内容一行都没被吃掉')
  assert.match(md, /新的一条/)
})

test('动作类只进社交流水，不写《B站发言台账》（点赞不是发言）', async (t) => {
  const { dataDir } = setup(t, { guard: { dryRun: false } })
  const { recordBili } = await import('./outbox.mjs')

  recordBili({ kind: '点赞', bvid: 'BV1xx411c7mD', title: '测试' })
  await sleep(250)
  const social = readFileSync(join(dataDir, 'bili-social.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.equal(social.length, 1)
  assert.equal(social[0].kind, 'like')
  assert.throws(() => readFileSync(join(dataDir, 'bili-outbox.md'), 'utf8'), /ENOENT/, '点赞不该出现在发言台账里')

  recordBili({ kind: '评论', bvid: 'BV2xx411c7mD', title: '测试', text: '这句是发言' })
  await sleep(250)
  assert.match(readFileSync(join(dataDir, 'bili-outbox.md'), 'utf8'), /评论/, '发言照旧写台账')
})
