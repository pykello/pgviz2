import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heapRegions } from '../src/shared/heap-layout';
import { Demo } from '../src/server/demo';

test('heap regions preserve exact headers, null bitmaps, padding and data', async () => {
  const page = await new Demo().request('heap', { oid: '2', block: '0' });
  const tuple = page.items[0]!;
  tuple.t_hoff = 32; tuple.t_infomask = 1; tuple.t_infomask2 = 9;
  const ranges = heapRegions(page).filter(r => r.tuple === tuple);
  assert.deepEqual(ranges.map(r => [r.kind, r.start, r.end]), [
    ['tuple-header', 8072, 8095], ['bitmap', 8095, 8097],
    ['padding', 8097, 8104], ['tuple', 8104, 8184],
  ]);
  assert.equal(heapRegions(page)[0]!.end, 24);
  assert.equal(heapRegions(page)[1]!.start, 24);
});

test('adjacent tuples may share a cell without sharing header bytes', async () => {
  const page = await new Demo().request('heap', { oid: '2', block: '0' });
  page.items[1]!.lp_len = 120;
  const ranges = heapRegions(page).filter(r => r.start < 8080 && r.end > 8064);
  assert.deepEqual(ranges.map(r => [r.tuple?.lp, r.kind, Math.max(8064, r.start), Math.min(8080, r.end)]), [
    [2, 'tuple', 8064, 8072], [1, 'tuple-header', 8072, 8080],
  ]);
  page.items[0]!.lp_flags = 2;
  assert.equal(heapRegions(page).some(r => r.tuple?.lp === 1), false);
});
