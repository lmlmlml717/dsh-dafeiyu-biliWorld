import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { exampleTime, MESSAGE_KEYS, parseSections, readAlarmMessages } from '../src/life/messages.ts';
import { resolveAlarmTime, wakeText } from '../src/life/alarm.ts';
import { alarmDescriptions, lifeTools } from '../src/life/tools.ts';
import type { Alarm } from '../src/life/types.ts';

const now = new Date('2026-10-23T12:00:00.000Z');
const plan: Alarm = { at: '2026-10-23T12:00:00.000Z', note: '看完那集', setAt: '2026-10-23T11:00:00.000Z', source: 'plan' };
async function tempDir(t: { after(fn: () => unknown): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-alarm-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir;
}

test('the shipped alarm template has every section', () => {
  const { sections, error } = readAlarmMessages(undefined);
  assert.equal(error, undefined);
  for (const key of MESSAGE_KEYS) assert.ok(sections[key].length > 0, key);
  assert.ok(!sections['闹钟响了'].includes('【我的时间】'), 'the mark is the plugin\'s, not the template\'s');
});
test('sections are split on ## headings; text before the first heading is ignored', () => {
  const sections = parseSections('<!-- 说明 -->\r\n## 甲\r\n第一行\r\n\r\n第二行\r\n## 乙\r\n\r\n## 丙  \r\n内容');
  assert.deepEqual([...sections], [['甲', '第一行\n\n第二行'], ['乙', ''], ['丙', '内容']]);
});
test('a world alarm.md replaces sections one by one; an unreadable one falls back with a reason', async t => {
  const dir = await tempDir(t);
  const file = join(dir, 'alarm.md');
  await writeFile(file, '## 闹钟响了\n叮！{{time}} 到啦{{#note}}：{{note}}{{/note}}\n## 结尾提醒\n');
  const own = readAlarmMessages(file);
  assert.equal(wakeText(plan, now, 'Asia/Seoul', '09:00', own), '【我的时间】叮！2026-10-23T21:00:00+09:00 到啦：看完那集', 'an empty tail section drops the tail');
  assert.match(wakeText({ ...plan, source: 'fallback', note: '' }, now, 'UTC', '09:00', own), /^【我的时间】早上了，新的一天。我上次没说接下来做什么，就按平常的时间起来。$/, 'sections it leaves out keep the shipped wording; its empty tail applies to every alarm');
  await rm(file); await mkdir(file);
  const broken = readAlarmMessages(file);
  assert.match(broken.error!, /闹钟模板 .* 读不了，先用默认的/);
  assert.match(wakeText(plan, now, 'UTC', '09:00', broken), /^【我的时间】2026-10-23T12:00:00\+00:00 到了，这是我说好做到的时间/);
});
test('templates can use her names, and her note is never read as a template', async t => {
  const file = join(await tempDir(t), 'alarm.md');
  await writeFile(file, '## 闹钟响了\n{{name}}，起来啦，{{partner}}在等你。{{note}}\n## 结尾提醒\n');
  const text = wakeText({ ...plan, note: '{{name}}' }, now, 'UTC', '09:00', readAlarmMessages(file), { name: '小鱼', partner: '阿明' });
  assert.equal(text, '【我的时间】小鱼，起来啦，阿明在等你。{{name}}');
});
test('the example time carries the configured zone\'s offset, in descriptions and errors alike', () => {
  assert.equal(exampleTime('Asia/Seoul'), '2026-10-23T21:00:00+09:00');
  assert.equal(exampleTime('America/New_York'), '2026-10-23T21:00:00-04:00');
  assert.equal(exampleTime('UTC'), '2026-10-23T21:00:00+00:00');
  assert.throws(() => resolveAlarmTime({ at: '2026-10-23T22:00:00' }, now, 'America/New_York'), /例如 2026-10-23T21:00:00-04:00/);
  const descriptions = alarmDescriptions(readAlarmMessages(undefined), { example: exampleTime('Europe/Berlin'), fallbackWakeTime: '07:30' });
  assert.match(descriptions.plan, /如 2026-10-23T21:00:00\+02:00/); assert.doesNotMatch(descriptions.plan, /想睡觉/);
  assert.match(descriptions.cancel, /早上 07:30/);
});
test('check_alarm and cancel_alarm are offered when the host can answer them, with the template\'s descriptions', async () => {
  const notifier = { toast: async () => {}, outlets: [] };
  assert.deepEqual(lifeTools({ planNext: () => '', notifier }).map(tool => tool.name), ['plan_next', 'reach_out']);
  const tools = lifeTools({ planNext: () => '', checkAlarm: () => 'CHECK', cancelAlarm: () => 'CANCEL', notifier, descriptions: { plan: 'P', check: 'C', cancel: 'X' } });
  assert.deepEqual(tools.map(tool => [tool.name, tool.description]), [['plan_next', 'P'], ['reach_out', tools[1]!.description], ['check_alarm', 'C'], ['cancel_alarm', 'X']]);
  const ctx = {} as never;
  assert.equal(await tools[2]!.execute({}, ctx), 'CHECK'); assert.equal(await tools[3]!.execute({}, ctx), 'CANCEL');
});
