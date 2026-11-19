import test from 'node:test';
import assert from 'node:assert/strict';
import { readInputs } from '../scripts/inspect.mjs';
import { RehearsalEngine } from '../scripts/lib/engine.mjs';
import { Ledger } from '../scripts/lib/ledger.mjs';
import { ResourceRegistry } from '../scripts/lib/resources.mjs';
import { parseTs } from '../scripts/lib/timeutil.mjs';

const from = parseTs('2026-08-02T00:00:00+08:00');
const to = parseTs('2026-08-02T00:30:00+08:00');

test('容量占用与释放：自由容量随 hold/release 变化且可回溯来源', () => {
  const registry = new ResourceRegistry([
    { id: 'R1', site: '前湾东', aliases: [], category: '商用', capacity: 5 },
  ]);
  const ledger = new Ledger(registry);
  assert.equal(ledger.feasible('R1', from, to, 5), true);
  ledger.hold('hold:A1', 'R1', from, to, 4, { at: from });
  assert.equal(ledger.feasible('R1', from, to, 2), false);
  assert.deepEqual(ledger.blockers('R1', from, to, 2)[0].holders.map((h) => h.holdId), ['hold:A1']);
  const released = ledger.release('hold:A1', { at: to });
  assert.equal(released[0].qty, 4);
  assert.equal(ledger.feasible('R1', from, to, 5), true);
});

test('超容量记账被拒绝，不会产生半笔占用', () => {
  const registry = new ResourceRegistry([
    { id: 'R1', site: '前湾东', aliases: [], category: '商用', capacity: 3 },
  ]);
  const ledger = new Ledger(registry);
  assert.throws(() => ledger.hold('hold:X', 'R1', from, to, 4, { at: from }));
  assert.equal(ledger.feasible('R1', from, to, 3), true);
});

test('reconstructAt 按事件流重建历史时点占用', () => {
  const registry = new ResourceRegistry([
    { id: 'R1', site: '前湾东', aliases: [], category: '商用', capacity: 5 },
  ]);
  const ledger = new Ledger(registry);
  const t1 = parseTs('2026-08-02T00:05:00+08:00');
  const t2 = parseTs('2026-08-02T00:35:00+08:00');
  ledger.hold('hold:A1', 'R1', from, to, 4, { at: t1 });
  ledger.release('hold:A1', { at: t2 });
  ledger.hold('hold:A3', 'R1', from, to, 2, { at: t2 });
  const atT1 = ledger.reconstructAt(parseTs('2026-08-02T00:10:00+08:00'));
  assert.equal(atT1[0].occupied, 4);
  const atEnd = ledger.reconstructAt(parseTs('2026-08-02T00:40:00+08:00'));
  assert.equal(atEnd[0].occupied, 2);
  assert.deepEqual(atEnd[0].holds.map((h) => h.holdId), ['hold:A3']);
});

test('交接回查：截止时点只含此前通知，状态与占用按当时重建', async () => {
  const data = await readInputs();
  const engine = new RehearsalEngine(data);
  engine.run();
  const h = engine.handover('2026-08-02T00:20:00+08:00');
  assert.deepEqual(h.received.map((r) => r.noticeId), ['N1', 'N2', 'N3', 'N4', 'N5', 'N6', 'N7']);
  // A2 此时处于歧义暂缓，不计入已确认
  assert.deepEqual(h.confirmedByCutoff.map((c) => c.offerId).sort(), ['A1', 'A6']);
  assert.equal(h.openAmbiguities[0].id, 'AMB-N5');
  // A2 占用已暂挂：00:30 格子自由容量为满
  const secondSlot = h.ledgerAtCutoff.find((c) => c.site === '前湾东' && c.slotStart.includes('00:30'));
  assert.equal(secondSlot.occupied, 0);
});

test('交接回查：晚些时点反映整组失效与重新确认', async () => {
  const data = await readInputs();
  const engine = new RehearsalEngine(data);
  engine.run();
  const h = engine.handover('2026-08-02T00:38:00+08:00');
  const status = Object.fromEntries(h.offers.map((o) => [o.id, o.atCutoff]));
  assert.equal(status.A2, 'withdrawn');
  assert.equal(status.A1, 'reschedulable');
  assert.equal(status.A3, 'confirmed');
  // 歧义已在 N8 裁定，截止时点不再列为未决
  assert.equal(h.openAmbiguities.length, 0);
});
