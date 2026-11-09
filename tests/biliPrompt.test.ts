import assert from 'node:assert/strict';
import test from 'node:test';
import { biliPrompt, shouldSkipWake, SKIP_FOCUS_LEFT_MIN } from '../src/bili/dailyBili.ts';

// biliPrompt 只读这几个字段，其余可选；用 any 避免为了一个纯文本函数造完整 options。
const options = { allowWrite: false, biliMjs: 'tools/bili.mjs', dailyMaxVideos: 5, wakeTime: '07:30', reviewTime: '23:00' } as any;
const now = new Date('2026-11-08T12:00:00Z');

test('提示词里不出现窗口、名额、额度、账本这些机器词', () => {
  const text = biliPrompt(now, options, 'Asia/Shanghai', { withinWindow: '20:00–24:00 第 1/1 次' }, {
    stateBlock: '【当下状态】\n这会儿还行，按平时说话。',
    focusLine: '（你上一次说要看书，还剩 20 分钟。）',
  });
  assert.doesNotMatch(text, /窗口/);
  assert.doesNotMatch(text, /名额/);
  assert.doesNotMatch(text, /额度/);
  assert.doesNotMatch(text, /账本/);
  assert.doesNotMatch(text, /第 \d+\/\d+ 次/);
  assert.doesNotMatch(text, /undefined/);
});

test('开场是随口一句，不是任务工单', () => {
  const text = biliPrompt(now, options, 'Asia/Shanghai', {});
  assert.match(text, /想起来就看一眼/);
  assert.match(text, /不想看就继续手上的事/);
  assert.doesNotMatch(text, /到点了/);
  assert.doesNotMatch(text, /按这个流程做/);
  assert.doesNotMatch(text, /^1\)/m);
  assert.doesNotMatch(text, /收工。$/);
});

test('操作命令留在备忘里，但不报条数上限，也明确不是任务清单', () => {
  const text = biliPrompt(now, options, 'Asia/Shanghai', {});
  assert.match(text, /操作备忘/);
  assert.match(text, /不是任务清单/);
  assert.match(text, /不用每条都发/);
  assert.match(text, /有感觉才写/);
  assert.match(text, /focus bilibili/);
  assert.match(text, /feed --json/);
  assert.match(text, /debrief --bvid/);
  assert.match(text, /act dyn/);
  assert.doesNotMatch(text, /挑 ≤\d+ 条/);
});

test('收工要求是「像跟朋友讲一样」，并给了正反例', () => {
  const text = biliPrompt(now, options, 'Asia/Shanghai', {});
  assert.match(text, /先说哪条视频（标题或 UP）/);
  assert.match(text, /像这样/);
  assert.match(text, /不要这样/);
  assert.match(text, /不用列 BV/);
});

test('被拦时只跳过，不要求贴回执', () => {
  const text = biliPrompt(now, options, 'Asia/Shanghai', {});
  assert.match(text, /发不出去就跳过/);
  assert.doesNotMatch(text, /把 act dyn 的返回原文贴给我/);
});

test('计划跳过时只给一句歇着，不提窗口与次数', () => {
  const text = biliPrompt(now, options, 'Asia/Shanghai', { action: 'skip', reason: '今天不想刷' });
  assert.match(text, /今天不想刷就歇着/);
  assert.doesNotMatch(text, /窗口/);
  assert.doesNotMatch(text, /第 \d+/);
});

test('有 ownerQQ 时用 share 把视频递过来，不再让她自己 POST', () => {
  const text = biliPrompt(now, { ...options, ownerQQ: '123456', napcatHttp: 'http://127.0.0.1:3000' }, 'Asia/Shanghai', {});
  assert.match(text, /share --bvid <BV>/);
  assert.match(text, /标题和 BV/);
  assert.match(text, /纯文字动态不用发我/);
  assert.doesNotMatch(text, /NapCat|send_private_msg/);
  assert.doesNotMatch(text, /把动态的 1-2 句核心内容/);
  // 0.8.25：分享有专门的路了，不再要求「说在这一轮最后一句」。
  assert.doesNotMatch(text, /说在这一轮最后一句/);
});

test('只看不发：看和发是两件事，不绑在一起', () => {
  const text = biliPrompt(now, options, 'Asia/Shanghai', {});
  assert.match(text, /只看不发也行/);
  assert.match(text, /发 B站动态和跟我分享是两件事/);
});

test('分享时要求先说清是哪条视频，不能只说“这个”', () => {
  const text = biliPrompt(now, options, 'Asia/Shanghai', {});
  assert.match(text, /先说哪条视频（标题或 UP）/);
  assert.match(text, /不要这样：「这个我也看了/);
});

test('shouldSkipWake：专注只剩几分钟就跳过，其余情况放行', () => {
  assert.equal(shouldSkipWake(null), null);
  assert.equal(shouldSkipWake({ activity: 'bilibili', remainMin: 20 }), null);
  assert.equal(shouldSkipWake({ activity: 'bilibili', remainMin: SKIP_FOCUS_LEFT_MIN }), '她的专注还剩 5 分钟');
  assert.equal(shouldSkipWake({ activity: 'bilibili', remainMin: 2 }), '她的专注还剩 2 分钟');
  assert.equal(shouldSkipWake({ activity: 'bilibili', expired: true, remainMin: 1 }), null);
  assert.equal(shouldSkipWake({ activity: 'bilibili', remainMin: Number.NaN }), null);
});
