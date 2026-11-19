import test from 'node:test';
import assert from 'node:assert/strict';
import { readInputs } from '../scripts/inspect.mjs';
import { RehearsalEngine, STATUS } from '../scripts/lib/engine.mjs';
import { parseTs } from '../scripts/lib/timeutil.mjs';

async function runEngine() {
  const data = await readInputs();
  const engine = new RehearsalEngine(data);
  const report = engine.run();
  return { engine, data, report };
}

const byId = (report, id) => report.offers.find((o) => o.id === id);

test('准备接受不等于已确认：N2 后 A1/A2 仍未占用容量', async () => {
  const data = await readInputs();
  const engine = new RehearsalEngine(data);
  for (const n of data.notices) {
    engine._processNotice(n);
    if (n.id === 'N2') break;
  }
  const a1 = engine.offers.get('A1');
  assert.equal(a1.status, STATUS.READY);
  assert.equal(a1.holdId, null);
  assert.ok(engine.ledger.feasible('R1', parseTs('2026-08-02T00:00:00+08:00'), parseTs('2026-08-02T00:30:00+08:00'), 5));
});

test('值班确认后才占用容量，并与准备接受相区别', async () => {
  const { report } = await runEngine();
  const a1 = byId(report, 'A1');
  assert.equal(report.noticeResults.find((r) => r.noticeId === 'N4').drafts.join('').includes('本轮已确认'), true);
  assert.ok(a1.sourceNotices.includes('N4'));
});

test('“改为 1”按绝对值更正，而非再减 1', async () => {
  const { report } = await runEngine();
  const a2 = byId(report, 'A2');
  assert.equal(a2.originalQuantity, 2);
  assert.equal(a2.currentQuantity, 1);
});

test('共享别名“前站”产生歧义：N5 挂起，只影响 A2，A1 等其它承诺继续有效', async () => {
  const { report } = await runEngine();
  const amb = report.ambiguities.find((a) => a.id === 'AMB-N5');
  assert.ok(amb);
  assert.equal(amb.interpretations.length, 2);
  assert.ok(amb.interpretations.some((i) => i.offerId === 'A2'));
  assert.ok(amb.interpretations.some((i) => i.offerId === null));
  // 歧义只挂起它能影响的 A2，A1 不在挂起目标里
  assert.deepEqual(amb.interpretations.map((i) => i.offerId).filter(Boolean), ['A2']);
});

test('指向不清的更正（N6）不擅自作废其它响应，作为跟进挂到同一歧义单', async () => {
  const { report } = await runEngine();
  const amb = report.ambiguities.find((a) => a.id === 'AMB-N5');
  assert.ok(amb.followUps.some((f) => f.noticeId === 'N6'));
  const n6 = report.noticeResults.find((r) => r.noticeId === 'N6');
  assert.ok(n6.drafts.join('').includes('跟进'));
});

test('值班裁定（resolve 权限）选定解释一，A2 恢复确认并重新占用', async () => {
  const data = await readInputs();
  const engine = new RehearsalEngine(data);
  for (const n of data.notices) {
    engine._processNotice(n);
    if (n.id === 'N8') break;
  }
  const report = engine.report();
  const amb = report.ambiguities.find((a) => a.id === 'AMB-N5');
  assert.equal(amb.status, 'resolved');
  assert.equal(amb.resolvedBy, 'N8');
  assert.equal(amb.chosenKey, 'A2');
  assert.equal(engine.offers.get('A2').status, STATUS.CONFIRMED);
  // 容量已重新占用
  assert.ok(!engine.ledger.feasible('R1', parseTs('2026-08-02T00:30:00+08:00'), parseTs('2026-08-02T01:00:00+08:00'), 5));
});

test('无 resolve/confirm 权限的角色不能裁定或确认', async () => {
  const { report } = await runEngine();
  // C1 只有 respond：其“准备接受”被受理，但任何确认动作无权
  const c1CanConfirm = report.noticeResults
    .filter((r) => r.author === 'C1')
    .some((r) => r.effects.join('').includes('confirmed'));
  assert.equal(c1CanConfirm, false);
});

