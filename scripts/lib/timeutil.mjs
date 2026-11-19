// 时间工具：所有时刻内部以 epoch 毫秒表示，展示时固定按资料里的 +08:00 口径。
// 区间一律含起点、不含终点（[from, to)）。

const DISPLAY_TZ_MINUTES = 8 * 60;

export const MINUTE = 60_000;

export function parseTs(text) {
  const t = Date.parse(text);
  if (Number.isNaN(t)) throw new Error(`无法解析时间：${text}`);
  return t;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

// 固定按 +08:00 展示，避免宿主时区影响演练口径。
export function fmtTs(epochMs) {
  const shifted = new Date(epochMs + DISPLAY_TZ_MINUTES * MINUTE);
  const y = shifted.getUTCFullYear();
  const mo = pad(shifted.getUTCMonth() + 1);
  const d = pad(shifted.getUTCDate());
  const h = pad(shifted.getUTCHours());
  const mi = pad(shifted.getUTCMinutes());
  return `${y}-${mo}-${d} ${h}:${mi}`;
}

export function fmtClock(epochMs) {
  return fmtTs(epochMs).slice(11);
}

export function fmtRange(from, to) {
  return `${fmtClock(from)}-${fmtClock(to)}`;
}

// "20 分钟后" 等相对发话时刻的偏移
export function offsetMinutes(base, minutes) {
  return base + minutes * MINUTE;
}

// 把时长描述（毫秒）套到起点上
export function endAfter(from, durationMs) {
  return from + durationMs;
}

export const CN_NUM = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 半: 0.5,
};

// 解析中文/阿拉伯数字，支持 "十"、"二十"、"半小时" 这类写法
export function parseNumber(token) {
  if (token == null) return null;
  const trimmed = String(token).trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed === '十') return 10;
  if (trimmed.startsWith('十')) return 10 + (CN_NUM[trimmed[1]] ?? 0);
  if (trimmed.endsWith('十')) return (CN_NUM[trimmed[0]] ?? 1) * 10;
  if (trimmed.includes('十')) {
    const [a, b] = trimmed.split('十');
    return (CN_NUM[a] ?? 1) * 10 + (CN_NUM[b] ?? 0);
  }
  if (trimmed === '半') return 0.5;
  return CN_NUM[trimmed] ?? null;
}

// "半小时" / "一小时" / "30 分钟" → 毫秒
export function durationToMs(token, unit) {
  const n = parseNumber(token);
  if (n == null) return null;
  if (unit === '小时' || unit === '时') return n * 60 * MINUTE;
  if (unit === '分钟' || unit === '分') return n * MINUTE;
  return null;
}

// 中文序数：第一段/第二段
export function parseSegmentOrdinal(token) {
  if (token == null) return null;
  if (/^\d+$/.test(token)) return Number(token);
  const map = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4 };
  return map[token] ?? null;
}

// 在 [from,to) 内按候选边界（意向时段）切片，没有边界时按 30 分钟兜底
export function splitSlots(from, to, boundaries) {
  const cuts = new Set([from, to]);
  for (const b of boundaries) {
    if (b > from && b < to) cuts.add(b);
  }
  const ordered = [...cuts].sort((a, b) => a - b);
  const slots = [];
  for (let i = 0; i < ordered.length - 1; i += 1) {
    slots.push({ from: ordered[i], to: ordered[i + 1], index: i + 1 });
  }
  return slots;
}

export function overlap(aFrom, aTo, bFrom, bTo) {
  return aFrom < bTo && bFrom < aTo;
}
