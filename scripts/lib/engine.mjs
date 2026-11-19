// 演练引擎：按发话时间顺序处理通知，维护意向生命周期、容量台账、
// 歧义挂起、权限校验、补发去重与可回查的事件日志。
// 引擎不连接任何设备，产出仅为供人工阅读的草稿与可核查记录。

import { parseNotice } from './parser.mjs';
import { ResourceRegistry } from './resources.mjs';
import { Ledger } from './ledger.mjs';
import {
  MINUTE,
  fmtClock,
  fmtRange,
  fmtTs,
  offsetMinutes,
  parseTs,
} from './timeutil.mjs';

const STATUS = {
  CANDIDATE: 'candidate', // 候选计划，尚未进入本轮
  READY: 'ready', // 对方准备接受，等待值班确认
  PENDING: 'pending', // 申请已受理，容量竞争未决，无权确认
  CONFIRMED: 'confirmed', // 本轮已确认并占用容量
  HELD_AMBIGUOUS: 'held-ambiguous', // 因歧义暂缓，容量暂挂
  WITHDRAWN: 'withdrawn', // 已撤回/释放
  RESCHEDULABLE: 'reschedulable', // 原时段失效，可按替代时段重排
  REJECTED: 'rejected', // 无权或不可行，未占用
};

export class RehearsalEngine {
  constructor(data) {
    this.data = data;
    this.registry = new ResourceRegistry(data.resources);
    this.ledger = new Ledger(this.registry);
    this.roles = new Map(data.roles.map((r) => [r.id, r]));
    this.offers = new Map();
    this.ambiguities = [];
    this.log = [];
    this.noticeResults = [];
    this.seenTexts = new Map(); // normalized -> noticeId
    this._initOffers();
  }

  _initOffers() {
    for (const raw of this.data.offers) {
      const offer = {
        ...raw,
        from: parseTs(raw.from),
        to: parseTs(raw.to),
        alternatives: (raw.alternatives ?? []).map((a) => ({
          ...a,
          from: parseTs(a.from),
          to: parseTs(a.to),
        })),
        status: STATUS.CANDIDATE,
        originalQuantity: raw.quantity,
        currentQuantity: raw.quantity,
        holdId: null,
        history: [],
        sourceNotices: [],
        pendingReason: null,
      };
      this.offers.set(offer.id, offer);

      if (raw.confirmedAt) {
        offer.status = STATUS.CONFIRMED;
        offer.holdId = `hold:${offer.id}`;
        offer.confirmedAt = parseTs(raw.confirmedAt);
        this.ledger.hold(
          offer.holdId,
          offer.resourceId,
          offer.from,
          offer.to,
          offer.currentQuantity,
          { offerId: offer.id, reason: 'baseline-confirmed', at: offer.confirmedAt },
        );
        this._event('baseline', `${offer.id} 作为演练开始前已确认承诺入账`, {
          offerId: offer.id,
          at: offer.confirmedAt,
        });
      }
    }
  }

  _event(kind, message, detail = {}, at = null) {
    this.log.push({ seq: this.log.length + 1, at, kind, message, detail });
  }

  _role(authorId) {
    return this.roles.get(authorId) ?? null;
  }

  _can(authorId, entitlement) {
    const role = this._role(authorId);
    return Boolean(role && role.entitlements.includes(entitlement));
  }

  // 资源协调员只能动授权资源
  _canTouchResource(authorId, resourceId) {
    const role = this._role(authorId);
    if (!role) return false;
    if (!role.resourceIds) return true;
    return role.resourceIds.includes(resourceId);
  }

  run() {
    const notices = [...this.data.notices].sort(
      (a, b) => parseTs(a.sentAt) - parseTs(b.sentAt),
    );
    for (const notice of notices) this._processNotice(notice);
    return this.report();
  }

  // ---- 单条通知 -----------------------------------------------------------

  _processNotice(notice) {
    const sentAt = parseTs(notice.sentAt);
    const parsed = parseNotice(notice);
    const result = {
      noticeId: notice.id,
      author: notice.author,
      sentAt,
      text: notice.text,
      drafts: [],
      effects: [],
      warnings: [],
      duplicateOf: null,
      unauthorized: false,
    };
    this.noticeResults.push(result);

    // 补发副本：同发话人、同规范化文本且引用对象未变 → 不再次占用容量
    const priorId = this.seenTexts.get(parsed.normalized);
    if (priorId) {
      result.duplicateOf = priorId;
      result.drafts.push(
        `【补发核对】本通知与 ${priorId} 内容及引用完全相同，按补发副本处理：不重复受理、不再次占用容量。`,
      );
      this._event('duplicate', `${notice.id} 识别为 ${priorId} 的补发副本`, {
        noticeId: notice.id,
        duplicateOf: priorId,
      }, sentAt);
      return result;
    }
    this.seenTexts.set(parsed.normalized, notice.id);

    if (parsed.unusedClauses.length > 0) {
      result.warnings.push(
        `存在未归入任何意图的小句：${parsed.unusedClauses.map((c) => `「${c.text}」`).join('、')}`,
      );
    }

    for (const intent of parsed.intents) {
      this._dispatch(notice, intent, result);
    }

    if (result.drafts.length === 0) {
      result.drafts.push('【值班草稿】该通知未产生可执行动作，请人工复核原句。');
    }
    return result;
  }

  _draft(result, text) {
    result.drafts.push(text);
  }

  _effect(result, text) {
    result.effects.push(text);
  }

