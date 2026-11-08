import assert from 'node:assert/strict';
import test from 'node:test';
import { isPeak, stepCost } from '../src/life/pricing.ts';

test('peak hours are Beijing weekday 9-12 and 14-18; weekends and statutory holidays are off-peak all day', () => {
  assert.equal(isPeak(new Date('2026-10-23T02:00:00Z')), true, 'Friday 10:00 Beijing');
  assert.equal(isPeak(new Date('2026-10-23T04:30:00Z')), false, 'Friday 12:30 Beijing');
  assert.equal(isPeak(new Date('2026-10-23T07:00:00Z')), true, 'Friday 15:00 Beijing');
  assert.equal(isPeak(new Date('2026-10-23T10:00:00Z')), false, 'Friday 18:00 Beijing');
  assert.equal(isPeak(new Date('2026-10-24T02:00:00Z')), false, 'Saturday');
  assert.equal(isPeak(new Date('2026-10-05T02:00:00Z')), false, 'National Day holiday, a Monday');
});
test('a step costs its cache hits, other input and output at the model\'s price; unknown models are priced as Flash', () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000 };
  const offPeak = new Date('2026-10-24T02:00:00Z'); const peak = new Date('2026-10-23T02:00:00Z');
  assert.equal(stepCost(usage, 'deepseek-flash', offPeak), 0.02 + 1 + 4);
  assert.equal(stepCost(usage, 'deepseek-flash', peak), 0.04 + 2 + 8);
  assert.equal(stepCost(usage, 'deepseek-v4-pro', offPeak), 0.15 + 4.5 + 13.5);
  assert.equal(stepCost(usage, 'some-other-model', offPeak), 0.02 + 1 + 4);
  assert.equal(stepCost({ inputTokens: 0, outputTokens: 0 }, 'deepseek-flash', peak), 0);
});
