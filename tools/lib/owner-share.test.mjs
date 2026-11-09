// owner-share.mjs：队列文件长什么样、重复递进来的怎么合并、坏行怎么办。不联网、不碰真凭据。
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendShare, deliveredIds, formatShare, OUTBOX_MAX_RECORDS, readShares, shareOutboxPath, shareStatePath, toBvid } from './owner-share.mjs'

// 每个用例一个独立的数据根：appendShare 只认 WORLD_BILI_DATA_DIR，不碰用户真实目录。
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'bili-share-'))
  const previous = process.env.WORLD_BILI_DATA_DIR
  process.env.WORLD_BILI_DATA_DIR = dir
  t.after(() => {
    if (previous === undefined) delete process.env.WORLD_BILI_DATA_DIR
    else process.env.WORLD_BILI_DATA_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

test('toBvid：裸 BV 和各种链接都认，别的东西返回 null', () => {
  assert.equal(toBvid('BV1xx411c7mD'), 'BV1xx411c7mD')
  assert.equal(toBvid(' https://www.bilibili.com/video/BV1xx411c7mD '), 'BV1xx411c7mD')
  assert.equal(toBvid('https://www.bilibili.com/video/BV1xx411c7mD/?p=2&t=3'), 'BV1xx411c7mD')
  assert.equal(toBvid('https://api.bilibili.com/x/web-interface/view?bvid=BV1xx411c7mD'), 'BV1xx411c7mD')
  assert.equal(toBvid('BV1xx'), null, '太短的不是 BV')
  assert.equal(toBvid('https://www.bilibili.com/video/av12345'), null)
  assert.equal(toBvid(''), null)
  assert.equal(toBvid(undefined), null)
})

test('formatShare：标题、BV、她的话各一行，中间不留空行', () => {
  const text = formatShare({ bvid: 'BV1xx411c7mD', title: '他烤了整只鸡', say: '我笑到呛住' })
  assert.equal(text, '《他烤了整只鸡》\nBV1xx411c7mD\n我笑到呛住')
  // 空行会让 QQ 通道把一次分享拆成三条消息（replies.ts 按空行分条）。
  assert.doesNotMatch(text, /\n\n/)
  // 主人只要 BV，不要长链接。
  assert.doesNotMatch(text, /https?:\/\//)
})

test('formatShare：没标题就只发 BV 和话；只有老记录没 bvid 时才退回链接', () => {
  assert.equal(formatShare({ bvid: 'BV1xx411c7mD', say: '这个' }), 'BV1xx411c7mD\n这个')
  assert.equal(formatShare({ bvid: 'BV1xx411c7mD' }), 'BV1xx411c7mD')
  assert.equal(formatShare({ url: 'https://example.com/x' }), 'https://example.com/x')
  assert.equal(formatShare({}), '')
})

test('appendShare：追加一行，字段齐全，读回来是同一条', (t) => {
  const dir = setup(t)
  const { record, duplicate } = appendShare({ bvid: 'BV1xx411c7mD', title: '标题', say: '话' })
  assert.equal(duplicate, false)
  assert.match(record.id, /^[0-9a-z]+-[0-9a-z]+$/)
  const lines = readFileSync(shareOutboxPath(), 'utf8').trim().split('\n')
  assert.equal(lines.length, 1, '一行一条，只追加')
  const [read] = readShares()
  assert.equal(read.id, record.id)
  assert.equal(read.bvid, 'BV1xx411c7mD')
  assert.equal(read.title, '标题')
  assert.equal(read.say, '话')
  // 队列里不存长链接：主人只要 BV（0.8.25）。
  assert.equal(read.url, undefined)
  assert.equal(shareOutboxPath(), join(dir, 'owner-outbox.jsonl'))
})

test('appendShare：十分钟内同一条视频同一句话不再追加', (t) => {  setup(t)
  const first = appendShare({ bvid: 'BV1xx411c7mD', title: '标题', say: '话', now: 1_700_000_000_000 })
  const again = appendShare({ bvid: 'BV1xx411c7mD', title: '标题', say: '话', now: 1_700_000_000_000 + 60_000 })
  assert.equal(again.duplicate, true)
  assert.equal(again.record.id, first.record.id)
  assert.equal(readShares().length, 1)
  // 过了十分钟她说第二遍，那是真的想说，要再进一次队列。
  appendShare({ bvid: 'BV1xx411c7mD', title: '标题', say: '话', now: 1_700_000_000_000 + 11 * 60_000 })
  assert.equal(readShares().length, 2)
})

test('readShares：文件不存在是空数组，坏行跳过但不吞掉好行', (t) => {
  setup(t)
  assert.deepEqual(readShares(), [])
  const file = shareOutboxPath()
  writeFileSync(file, [
    '{"id":"a","bvid":"BV1xx411c7mD","title":"好的"}',
    '这不是 JSON',
    '{"bvid":"BV1xx411c7mD"}',
    '',
    '{"id":"b","bvid":"BV2xx411c7mD"}',
    '',
  ].join('\n'))
  assert.deepEqual(readShares().map(r => r.id), ['a', 'b'])
})

test('deliveredIds：通道没写过就是空集，写了读得回来', (t) => {
  setup(t)
  assert.equal(deliveredIds().size, 0)
  writeFileSync(shareStatePath(), JSON.stringify({ ids: ['a', 'b'] }))
  assert.deepEqual([...deliveredIds()], ['a', 'b'])
  writeFileSync(shareStatePath(), '写坏了')
  assert.equal(deliveredIds().size, 0, '读坏了当没记过，不能因此打不开通道')
})

test('appendShare：队列压到上限内，最新的那条一定还在（只增不清会一直长）', (t) => {
  setup(t)
  const base = 1_700_000_000_000
  const total = OUTBOX_MAX_RECORDS + 5
  for (let i = 0; i < total; i++) {
    appendShare({ bvid: `BV1${String(i).padStart(9, '0')}`, title: `第${i}条`, say: 'x', now: base + i * 60_000 })
  }
  const records = readShares()
  assert.equal(records.length, OUTBOX_MAX_RECORDS, '只留上限那么多条')
  assert.equal(records.at(-1).title, `第${total - 1}条`, '最新的一条不能被压实删掉')
  assert.equal(records[0].title, `第${total - OUTBOX_MAX_RECORDS}条`, '丢的是最旧的那批')
  assert.equal(readFileSync(shareOutboxPath(), 'utf8').trim().split('\n').length, OUTBOX_MAX_RECORDS, '文件里也是一行一条')
})