  // 意图动作分派与权限门槛
  _dispatch(notice, intent, result) {
    const { author } = notice;
    const at = parseTs(notice.sentAt);

    // 撤回已确认承诺属于对承诺的授权更正（revise）；
    // 撤回尚未确认的协调响应属于响应权（respond）。
    let need;
    if (intent.action === 'withdraw') {
      const touchesConfirmed = intent.offerIds.some((id) => {
        const o = this.offers.get(id);
        return o && [STATUS.CONFIRMED, STATUS.HELD_AMBIGUOUS].includes(o.status);
      });
      need = touchesConfirmed ? 'revise' : 'respond';
    } else {
      const entitlementByAction = {
        reduce: intent.offerIds.length > 0 ? 'respond' : 'issue',
        increase: intent.offerIds.length > 0 ? 'respond' : 'issue',
        restore: 'revise',
        request: 'respond',
        confirm: intent.ruling ? 'resolve' : 'confirm',
      };
      need = entitlementByAction[intent.action];
    }
    if (need && !this._can(author, need)) {
      result.unauthorized = true;
      this._draft(
        result,
        `【无权办理】${this._role(author)?.name ?? author} 缺少「${need}」权限，${this._intentBrief(intent)} 不予执行，已确认承诺不因此改变。`,
      );
      this._event('denied', `${notice.id} 权限不足（需 ${need}）`, {
        noticeId: notice.id,
        action: intent.action,
      }, at);
      return;
    }

    switch (intent.action) {
      case 'reduce':
      case 'increase':
        this._handleAdjust(notice, intent, result);
        break;
      case 'request':
        this._handleRequest(notice, intent, result);
        break;
      case 'confirm':
        this._handleConfirm(notice, intent, result);
        break;
      case 'restore':
      case 'withdraw':
        this._handleRevoke(notice, intent, result);
        break;
      default:
        result.warnings.push(`未识别的动作：${intent.action}`);
    }
  }

  _intentBrief(intent) {
    const parts = [];
    if (intent.scopeWords.length) parts.push(intent.scopeWords.join('/'));
    if (intent.offerIds.length) parts.push(intent.offerIds.join('、'));
    if (intent.segmentIndex) parts.push(`第${intent.segmentIndex}段`);
    if (intent.quantity != null) parts.push(`${intent.quantity} 单位`);
    return parts.join(' ') || intent.id;
  }

  // ---- 时间与范围解析 ------------------------------------------------------

  // 解析意图的作用时段：显式时钟 > 相对偏移+时长 > 引用意向/通知的时段
  _resolveWindow(intent, at, referencedOffers, referencedNotices = []) {
    if (intent.resolvedClockRange) {
      return {
        from: intent.resolvedClockRange.from,
        to: intent.resolvedClockRange.to,
        basis: '原句时钟区间（跨午夜按发话日解释）',
      };
    }
    if (intent.offsetMin != null) {
      const from = offsetMinutes(at, intent.offsetMin);
      const duration = intent.durationMs ?? 60 * MINUTE;
      return { from, to: from + duration, basis: `发话时刻 +${intent.offsetMin} 分钟，时长 ${duration / MINUTE} 分钟` };
    }
    if (referencedOffers.length > 0) {
      const from = Math.min(...referencedOffers.map((o) => o.from));
      const to = Math.max(...referencedOffers.map((o) => o.to));
      return { from, to, basis: '沿用所引用计划/意向的时段' };
    }
    // “更正前条”等：沿用被引用通知当时生成的申请窗口；
    // 若本句带时长，以引用窗口起点重算终点（例如原一小时口径改成新的量与时长）。
    if (referencedNotices.length > 0) {
      for (const rawRefId of referencedNotices) {
        // 补发副本本身不产生申请，需穿透到它所复制的原始通知
        const refId = this._originNoticeId(rawRefId);
        const app = this.applications?.get(`APP-${refId}`);
        if (app) {
          const from = app.from;
          const to = intent.durationMs != null ? from + intent.durationMs : app.to;
          return {
            from,
            to,
            basis: `沿用 ${refId} 的发话时间口径（起点 ${fmtClock(from)}）${intent.durationMs != null ? `，时长按本句 ${intent.durationMs / MINUTE} 分钟` : ''}`,
          };
        }
      }
    }
    return null;
  }

  // 补发副本 → 原始通知 id；非副本原样返回
  _originNoticeId(noticeId) {
    const result = this.noticeResults.find((r) => r.noticeId === noticeId);
    return result?.duplicateOf ? this._originNoticeId(result.duplicateOf) : noticeId;
  }

  // 把范围词解析成资源 id 列表（含类别例外），返回歧义信息
  _resolveResources(intent, result) {
    const scope = this.registry.resolveScope(intent.scopeWords);
    let exclusion = null;
    if (intent.exclusion) {
      exclusion = this.registry.resolveExclusion(intent.exclusion.raw);
      result.warnings.push(`例外判断：${exclusion.basis}`);
    }
    const { kept, removed } = this.registry.applyExclusion(
      scope.candidateIds,
      exclusion,
    );
    return {
      scope,
      exclusion,
      resourceIds: kept,
      excludedIds: removed,
      ambiguous: scope.ambiguous,
    };
  }

  // 引用通知（N 编号）→ 该通知涉及的意向
  _offersFromNoticeRefs(refs) {
    const ids = new Set();
    for (const ref of refs) {
      for (const offer of this.offers.values()) {
        if (offer.sourceNotices.includes(ref)) ids.add(offer.id);
      }
    }
    return [...ids].map((id) => this.offers.get(id));
  }

  // 识别“前条/前一条/刚才/上一条”等说法指向的最近通知（at 为当前通知发话时刻）
  _detectReferencedNotices(intent, at) {
    const text = intent.clauseRefs.map((c) => c.text).join('');
    const explicit = [...intent.noticeRefs];
    if (/前一条|前条|刚才|上一条/.test(text)) {
      const earlier = this.noticeResults
        .filter((r) => r.sentAt < at)
        .map((r) => r.noticeId);
      if (earlier.length) explicit.push(earlier[earlier.length - 1]);
    }
    return [...new Set(explicit)];
  }