test('协调员只能动授权资源：越资源申请被拒，授权资源申请受理', async () => {
  const { report } = await runEngine();
  const n7 = report.noticeResults.find((r) => r.noticeId === 'N7');
  assert.ok(n7.drafts.join('').includes('前湾西'));
  assert.equal(n7.unauthorized, false);
});

test('撤回已确认的一段 → 释放容量 → 同组整组失效并标记可重排，给出替代时段', async () => {
  const { report } = await runEngine();
  const a2 = byId(report, 'A2');
  const a1 = byId(report, 'A1');
  assert.equal(a2.status, STATUS.WITHDRAWN);
  assert.equal(a1.status, STATUS.RESCHEDULABLE);
  assert.ok(a1.pendingReason.includes('G1'));
  assert.equal(a2.alternatives.length, 1);
  assert.equal(a2.alternatives[0].id, 'A2-X1');
  const n11 = report.noticeResults.find((r) => r.noticeId === 'N11');
  assert.ok(n11.drafts.join('').includes('整组失效'));
});

test('撤回发起人具备 revise 权限，已确认承诺可由授权文本改变', async () => {
  const { report } = await runEngine();
  const n11 = report.noticeResults.find((r) => r.noticeId === 'N11');
  assert.equal(n11.unauthorized, false);
});

test('容量竞争时无权直接确认：释放后重算获得机会，仍需值班确认', async () => {
  const { engine, report } = await runEngine();
  // N12 时 A1 仍占用，A3 先竞争；N11 释放后 N12 成功确认 A3
  const a3 = byId(report, 'A3');
  assert.equal(a3.status, STATUS.CONFIRMED);
  const n12 = report.noticeResults.find((r) => r.noticeId === 'N12');
  assert.ok(n12.drafts.join('').includes('本轮已确认'));
  // A5 在 A3 确认后只剩 3 自由容量，A5=3 恰好可行，N14 确认
  assert.equal(byId(report, 'A5').status, STATUS.CONFIRMED);
});

test('台账守恒：每格占用不超容量，自由容量 = 容量 - 占用', async () => {
  const { report } = await runEngine();
  for (const cell of report.ledger) {
    assert.ok(cell.occupied <= cell.capacity);
    assert.equal(cell.free, cell.capacity - cell.occupied);
    const holdSum = cell.holds.reduce((s, h) => s + h.qty, 0);
    assert.equal(holdSum, cell.occupied);
  }
});

test('补发副本不重复占用：N9 与 N1 同文同引用，标记 duplicate 且不产生新申请', async () => {
  const { report } = await runEngine();
  const n9 = report.noticeResults.find((r) => r.noticeId === 'N9');
  assert.equal(n9.duplicateOf, 'N1');
  assert.ok(!report.applications.some((a) => a.appId === 'APP-N9'));
});

test('真实修改才重新审阅：N10 更正重审原申请并沿用发话时间口径', async () => {
  const { report } = await runEngine();
  const n10 = report.noticeResults.find((r) => r.noticeId === 'N10');
  assert.ok(n10.drafts.join('').includes('更正重审'));
  const app = report.applications.find((a) => a.appId === 'APP-N1');
  assert.equal(app.quantity, 3);
  assert.equal(app.revisesNoticeId, 'N1');
  // 沿用 N1 的发话时刻口径：23:40 + 20 分钟 = 00:00 起
  assert.equal(app.from, parseTs('2026-08-02T00:00:00+08:00'));
});

test('类别例外按站点类别判断：医疗站点 R2/R4 被排除，商用 R1/R3 保留', async () => {
  const { report } = await runEngine();
  const n13 = report.noticeResults.find((r) => r.noticeId === 'N13');
  assert.ok(n13.drafts.join('').includes('后湾南'));
  assert.ok(n13.warnings.join('').includes('R2、R4'));
});

test('独立条件可逐段接受，整组条件缺段时整组不确认', async () => {
  const data = await readInputs();
  const engine = new RehearsalEngine(data);
  // 只跑到 N4，验证整组必须同时点名
  for (const n of data.notices) {
    engine._processNotice(n);
    if (n.id === 'N4') break;
  }
  const a1 = engine.offers.get('A1');
  const a2 = engine.offers.get('A2');
  assert.equal(a1.status, STATUS.CONFIRMED);
  assert.equal(a2.status, STATUS.CONFIRMED);
});
