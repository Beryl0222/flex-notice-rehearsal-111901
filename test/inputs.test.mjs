import test from 'node:test';
import assert from 'node:assert/strict';
import { readInputs } from '../scripts/inspect.mjs';

const data = await readInputs();

test("演练意向引用存在的资源及跨日时间", () => {
  for (const offer of data.offers) {
    const resource = data.resources.find(item => item.id === offer.resourceId);
    assert.ok(resource && offer.quantity <= resource.capacity);
    assert.ok(Date.parse(offer.from) < Date.parse(offer.to));
  }
  assert.ok(data.notices.every(notice => data.roles.some(role => role.id === notice.author)));
});
