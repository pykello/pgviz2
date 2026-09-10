import { test } from 'node:test';
import assert from 'node:assert/strict';
import { btreeByteOrder, decodeIndexKey, type KeyContext } from '../src/server/keys';
import type { IndexItem } from '../src/shared/types';
const item: IndexItem = { itemoffset: 1, ctid: '(0,1)', itemlen: 16, data: '', nulls: false, vars: false, dead: false, htid: '(0,1)', tids: null, heapTids: ['(0,1)'], child: null, highKey: false, minusInfinity: false };
for (const little of [true, false]) test(`decode actual tuple header and signed keys (${little ? 'little' : 'big'} endian)`, () => {
  const meta = Buffer.alloc(8192); if (little) meta.writeUInt32LE(0x053162, 24); else meta.writeUInt32BE(0x053162, 24);
  assert.equal(btreeByteOrder(meta), little);
  const page = Buffer.alloc(8192), data = Buffer.alloc(8);
  if (little) { page.writeUInt32LE(8000 + (1 << 15) + (16 << 17), 24); page.writeUInt16LE(16, 8006); data.writeBigInt64LE(-9223372036854775808n); }
  else { page.writeUInt32BE((8000 * 2 ** 17) + (1 << 15) + 16, 24); page.writeUInt16BE(16, 8006); data.writeBigInt64BE(-9223372036854775808n); }
  const context: KeyContext = { columns: [{ name: 'id', type: 'bigint', oid: 20, length: 8, alignment: 'd' }], keyCount: 1, littleEndian: little, encoding: 'UTF8' };
  const entry = { ...item, data: data.toString('hex').match(/../g)!.join(' ') };
  assert.equal(decodeIndexKey(entry, page, context), '-9223372036854775808');
  assert.equal(decodeIndexKey(entry, Buffer.alloc(3), context), undefined);
  assert.equal(decodeIndexKey(entry, page, { ...context, columns: [{ ...context.columns[0]!, oid: 99999 }] }), undefined);
});

test('heap attributes decode both byte orders and reject external or malformed data', async () => {
  const { decodeHeapAttribute } = await import('../src/server/keys');
  const column = { name: 'v', type: 'bigint', oid: 20, length: 8, alignment: 'd' as const };
  for (const little of [true, false]) {
    const bytes = Buffer.alloc(8);
    if (little) bytes.writeBigInt64LE(9223372036854775807n); else bytes.writeBigInt64BE(9223372036854775807n);
    assert.equal(decodeHeapAttribute(bytes, column, little, 'UTF8'), '9223372036854775807');
    assert.equal(decodeHeapAttribute(bytes.subarray(1), column, little, 'UTF8'), undefined);
    const text = { ...column, oid: 25, length: -1 };
    assert.equal(decodeHeapAttribute(Buffer.from([little ? 7 : 0x83, 104, 105]), text, little, 'UTF8'), '"hi"');
    assert.equal(decodeHeapAttribute(Buffer.from([little ? 1 : 0x80, 18, 0, 0]), text, little, 'UTF8'), undefined);
  }
});