  // 段序号 → 组内/引用集合中的对应意向
  _offersBySegment(offers, segmentIndex) {
    if (segmentIndex == null) return offers;
    const withSeg = offers.filter((o) => o.segmentIndex === segmentIndex);
    return withSeg.length ? withSeg : offers;
  }

  // ---- 调节（上调/下调）----------------------------------------------------

  _handleAdjust(notice, intent, result) {
    const at = parseTs(notice.sentAt);

    // 指向具体意向的调节（含“主动减少”）：直接修改该意向
    if (intent.offerIds.length > 0) {
      for (const id of intent.offerIds) {
        const offer = this.offers.get(id);
        if (!offer) {
          result.warnings.push(`引用的意向 ${id} 不存在，已跳过。`);
          continue;
        }
        if (!this._canTouchResource(notice.author, offer.resourceId)) {
          result.unauthorized = true;
          this._draft(result, `【无权办理】协调员 ${notice.author} 不负责 ${this.registry.get(offer.resourceId).site}，${id} 的修改被拒绝。`);
          continue;
        }
        const before = offer.currentQuantity;
        // “改为 X”按绝对值；“减少 X”按差值；无显式量则保持不变。
        const next = intent.absoluteQuantity && intent.quantity != null
          ? intent.quantity
          : intent.action === 'increase'
            ? before + (intent.quantity ?? 0)
            : Math.max(0, before - (intent.quantity ?? 0));

        offer.history.push({ at, noticeId: notice.id, from: before, to: next });
        offer.currentQuantity = next;
        offer.sourceNotices.push(notice.id);

        if (offer.status === STATUS.CONFIRMED) {
          // 已确认承诺的量被授权文本修改：重记容量；若新量不可行则整笔挂起
          this.ledger.release(offer.holdId, { noticeId: notice.id, reason: 'adjust-release', at });
          if (this.ledger.feasible(offer.resourceId, offer.from, offer.to, next)) {
            this.ledger.hold(offer.holdId, offer.resourceId, offer.from, offer.to, next,
              { offerId: offer.id, noticeId: notice.id, reason: 'adjust-rehold', at });
            this._draft(result, `【已重记】${id} 量 ${before}→${next}，已确认承诺按授权更正重记容量，仍为已确认。`);
          } else {
            offer.status = STATUS.HELD_AMBIGUOUS;
            offer.pendingReason = '修改后容量不足，等待值班处理';
            this._draft(result, `【暂缓】${id} 修改为 ${next} 后容量不足，原占用已释放并暂缓，待值班裁定。`);
          }
        } else {
          this._draft(result, `【已登记】${id} 申报量 ${before}→${next}（来源原句可回溯），待确认流程。`);
        }
        this._effect(result, `${id} 量：${before} → ${next}`);
        this._event('adjust', `${notice.id} 调整 ${id}：${before}→${next}`, { offerId: id, before, next }, at);
      }
      return;
    }

    // 面向资源范围的调节通知：生成一项“申请”，等待匹配意向与值班确认
    const resolved = this._resolveResources(intent, result);
    const refNoticeIds = this._detectReferencedNotices(intent, at);
    // 更正类通知若改的是同一条申请，则替换原申请而非新开，保证引用可连回原句
    const originRefId = refNoticeIds.length ? this._originNoticeId(refNoticeIds[0]) : null;
    const priorAppId = intent.correction && originRefId ? `APP-${originRefId}` : null;
    const window = this._resolveWindow(intent, at, [], refNoticeIds);
    if (!window) {
      result.warnings.push('无法确定作用时段，已挂起待人工解释。');
      return;
    }
    const app = {
      appId: priorAppId ?? `APP-${notice.id}`,
      noticeId: notice.id,
      revisesNoticeId: priorAppId ? originRefId : null,
      at,
      action: intent.action,
      quantity: intent.quantity,
      resourceIds: resolved.resourceIds,
      excludedIds: resolved.excludedIds,
      from: window.from,
      to: window.to,
      windowBasis: window.basis,
      acceptance: intent.acceptance,
      status: 'open',
      note: null,
    };
    this.applications ??= new Map();
    const replaced = this.applications.has(app.appId);
    this.applications.set(app.appId, app);

    // 匹配时段相交、资源相符的候选/就绪意向
    const matches = [...this.offers.values()].filter((o) =>
      app.resourceIds.includes(o.resourceId) &&
      o.from < app.to && app.from < o.to &&
      ![STATUS.WITHDRAWN, STATUS.RESCHEDULABLE].includes(o.status),
    );

    const resText = resolved.resourceIds.map((id) => this.registry.get(id).site).join('、') || '（无资源）';
    const exclText = resolved.excludedIds.length
      ? `；例外排除 ${resolved.excludedIds.map((id) => this.registry.get(id).site).join('、')}`
      : '';
    this._draft(
      result,
      `【${replaced ? '更正重审' : '调节申请'} ${app.appId}】${fmtRange(app.from, app.to)}（${window.basis}）作用于 ${resText}，${intent.action === 'reduce' ? '下调' : '上调'} ${app.quantity} 单位${exclText}；接受条件：${app.acceptance === 'group' ? '整组一次接受' : app.acceptance === 'independent' ? '可分段独立接受' : '未声明（默认逐段）'}。匹配意向：${matches.map((m) => m.id).join('、') || '无'}。`,
    );
    this._event(replaced ? 'application-revise' : 'application',
      `${notice.id} ${replaced ? `更正 ${app.revisesNoticeId} 的申请` : '生成调节申请'}`,
      { appId: app.appId, matches: matches.map((m) => m.id) }, at);
  }

