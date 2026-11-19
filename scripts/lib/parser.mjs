// 中文通知解析器（规则式，纯本地）。
// 输出结构化意图，并为每个字段保留来源原句（clauseRefs），保证“解析结果可连回原句”。
// 解析器只做语言层面的解释；涉及历史引用、容量与权限的判断由引擎负责。

import {
  durationToMs,
  parseNumber,
  parseSegmentOrdinal,
  parseTs,
} from './timeutil.mjs';
import { CATEGORY_SYNONYMS } from './resources.mjs';

// 按标点切分，不按空白、不按顿号切分：
// 顿号常用于并列编号/站点（“A1、A2”“前湾、后湾”），属于同一意图。
const SPLIT_RE = /[；;。！!？?，,]+/;

const SCOPE_TERMS = [
  '前湾东', '前湾西', '后湾南', '后湾北', // 先长后短，避免前缀误匹配
  '前湾', '后湾', '前站', '后站', '东站', '西站', '南站', '北站',
];

// 动作识别有优先级：撤回 > 恢复 > 申请/准备接受 > 增减 > 确认/裁定。
// 例如“申请…下调 3 单位”首先是一项申请，而非直接调节指令。
// 含“裁定”的整句属于值班裁决，统一归为 confirm（引擎再按 ruling 走歧义裁定）。
function detectAction(clause, noticeHasRuling) {
  if (noticeHasRuling) return 'confirm';
  if (/撤回|撤销|取消/.test(clause)) return 'withdraw';
  if (/恢复|归还/.test(clause)) return 'restore';
  if (/申请|准备接受/.test(clause)) return 'request';
  // “等值班确认”是请求的补充，本身不构成独立动作
  if (/等[^，,；;]*确认/.test(clause)) return null;
  if (/确认|裁定/.test(clause)) return 'confirm';
  if (/确认|裁定/.test(clause)) return 'confirm';
  if (/主动减少|减少|下调/.test(clause)) return 'reduce';
  if (/上调|增加/.test(clause)) return 'increase';
  return null;
}

function extractOfferIds(clause) {
  const ids = clause.match(/A\d+(?:-X\d+)?/g);
  return ids ? [...new Set(ids)] : [];
}

function extractNoticeRefs(clause) {
  const refs = clause.match(/N\d+/g);
  return refs ? [...new Set(refs)] : [];
}

function extractTime(clause, sentAt) {
  const out = { offsetMin: null, clockRange: null, clockStart: null, durationMs: null, explicit: false };

  const offset = clause.match(/(\d+|半|一|两|二|三|四|五|十)\s*分钟后/);
  if (offset) {
    out.offsetMin = parseNumber(offset[1]);
    out.explicit = true;
  }

  const clock = clause.match(/(\d{1,2}:\d{2})\s*(?:到|至|-|–|—)\s*(\d{1,2}:\d{2})/);
  if (clock) {
    out.clockRange = { start: clock[1], end: clock[2] };
    out.explicit = true;
  } else {
    // 单点时刻，如“00:45 起”
    const start = clause.match(/(\d{1,2}:\d{2})\s*(?:起|开始)?/);
    if (start) {
      out.clockStart = start[1];
      out.explicit = true;
    }
  }

  // 时长：显式“时长 X 单位”，或独立的“X 小时”；
  // “X 分钟后”是发话偏移，不得当作时长。
  let durMatch =
    clause.match(/时长\s*(\d+(?:\.\d+)?|一|两|半)\s*(小时|分钟|时|分)/) ||
    (clause.includes('分钟后')
      ? null
      : clause.match(/^(\d+(?:\.\d+)?|一|两|半)\s*(小时|时)$/)) ||
    (clause.includes('分钟后')
      ? null
      : clause.match(/(\d+(?:\.\d+)?|一|两|半)\s*小时/));
  if (!durMatch && !clause.includes('分钟后')) {
    const m = clause.match(/(\d+(?:\.\d+)?|一|两|半)\s*分钟(?!后)/);
    if (m) durMatch = [m[0], m[1], '分钟'];
  }
  if (durMatch) out.durationMs = durationToMs(durMatch[1], durMatch[2]);

  return out;
}

// “HH:MM”按发话当日解释；若算出来早于发话时刻超过 6 小时，则视为次日（跨午夜）。
function clockToEpoch(clock, baseTs) {
  const base = new Date(baseTs + 8 * 3600_000);
  const [h, m] = clock.split(':').map(Number);
  let shifted = Date.UTC(
    base.getUTCFullYear(),
    base.getUTCMonth(),
    base.getUTCDate(),
    h,
    m,
  ) - 8 * 3600_000;
  if (shifted < baseTs - 6 * 3600_000) shifted += 24 * 3600_000;
  return shifted;
}

