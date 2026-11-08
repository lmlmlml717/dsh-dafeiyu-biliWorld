import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeCall, summarizeSince } from '../src/life/activity.ts';

const room = 'C:\\Users\\me\\.dsh\\worlds\\jingjing\\room';
const outside = (tool: string, args: unknown) => summarizeCall(tool, JSON.stringify(args), room).outside;
test('shell commands are always outside and summarized by their command', () => {
  assert.deepEqual(summarizeCall('pwsh', JSON.stringify({ command: 'Start-Process   steam://run/1' }), room), { summary: 'Start-Process steam://run/1', outside: true });
  assert.equal(outside('Bash', { command: 'ls' }), true);
  assert.equal(outside('PowerShell', { command: 'ls' }), true);
});
test('file tools are outside only when a path leaves the room', { skip: process.platform !== 'win32' }, () => {
  assert.equal(outside('write', { path: 'notes/plan.md', content: 'x' }), false);
  assert.equal(outside('write', { file_path: room + '\\a.md' }), false);
  assert.equal(outside('edit', { path: '../escape.md' }), true);
  assert.equal(outside('read', { paths: ['a.md', 'D:\\work\\b.md'] }), true);
  assert.equal(summarizeCall('read', JSON.stringify({ path: 'notes/plan.md' }), room).summary, 'notes/plan.md');
});
test('path boundaries: the room itself, case, dot-dot names, UNC', { skip: process.platform !== 'win32' }, () => {
  assert.equal(outside('read', { path: room }), false);
  assert.equal(outside('read', { path: room.toUpperCase() + '\\A.md' }), false);
  assert.equal(outside('read', { path: '..foo.md' }), false);
  assert.equal(outside('read', { path: '\\\\server\\share\\x' }), true);
});
test('nested and extra path keys are inspected', { skip: process.platform !== 'win32' }, () => {
  assert.equal(outside('edit', { operations: [{ path: 'D:\\x' }] }), true);
  assert.equal(outside('edit', { operations: [{ path: 'a.md' }] }), false);
  assert.equal(outside('glob', { root: 'D:\\work' }), true);
  assert.equal(outside('glob', { folder: 'D:\\work' }), true);
});
test('tools with a spoken form are summarised in words instead of JSON', () => {
  assert.deepEqual(summarizeCall('send_sticker', '{"action":"list"}', room), { summary: '发了个表情', outside: false });
  assert.deepEqual(summarizeCall('plan_next', '{"note":"写测试"}', room), { summary: '定了个闹钟', outside: false });
  assert.equal(summarizeCall('web_search', JSON.stringify({ queries: ['甲', '乙', '丙'] }), room).summary, '搜了 甲、乙');
  assert.equal(summarizeCall('read_image', JSON.stringify({ file_path: 'C:\\a\\b\\c.png' }), room).summary, '看了 c.png');
  assert.equal(summarizeCall('web_fetch', JSON.stringify({ url: 'https://www.pnas.org/doi/1' }), room).summary, '读了 www.pnas.org');
  // An unparsable URL still says something a reader can follow, rather than dumping the argument.
  assert.equal(summarizeCall('web_fetch', JSON.stringify({ url: 'not a url' }), room).summary, '读了一个网页');
});
test('a tool with neither a spoken form nor a path keeps the old clipped fallback', () => {
  assert.equal(summarizeCall('mystery_tool', 'x'.repeat(500), room).summary.length, 160);
  assert.deepEqual(summarizeCall('mystery_tool', '{"a":1}', room), { summary: '{"a":1}', outside: false });
});
test('clip does not split surrogate pairs', () => {
  const out = summarizeCall('pwsh', JSON.stringify({ command: 'x'.repeat(159) + '😀' + 'yyy' }), room).summary;
  assert.ok(out.endsWith('😀'));
  assert.doesNotMatch(out, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
});

const call = (time: string, tool: string, summary: string) => ({ time, sessionId: 's', callId: 'c', tool, summary, outside: false });
const NOW = new Date('2026-10-26T10:00:00Z');
test('the alarm says she did nothing when the window holds no calls', () => {
  assert.equal(summarizeSince([], '2026-10-26T09:00:00Z', NOW), '这段时间我没动过手。');
  // A call from before she set the alarm is not hers to answer for.
  assert.equal(summarizeSince([call('2026-10-26T08:00:00Z', 'read', 'a.md')], '2026-10-26T09:00:00Z', NOW), '这段时间我没动过手。');
});
test('the alarm counts her calls, names the tools and quotes the last thing she touched', () => {
  const records = [
    call('2026-10-26T09:10:00.000Z', 'pwsh', 'node --test'),
    call('2026-10-26T09:20:00.000Z', 'read', 'src/index.ts'),
    call('2026-10-26T09:30:00.000Z', 'edit', 'src/life/activity.ts'),
    // Recorded after the alarm rang: not part of what she did before it.
    call('2026-10-26T11:00:00.000Z', 'edit', 'too late'),
  ];
  assert.equal(summarizeSince(records, '2026-10-26T09:00:00Z', NOW), '这段时间我动了 3 次手（pwsh、read、edit），最后一次是：src/life/activity.ts。');
});
test('more than three kinds of tool are counted instead of listed', () => {
  const records = ['a', 'b', 'c', 'd'].map((tool, index) => call(`2026-10-26T09:0${index}:00.000Z`, tool, `x${index}`));
  assert.equal(summarizeSince(records, '2026-10-26T09:00:00Z', NOW), '这段时间我动了 4 次手（a、b、c 等 4 种），最后一次是：x3。');
});
test('the quoted summary stays short, so the alarm line does not become a log', () => {
  const long = '一'.repeat(100);
  const line = summarizeSince([call('2026-10-26T09:30:00.000Z', 'pwsh', long)], '2026-10-26T09:00:00Z', NOW);
  assert.ok(line.includes('一'.repeat(40) + '。'));
  assert.ok(!line.includes('一'.repeat(41)));
});
test('an unreadable setAt is silence rather than a made-up claim', () => {
  assert.equal(summarizeSince([call('2026-10-26T09:30:00.000Z', 'pwsh', 'x')], 'not a date', NOW), '');
});
