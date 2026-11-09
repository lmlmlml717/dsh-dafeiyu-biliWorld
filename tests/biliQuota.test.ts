// 额度页与闸门必须读同一段配置（0.9.0）：点赞/投币/弹幕在 bilibili.react / bilibili.danmaku 下。
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getBiliQuota } from '../src/bili/quota.ts';

function setup(t: { after(fn: () => void): void }, cfg: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'bili-quota-'));
  const prevData = process.env.WORLD_BILI_DATA_DIR;
  const prevCfg = process.env.WORLD_BILI_CONFIG;
  process.env.WORLD_BILI_DATA_DIR = join(dir, 'bili');
  process.env.WORLD_BILI_CONFIG = join(dir, 'bili.config.json');
  mkdirSync(process.env.WORLD_BILI_DATA_DIR, { recursive: true });
  writeFileSync(process.env.WORLD_BILI_CONFIG, JSON.stringify(cfg));
  t.after(() => {
    if (prevData === undefined) delete process.env.WORLD_BILI_DATA_DIR; else process.env.WORLD_BILI_DATA_DIR = prevData;
    if (prevCfg === undefined) delete process.env.WORLD_BILI_CONFIG; else process.env.WORLD_BILI_CONFIG = prevCfg;
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('点赞/投币/弹幕的上限读 react / danmaku，和 bili-write 的闸门是同一段', (t) => {
  const dir = setup(t, {
    bilibili: {
      react: { likeDaily: 3, coinDaily: 2 },
      danmaku: { dailyMax: 7 },
      dynamic: { pureDailyMax: 4, shareDailyMax: 6 },
    },
  });
  const q = getBiliQuota();
  assert.equal(q.limits.like, 3);
  assert.equal(q.limits.coin, 2);
  assert.equal(q.limits.danmaku, 7);
  assert.equal(q.limits.dyn_pure, 4);
  assert.equal(q.limits.dyn_share, 6, '转发上限走 shareDailyMax');
  assert.ok(dir);
});

test('没配就用兜底值（10 / 1 / 5 / 2），不会变成 undefined', (t) => {
  setup(t, {});
  const q = getBiliQuota();
  assert.deepEqual(q.limits, { dyn_pure: 2, dyn_share: 3, like: 10, coin: 1, danmaku: 5 });
});
