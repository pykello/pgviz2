import { test } from 'node:test';
import assert from 'node:assert/strict';
import { integer, keyLabel, normalizeNode, sample } from '../src/shared/tree';
import type { BtreeStats, RawIndexItem } from '../src/shared/types';
const stats: BtreeStats = { blkno: 1, type: 'r', live_items: 1, dead_items: 0, avg_item_size: 16, page_size: 8192, free_size: 8000, btpo_prev: 0, btpo_next: 0, btpo_level: 0, btpo_flags: 3 };
const row: RawIndexItem = { itemoffset: 1, ctid: '(5,8194)', itemlen: 32, data: 'f6 ff ff ff 00 00 00 00', nulls: false, vars: false, dead: false, htid: '(0,1)', tids: ['(0,1)', '(0,2)'] };
test('a root at level zero is a leaf, and posting ctid is never a downlink', () => {
  const n = normalizeNode(stats, [row]); assert.equal(n.leaf, true); assert.deepEqual(n.children, []); assert.deepEqual(n.items[0]!.heapTids, ['(0,1)', '(0,2)']);
});
test('high key is excluded, first real pivot is minus infinity', () => {
  const n = normalizeNode({ ...stats, btpo_level: 1, btpo_next: 7 }, [row, { ...row, itemoffset: 2, ctid: '(9,0)' }]);
  assert.equal(n.items[0]!.highKey, true); assert.equal(n.items[0]!.child, null); assert.deepEqual(n.children, [9]); assert.equal(n.items[1]!.minusInfinity, true);
});
test('readable labels are preferred while unknown values and explicit raw mode retain bytes', () => {
  const i = normalizeNode(stats, [row]).items[0]!;
  assert.equal(keyLabel({ ...i, value: '-10' }), '-10'); assert.match(keyLabel({ ...i, value: '-10' }, 'integer', 'raw'), /^f6 ff/);
  assert.equal(keyLabel(i, 'integer', 'little'), '-10'); assert.match(keyLabel(i, 'integer'), /^f6 ff/); assert.match(keyLabel(i, 'text', 'little'), /^f6 ff/);
});
test('summary retains first two and last; input ranges reject invalid values', () => {
  assert.deepEqual(sample([1, 2, 3, 4, 5]), [1, 2, 5]); assert.deepEqual(sample([]), []);
  for (const v of [-1, '1;SELECT', 'NaN', '1.5', undefined, 4294967296]) assert.throws(() => integer(v, 'Block'));
  assert.throws(() => integer(0, 'Block', 0, -1)); assert.equal(integer('42', 'Block'), 42);
});
