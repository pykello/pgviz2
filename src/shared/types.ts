export type Fields = Record<string, unknown>;
export interface RelationSummary { oid: number; schema: string; name: string; relkind: string; method: 'heap' | 'btree' }
export interface Relation extends RelationSummary { qualified: string; table_oid: number | null; bytes: number; pages: number }
export interface Status { mode: 'live' | 'demo'; version: string; version_num: number; block_size: number; database: string; superuser: boolean; pageinspect: string | null }
export interface BtreeStats extends Fields { blkno: number; type: string; live_items: number; dead_items: number; avg_item_size: number; page_size: number; free_size: number; btpo_prev: number; btpo_next: number; btpo_level: number; btpo_flags: number }
export interface RawIndexItem { itemoffset: number; ctid: string; itemlen: number; nulls: boolean; vars: boolean; data: string; dead: boolean | null; htid: string | null; tids: string[] | null }
export interface IndexItem extends RawIndexItem { value?: string; highKey: boolean; child: number | null; minusInfinity: boolean; heapTids: string[] }
export interface BtreeNode { block: number; level: number; leaf: boolean; stats: BtreeStats; items: IndexItem[]; children: number[] }
export interface BtreeMeta extends Fields { root: number; level: number; fastroot: number; fastlevel: number }
export interface Tree { relation: Relation; meta: BtreeMeta; root: number; nodes: BtreeNode[]; columns: { name: string; type: string }[]; capturedAt: string; consistency: string }
export interface PageHeader extends Fields { lower: number; upper: number; special: number; pagesize: number; lsn: string; checksum: number; flags: number }
export interface HeapItem { lp: number; lp_off: number; lp_flags: number; lp_len: number; t_xmin: string | null; t_xmax: string | null; t_ctid: string | null; t_hoff: number | null; t_infomask: number | null; t_infomask2: number | null; t_bits: string | null; t_attrs: (string | null)[] | null; raw_flags?: string[]; combined_flags?: string[] }
export interface HeapPage { relation: Relation; block: number; header: PageHeader; items: HeapItem[]; raw: string }
export interface MapPage { block: number; free: number; size: number; kind: string; items?: number; dead?: number }
export interface PageMap { relation: Relation; start: number; pages: MapPage[] }
export interface Api { status: Status; relations: RelationSummary[]; tree: Tree; node: BtreeNode; heap: HeapPage; map: PageMap }
export type Route = keyof Api;
export type Args = Record<string, string>;
export interface Provider { request<K extends Route>(route: K, args: Args): Promise<Api[K]>; close(): Promise<void> }
