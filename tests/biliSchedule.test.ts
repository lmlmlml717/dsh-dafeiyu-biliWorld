import assert from 'node:assert/strict';
import test from 'node:test';
import { biliNightConfig, scheduleStillFits, MAX_WAKES_PER_DAY, MIN_GAP_MAX } from '../src/bili/dailyBili.ts';

test('每天次数与最小间隔从 bili.config.json 读，并按允许范围夹紧', () => {
  const base = (night: Record<string, unknown>) => biliNightConfig({ night }, '09:00', '23:00');

  assert.equal(base({}).windows[0]!.wakes, 1, '默认每天 1 次');
  assert.equal(base({ wakesPerDay: 3 }).windows[0]!.wakes, 3);
  assert.equal(base({ wakesPerDay: '6' }).windows[0]!.wakes, 6, '字符串也能读');
  assert.equal(base({ wakesPerDay: 99 }).windows[0]!.wakes, MAX_WAKES_PER_DAY, '超过 12 被夹回 12');
  assert.equal(base({ wakesPerDay: 0 }).windows[0]!.wakes, 1, '0 夹回 1');
  assert.equal(base({ wakesPerDay: -5 }).windows[0]!.wakes, 1);
  assert.equal(base({ wakesPerDay: 'abc' }).windows[0]!.wakes, 1, '非法值回默认');

  assert.equal(base({}).minGapMin, 10, '默认间隔 10 分钟');
  assert.equal(base({ minGapMin: 30 }).minGapMin, 30);
  assert.equal(base({ minGapMin: 9999 }).minGapMin, MIN_GAP_MAX, '超过上限夹回 240');
  assert.equal(base({ minGapMin: 0 }).minGapMin, 1);

  assert.equal(base({ maxVideos: 200 }).maxVideos, 200, '候选池数量保持原样，不夹');
});

test('窗口来自 world 主框架的起床/回顾时间，缺省时回落到 20:00–24:00', () => {
  assert.deepEqual(biliNightConfig({}, '09:00', '23:00').windows, [{ start: '09:00', end: '23:00', wakes: 1 }]);
  assert.deepEqual(biliNightConfig({}, '', '').windows, [{ start: '20:00', end: '24:00', wakes: 1 }]);
});

test('已排好的计划只在“窗口没变、每天次数没变”时沿用', () => {
  const nightPlan = { isPending: () => true, occurrences: () => [{ key: '2026-11-08|09:00-23:00' }] };
  const cfg = biliNightConfig({ night: { wakesPerDay: 3 } }, '09:00', '23:00');
  const plan = { wakesPerDay: 3, windowKey: '2026-11-08|09:00-23:00' };

  assert.equal(scheduleStillFits(plan, cfg, 0, nightPlan), true);
  assert.equal(scheduleStillFits({ ...plan, wakesPerDay: 2 }, cfg, 0, nightPlan), false, '次数变了要重排');
  assert.equal(scheduleStillFits({ ...plan, windowKey: '旧窗口' }, cfg, 0, nightPlan), false, '窗口变了要重排');
  assert.equal(scheduleStillFits(null, cfg, 0, nightPlan), false, '没有计划');
  assert.equal(scheduleStillFits(plan, cfg, 0, { isPending: () => false, occurrences: () => [{ key: plan.windowKey }] }), false, '已触发/过期的计划不能沿用');
  assert.equal(scheduleStillFits(plan, cfg, 0, {}), false, '工具链缺失时保守重排');
});
