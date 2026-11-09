// act.mjs 的回归测试：干跑不能占 session 名额（0.8.24 修）。
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from './act.mjs';

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'bili-act-'));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.WORLD_BILI_DATA_DIR;
    process.exitCode = 0;
  });
  process.env.WORLD_BILI_DATA_DIR = dir;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'session.json'), JSON.stringify({
    version: 2,
    window: { start: '00:00', end: '23:59' },
    target: { watch: 5, pure: 5 },
    counts: { watch: 0, pure: 0, share: 0 },
    daily: { max: 0, today: 0, remaining: null },
    resetAtMs: Date.now(),
  }), 'utf8');
  return dir;
}

test('干跑的纯动态不占 session 名额', async t => {
  const dir = setup(t);
  await run(['dyn', '--text', '今天没什么事']);
  const state = JSON.parse(readFileSync(join(dir, 'session.json'), 'utf8'));
  assert.equal(state.counts.pure, 0, '干跑只是预览，不该消费名额');
});
