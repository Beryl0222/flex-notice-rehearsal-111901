import test from 'node:test';
import assert from 'node:assert/strict';
import { readInputs } from '../scripts/inspect.mjs';
import { ResourceRegistry } from '../scripts/lib/resources.mjs';

const data = await readInputs();
const registry = new ResourceRegistry(data.resources);

test('商区词命中该商区全部站点，类别例外按资源类别剔除', () => {
  const scope = registry.resolveScope(['前湾']);
  assert.deepEqual(scope.candidateIds.sort(), ['R1', 'R2']);
  const exclusion = registry.resolveExclusion('医疗');
  assert.deepEqual(exclusion.excluded.sort(), ['R2', 'R4']);
  const { kept, removed } = registry.applyExclusion(scope.candidateIds, exclusion);
  assert.deepEqual(kept, ['R1']);
  assert.deepEqual(removed, ['R2']);
});

test('共享别名在多站点间产生歧义，全称不歧义', () => {
  const ambiguous = registry.resolveScope(['前站']);
  assert.equal(ambiguous.ambiguous, true);
  assert.equal(ambiguous.candidateIds.length, 2);
  const exact = registry.resolveScope(['前湾西']);
  assert.equal(exact.ambiguous, false);
  assert.deepEqual(exact.candidateIds, ['R2']);
});

test('最长匹配：站点全称出现时不重复计入商区短词', () => {
  const scope = registry.resolveScope(['前湾', '前湾西']);
  assert.deepEqual(scope.candidateIds, ['R2']);
});

test('医院与医疗视为同一类别口径', () => {
  const a = registry.resolveExclusion('医院');
  const b = registry.resolveExclusion('医疗');
  assert.equal(a.category, '医疗');
  assert.deepEqual(a.excluded, b.excluded);
});
