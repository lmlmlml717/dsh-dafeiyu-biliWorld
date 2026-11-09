// 「想给你看这条」这条线的护栏：队列文件自己写、通道换成假的，跑的是真的轮询与去重。
//
// 这条线容易坏在三个地方：重启后重发（id 记账）、发失败后不动（重试）、坏行让整条线停摆。
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createShareOutbox, formatShareText, parseShares, type ShareRecord } from '../src/ecosystem/qq-native/share.ts';

const quiet = { warn: () => {}, info: () => {} };

function setup(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'qq-share-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, file: join(dir, 'owner-outbox.jsonl'), stateFile: join(dir, 'owner-outbox.jsonl.sent.json') };
}

/** 往队列里追一条，返回它（id 自己定，测试要看得到）。 */
function push(file: string, record: Partial<ShareRecord> & { id: string }) {
  writeFileSync(file, JSON.stringify({ bvid: '', title: '', say: '', ...record }) + '\n', { flag: 'a' });
  return record;
}

test('formatShareText：标题、BV、话各一行，不留空行；空记录返回空串', () => {
  assert.equal(
    formatShareText({ id: 'a', bvid: 'BV1xx411c7mD', title: '烤鸡', say: '笑死' }),
    '《烤鸡》\nBV1xx411c7mD\n笑死',
  );
  // 主人只要 BV，不要长链接。
  assert.doesNotMatch(formatShareText({ id: 'a', bvid: 'BV1xx411c7mD', title: 'T', say: 'S' }), /https?:\/\//);
  // 没有 bvid 的老记录才退回 url，别让那条发不出去。
  assert.equal(formatShareText({ id: 'a', url: 'https://example.com/x' }), 'https://example.com/x');
  // 空行会被 QQ 通道拆成两条消息，一次分享变成刷屏。
  assert.doesNotMatch(formatShareText({ id: 'a', bvid: 'BV1xx411c7mD', title: 'T', say: 'S' }), /\n\n/);
  assert.equal(formatShareText({ id: 'a' }), '');
});

test('parseShares：坏行跳过，没有 id 或没有视频的行也跳过', () => {
  const raw = [
    '{"id":"a","bvid":"BV1xx411c7mD"}',
    '不是 JSON',
    '{"bvid":"BV1xx411c7mD"}',
    '{"id":"b","title":"只有标题"}',
    '',
    '{"id":"c","url":"https://example.com/x"}',
  ].join('\n');
  assert.deepEqual(parseShares(raw).map(record => record.id), ['a', 'c']);
});

test('队列里有一条，就发一条；再轮询一次不重发', async t => {
  const { file } = setup(t);
  const sent: string[] = [];
  push(file, { id: 'a', bvid: 'BV1xx411c7mD', title: '烤鸡', say: '笑死' });
  const box = createShareOutbox({ file, send: async text => { sent.push(text); }, logger: quiet });

  await box.flush();
  assert.deepEqual(sent, ['《烤鸡》\nBV1xx411c7mD\n笑死']);
  assert.equal(box.pending(), 0);

  await box.flush();
  assert.equal(sent.length, 1, '同一个 id 不该再发一遍');
  assert.equal(box.sentTotal(), 1);
});

test('记账写在 .sent.json 里：换一个实例（重启/重载）也不会重发', async t => {
  const { file, stateFile } = setup(t);
  const sent: string[] = [];
  push(file, { id: 'a', bvid: 'BV1xx411c7mD', title: '烤鸡' });
  await createShareOutbox({ file, stateFile, send: async text => { sent.push(text); }, logger: quiet }).flush();
  assert.equal(sent.length, 1);
  assert.deepEqual(JSON.parse(readFileSync(stateFile, 'utf8')).ids, ['a']);

  await createShareOutbox({ file, stateFile, send: async text => { sent.push(text); }, logger: quiet }).flush();
  assert.equal(sent.length, 1, '重启后同一条不该再发');
});

test('这次没发出去就留在原地，下一轮接着试', async t => {
  const { file } = setup(t);
  const sent: string[] = [];
  let attempts = 0;
  push(file, { id: 'a', bvid: 'BV1xx411c7mD', title: '烤鸡' });
  const box = createShareOutbox({
    file, logger: quiet,
    send: async text => { attempts += 1; if (attempts < 3) throw new Error('通道没连上'); sent.push(text); },
  });

  await box.flush();
  assert.equal(attempts, 1);
  assert.equal(box.pending(), 1, '没发出去的还欠着');
  await box.flush();
  assert.equal(attempts, 2);
  assert.equal(box.pending(), 1);
  await box.flush();
  assert.equal(attempts, 3, '第三次接通了');
  assert.equal(box.pending(), 0);
  assert.equal(sent.length, 1);
});

test('试满次数就放弃：记进状态，重启也不再试', async t => {
  const { file, stateFile } = setup(t);
  const attempted: string[] = [];
  const failing = async (_text: string, record: ShareRecord) => { attempted.push(record.id); throw new Error('还是不通'); };
  push(file, { id: 'b', bvid: 'BV2xx411c7mD', title: '没戏' });
  const first = createShareOutbox({ file, stateFile, maxTries: 2, logger: quiet, send: failing });
  await first.flush();
  await first.flush();
  assert.deepEqual(attempted, ['b', 'b'], '试满 maxTries 就停');

  // 重启后再来一轮：放弃过的那条不该出现在队列里被重试。
  push(file, { id: 'c', bvid: 'BV3xx411c7mD', title: '后来的' });
  const second = createShareOutbox({ file, stateFile, maxTries: 2, logger: quiet, send: failing });
  await second.flush();
  assert.deepEqual(attempted, ['b', 'b', 'c'], '只有新进来的那条被试了一次');
});

test('一条发不出去，后面的先不发（通道不通时别把队全打乱）', async t => {
  const { file } = setup(t);
  const sent: string[] = [];
  push(file, { id: 'a', bvid: 'BV1xx411c7mD', title: '第一条' });
  push(file, { id: 'b', bvid: 'BV2xx411c7mD', title: '第二条' });
  const box = createShareOutbox({ file, logger: quiet, send: async text => { if (text.includes('第一条')) throw new Error('不通'); sent.push(text); } });
  await box.flush();
  assert.deepEqual(sent, [], '第一条不通，第二条这轮不该抢跑');
  assert.equal(box.pending(), 2);
});

test('ready 为假时只是等着：不消耗重试次数，也不会被放弃', async t => {
  const { file } = setup(t);
  const sent: string[] = [];
  let online = false;
  // maxTries=1：只要有一次「算作失败」，这条就会被放弃——正好用来证明 ready 不算失败。
  const box = createShareOutbox({ file, maxTries: 1, logger: quiet, ready: () => online, send: async text => { sent.push(text); } });
  push(file, { id: 'a', bvid: 'BV1xx411c7mD', title: '烤鸡' });

  await box.flush(); await box.flush(); await box.flush();
  assert.deepEqual(sent, [], '通道没连上时不发');
  assert.equal(box.pending(), 1, '还在队列里等着');

  online = true;
  await box.flush();
  assert.deepEqual(sent, ['《烤鸡》\nBV1xx411c7mD'], '一连上就发出来');
  assert.equal(box.pending(), 0);
});
