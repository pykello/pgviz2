import type { BtreeNode, IndexItem } from '../shared/types';

export interface IndexColumn { name: string; type: string; oid: number; length: number; alignment: 'c' | 's' | 'i' | 'd' }
export interface KeyContext { columns: IndexColumn[]; keyCount: number; littleEndian: boolean; encoding: string }

// PostgreSQL 18 nbtree.h: BTMAGIC in BTMetaPageData, after the 24-byte page header.
export function btreeByteOrder(meta: Buffer): boolean | undefined {
  if (meta.length < 28) return undefined;
  if (meta.readUInt32LE(24) === 0x053162) return true;
  if (meta.readUInt32BE(24) === 0x053162) return false;
  return undefined;
}
function decodeText(bytes: Buffer, encoding: string): string | undefined {
  if (encoding === 'UTF8') return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (encoding === 'LATIN1') return bytes.toString('latin1');
  if (bytes.every(b => b < 128)) return bytes.toString('ascii');
  return undefined;
}
function numeric(bytes: Buffer, little: boolean): string | undefined {
  if (bytes.length < 2) return undefined;
  const u16 = (i: number) => little ? bytes.readUInt16LE(i) : bytes.readUInt16BE(i);
  const sign = u16(0), flag = sign & 0xc000;
  if (flag === 0xc000) return ({ 0xc000: 'NaN', 0xd000: 'Infinity', 0xf000: '-Infinity' } as Record<number, string>)[sign];
  const short = flag === 0x8000;
  if (!short && bytes.length < 4) return undefined;
  const negative = short ? !!(sign & 0x2000) : flag === 0x4000;
  const scale = short ? (sign & 0x1f80) >> 7 : sign & 0x3fff;
  const weight = short ? (sign & 0x3f) - (sign & 0x40 ? 64 : 0) : little ? bytes.readInt16LE(2) : bytes.readInt16BE(2);
  // Keep unexpectedly huge values in hex instead of allocating giant labels.
  if (Math.abs(weight) > 1000 || scale > 4000) return undefined;
  const digits: number[] = [];
  for (let i = short ? 2 : 4; i < bytes.length; i += 2) { const digit = u16(i); if (digit > 9999) return undefined; digits.push(digit); }
  const group = (position: number) => String(digits[weight - position] ?? 0).padStart(4, '0');
  let whole = ''; for (let position = Math.max(0, weight); position >= 0; position--) whole += group(position);
  whole = whole.replace(/^0+(?=\d)/, '');
  let fraction = ''; for (let position = -1; fraction.length < scale; position--) fraction += group(position);
  return (negative ? '-' : '') + whole + (scale ? '.' + fraction.slice(0, scale) : '');
}
function scalar(oid: number, b: Buffer, little: boolean, encoding: string): string | undefined {
  switch (oid) {
    case 16: return b[0] === 0 ? 'false' : b[0] === 1 ? 'true' : undefined;
    case 21: return String(little ? b.readInt16LE() : b.readInt16BE());
    case 23: return String(little ? b.readInt32LE() : b.readInt32BE());
    case 20: return String(little ? b.readBigInt64LE() : b.readBigInt64BE());
    case 26: return String(little ? b.readUInt32LE() : b.readUInt32BE());
    case 700: return String(little ? b.readFloatLE() : b.readFloatBE());
    case 701: return String(little ? b.readDoubleLE() : b.readDoubleBE());
    case 25: case 1043: case 1042: {
      const text = decodeText(b, encoding); return text === undefined ? undefined : JSON.stringify(oid === 1042 ? text.trimEnd() : text);
    }
    case 1700: return numeric(b, little);
    case 2950: { const h = b.toString('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; }
    default: return undefined;
  }
}
/** Decode PostgreSQL 18's actual index tuple payload; never look up a newer heap row. */
export function decodeIndexKey(item: IndexItem, page: Buffer, context: KeyContext): string | undefined {
  if (item.minusInfinity) return '−∞';
  try {
    const { littleEndian: little, columns, keyCount, encoding } = context;
    const u16 = (i: number) => little ? page.readUInt16LE(i) : page.readUInt16BE(i);
    const pointer = 24 + (item.itemoffset - 1) * 4;
    const line = little ? page.readUInt32LE(pointer) : page.readUInt32BE(pointer);
    const offset = little ? line & 0x7fff : line >>> 17;
    const info = u16(offset + 6);
    if (offset < 24 || offset + item.itemlen > page.length || (info & 0x1fff) !== item.itemlen || !!(info & 0x8000) !== item.nulls) return undefined;
    const pivot = (item.highKey || item.child !== null) && !!(info & 0x2000);
    const stored = pivot ? u16(offset + 4) & 0x0fff : columns.length;
    if (stored > columns.length) return undefined;
    const bytes = Buffer.from(item.data.replaceAll(' ', ''), 'hex');
    let cursor = 0;
    const values: string[] = [];
    for (let i = 0; i < keyCount; i++) {
      if (i >= stored) { values.push('−∞'); continue; }
      if (item.nulls && !(page[offset + 8 + Math.floor(i / 8)]! & (1 << (i % 8)))) { values.push('NULL'); continue; }
      const column = columns[i]; if (!column) return undefined;
      const align = { c: 1, s: 2, i: 4, d: 8 }[column.alignment];
      if (!align) return undefined;
      let value: Buffer;
      if (column.length === -1) {
        if (!bytes[cursor]) cursor = Math.ceil(cursor / align) * align;
        const first = bytes[cursor]; if (first === undefined) return undefined;
        const short = little ? !!(first & 1) : !!(first & 0x80);
        if (short) {
          const length = little ? first >>> 1 : first & 0x7f;
          if (length < 1 || cursor + length > bytes.length) return undefined; // excludes external TOAST pointers
          value = bytes.subarray(cursor + 1, cursor + length); cursor += length;
        } else {
          const header = little ? bytes.readUInt32LE(cursor) : bytes.readUInt32BE(cursor);
          if (little ? (header & 3) !== 0 : (header >>> 30) !== 0) return undefined; // compressed varlena is left raw
          const length = little ? header >>> 2 : header & 0x3fffffff;
          if (length < 4 || cursor + length > bytes.length) return undefined;
          value = bytes.subarray(cursor + 4, cursor + length); cursor += length;
        }
      } else {
        cursor = Math.ceil(cursor / align) * align;
        if (column.length < 1 || cursor + column.length > bytes.length) return undefined;
        value = bytes.subarray(cursor, cursor + column.length); cursor += column.length;
      }
      const decoded = scalar(column.oid, value, little, encoding);
      if (decoded === undefined) return undefined;
      values.push(decoded);
    }
    return values.length === 1 ? values[0] : '(' + values.join(', ') + ')';
  } catch { return undefined; } // unknown, compressed, truncated or corrupt data remains inspectable as hex
}
export function labelNode(node: BtreeNode, page: Buffer, context: KeyContext): BtreeNode {
  for (const item of node.items) { const value = decodeIndexKey(item, page, context); if (value !== undefined) item.value = value; }
  return node;
}

/** pageinspect supplies each heap attribute including its varlena header. */
export function decodeHeapAttribute(bytes: Buffer, column: IndexColumn, little: boolean, encoding: string): string | undefined {
  try {
    let value = bytes;
    if (column.length === -1) {
      const first = bytes[0]; if (first === undefined) return undefined;
      const short = little ? !!(first & 1) : !!(first & 0x80);
      if (short) {
        const length = little ? first >>> 1 : first & 0x7f;
        if (length < 1 || length !== bytes.length) return undefined;
        value = bytes.subarray(1);
      } else {
        const header = little ? bytes.readUInt32LE() : bytes.readUInt32BE();
        if (little ? (header & 3) !== 0 : (header >>> 30) !== 0) return undefined;
        const length = little ? header >>> 2 : header & 0x3fffffff;
        if (length < 4 || length !== bytes.length) return undefined;
        value = bytes.subarray(4);
      }
    } else if (column.length < 1 || bytes.length !== column.length) return undefined;
    return scalar(column.oid, value, little, encoding);
  } catch { return undefined; }
}