  // ---- 申请/准备接受 -------------------------------------------------------

  _handleRequest(notice, intent, result) {
    const at = parseTs(notice.sentAt);
    if (intent.offerIds.length === 0) {
      // 纯资源范围申请（如 N7）
      return this._handleScopeRequest(notice, intent, result);
    }
    for (const id of intent.offerIds) {
      const offer = this.offers.get(id);
      if (!offer) {
        result.warnings.push(`意向 ${id} 不存在。`);
        continue;
      }
      if (!this._canTouchResource(notice.author, offer.resourceId)) {
        result.unauthorized = true;
        this._draft(result, `【无权办理】${notice.author} 不负责 ${this.registry.get(offer.resourceId).site}，${id} 的接受意向被拒绝。`);
        continue;
      }
      if (offer.status === STATUS.CONFIRMED) {
        this._draft(result, `【提示】${id} 已确认，无需重复准备接受。`);
        continue;
      }
      offer.status = STATUS.READY;
      offer.sourceNotices.push(notice.id);
      offer.pendingReason = '对方准备接受，等待值班确认（区别于本轮已确认）';
      this._draft(result, `【准备接受】${id} 标记为“对方准备接受”，尚未确认、未占用容量，等待值班员确认。`);
      this._event('ready', `${id} 进入准备接受`, { offerId: id, noticeId: notice.id }, at);
    }
  }

  _handleScopeRequest(notice, intent, result) {
    const at = parseTs(notice.sentAt);
    const resolved = this._resolveResources(intent, result);
    const window = this._resolveWindow(intent, at, []);
    if (!window || resolved.resourceIds.length === 0) {
      result.warnings.push('资源范围或时段无法确定，申请挂起。');
      return;
    }
    for (const resourceId of resolved.resourceIds) {
      if (!this._canTouchResource(notice.author, resourceId)) {
        result.unauthorized = true;
        this._draft(result, `【无权办理】${notice.author} 不负责 ${this.registry.get(resourceId).site}，该站申请被拒绝。`);
        continue;
      }
      const qty = intent.quantity ?? 0;
      const feasible = this.ledger.feasible(resourceId, window.from, window.to, qty);
      const appId = `APP-${notice.id}-${resourceId}`;
      this.applications ??= new Map();
      this.applications.set(appId, {
        appId,
        noticeId: notice.id,
        at,
        action: 'request',
        quantity: qty,
        resourceIds: [resourceId],
        excludedIds: resolved.excludedIds,
        from: window.from,
        to: window.to,
        windowBasis: window.basis,
        acceptance: 'independent',
        status: feasible ? 'open' : 'blocked',
        note: feasible ? null : '自由容量不足，与既有占用竞争',
      });
      const site = this.registry.get(resourceId).site;
      if (feasible) {
        this._draft(result, `【申请待确认】${site} ${fmtRange(window.from, window.to)} 下调 ${qty} 单位容量可行，等待值班确认后才占用。`);
      } else {
        const blockers = this.ledger.blockers(resourceId, window.from, window.to, qty);
        const who = blockers.flatMap((b) => b.holders.map((h) => h.holdId)).join('、');
        this._draft(result, `【无权确认-容量竞争】${site} ${fmtRange(window.from, window.to)} 需 ${qty} 单位，但自由容量不足（占用方：${who}）。系统不自动确认，请值班先释放容量或择优裁定。`);
      }
      this._event('scope-request', `${notice.id} 对 ${site} 的申请`, { appId, feasible }, at);
    }
  }

  // ---- 值班确认 ------------------------------------------------------------

  _handleConfirm(notice, intent, result) {
    const at = parseTs(notice.sentAt);

    // 值班裁定：解决既有歧义
    if (intent.ruling || intent.noticeRefs.length > 0) {
      return this._handleResolution(notice, intent, result);
    }

    if (intent.offerIds.length === 0) {
      result.warnings.push('确认文本未指向具体意向，请补充编号。');
      return;
    }

    // 整组条件：同组意向必须整组一次接受
    const groupIds = new Set(
      intent.offerIds
        .map((id) => this.offers.get(id))
        .filter((o) => o && o.groupId)
        .map((o) => o.groupId),
    );
    for (const groupId of groupIds) {
      const members = [...this.offers.values()].filter((o) => o.groupId === groupId);
      const named = members.filter((m) => intent.offerIds.includes(m.id));
      const missing = members.filter((m) => !intent.offerIds.includes(m.id));
      if (missing.length > 0 && named.length > 0) {
        this._draft(result,
          `【整组条件未满足】组 ${groupId} 必须整组一次接受，本次只点了 ${named.map((m) => m.id).join('、')}，缺少 ${missing.map((m) => m.id).join('、')}，整组暂不确认。`);
        return;
      }
    }

    for (const id of intent.offerIds) {
      const offer = this.offers.get(id);
      if (!offer) {
        result.warnings.push(`意向 ${id} 不存在。`);
        continue;
      }
      if (offer.status === STATUS.CONFIRMED) {
        this._draft(result, `【提示】${id} 本轮已确认，不重复占用。`);
        continue;
      }
      if (offer.status === STATUS.HELD_AMBIGUOUS) {
        this._draft(result, `【暂缓】${id} 受歧义影响处于暂缓状态，需先由值班裁定歧义，暂不能确认。`);
        continue;
      }
      const qty = offer.currentQuantity;
      if (!this.ledger.feasible(offer.resourceId, offer.from, offer.to, qty)) {
        const blockers = this.ledger.blockers(offer.resourceId, offer.from, offer.to, qty);
        const who = [...new Set(blockers.flatMap((b) => b.holders.map((h) => h.holdId)))].join('、');
        offer.status = STATUS.PENDING;
        offer.pendingReason = `容量竞争：自由容量不足，占用方 ${who}`;
        this._draft(result, `【无权确认-竞争】${id}（${this.registry.get(offer.resourceId).site} ${fmtRange(offer.from, offer.to)}，${qty} 单位）与 ${who} 竞争同一允许容量，值班员无权直接确认，须先释放或裁定取舍。`);
        this._event('pending', `${id} 因容量竞争挂起`, { offerId: id, who }, at);
        continue;
      }
      offer.holdId = `hold:${id}`;
      this.ledger.hold(offer.holdId, offer.resourceId, offer.from, offer.to, qty,
        { offerId: id, noticeId: notice.id, reason: 'confirmed', at });
      offer.status = STATUS.CONFIRMED;
      offer.pendingReason = null;
      offer.sourceNotices.push(notice.id);
      this._draft(result, `【本轮已确认】${id}（${this.registry.get(offer.resourceId).site} ${fmtRange(offer.from, offer.to)}，${qty} 单位）已占用容量；与“准备接受”相区别。`);
      this._effect(result, `${id} → confirmed，占用 ${qty} 单位`);
      this._event('confirm', `${id} 由 ${notice.author} 确认`, { offerId: id, noticeId: notice.id }, at);
    }

    this._reevaluateWaiting(result, at);
  }

