import assert from 'node:assert/strict';
import test from 'node:test';
import { formatTimeContext } from '../src/timeContext.ts';

test('request time is exactly two lines in the configured zone', () => {
  assert.equal(formatTimeContext(new Date('2026-10-23T12:30:00Z'), 'Asia/Seoul'), '当前时间：2026-10-23T21:30:00+09:00\n时区：Asia/Seoul');
});
test('UTC, fractional offsets and daylight saving follow the named zone', () => {
  for (const [input, zone, expected] of [
    ['2026-10-23T12:30:00Z', 'UTC', '2026-10-23T12:30:00+00:00'],
    ['2026-10-23T12:30:00Z', 'Asia/Kathmandu', '2026-10-23T18:15:00+05:45'],
    ['2026-01-23T12:30:00Z', 'America/New_York', '2026-01-23T07:30:00-05:00'],
    ['2026-07-23T12:30:00Z', 'America/New_York', '2026-07-23T08:30:00-04:00'],
  ]) assert.equal(formatTimeContext(new Date(input), zone), `当前时间：${expected}\n时区：${zone}`);
});
