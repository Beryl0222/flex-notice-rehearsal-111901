// 容量台账：按站点 × 时段记录自由容量、占用与释放。
// 占用来源全部可回溯到意向 id 与通知 id；释放与重算同样留痕。

import { MINUTE, overlap } from './timeutil.mjs';

// 以 30 分钟为最小记账格子；查询时聚合所有相交格子。
const GRID = 30 * MINUTE;

function gridStart(ts) {
  return Math.floor(ts / GRID) * GRID;
}

export class Ledger {
  constructor(registry) {
    this.registry = registry;
    // key: resourceId|gridStart -> { free, holds: Map(holdId -> qty) }
    this.cells = new Map();
    this.events = [];
  }

  key(resourceId, gs) {
    return `${resourceId}|${gs}`;
  }

  cell(resourceId, gs) {
    const k = this.key(resourceId, gs);
    let cell = this.cells.get(k);
    if (!cell) {
      cell = {
        capacity: this.registry.get(resourceId).capacity,
        free: this.registry.get(resourceId).capacity,
        holds: new Map(),
      };
      this.cells.set(k, cell);
    }
    return cell;
  }

  // 某资源在 [from,to) 的逐格占用情况
  profile(resourceId, from, to) {
    const out = [];
    for (let gs = gridStart(from); gs < to; gs += GRID) {
      const cell = this.cell(resourceId, gs);
      const slotFrom = Math.max(gs, from);
      const slotTo = Math.min(gs + GRID, to);
      out.push({
        from: slotFrom,
        to: slotTo,
        capacity: cell.capacity,
        free: cell.free,
        occupied: cell.capacity - cell.free,
        holds: [...cell.holds.entries()].map(([holdId, qty]) => ({ holdId, qty })),
      });
    }
    return out;
  }

  // 整段可行：每一格自由容量都 >= qty
  feasible(resourceId, from, to, qty) {
    return this.profile(resourceId, from, to).every((p) => p.free >= qty);
  }

  blockers(resourceId, from, to, qty) {
    const bad = this.profile(resourceId, from, to).filter((p) => p.free < qty);
    return bad.map((p) => ({
      from: p.from,
      to: p.to,
      free: p.free,
      need: qty,
      holders: p.holds,
    }));
  }

  hold(holdId, resourceId, from, to, qty, meta) {
    for (let gs = gridStart(from); gs < to; gs += GRID) {
      const cell = this.cell(resourceId, gs);
      if (cell.free < qty) {
        throw new Error(`容量不足，无法记账：${holdId} @ ${resourceId}`);
      }
    }
    for (let gs = gridStart(from); gs < to; gs += GRID) {
      const cell = this.cell(resourceId, gs);
      cell.holds.set(holdId, (cell.holds.get(holdId) ?? 0) + qty);
      cell.free -= qty;
    }
    this.events.push({ type: 'hold', holdId, resourceId, from, to, qty, ...meta });
  }

  release(holdId, meta) {
    const released = [];
    for (const [k, cell] of this.cells) {
      if (cell.holds.has(holdId)) {
        const qty = cell.holds.get(holdId);
        cell.holds.delete(holdId);
        cell.free += qty;
        const [resourceId, gsText] = k.split('|');
        released.push({ resourceId, from: Number(gsText), qty });
      }
    }
    this.events.push({ type: 'release', holdId, released, ...meta });
    return released;
  }

  // 调整某笔占用的量（先放后占），返回每一格的变化说明
  resize(holdId, resourceId, from, to, newQty, meta) {
    this.release(holdId, { reason: 'resize-before', ...meta });
    this.hold(holdId, resourceId, from, to, newQty, { reason: 'resize-after', ...meta });
  }

  holdersAt(resourceId, from, to) {
    const ids = new Set();
    for (const p of this.profile(resourceId, from, to)) {
      for (const h of p.holds) ids.add(h.holdId);
    }
    return [...ids];
  }

  overlapsExisting(resourceId, from, to) {
    return this.holdersAt(resourceId, from, to).length > 0;
  }

  // 依据 hold/release 事件流重建某 cutoff 时点的格子占用（供交接回查）。
  // 事件按时间顺序重放到 cutoff；同一 holdId 的“先放后占”按重放自然处理。
  reconstructAt(cutoff) {
    const cells = new Map();
    const ensure = (resourceId, gs) => {
      const k = `${resourceId}|${gs}`;
      if (!cells.has(k)) {
        cells.set(k, {
          resourceId,
          gs,
          capacity: this.registry.get(resourceId).capacity,
          holds: new Map(),
        });
      }
      return cells.get(k);
    };
    for (const ev of this.events) {
      if (ev.at == null || ev.at > cutoff) continue;
      if (ev.type === 'hold') {
        for (let gs = gridStart(ev.from); gs < ev.to; gs += GRID) {
          const cell = ensure(ev.resourceId, gs);
          cell.holds.set(ev.holdId, (cell.holds.get(ev.holdId) ?? 0) + ev.qty);
        }
      } else if (ev.type === 'release') {
        for (const item of ev.released) {
          const cell = cells.get(`${item.resourceId}|${item.from}`);
          if (cell) cell.holds.delete(ev.holdId);
        }
      }
    }
    return [...cells.values()].map((cell) => {
      const occupied = [...cell.holds.values()].reduce((s, q) => s + q, 0);
      return {
        resourceId: cell.resourceId,
        gs: cell.gs,
        capacity: cell.capacity,
        occupied,
        free: cell.capacity - occupied,
        holds: [...cell.holds.entries()].map(([holdId, qty]) => ({ holdId, qty })),
      };
    });
  }
}

export function offersOverlap(a, b) {
  return overlap(a.from, a.to, b.from, b.to);
}
