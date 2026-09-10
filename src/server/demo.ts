import type { Api, Args, BtreeStats, HeapPage, Provider, RawIndexItem, Relation, Route, Tree } from '../shared/types';
import { InputError, integer, normalizeNode, sample } from '../shared/tree';
const index: Relation = { oid: 1, schema: 'public', name: 'orders_customer_idx', qualified: 'public.orders_customer_idx', relkind: 'i', method: 'btree', table_oid: 2, bytes: 49 * 8192, pages: 49 };
const table: Relation = { ...index, oid: 2, name: 'orders', qualified: 'public.orders', relkind: 'r', method: 'heap', table_oid: null, pages: 160, bytes: 160 * 8192 };
const rawItem = (offset: number, value: number, tid: string): RawIndexItem => {
  const b = Buffer.alloc(8); b.writeInt32LE(value);
  return { itemoffset: offset, ctid: tid, itemlen: 16, data: b.toString('hex').match(/../g)!.join(' '), nulls: false, vars: false, dead: false, htid: tid, tids: null };
};
function node(block: number) {
  const level = block === 48 ? 2 : block >= 40 ? 1 : 0;
  const children = block === 48 ? [40, 41, 42, 43, 44, 45, 46, 47] : Array.from({ length: 4 }, (_, i) => (block - 40) * 4 + i + 1);
  const next = block === 48 || block === 47 || block === 32 ? 0 : block + 1;
  const rows = level ? children.map((c, i) => rawItem(i + 1 + Number(!!next), (level === 2 ? (c - 40) * 400 + 100 : c * 100), `(${c},1)`)) : Array.from({ length: 18 }, (_, i) => rawItem(i + 1 + Number(!!next), block * 100 + i, `(${block * 2},${i + 1})`));
  if (next) rows.unshift(rawItem(1, level === 1 ? (block - 39) * 400 + 100 : (block + 1) * 100, '(0,1)'));
  if (!level) { const r = rows[2]!; r.tids = [`(${block * 2},2)`, `(${block * 2},22)`, `(${block * 2 + 1},4)`]; r.htid = r.tids[0]!; r.ctid = '(16,8195)'; r.itemlen = 40; }
  const stats: BtreeStats = { blkno: block, type: block === 48 ? 'r' : level ? 'i' : 'l', live_items: rows.length, dead_items: 0, avg_item_size: 16, page_size: 8192, free_size: level ? 6500 : 800 + block * 91, btpo_prev: [1, 40, 48].includes(block) ? 0 : block - 1, btpo_next: next, btpo_level: level, btpo_flags: level ? 0 : 1 };
  const result = normalizeNode(stats, rows);
  for (const item of result.items) item.value = item.minusInfinity ? '−∞' : String(Buffer.from(item.data.replaceAll(' ', ''), 'hex').readInt32LE());
  return result;
}
function heap(block: number): HeapPage {
  const raw = Buffer.alloc(8192);
  const items: HeapPage['items'] = Array.from({ length: 24 }, (_, i) => {
    const offset = 8192 - (i + 1) * 120;
    raw.fill(i + 32, offset, offset + 112);
    return { lp: i + 1, lp_off: offset, lp_len: 112, lp_flags: 1, t_xmin: '741', t_xmax: i === 3 ? '752' : '0', t_ctid: `(${block},${i === 3 ? 20 : i + 1})`, t_hoff: 24, t_infomask: 2306, t_infomask2: i === 3 ? 16387 : 3, t_bits: null, t_attrs: ['01000000', '637573746f6d6572', null], raw_flags: i === 3 ? ['HEAP_HOT_UPDATED', 'HEAP_XMIN_COMMITTED'] : ['HEAP_XMIN_COMMITTED', 'HEAP_XMAX_INVALID'], combined_flags: [] };
  });
  return { relation: table, block, raw: raw.toString('hex'), header: { lower: 120, upper: 5312, special: 8192, pagesize: 8192, lsn: '0/16B4C88', checksum: 0, flags: 0 }, items };
}
export class Demo implements Provider {
  async close() {}
  async request<K extends Route>(route: K, args: Args): Promise<Api[K]> { return this.dispatch(route, args) as Api[K]; }
  private dispatch(route: Route, args: Args): Api[Route] {
    if (route === 'status') return { mode: 'demo', version: '18 · sample data', version_num: 180000, block_size: 8192, database: 'storage_lab', superuser: true, pageinspect: '1.13' };
    if (route === 'relations') return [index, table].filter(r => `${r.schema}.${r.name}`.includes(args.q ?? '') && (args.oid === undefined || r.oid === integer(args.oid, 'Relation OID', 1)));
    const rel = args.oid === '1' ? index : args.oid === '2' ? table : null;
    if (!rel) throw new InputError('Unknown demo relation.');
    if (route === 'tree') {
      if (rel !== index) throw new InputError('Choose a B-tree index.');
      const root = integer(args.root ?? 48, 'Root', 1, 48), depth = integer(args.depth ?? 3, 'Depth', 1, 4);
      const nodes: Tree['nodes'] = [], queue = [{ block: root, d: 0 }];
      while (queue.length && nodes.length < 40) {
        const { block, d } = queue.shift()!, n = node(block); nodes.push(n);
        if (d + 1 < depth) queue.push(...sample(n.children).map(block => ({ block, d: d + 1 })));
      }
      return { relation: index, root, nodes, meta: { root: 48, level: 2, fastroot: 48, fastlevel: 2, version: 4, allequalimage: true }, columns: [{ name: 'customer_id', type: 'integer' }], capturedAt: new Date().toISOString(), consistency: 'Illustrative fixture, not a live database. Connect with DATABASE_URL to inspect real storage.' };
    }
    if (route === 'node') return node(integer(args.block, 'Block', 1, 48));
    if (route === 'heap') { if (rel !== table) throw new InputError('Choose a heap table.'); return heap(integer(args.block ?? 0, 'Block', 0, 159)); }
    const start = integer(args.start ?? 0, 'Start'), count = integer(args.count ?? 128, 'Count', 1, 256);
    return { relation: rel, start, pages: Array.from({ length: Math.max(0, Math.min(count, rel.pages - start)) }, (_, i) => ({ block: start + i, size: 8192, free: 400 + (start + i) * 139 % 6200, kind: rel === table ? 'heap' : start + i === 0 ? 'meta' : start + i >= 40 ? 'i' : 'l' })) };
  }
}
