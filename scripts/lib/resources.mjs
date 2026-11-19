// 资源口径：站点名、别名、类别、原始容量。
// 解析任何通知时都通过这里解析资源，并保留“当时可用的资源口径”快照，便于回查。

export const CATEGORY_SYNONYMS = {
  医疗: '医疗',
  医院: '医疗',
  商用: '商用',
  商业: '商用',
};

// 场地词 → 站点名前缀。资源 site 以该词开头即属于该商区。
const AREA_PREFIXES = ['前湾', '后湾'];

export class ResourceRegistry {
  constructor(resources) {
    this.resources = resources.map((r) => ({ ...r }));
    this.byId = new Map(this.resources.map((r) => [r.id, r]));
  }

  get(id) {
    const r = this.byId.get(id);
    if (!r) throw new Error(`资料中不存在资源 ${id}`);
    return r;
  }

  // 某时点的口径快照（本演练资源主数据不变，快照仍逐时点留痕）
  snapshotAt(_epochMs) {
    return this.resources.map((r) => ({ ...r }));
  }

  // 类别例外：返回“被排除的资源 id 集合”与排除依据
  resolveExclusion(categoryWord) {
    const category = CATEGORY_SYNONYMS[categoryWord];
    if (!category) return { category: null, excluded: [], basis: null };
    const excluded = this.resources
      .filter((r) => r.category === category)
      .map((r) => r.id);
    return {
      category,
      excluded,
      basis: `类别「${categoryWord}」→ ${category} 类：${excluded.join('、') || '无'}`,
    };
  }

  // 解析范围词（商区词 / 站点名 / 别名），返回候选资源与歧义标记。
  // 别名可能被多个站点共用（如“前站”同时指前湾东/西），此时逐条列出候选。
  // 采用最长匹配：出现“前湾西”这类全称时，不再把商区词“前湾”重复计入。
  resolveScope(words) {
    const candidates = [];
    const push = (resource, matchedBy) => {
      if (!candidates.some((c) => c.resourceId === resource.id)) {
        candidates.push({ resourceId: resource.id, matchedBy });
      }
    };

    // 若存在被更长词包含的短词（如“前湾”⊂“前湾西”），短词视为排版包含，丢弃。
    const effective = words.filter((w) => !words.some((other) => other !== w && other.includes(w)));

    for (const word of effective) {
      if (AREA_PREFIXES.includes(word)) {
        for (const r of this.resources) {
          if (r.site.startsWith(word)) push(r, `商区「${word}」`);
        }
        continue;
      }
      const exact = this.resources.find((r) => r.site === word);
      if (exact) {
        push(exact, `站点全称「${word}」`);
        continue;
      }
      const byAlias = this.resources.filter((r) => r.aliases.includes(word));
      for (const r of byAlias) push(r, `别名「${word}」`);
    }

    const uniqueIds = [...new Set(candidates.map((c) => c.resourceId))];
    const ambiguous = uniqueIds.length > 1;
    return {
      candidateIds: uniqueIds,
      matches: candidates,
      ambiguous,
      reason: ambiguous
        ? `范围词在 ${uniqueIds.length} 个站点间有歧义：` +
          uniqueIds
            .map((id) => `${this.get(id).site}（${this.describe(id)}）`)
            .join('、')
        : null,
    };
  }

  describe(id) {
    const r = this.get(id);
    return `${r.site}/${r.category}/容量${r.capacity}`;
  }

  // 在候选资源上应用类别例外
  applyExclusion(candidateIds, exclusion) {
    if (!exclusion || exclusion.excluded.length === 0) {
      return { kept: candidateIds, removed: [] };
    }
    const removed = candidateIds.filter((id) => exclusion.excluded.includes(id));
    const kept = candidateIds.filter((id) => !exclusion.excluded.includes(id));
    return { kept, removed };
  }
}
