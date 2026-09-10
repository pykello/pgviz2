import { btreeByteOrder, labelNode, decodeHeapAttribute, type IndexColumn, type KeyContext } from './keys';
import pg, { type PoolClient, type QueryResultRow } from 'pg';
import type { Api, Args, BtreeMeta, BtreeStats, HeapItem, PageHeader, Provider, RawIndexItem, Relation, Route, MapPage } from '../shared/types';
import { InputError, integer, normalizeNode, sample } from '../shared/tree';
// All int8 values in this API are page numbers or sizes, never key values.
pg.types.setTypeParser(20, value => { const n = Number(value); if (!Number.isSafeInteger(n)) throw new InputError('Integer exceeds the supported safe range.'); return n; });
const quote = (s: string) => '"' + s.replaceAll('"', '""') + '"';
export class Database implements Provider {
  private pool: pg.Pool;
  constructor(dsn: string) {
    this.pool = new pg.Pool({ connectionString: dsn, max: 4, connectionTimeoutMillis: 5000,
      options: '-c default_transaction_read_only=on -c statement_timeout=8000 -c lock_timeout=1500 -c search_path=pg_catalog' });
    this.pool.on('error', e => console.error('Database pool:', e.message));
  }
  async close() { await this.pool.end(); }
  async request<K extends Route>(route: K, args: Args): Promise<Api[K]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      const ext = await client.query<{ nspname: string; extversion: string }>("SELECT n.nspname,e.extversion FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pageinspect'");
      const result = await new Reader(client, ext.rows[0]).request(route, args);
      await client.query('COMMIT');
      return result;
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
    finally { client.release(); }
  }
}
class Reader {
  private keyContexts = new Map<number, KeyContext | undefined>();
  constructor(private client: PoolClient, private ext?: { nspname: string; extversion: string }) {}
  async rows<T extends QueryResultRow>(q: string, params: unknown[] = []): Promise<T[]> { return (await this.client.query<T>(q, params)).rows; }
  fn(name: string) {
    if (!this.ext) throw new InputError('Install pageinspect in this database first: CREATE EXTENSION pageinspect; (as a superuser).');
    return `${quote(this.ext.nspname)}.${quote(name)}`;
  }
  async call<T extends QueryResultRow>(name: string, args: unknown[], placeholders?: string) {
    return this.rows<T>(`SELECT * FROM ${this.fn(name)}(${placeholders ?? args.map((_, i) => '$' + (i + 1)).join(',')})`, args);
  }
  async relation(value: unknown): Promise<Relation> {
    const oid = integer(value, 'Relation OID', 1);
    const [rel] = await this.rows<Relation>(`SELECT c.oid::int,n.nspname AS schema,c.relname AS name,
      format('%I.%I',n.nspname,c.relname) AS qualified,c.relkind,am.amname AS method,i.indrelid::int AS table_oid,
      pg_relation_size(c.oid)::float8 AS bytes,(pg_relation_size(c.oid)/current_setting('block_size')::int)::float8 AS pages
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_am am ON am.oid=c.relam
      LEFT JOIN pg_index i ON i.indexrelid=c.oid WHERE c.oid=$1 AND c.relkind IN ('r','m','i')`, [oid]);
    if (!rel) throw new InputError('Relation does not exist or has no inspectable storage.');
    return rel;
  }
  block(rel: Relation, value: unknown, minimum = 0) { return integer(value, 'Block', minimum, rel.pages - 1); }
  async keys(rel: Relation): Promise<KeyContext | undefined> {
    if (this.keyContexts.has(rel.oid)) return this.keyContexts.get(rel.oid);
    const columns = await this.rows<IndexColumn>(`SELECT a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type,
      coalesce(nullif(t.typbasetype,0),a.atttypid)::int AS oid,a.attlen AS length,a.attalign AS alignment
      FROM pg_attribute a JOIN pg_type t ON t.oid=a.atttypid WHERE a.attrelid=$1 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`, [rel.oid]);
    const [settings] = await this.rows<{ count: number; encoding: string }>(`SELECT indnkeyatts AS count,current_setting('server_encoding') AS encoding FROM pg_index WHERE indexrelid=$1`, [rel.oid]);
    const [raw] = await this.call<{ get_raw_page: Buffer }>('get_raw_page', [rel.qualified, 0]);
    const littleEndian = raw ? btreeByteOrder(raw.get_raw_page) : undefined;
    const context = littleEndian === undefined || !settings ? undefined : { columns, keyCount: settings.count, littleEndian, encoding: settings.encoding };
    this.keyContexts.set(rel.oid, context); return context;
  }
  async node(rel: Relation, block: number) {
    this.block(rel, block, 1);
    const [stats] = await this.call<BtreeStats>('bt_page_stats', [rel.qualified, block]);
    if (!stats) throw new InputError('Page statistics unavailable.');
    if (['d', 'D', 'e'].includes(stats.type)) return normalizeNode(stats, []);
    const context = await this.keys(rel);
    const [raw] = await this.call<{ get_raw_page: Buffer }>('get_raw_page', [rel.qualified, block]);
    if (!raw) throw new InputError('Page image unavailable.');
    // Decode labels and items from one image, including null bitmaps and truncated pivots.
    const items = (await this.rows<{ item: RawIndexItem }>(`SELECT to_jsonb(p) AS item FROM ${this.fn('bt_page_items')}($1::bytea) p`, [raw.get_raw_page])).map(r => r.item);
    const node = normalizeNode(stats, items);
    return context ? labelNode(node, raw.get_raw_page, context) : node;
  }
  async request<K extends Route>(route: K, args: Args): Promise<Api[K]> {
    // One typed dispatch boundary; each method below returns the shared API model.
    return await this.dispatch(route, args) as Api[K];
  }
  async dispatch(route: Route, args: Args): Promise<Api[Route]> {
    if (route === 'status') {
      const [s] = await this.rows<Api['status']>(`SELECT current_setting('server_version') AS version,
        current_setting('server_version_num')::int AS version_num,current_setting('block_size')::int AS block_size,
        current_database() AS database,current_setting('is_superuser')::bool AS superuser`);
      return { ...s!, mode: 'live', pageinspect: this.ext?.extversion ?? null };
    }
    if (route === 'relations') return this.rows<Api['relations'][number]>(`SELECT c.oid::int,n.nspname AS schema,c.relname AS name,c.relkind,a.amname AS method
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_am a ON a.oid=c.relam
      WHERE c.relkind IN ('r','m','i') AND a.amname IN ('heap','btree')
      AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
      AND (n.nspname || '.' || c.relname) ILIKE $1 AND ($2::oid IS NULL OR c.oid=$2::oid)
      ORDER BY n.nspname,c.relname LIMIT 500`, ['%' + (args.q ?? '').slice(0, 100) + '%', args.oid === undefined ? null : integer(args.oid, 'Relation OID', 1)]);
    const rel = await this.relation(args.oid);
    if ((route === 'tree' || route === 'node') && rel.method !== 'btree') throw new InputError('Choose a B-tree index.');
    if (route === 'node') return this.node(rel, this.block(rel, args.block, 1));
    if (route === 'tree') {
      const [meta] = await this.call<BtreeMeta>('bt_metap', [rel.qualified]);
      if (!meta) throw new InputError('Metapage unavailable.');
      const depth = integer(args.depth ?? 3, 'Depth', 1, 4);
      const root = integer(args.root ?? meta.root, 'Root');
      const nodes: Api['tree']['nodes'] = [], queue = root ? [{ block: root, distance: 0 }] : [], seen = new Set<number>();
      while (queue.length && nodes.length < 40) {
        const { block, distance } = queue.shift()!;
        if (seen.has(block)) continue;
        seen.add(block);
        const node = await this.node(rel, block);
        nodes.push(node);
        if (distance + 1 < depth) queue.push(...sample(node.children).map(block => ({ block, distance: distance + 1 })));
      }
      const columns = await this.rows<Api['tree']['columns'][number]>('SELECT attname AS name,format_type(atttypid,atttypmod) AS type FROM pg_attribute WHERE attrelid=$1 AND attnum>0 AND NOT attisdropped ORDER BY attnum', [rel.oid]);
      return { relation: rel, meta, root, nodes, columns, capturedAt: new Date().toISOString(),
        consistency: 'Physical pages are read independently; concurrent splits or vacuum may require a refresh.' };
    }
    if (!['heap', 'btree'].includes(rel.method)) throw new InputError('Unsupported access method.');
    if (route === 'heap') {
      if (rel.method !== 'heap') throw new InputError('Choose a heap table.');
      const block = this.block(rel, args.block ?? 0);
      const [raw] = await this.call<{ get_raw_page: Buffer }>('get_raw_page', [rel.qualified, block]);
      const [header] = await this.call<PageHeader>('page_header', [raw!.get_raw_page]);
      const rawItems = await this.rows<Omit<HeapItem, 't_attrs'> & { t_attrs: (Buffer | null)[] | null }>(`SELECT h.*, f.raw_flags, f.combined_flags
        FROM ${this.fn('heap_page_item_attrs')}($1,$2::regclass,false) h
        LEFT JOIN LATERAL ${this.fn('heap_tuple_infomask_flags')}(h.t_infomask,h.t_infomask2) f ON h.t_infomask IS NOT NULL
        ORDER BY h.lp`, [raw!.get_raw_page, rel.qualified]);
      const columns = await this.rows<IndexColumn & { dropped: boolean }>(`SELECT a.attname AS name,
        format_type(a.atttypid,a.atttypmod) AS type,coalesce(nullif(t.typbasetype,0),a.atttypid)::int AS oid,
        a.attlen AS length,a.attalign AS alignment,a.attisdropped AS dropped
        FROM pg_attribute a LEFT JOIN pg_type t ON t.oid=a.atttypid
        WHERE a.attrelid=$1 AND a.attnum>0 ORDER BY a.attnum`, [rel.oid]);
      const [settings] = await this.rows<{ encoding: string }>("SELECT current_setting('server_encoding') AS encoding");
      const image = raw!.get_raw_page, pageVersion = header!.pagesize | 4;
      const little = image.readUInt16LE(18) === pageVersion ? true : image.readUInt16BE(18) === pageVersion ? false : undefined;
      const items: HeapItem[] = rawItems.map(item => ({ ...item,
        t_attrs: item.t_attrs?.map(attr => attr === null ? null : Buffer.from(attr).toString('hex')) ?? null,
        values: item.lp_flags !== 1 || !item.t_attrs ? [] : columns.flatMap((column, i) => {
          if (column.dropped) return [];
          const attr = item.t_attrs![i];
          const absent = i >= ((item.t_infomask2 ?? 0) & 0x7ff);
          const value = absent ? undefined : attr === null ? 'NULL' : attr === undefined || little === undefined ? undefined : decodeHeapAttribute(Buffer.from(attr), column, little, settings!.encoding);
          return [{ name: column.name, type: column.type, value, state: absent ? 'absent' as const : value === undefined ? 'raw' as const : 'decoded' as const }];
        }) }));
      return { relation: rel, block, header: header!, items, raw: raw!.get_raw_page.toString('hex') };
    }
    if (route === 'map') {
      const start = integer(args.start ?? 0, 'Start'), count = integer(args.count ?? 128, 'Count', 1, 256);
      const pages: MapPage[] = [];
      for (let block = start; block < Math.min(start + count, rel.pages); block++) {
        if (rel.method === 'btree' && block > 0) {
          const [s] = await this.call<BtreeStats>('bt_page_stats', [rel.qualified, block]);
          pages.push({ block, free: s!.free_size, size: s!.page_size, kind: s!.type, items: s!.live_items, dead: s!.dead_items });
        } else {
          const [r] = await this.call<{ get_raw_page: Buffer }>('get_raw_page', [rel.qualified, block]);
          const [h] = await this.call<PageHeader>('page_header', [r!.get_raw_page]);
          pages.push({ block, free: h!.upper - h!.lower, size: h!.pagesize, kind: rel.method === 'btree' ? 'meta' : 'heap' });
        }
      }
      return { relation: rel, start, pages };
    }
    throw new InputError('Unknown API route.');
  }
}