  // ---- 撤回 / 恢复（含歧义）------------------------------------------------

  _handleRevoke(notice, intent, result) {
    const at = parseTs(notice.sentAt);

    // 明确指向意向编号的撤回：来源清楚
    if (intent.offerIds.length > 0) {
      for (const id of intent.offerIds) {
        const offer = this.offers.get(id);
        if (!offer) {
          result.warnings.push(`意向 ${id} 不存在。`);
          continue;
        }
        if (!this._canTouchResource(notice.author, offer.resourceId) && !this._can(notice.author, 'revise')) {
          result.unauthorized = true;
          this._draft(result, `【无权办理】${notice.author} 无权撤回 ${id}（资源不属其协调范围）。`);
          continue;
        }
        this._revokeOffer(offer, notice, intent, result);
      }
      this._reevaluateWaiting(result, at);
      return;
    }

    // 指向“第 N 段 / 前一条 / 刚才”等：结合历史与资源范围生成候选解释
    let targets = this._collectReferencedOffers(intent);
    targets = this._offersBySegment(targets, intent.segmentIndex);
    let scope = null;
    let extraInterpretations = [];

    // 范围词（含共享别名，如“前站”同时指前湾东/西）参与解释
    if (intent.scopeWords.length > 0) {
      scope = this.registry.resolveScope(intent.scopeWords);
      const inScope = targets.filter((o) => scope.candidateIds.includes(o.resourceId));
      if (inScope.length > 0) targets = inScope;
      // 范围词命中多个站点，但部分站点没有对应意向：仍列为一种“无对应意向”的解释
      if (scope.ambiguous) {
        const sitesWithOffer = new Set(targets.map((o) => o.resourceId));
        for (const rid of scope.candidateIds) {
          if (!sitesWithOffer.has(rid)) {
            extraInterpretations.push({
              key: `empty:${rid}`,
              offerId: null,
              resourceId: rid,
              resource: this.registry.describe(rid),
              window: intent.segmentIndex ? `第${intent.segmentIndex}段（资料中无意向）` : '资料中无意向',
              quantity: 0,
              currentStatus: 'no-offer',
            });
          }
        }
      }
    }

    // 更正语（“说反了/更正”）若指向一条仍开放的歧义，作为跟进说明挂到同一歧义单
    const openAmb = intent.correction
      ? this.ambiguities.find((a) =>
          a.status === 'open' &&
          a.interpretations.some((it) => it.offerId && targets.some((t) => t.id === it.offerId)))
      : null;
    if (openAmb) {
      openAmb.followUps ??= [];
      openAmb.followUps.push({ noticeId: notice.id, at, text: notice.text });
      this._draft(result, `【歧义跟进 ${openAmb.id}】${notice.id} 是对该歧义的更正（“${notice.text}”），原承诺继续暂缓，等待值班裁定；与本歧义无关的响应不受影响。`);
      this._event('ambiguity-followup', `${notice.id} 跟进歧义 ${openAmb.id}`, { ambiguityId: openAmb.id }, at);
      return;
    }

    if (targets.length === 0 && extraInterpretations.length === 0) {
      this._draft(result, `【来源不明】无法从现有计划中确定“${intent.clauseRefs.map((c) => c.text).join('；')}”指向的承诺，系统无权据此释放任何容量；请值班员补充明确编号或引用。`);
      this._event('unresolved-revoke', `${notice.id} 撤回来源不明`, { noticeId: notice.id }, at);
      return;
    }

    // 多个合理解释，或共享别名本身有歧义 → 歧义挂起，只挂起该歧义可影响的承诺
    if (targets.length > 1 || extraInterpretations.length > 0 || (intent.correction && targets.length > 0)) {
      this._openAmbiguity(notice, intent, targets, result, extraInterpretations);
      return;
    }

    // 唯一可确定的解释：照常办理
    const [only] = targets;
    this._revokeOffer(only, notice, intent, result);
    this._reevaluateWaiting(result, at);
  }

