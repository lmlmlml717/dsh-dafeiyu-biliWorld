import assert from 'node:assert/strict';
import test from 'node:test';
import { completePlan, makePlan } from '../tools/lib/night-plan.mjs';

const MINUTE = 60_000;
const at = (day, hour, minute = 0) => new Date(2026, 10, day, hour, minute, 0, 0).getTime();
const config = (wakes, start = '09:00', end = '23:00', minGapMin = 10) => ({
  windows: [{ start, end, wakes }], skipChance: 0, minGapMin,
});

test('the first wake lands in the first equal segment, not hours later', () => {
  const now = at(8, 9);
  const plan = makePlan(config(8), {}, now, () => 0.999);
  const end = at(8, 23);
  const band = (end - now - 7 * 10 * MINUTE) / 8;
  assert.equal(plan.done, undefined);
  assert.ok(plan.atMs >= now, 'never in the past');
  assert.ok(plan.atMs <= now + band + 1, `first wake within the first segment (${Math.round((plan.atMs - now) / MINUTE)} min)`);
  assert.match(plan.withinWindow, /第 1\/8 次$/);
});

test('eight wakes stay inside the window, keep minGap, and the ninth is done', () => {
  let state = {};
  let now = at(8, 9);
  const starts = [];
  for (let index = 0; index < 8; index += 1) {
    const plan = makePlan(config(8), state, now, () => 0.5);
    assert.equal(plan.done, undefined, `plan ${index + 1} exists`);
    assert.ok(plan.atMs >= now, 'monotonic');
    starts.push(plan.atMs);
    state = completePlan(plan, plan.atMs);
    now = plan.atMs;
  }
  for (let index = 1; index < starts.length; index += 1) {
    assert.ok(starts[index] - starts[index - 1] >= 10 * MINUTE, 'minGap respected');
    assert.ok(starts[index] - starts[index - 1] <= 180 * MINUTE, `gap ${index} stays near the equal share, not bunched`);
  }
  assert.ok(starts.at(-1) <= at(8, 23), 'the last one still fits before the window ends');
  const ninth = makePlan(config(8), state, now, () => 0.5);
  assert.equal(ninth.done, true, 'the ninth wake is cut off for today');
});

test('a window that cannot fit all wakes keeps what fits, then cuts the rest (tail-cut preserved)', () => {
  const cfg = config(5, '09:00', '11:00', 60);
  const first = makePlan(cfg, {}, at(8, 9), () => 0);
  assert.equal(first.done, undefined, 'still schedules one when it physically fits');
  assert.equal(first.atMs, at(8, 9));
  const second = makePlan(cfg, completePlan(first, first.atMs), first.atMs, () => 0);
  assert.equal(second.done, undefined, 'the second one still fits an hour later');
  assert.equal(second.atMs, at(8, 10));
  const done = makePlan(cfg, completePlan(second, second.atMs), second.atMs, () => 0);
  assert.equal(done.done, true, 'the remaining wakes are dropped for today, not补跑');
  assert.match(done.reason, /排不下/);
});

test('a skip plan still consumes the slot', () => {
  const cfg = { ...config(3), skipChance: 1 };
  const plan = makePlan(cfg, {}, at(8, 9), () => 0.5);
  assert.equal(plan.action, 'skip');
  const next = makePlan(cfg, completePlan(plan, plan.atMs), plan.atMs, () => 0.5);
  assert.match(next.withinWindow, /第 2\/3 次$/);
});

test('a cross-midnight window segments the remaining time up to the next day', () => {
  const now = at(8, 22, 30);
  const plan = makePlan(config(4, '22:00', '02:00'), {}, now, () => 0.999);
  const end = at(9, 2);
  const band = (end - now - 3 * 10 * MINUTE) / 4;
  assert.equal(plan.done, undefined);
  assert.equal(plan.window, '22:00–02:00');
  assert.ok(plan.atMs <= now + band + 1, 'first wake is inside the first quarter of the remaining window');
  assert.ok(plan.atMs < end);
});

test('a pending plan is reused byte for byte', () => {
  const plan = makePlan(config(8), {}, at(8, 9), () => 0.4);
  assert.deepEqual(makePlan(config(8), plan, at(8, 9) + 5 * MINUTE, () => 0.9), plan);
});
