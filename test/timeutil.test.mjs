import test from 'node:test';
import assert from 'node:assert/strict';
import {
  durationToMs,
  fmtClock,
  MINUTE,
  parseNumber,
  parseTs,
  splitSlots,
} from '../scripts/lib/timeutil.mjs';

test('中文数字与时长解析', () => {
  assert.equal(parseNumber('四'), 4);
  assert.equal(parseNumber('两'), 2);
  assert.equal(parseNumber('十'), 10);
  assert.equal(parseNumber('20'), 20);
  assert.equal(durationToMs('半', '小时'), 30 * MINUTE);
  assert.equal(durationToMs('一', '小时'), 60 * MINUTE);
  assert.equal(durationToMs('30', '分钟'), 30 * MINUTE);
});

test('跨午夜时钟固定按 +08:00 展示，不受宿主时区影响', () => {
  const ts = parseTs('2026-08-02T00:00:00+08:00');
  assert.equal(fmtClock(ts), '00:00');
  const before = parseTs('2026-08-01T23:40:00+08:00');
  assert.equal(fmtClock(before), '23:40');
});

test('按候选边界切分时槽', () => {
  const from = parseTs('2026-08-02T00:00:00+08:00');
  const to = parseTs('2026-08-02T01:00:00+08:00');
  const boundary = parseTs('2026-08-02T00:30:00+08:00');
  const slots = splitSlots(from, to, [boundary]);
  assert.equal(slots.length, 2);
  assert.equal(slots[0].index, 1);
  assert.equal(slots[1].index, 2);
  assert.equal(slots[1].from, boundary);
});