  _collectReferencedOffers(intent) {
    const found = new Map();
    // N 编号引用
    for (const offer of this._offersFromNoticeRefs(intent.noticeRefs)) found.set(offer.id, offer);
    // “前一条/刚才/前条”：取最近被通知触碰过的意向；
    // 更正/“说反了”针对的恰恰是上一条已造成的变化，因此撤回/可重排状态也纳入候选。
    if (/前一条|前条|刚才|上一条/.test(intent.clauseRefs.map((c) => c.text).join(''))) {
      const touched = [...this.offers.values()]
        .filter((o) => o.sourceNotices.length > 0)
        .sort((a, b) => Math.max(...a.history.map((h) => h.at), 0) - Math.max(...b.history.map((h) => h.at), 0));
      for (const offer of touched) found.set(offer.id, offer);
    }
    return [...found.values()];
  }

  _openAmbiguity(notice, intent, targets, result, extraInterpretations = []) {
    const at = parseTs(notice.sentAt);
    const interpretations = [
      ...targets.map((offer) => ({
        key: offer.id,
        offerId: offer.id,
        resource: this.registry.describe(offer.resourceId),
        window: fmtRange(offer.from, offer.to),
        quantity: offer.currentQuantity,
        currentStatus: offer.status,
      })),
      ...extraInterpretations,
    ];
    const ambiguity = {
      id: `AMB-${notice.id}`,
      noticeId: notice.id,
      openedAt: at,
      sourceText: notice.text,
      clause: intent.clauseRefs.map((c) => c.text).join('；'),
      action: intent.action,
      interpretations,
      followUps: [],
      status: 'open',
      resolvedBy: null,
      chosenKey: null,
    };
    this.ambiguities.push(ambiguity);

    // 只有该歧义可影响的承诺暂缓（容量暂挂）；无关响应继续有效。
    for (const offer of targets) {
      if ([STATUS.CONFIRMED, STATUS.READY, STATUS.PENDING].includes(offer.status)) {
        if (offer.status === STATUS.CONFIRMED && offer.holdId &&
            this.ledger.holdersAt(offer.resourceId, offer.from, offer.to).includes(offer.holdId)) {
          this.ledger.release(offer.holdId, { noticeId: notice.id, reason: 'ambiguity-hold', at });
        }
        offer.status = STATUS.HELD_AMBIGUOUS;
        offer.pendingReason = `歧义 ${ambiguity.id} 暂缓`;
        offer.ambiguityId = ambiguity.id;
      }
    }

    const lines = interpretations.map((it, i) =>
      `  解释${'一二三四'[i] ?? i + 1}：${it.offerId ?? '（无意向）'}（${it.resource}，${it.window}，${it.quantity} 单位，当前 ${it.currentStatus}）`);
    this._draft(result,
      `【歧义挂起 ${ambiguity.id}】“${ambiguity.clause}”存在 ${interpretations.length} 种合理解释，涉及资源与时段如下：\n` +
      lines.join('\n') +
      `\n仅上述承诺暂缓（容量已暂挂），其余确定的解释与承诺继续办理；请值班员裁定后恢复或撤回。`);
    this._event('ambiguity-open', `${notice.id} 产生歧义 ${ambiguity.id}`, {
      ambiguityId: ambiguity.id,
      offerId: targets.length === 1 ? targets[0].id : null,
      offerIds: targets.map((t) => t.id),
    }, at);
  }

  _handleResolution(notice, intent, result) {
    const at = parseTs(notice.sentAt);
    const rulingText = intent.clauseRefs.map((c) => c.text).join('');
    // 裁定文本引用的可能是歧义单本身的通知，也可能是其跟进通知（如 N6 跟进 AMB-N5）
    const ambiguity = [...this.ambiguities].reverse().find((a) => {
      const followUpIds = (a.followUps ?? []).map((f) => f.noticeId);
      return a.status === 'open' && (
        intent.noticeRefs.includes(a.noticeId) ||
        followUpIds.some((id) => intent.noticeRefs.includes(id)) ||
        rulingText.includes(a.noticeId) ||
        followUpIds.some((id) => rulingText.includes(id))
      );
    });
    if (!ambiguity) {
      result.warnings.push('裁定未找到对应的开放歧义，请人工核对引用。');
      return;
    }
    // “解释一/解释二” → 候选序号
    const m = intent.clauseRefs.map((c) => c.text).join('').match(/解释\s*(\d+|一|二|两|三|四)/);
    const ordMap = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4 };
    const idx = m ? (ordMap[m[1]] ?? Number(m[1])) - 1 : 0;
    const chosen = ambiguity.interpretations[Math.max(0, idx)];
    ambiguity.status = 'resolved';
    ambiguity.resolvedBy = notice.id;
    ambiguity.chosenKey = chosen.key;

    const chosenOffer = this.offers.get(chosen.offerId);
    const heldOffers = [...this.offers.values()].filter((o) => o.ambiguityId === ambiguity.id);

    for (const offer of heldOffers) {
      if (offer.id === chosenOffer.id) {
        // 选中的解释按原动作办理（恢复=重新确认占用；撤回=彻底释放）
        if (ambiguity.action === 'withdraw') {
          this._revokeOffer(offer, notice, { action: 'withdraw', clauseRefs: intent.clauseRefs }, result, ambiguity.id);
        } else {
          offer.status = STATUS.CONFIRMED;
          offer.pendingReason = null;
          offer.ambiguityId = null;
          offer.holdId = offer.holdId ?? `hold:${offer.id}`;
          if (this.ledger.feasible(offer.resourceId, offer.from, offer.to, offer.currentQuantity)) {
            this.ledger.hold(offer.holdId, offer.resourceId, offer.from, offer.to, offer.currentQuantity,
              { offerId: offer.id, noticeId: notice.id, reason: 'ambiguity-restore', at });
            this._draft(result, `【裁定恢复】${offer.id} 按选定解释恢复为已确认，容量重新占用。`);
          } else {
            offer.status = STATUS.PENDING;
            offer.pendingReason = '恢复时容量已被竞争占用，等待值班再裁定';
            this._draft(result, `【恢复受阻】${offer.id} 恢复时容量不足，转待裁定，不自动抢占。`);
          }
        }
      } else {
        // 未选中的解释：对应承诺回到暂缓前的就绪/候选态，不被错误作废
        offer.ambiguityId = null;
        offer.status = offer.history.length ? STATUS.READY : STATUS.CANDIDATE;
        offer.pendingReason = '歧义已裁定为其它解释，本承诺恢复暂缓前状态';
        this._draft(result, `【不受影响】${offer.id} 与选定解释无关，恢复为暂缓前状态（${offer.status}），未作废。`);
      }
    }

