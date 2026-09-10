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
