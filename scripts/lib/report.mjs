// 把引擎结果渲染成供人工阅读的中文文本（非机器指令，不连接设备）。

import { fmtTs } from './timeutil.mjs';

const STATUS_LABEL = {
  candidate: '候选计划',
  ready: '对方准备接受（未确认）',
  pending: '待裁定（容量竞争）',
  confirmed: '本轮已确认',
  'held-ambiguous': '歧义暂缓',
  withdrawn: '已撤回/释放',
  reschedulable: '可重新安排',
  rejected: '已拒绝',
};

export function renderRunReport(report) {
  const lines = [];
  lines.push(`# ${report.drill.name}`);
  lines.push(`演练编号：${report.drill.id}`);
  lines.push(`说明：${report.drill.note}`);
  lines.push('');

  lines.push('## 一、通知逐条处理与值班响应草稿');
  for (const r of report.noticeResults) {
    lines.push('');
    lines.push(`### ${r.noticeId} ｜ ${fmtTs(r.sentAt)} ｜ 发话人 ${r.author}`);
    lines.push(`原句：${r.text}`);
    if (r.duplicateOf) lines.push(`▶ 补发副本：同 ${r.duplicateOf}，未重复占用容量。`);
    if (r.unauthorized) lines.push('▶ 本条含无权办理项（详见草稿）。');
    for (const d of r.drafts) lines.push(`- ${d}`);
    if (r.effects.length) {
      lines.push('- 状态/容量变化：');
      for (const e of r.effects) lines.push(`  · ${e}`);
    }
    for (const w of r.warnings) lines.push(`- 备注：${w}`);
  }

  lines.push('');
  lines.push('## 二、意向与承诺台账');
  lines.push('');
  lines.push('| 意向 | 站点/类别 | 时段 | 原量 | 现量 | 接受条件 | 状态 | 待办/原因 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const o of report.offers) {
    const cond = o.kind === 'group' ? `整组(${o.groupId})第${o.segmentIndex}段` : '独立';
    lines.push(
      `| ${o.id} | ${o.site}/${o.category} | ${o.from.slice(11)}-${o.to.slice(11)} | ${o.originalQuantity} | ${o.currentQuantity} | ${cond} | ${STATUS_LABEL[o.status] ?? o.status} | ${o.pendingReason ?? '—'} |`,
    );
  }

  lines.push('');
  lines.push('## 三、站点自由容量（30 分钟记账格）');
  lines.push('');
  lines.push('| 站点 | 格子 | 容量 | 已占用 | 自由 | 占用来源 |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const c of report.ledger) {
    const holders = c.holds.map((h) => `${h.holdId}=${h.qty}`).join('、') || '—';
    lines.push(`| ${c.site} | ${c.slotStart.slice(11)}-${c.slotEnd.slice(11)} | ${c.capacity} | ${c.occupied} | ${c.free} | ${holders} |`);
  }

  lines.push('');
  lines.push('## 四、歧义清单（多种合理解释）');
  if (report.ambiguities.length === 0) {
    lines.push('无。');
  }
  for (const a of report.ambiguities) {
    lines.push('');
    lines.push(`### ${a.id}（${a.status === 'open' ? '待裁定' : `已由 ${a.resolvedBy} 裁定`}）`);
    lines.push(`来源原句：${a.sourceText}`);
    lines.push(`作用小句：${a.clause}`);
    for (const [i, it] of a.interpretations.entries()) {
      const pick = a.status === 'resolved' && a.chosenKey === it.key ? ' ← 裁定选定' : '';
      lines.push(`- 解释${'一二三四'[i] ?? i + 1}：${it.offerId}｜${it.resource}｜${it.window}｜${it.quantity} 单位｜当时状态 ${it.currentStatus}${pick}`);
    }
  }

  lines.push('');
  lines.push('## 五、待裁定申请（系统无权自动确认）');
  const pending = report.offers.filter((o) => ['pending', 'held-ambiguous', 'reschedulable'].includes(o.status));
  const blockedApps = report.applications.filter((a) => a.status === 'blocked');
  if (pending.length === 0 && blockedApps.length === 0) {
    lines.push('无。');
  }
  for (const o of pending) {
    const alt = o.alternatives.length
      ? `可重排：${o.alternatives.map((a) => `${a.from.slice(11)}-${a.to.slice(11)}(${a.id})`).join('、')}`
      : '无替代时段';
    lines.push(`- ${o.id}（${o.site} ${o.from.slice(11)}-${o.to.slice(11)}）：${STATUS_LABEL[o.status]}；${o.pendingReason ?? ''}；${alt}`);
  }
  for (const app of blockedApps) {
    lines.push(`- ${app.appId}：${app.note}（${app.windowBasis}）`);
  }

  lines.push('');
  lines.push('## 六、可核查事件流水');
  for (const e of report.events) {
    lines.push(`- #${e.seq} [${e.kind}] ${e.at ? fmtTs(e.at) : '初始化'} ${e.message}`);
  }

  lines.push('');
  lines.push('— 本报告由本地演练台生成，全部设施与消息为虚构，仅供人工练习与核对，不构成对任何设备的控制指令。');
  return lines.join('\n');
}

export function renderHandover(h) {
  const lines = [];
  lines.push(`# 交接回查 ｜ ${h.drillId} ｜ 截止演练时点 ${h.cutoff}`);
  lines.push('');
  lines.push(`## 截至该时点共收到 ${h.received.length} 条通知`);
  for (const n of h.received) {
    const tags = [];
    if (n.duplicateOf) tags.push(`补发(${n.duplicateOf})`);
    if (n.unauthorized) tags.push('含无权项');
    lines.push(`- ${n.noticeId} ${n.at} ${n.author}：${n.text}${tags.length ? ` ［${tags.join('，')}］` : ''}`);
  }
  lines.push('');
  lines.push('## 截止时点已确认承诺');
  if (h.confirmedByCutoff.length === 0) lines.push('无。');
  for (const c of h.confirmedByCutoff) {
    lines.push(`- ${c.offerId}｜${c.site}｜${c.window}｜${c.quantity} 单位`);
  }
  lines.push('');
  lines.push('## 截止时点未决歧义');
  if (h.openAmbiguities.length === 0) lines.push('无。');
  for (const a of h.openAmbiguities) {
    lines.push(`- ${a.id}：${a.source}`);
    for (const [i, it] of a.interpretations.entries()) {
      lines.push(`    解释${'一二三四'[i] ?? i + 1}：${it.offerId} ${it.resource} ${it.window}`);
    }
  }
  lines.push('');
  lines.push('## 截止时点容量占用');
  lines.push('| 站点 | 格子 | 占用/容量 | 自由 | 来源 |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const c of h.ledgerAtCutoff) {
    const holders = c.holds.map((x) => `${x.holdId}=${x.qty}`).join('、') || '—';
    lines.push(`| ${c.site} | ${c.slotStart.slice(11)}-${c.slotEnd.slice(11)} | ${c.occupied}/${c.capacity} | ${c.free} | ${holders} |`);
  }
  lines.push('');
  lines.push('## 截止时点事件流水（供经办人逐条回查）');
  for (const e of h.events) {
    lines.push(`- #${e.seq} [${e.kind}] ${e.at ? fmtTs(e.at) : '初始化'} ${e.message}`);
  }
  return lines.join('\n');
}
