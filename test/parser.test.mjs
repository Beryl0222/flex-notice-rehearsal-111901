import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNotice, normalizeText } from '../scripts/lib/parser.mjs';

function parse(text, sentAt = '2026-08-01T23:40:00+08:00') {
  return parseNotice({ id: 'T', author: 'M1', sentAt, text });
}

test('相对发话时刻的偏移与时长：20 分钟后 + 一小时', () => {
  const p = parse('前湾 20 分钟后下调 4 单位，一小时；医疗类资源除外。两段一并接。');
  assert.equal(p.intents.length, 1);
  const i = p.intents[0];
  assert.equal(i.action, 'reduce');
  assert.equal(i.offsetMin, 20);
  assert.equal(i.durationMs, 60 * 60_000);
  assert.equal(i.quantity, 4);
  assert.equal(i.exclusion.category, '医疗');
  assert.equal(i.acceptance, 'group');
  assert.equal(p.unusedClauses.length, 0);
});

test('“分钟后”是发话偏移，不得误当时长', () => {
  const p = parse('前湾 20 分钟后下调 4 单位。');
  const i = p.intents[0];
  assert.equal(i.offsetMin, 20);
  assert.equal(i.durationMs, null);
});

test('申请语义优先于其中的“下调”动作词', () => {
  const p = parse('申请前湾西 00:00 到 00:30 下调 3 单位。', '2026-08-02T00:20:00+08:00');
  assert.equal(p.intents.length, 1);
  assert.equal(p.intents[0].action, 'request');
  assert.equal(p.intents[0].quantity, 3);
});

test('“等值班确认”并入准备接受，不另起确认意图', () => {
  const p = parse('前湾东 A1、A2 我方准备接受，等值班确认。');
  assert.equal(p.intents.length, 1);
  assert.equal(p.intents[0].action, 'request');
  assert.deepEqual(p.intents[0].offerIds, ['A1', 'A2']);
});

test('单点时刻 00:45 起 + 半小时时长', () => {
  const p = parse('前湾、后湾下调 2 单位，时长半小时，00:45 起；可分段独立接受。',
    '2026-08-02T00:42:00+08:00');
  const i = p.intents[0];
  assert.equal(i.acceptance, 'independent');
  assert.equal(i.resolvedClockRange.to - i.resolvedClockRange.from, 30 * 60_000);
  assert.deepEqual(i.scopeWords, ['前湾', '后湾']);
});

test('“改为 X”标记为绝对量更正', () => {
  const p = parse('更正：A2 主动减少 1 单位，00:30 到 01:00 的量改为 1。',
    '2026-08-02T00:00:00+08:00');
  const i = p.intents[0];
  assert.equal(i.correction, true);
  assert.equal(i.absoluteQuantity, true);
  assert.equal(i.quantity, 1);
});

test('裁定整句归为一个确认（裁决）意图', () => {
  const p = parse('值班裁定：N6 的解释一成立，按前湾东第二段归还办理。',
    '2026-08-02T00:25:00+08:00');
  assert.equal(p.intents.length, 1);
  assert.equal(p.intents[0].action, 'confirm');
  assert.equal(p.intents[0].ruling, true);
  assert.deepEqual(p.intents[0].noticeRefs, ['N6']);
});

test('段序号与引用编号可回溯到原小句', () => {
  const p = parse('前一条第二段恢复，这次只说前站。', '2026-08-02T00:10:00+08:00');
  const i = p.intents[0];
  assert.equal(i.action, 'restore');
  assert.equal(i.segmentIndex, 2);
  assert.ok(i.clauseRefs.some((c) => c.text.includes('前站')));
});

test('规范化文本去除标点空白，用于补发去重', () => {
  const a = normalizeText('前湾 20 分钟后下调。');
  const b = normalizeText('前湾20分钟后下调');
  assert.equal(a, b);
});
