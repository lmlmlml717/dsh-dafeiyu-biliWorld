// 分享队列的宿主侧视图：面板看到的待发/已发、重发一条、清掉已发的。
//
// 这条线的数据是工具链写的（tools/lib/owner-share.mjs），这里只读 + 两个小动作，所以测试直接用临时目录造文件。
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearDeliveredShares, readPush, readShares, requeueShare } from '../src/bili/shares.ts';

function setup(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'bili-shares-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'bili'), { recursive: true });
  const outbox = join(dir, 'bili', 'owner-outbox.jsonl');
  const state = join(dir, 'bili', 'owner-outbox.jsonl.sent.json');
  const push = (record: Record<string, unknown>) => writeFileSync(outbox, JSON.stringify(record) + '\n', { flag: 'a' });
  return { dir, outbox, state, push };
}

test('队列不存在时是一份空视图（卡片显示「还没有」，不是报错）', (t) => {
  const { dir } = setup(t);
  assert.deepEqual(readShares(dir), { pending: 0, sent: 0, records: [], push: true });
});

test('待发/已发分开算，记录新的在前，已发的带 delivered 标记', (t) => {
  const { dir, state, push } = setup(t);
  push({ id: 'a', at: '2026-11-09T12:00:00.000Z', bvid: 'BV1xx411c7mD', title: '烤鸡', say: '笑死' });
  push({ id: 'b', at: '2026-11-09T13:00:00.000Z', bvid: 'BV2xx411c7mD', title: '第二条' });
  writeFileSync(state, JSON.stringify({ ids: ['a'] }));

  const view = readShares(dir);
  assert.equal(view.sent, 1);
  assert.equal(view.pending, 1);
  assert.deepEqual(view.records.map(r => r.id), ['b', 'a'], '新的在前');
  assert.deepEqual(view.records.map(r => r.delivered), [false, true]);
});

test('readPush：没配就是开；写了 false 就是停；写坏了也当开（别悄悄把分享关掉）', (t) => {
  const { dir } = setup(t);
  assert.equal(readPush(dir), true, '没有配置文件');
  writeFileSync(join(dir, 'bili.config.json'), JSON.stringify({ share: { push: false } }));
  assert.equal(readPush(dir), false);
  writeFileSync(join(dir, 'bili.config.json'), '{ 这不是 JSON');
  assert.equal(readPush(dir), true);
});

test('重发：追加一条新 id 的副本，原记录不动', (t) => {
  const { dir, outbox, push } = setup(t);
  push({ id: 'a', bvid: 'BV1xx411c7mD', title: '烤鸡', say: '笑死' });

  assert.equal(requeueShare(dir, 'a', 1_700_000_000_000), undefined);
  const lines = readFileSync(outbox, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(lines.length, 2, '原记录还在，新的追加在后面');
  assert.equal(lines[0].id, 'a');
  assert.notEqual(lines[1].id, 'a', '新 id，通道才会当成新的一条发');
  assert.equal(lines[1].requeuedFrom, 'a');
  assert.equal(lines[1].bvid, 'BV1xx411c7mD');
  assert.equal(lines[1].say, '笑死');
});

test('重发一条不存在的记录：返回原因，不动文件', (t) => {
  const { dir, outbox, push } = setup(t);
  push({ id: 'a', bvid: 'BV1xx411c7mD' });
  const before = readFileSync(outbox, 'utf8');
  assert.match(requeueShare(dir, 'nope')!, /没有这条/);
  assert.equal(readFileSync(outbox, 'utf8'), before);
});

test('清空：只删已经发出去的，待发的永远留着', (t) => {
  const { dir, outbox, state, push } = setup(t);
  push({ id: 'a', bvid: 'BV1xx411c7mD' });
  push({ id: 'b', bvid: 'BV2xx411c7mD' });
  writeFileSync(state, JSON.stringify({ ids: ['a'] }));

  assert.equal(clearDeliveredShares(dir), 1);
  const left = readFileSync(outbox, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(left.map(r => r.id), ['b'], '没发出去的那条还在');
  // 再清一次没有可删的了。
  assert.equal(clearDeliveredShares(dir), 0);
});
