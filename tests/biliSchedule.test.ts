import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { biliNightConfig, createDailyBili, scheduleStillFits, MAX_WAKES_PER_DAY, MIN_GAP_MAX } from '../src/bili/dailyBili.ts';

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

test('快收工跳过的那次不算用掉一次唤醒（0.8.25）', async t => {
  const nightPlan = await import('../tools/lib/night-plan.mjs') as any;
  const dir = mkdtempSync(join(tmpdir(), 'bili-skip-'));
  const prevData = process.env.WORLD_BILI_DATA_DIR;
  const prevCfg = process.env.WORLD_BILI_CONFIG;
  process.env.WORLD_BILI_DATA_DIR = dir;
  process.env.WORLD_BILI_CONFIG = join(dir, 'bili.config.json');
  t.after(() => {
    if (prevData === undefined) delete process.env.WORLD_BILI_DATA_DIR; else process.env.WORLD_BILI_DATA_DIR = prevData;
    if (prevCfg === undefined) delete process.env.WORLD_BILI_CONFIG; else process.env.WORLD_BILI_CONFIG = prevCfg;
    rmSync(dir, { recursive: true, force: true });
  });
  writeFileSync(join(dir, 'bili.config.json'), JSON.stringify({ night: { wakesPerDay: 3, minGapMin: 1, skipChance: 0 } }));

  const now = Date.now();
  // 用真库造一条「今天还没兑现」的计划。窗口给 00:00–24:00，什么时候跑这个测试都成立。
  const nightCfg = { windows: [{ start: '00:00', end: '24:00', wakes: 3 }], skipChance: 0, minGapMin: 1, maxVideos: 3 };
  const plan = nightPlan.makePlan(nightCfg, {}, now);
  assert.equal(plan.action, 'wake', '前提：这是一条要叫醒她的计划');
  writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan));
  // 她正在刷 B 站、只剩两分钟：shouldSkipWake 命中，这次不该投递。
  writeFileSync(join(dir, 'focus.json'), JSON.stringify({ activity: 'bilibili', until: now + 2 * 60_000, setAt: now, min: 40, note: '' }));

  const steered: unknown[] = [];
  const daily = createDailyBili({
    home: async () => ({ steer: (message: unknown) => { steered.push(message); } }) as any,
    flush: async () => {},
    logger: { warn: () => {}, info: () => {} },
    timeZone: 'Asia/Shanghai',
    options: {
      enabled: () => true, dailyTime: '20:00', dailyMaxVideos: 3, napcatHttp: '', biliMjs: 'tools/bili.mjs',
      dataDir: dir, wakeTime: '00:00', reviewTime: '24:00', allowWrite: true,
    },
  });
  t.after(() => daily.stop());
  await daily.triggerNow();
  daily.stop();

  assert.deepEqual(steered, [], '快收工不该投递 prompt');
  const after = JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8'));
  assert.equal(after.wakes, 0, '跳过的那次不能被记成用掉——次数要留给后面');
});
