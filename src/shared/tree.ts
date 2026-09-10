import type { BtreeNode, BtreeStats, IndexItem, RawIndexItem } from './types';
export class InputError extends Error {}
export function integer(value: unknown, name: string, low = 0, high = 4294967295): number {
  if (!/^\d+$/.test(String(value)) || Number(value) < low || Number(value) > high)
    throw new InputError(`${name} must be an integer from ${low} to ${high}.`);
  return Number(value);
}
export function sample<T>(items: T[], count = 3): T[] { return items.length <= count ? items : [...items.slice(0, count - 1), ...items.slice(-1)]; }
export function tidBlock(tid: string): number | null { const m = /^\((\d+),(\d+)\)$/.exec(tid); return m ? Number(m[1]) : null; }
export function normalizeNode(stats: BtreeStats, rows: RawIndexItem[]): BtreeNode {
  const level = stats.btpo_level;
  const leaf = level === 0;
  const items: IndexItem[] = rows.map(row => {
    const highKey = stats.btpo_next !== 0 && row.itemoffset === 1;
    return { ...row, highKey, child: leaf || highKey ? null : tidBlock(row.ctid),
      minusInfinity: !leaf && !highKey && row.itemoffset === (stats.btpo_next ? 2 : 1),
      heapTids: leaf && !highKey ? row.tids ?? [row.htid ?? row.ctid] : [] };
  });
  return { block: stats.blkno, level, leaf, stats, items, children: items.flatMap(i => i.child === null ? [] : [i.child]) };
}
// Readable labels are decoded from the page on the server; raw bytes remain an explicit option.
export function keyLabel(item: IndexItem, type?: string, endian: 'auto' | 'raw' | 'little' | 'big' = 'auto'): string {
  if (item.minusInfinity) return '−∞';
  if (endian === 'auto' && item.value !== undefined) return item.value;
  const bytes = item.data.trim().split(/\s+/).filter(Boolean);
  const size = ({ smallint: 2, integer: 4, bigint: 8 } as Record<string, number>)[type ?? ''];
  if ((endian === 'little' || endian === 'big') && size && bytes.length >= size && !item.nulls) {
    const part = bytes.slice(0, size);
    if (endian === 'little') part.reverse();
    const n = BigInt('0x' + part.join(''));
    return BigInt.asIntN(size * 8, n).toString();
  }
  return bytes.length ? bytes.slice(0, 6).join(' ') + (bytes.length > 6 ? '…' : '') : '∅';
}
