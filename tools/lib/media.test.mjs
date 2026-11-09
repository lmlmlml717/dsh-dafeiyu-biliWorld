// media.mjs 的纯函数测试：不联网、不依赖 ffmpeg。
// 这些函数决定 debrief 弹幕那一路"报什么"和抽帧"取哪几秒"，出错会直接让材料失真。
import assert from 'node:assert/strict'
import test from 'node:test'
import { fmtClock, parseDanmakuXml, pickFrameTimes, summarizeDanmaku } from './media.mjs'

test('fmtClock：秒压成 mm:ss，负数与小数都兜住', () => {
  assert.equal(fmtClock(0), '00:00')
  assert.equal(fmtClock(75.9), '01:15')
  assert.equal(fmtClock(-3), '00:00')
})

test('parseDanmakuXml：取 p 的第一段时间与正文，并解 XML 实体', () => {
  const xml = '<i><d p="12.5,1,25,16777215,0,0,0,0">好听&amp;好看</d><d p="abc,1">坏时间</d><d p="30,1">  </d></i>'
  const list = parseDanmakuXml(xml)
  assert.deepEqual(list, [{ t: 12.5, text: '好听&好看' }])
})

test('summarizeDanmaku：剔除刷屏波后按桶取峰值，峰值只算有效条数', () => {
  const spam = Array.from({ length: 40 }, (_, i) => ({ t: i, text: '前方高能' }))
  const real = Array.from({ length: 8 }, (_, i) => ({ t: i + 1, text: `真的好看${i}` }))
  const later = [{ t: 65, text: '这段笑死' }, { t: 66, text: '这段笑死' }]
  const s = summarizeDanmaku([...spam, ...real, ...later], { bucket: 30, top: 3 })
  assert.equal(s.total, 50)
  assert.equal(s.spam.length, 1)
  assert.ok(s.spamHits >= 40)
  // 峰值按有效条数排序：带 8 条有效弹幕的第一桶应当排在最前，刷屏不算数
  assert.equal(s.peaks[0].real, 8)
  assert.equal(s.peaks[0].from, 0)
  // 第三桶的两条重复弹幕会各自计数一次，不会被当成刷屏（<20 条）
  assert.ok(s.topAll.some(x => x.text === '这段笑死'))
})

test('pickFrameTimes：有变化点时吸附到 ±半格内最近的变化点', () => {
  const r = pickFrameTimes({ duration: 90, count: 9, sceneTimes: [5.1, 15.2, 26, 34, 45, 54, 65, 74, 85] })
  assert.equal(r.times.length, 9)
  assert.equal(r.snapped, 9)
  assert.ok(Math.abs(r.times[0] - 5.1) < 0.01, '第一帧吸附到最近的变化点')
  assert.match(r.how, /吸附画面变化点/)
})

test('pickFrameTimes：没有变化点就退回纯等间隔，并说明每帧间隔', () => {
  const r = pickFrameTimes({ duration: 90, count: 9, sceneTimes: [] })
  assert.equal(r.snapped, 0)
  assert.match(r.how, /等间隔/)
  assert.ok(r.times[0] > 0 && r.times[8] < 90)
})