function extractQuantity(clause) {
  const qty = clause.match(/(\d+(?:\.\d+)?|一|两|二|三|四|五)\s*单位/);
  return qty ? parseNumber(qty[1]) : null;
}

function extractScopeWords(clause) {
  const words = [];
  for (const term of SCOPE_TERMS) {
    if (clause.includes(term)) words.push(term);
  }
  return [...new Set(words)];
}

function extractExclusion(clause) {
  const m = clause.match(/(医疗|医院|商用|商业)\s*类/);
  if (!m) return null;
  return { raw: m[1], category: CATEGORY_SYNONYMS[m[1]] ?? m[1] };
}

function extractSegment(clause) {
  const seg = clause.match(/第\s*(\d+|一|二|两|三|四)\s*段/);
  return seg ? parseSegmentOrdinal(seg[1]) : null;
}

export function normalizeText(text) {
  return text.replace(/[\s；;。！!？?，,、]/g, '');
}

export function parseNotice(notice) {
  const sentAt = parseTs(notice.sentAt);
  const noticeHasRuling = /裁定/.test(notice.text);
  const clauses = notice.text
    .split(SPLIT_RE)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((raw, index) => ({ raw, index }));

  const intents = [];
  const unused = [];
  let current = null;
  let pendingPrefix = null;

  const newIntent = () => {
    current = {
      id: `${notice.id}.I${intents.length + 1}`,
      action: null,
      offerIds: [],
      noticeRefs: [],
      scopeWords: [],
      exclusion: null,
      quantity: null,
      absoluteQuantity: /改为/.test(notice.text),
      offsetMin: null,
      clockRange: null,
      durationMs: null,
      segmentIndex: null,
      acceptance: null,
      correction: /更正|说反了|改为|补发/.test(notice.text),
      ruling: /裁定/.test(notice.text),
      clauseRefs: [],
    };
    intents.push(current);
    return current;
  };

  for (const c of clauses) {
    const clause = c.raw;
    const ref = { clauseIndex: c.index, text: clause };
    const action = detectAction(clause, noticeHasRuling);

    if (action) {
      // 同一通知里连续的同动作小句合并（如裁定句的补充说明），避免重复派发。
      if (current && current.action === action) {
        current.clauseRefs.push(ref);
      } else {
        current = newIntent();
        if (pendingPrefix) {
          current.clauseRefs.push(...pendingPrefix);
          pendingPrefix = null;
        }
        current.action = action;
        current.clauseRefs.push(ref);
      }
    } else if (current) {
      // 无动作的补充小句并入最近的动作意图
      current.clauseRefs.push(ref);
    } else {
      if (!pendingPrefix) pendingPrefix = [];
      pendingPrefix.push(ref);
      continue;
    }

    if (/两段一并接|整组|一并|一起接|打包/.test(clause)) current.acceptance = 'group';
    if (/独立接受|分段独立|逐段|分别接受/.test(clause)) current.acceptance = 'independent';

    current.offerIds.push(...extractOfferIds(clause));
    current.noticeRefs.push(...extractNoticeRefs(clause));
    current.scopeWords.push(...extractScopeWords(clause));
    const exclusion = extractExclusion(clause);
    if (exclusion) current.exclusion = exclusion;
    const qty = extractQuantity(clause);
    if (qty != null) current.quantity = qty;
    const seg = extractSegment(clause);
    if (seg != null) current.segmentIndex = seg;

    const time = extractTime(clause, sentAt);
    if (time.offsetMin != null) current.offsetMin = time.offsetMin;
    if (time.clockRange) current.clockRange = time.clockRange;
    if (time.clockStart) current.clockStart = time.clockStart;
    if (time.durationMs != null) current.durationMs = time.durationMs;
  }

  for (const intent of intents) {
    intent.offerIds = [...new Set(intent.offerIds)];
    intent.noticeRefs = [...new Set(intent.noticeRefs)];
    intent.scopeWords = [...new Set(intent.scopeWords)];
    if (intent.clockRange) {
      intent.resolvedClockRange = {
        from: clockToEpoch(intent.clockRange.start, sentAt),
        to: clockToEpoch(intent.clockRange.end, sentAt),
      };
    }
    if (intent.clockStart) {
      const from = clockToEpoch(intent.clockStart, sentAt);
      intent.resolvedClockStart = from;
      if (intent.durationMs != null) {
        intent.resolvedClockRange = { from, to: from + intent.durationMs };
      }
    }
  }

  return {
    noticeId: notice.id,
    sentAt,
    normalized: normalizeText(notice.text),
    intents,
    unusedClauses: unused,
  };
}