    this._event('ambiguity-resolve', `${ambiguity.id} 由 ${notice.id} 裁定`, {
      ambiguityId: ambiguity.id,
      chosen: chosen.key,
      offerId: chosenOffer.id,
    }, at);
    this._reevaluateWaiting(result, at);
  }

  // 撤回单笔意向：释放容量；整组中一段失效则整组失效；给出替代时段
  _revokeOffer(offer, notice, intent, result, ambiguityId = null) {
    const at = parseTs(notice.sentAt);
    if (offer.status === STATUS.WITHDRAWN) {
      this._draft(result, `【提示】${offer.id} 已处于撤回状态，不重复释放。`);
      return;
    }
    const wasConfirmed = offer.status === STATUS.CONFIRMED || offer.status === STATUS.HELD_AMBIGUOUS;
    if (offer.holdId && this.ledger.holdersAt(offer.resourceId, offer.from, offer.to).includes(offer.holdId)) {
      this.ledger.release(offer.holdId, { noticeId: notice.id, reason: intent.action, at });
    }
    offer.status = STATUS.WITHDRAWN;
    offer.pendingReason = null;
    offer.ambiguityId = ambiguityId;
    offer.sourceNotices.push(notice.id);

    const altText = offer.alternatives.length
      ? `可改约替代时段：${offer.alternatives.map((a) => `${fmtRange(a.from, a.to)} ${a.quantity} 单位（${a.id}）`).join('；')}`
      : '资料中无替代时段';
    this._draft(result,
      `【${intent.action === 'restore' ? '恢复处理' : '撤回'}】${offer.id}（${this.registry.get(offer.resourceId).site} ${fmtRange(offer.from, offer.to)}）${wasConfirmed ? '已确认承诺被授权文本改变，容量已释放' : '申请撤回，未占用容量'}。${altText}。`);
    this._effect(result, `${offer.id} → withdrawn，释放 ${offer.currentQuantity} 单位`);
    this._event('revoke', `${notice.id} ${intent.action} ${offer.id}`, { offerId: offer.id }, at);

    // 整组联动：同组其它已确认段一并失效，标为可重排
    if (offer.groupId) {
      const siblings = [...this.offers.values()].filter(
        (o) => o.groupId === offer.groupId && o.id !== offer.id &&
        [STATUS.CONFIRMED, STATUS.READY, STATUS.HELD_AMBIGUOUS].includes(o.status),
      );
      for (const sib of siblings) {
        if (sib.holdId && this.ledger.holdersAt(sib.resourceId, sib.from, sib.to).includes(sib.holdId)) {
          this.ledger.release(sib.holdId, { noticeId: notice.id, reason: 'group-invalidated', at });
        }
        sib.status = STATUS.RESCHEDULABLE;
        sib.pendingReason = `整组 ${offer.groupId} 因 ${offer.id} 被撤回而整组失效`;
        const sibAlt = sib.alternatives.length
          ? `替代时段 ${sib.alternatives.map((a) => fmtRange(a.from, a.to)).join('、')}`
          : '无替代时段';
        this._draft(result,
          `【整组失效】${sib.id} 与 ${offer.id} 同属组 ${offer.groupId}（整组一次接受条件），一段失效导致该段不能单独保留，已释放容量并标记可重排（${sibAlt}）。`);
        this._effect(result, `${sib.id} → reschedulable`);
        this._event('group-invalidate', `${sib.id} 因整组联动失效`, { offerId: sib.id, groupId: offer.groupId, trigger: offer.id }, at);
      }
    }
  }

  // 容量变化后重算等待中的申请：新释放的容量可给谁
  _reevaluateWaiting(result, at) {
    const waiting = [...this.offers.values()].filter((o) => o.status === STATUS.PENDING);
    for (const offer of waiting) {
      if (this.ledger.feasible(offer.resourceId, offer.from, offer.to, offer.currentQuantity)) {
        offer.pendingReason = '容量已腾出，具备确认条件，仍需值班明确确认（系统不自动确认）';
        this._draft(result, `【机会重开】${offer.id} 所需容量现已空闲，可重新安排；但需值班员明确确认后才会占用。`);
        this._event('reevaluate', `${offer.id} 重新具备确认条件`, { offerId: offer.id }, at);
      }
    }
    if (this.applications) {
      for (const app of this.applications.values()) {
        if (app.status === 'blocked') {
          const ok = app.resourceIds.every((rid) =>
            this.ledger.feasible(rid, app.from, app.to, app.quantity));
          if (ok) {
            app.status = 'open';
            app.note = '容量释放后恢复可确认，等待值班确认';
            this._draft(result, `【申请解冻】${app.appId} 竞争容量已腾出，可提交值班确认。`);
          }
        }
      }
    }
  }


  // ---- 报告与交接回查 ------------------------------------------------------

  report() {
    return {
      drill: this.data.drill,
      generatedAt: Date.now(),
      noticeResults: this.noticeResults,
      offers: [...this.offers.values()].map((o) => this._offerView(o)),
      applications: this.applications ? [...this.applications.values()] : [],
      ambiguities: this.ambiguities,
      ledger: this._ledgerView(),
      events: this.log,
    };
  }

  _offerView(o) {
    const resource = this.registry.get(o.resourceId);
    return {
      id: o.id,
      resourceId: o.resourceId,
      site: resource.site,
      category: resource.category,
      from: fmtTs(o.from),
      to: fmtTs(o.to),
      originalQuantity: o.originalQuantity,
      currentQuantity: o.currentQuantity,
      kind: o.kind,
      groupId: o.groupId ?? null,
      segmentIndex: o.segmentIndex ?? null,
      status: o.status,
      holdId: o.holdId,
      pendingReason: o.pendingReason,
      sourceNotices: o.sourceNotices,
      alternatives: o.alternatives.map((a) => ({
        id: a.id,
        from: fmtTs(a.from),
        to: fmtTs(a.to),
        quantity: a.quantity,
      })),
      history: o.history,
    };
  }

  _ledgerView() {
    const out = [];
    for (const [key, cell] of this.ledger.cells) {
      const [resourceId, gs] = key.split('|');
      out.push({
        resourceId,
        site: this.registry.get(resourceId).site,
        slotStart: fmtTs(Number(gs)),
        slotEnd: fmtTs(Number(gs) + 30 * MINUTE),
        capacity: cell.capacity,
        free: cell.free,
        occupied: cell.capacity - cell.free,
        holds: [...cell.holds.entries()].map(([holdId, qty]) => ({ holdId, qty })),
      });
    }
    return out.sort((a, b) => a.slotStart.localeCompare(b.slotStart) || a.resourceId.localeCompare(b.resourceId));
  }

  // 交接：按演练时点 cutoff 回查“收到什么、确认过什么、变化如何影响占用与答复”
  handover(cutoffText) {
    const cutoff = parseTs(cutoffText);
    const noticesBefore = this.noticeResults.filter((r) => r.sentAt <= cutoff);
    const eventsBefore = this.log.filter((e) => e.at == null || e.at <= cutoff);
    const offersBefore = [...this.offers.values()].map((o) => {
      const view = this._offerView(o);
      view.atCutoff = this._statusAt(o, cutoff);
      return view;
    });
    const openAmbiguities = this.ambiguities.filter(
      (a) => a.openedAt <= cutoff &&
        (a.status !== 'resolved' ||
          (a.resolvedBy && parseTs(this._noticeTime(a.resolvedBy)) > cutoff)),
    );
    return {
      drillId: this.data.drill.id,
      cutoff: fmtTs(cutoff),
      received: noticesBefore.map((r) => ({
        noticeId: r.noticeId,
        at: fmtTs(r.sentAt),
        author: r.author,
        text: r.text,
        duplicateOf: r.duplicateOf,
        unauthorized: r.unauthorized,
      })),
      confirmedByCutoff: offersBefore
        .filter((o) => o.atCutoff === STATUS.CONFIRMED)
        .map((o) => ({ offerId: o.id, site: o.site, window: `${o.from}-${o.to.slice(11)}`, quantity: o.currentQuantity })),
      openAmbiguities: openAmbiguities.map((a) => ({
        id: a.id,
        source: a.sourceText,
        interpretations: a.interpretations,
      })),
      offers: offersBefore,
      events: eventsBefore,
      ledgerAtCutoff: this._ledgerViewAt(cutoff),
    };
  }

  // 截止时点台账：按事件流重放，而非直接读最终态
  _ledgerViewAt(cutoff) {
    return this.ledger
      .reconstructAt(cutoff)
      .map((cell) => ({
        resourceId: cell.resourceId,
        site: this.registry.get(cell.resourceId).site,
        slotStart: fmtTs(cell.gs),
        slotEnd: fmtTs(cell.gs + 30 * MINUTE),
        capacity: cell.capacity,
        free: cell.free,
        occupied: cell.occupied,
        holds: cell.holds,
      }))
      .sort((a, b) => a.slotStart.localeCompare(b.slotStart) || a.resourceId.localeCompare(b.resourceId));
  }

  _noticeTime(noticeId) {
    const n = this.data.notices.find((x) => x.id === noticeId);
    return n ? n.sentAt : '1970-01-01T00:00:00+08:00';
  }

  // 依据历史事件重建意向在 cutoff 时点的状态
  _statusAt(offer, cutoff) {
    let status = offer.confirmedAt && offer.confirmedAt <= cutoff ? STATUS.CONFIRMED : STATUS.CANDIDATE;
    const timeline = [
      ...offer.history.map((h) => ({ at: h.at, kind: 'adjust' })),
      ...this.log.filter((e) => {
        if (e.at == null || e.at > cutoff) return false;
        const d = e.detail ?? {};
        return d.offerId === offer.id || (Array.isArray(d.offerIds) && d.offerIds.includes(offer.id));
      }),
    ].sort((a, b) => a.at - b.at);
    for (const ev of timeline) {
      if (ev.at > cutoff) break;
      switch (ev.kind) {
        case 'ready': status = STATUS.READY; break;
        case 'confirm': status = STATUS.CONFIRMED; break;
        case 'pending': status = STATUS.PENDING; break;
        case 'ambiguity-open': status = STATUS.HELD_AMBIGUOUS; break;
        case 'ambiguity-resolve': status = STATUS.CONFIRMED; break;
        case 'revoke': status = STATUS.WITHDRAWN; break;
        case 'group-invalidate': status = STATUS.RESCHEDULABLE; break;
        default:
      }
    }
    return status;
  }}

export { STATUS };
