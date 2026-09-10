export interface LogicalRecord { lsn: string; xid: string; data: string; truncated: boolean }
export interface PhysicalRecord { start_lsn: string; end_lsn: string; prev_lsn: string; xid: string; resource_manager: string; record_type: string; record_length: number; main_data_length: number; fpi_length: number; description: string; block_ref: string; summary: string; relations: string[] }
export interface WalStatus { physical: boolean; logical: boolean; reason: string; database: string; walLevel: string }
export interface WalCapture { token: string; slot: string | null; startLsn: string; logical: boolean; note: string }
export interface WalBatch { physical: PhysicalRecord[]; logical: LogicalRecord[]; omittedPhysical: number; omittedLogical: number; cursor: string }
export function lsnNumber(lsn: string): bigint { const parts = lsn.split('/'); return (BigInt('0x' + parts[0]) << 32n) + BigInt('0x' + parts[1]); }
export function lsnText(n: bigint): string { return (n >> 32n).toString(16).toUpperCase() + '/' + (n & 0xffffffffn).toString(16).toUpperCase(); }
export function physicalSummary(rm: string, type: string): string {
  const name = type.split('+')[0]!.trim();
  const heap: Record<string, string> = { INSERT: 'Insert a heap tuple', UPDATE: 'Update a heap tuple', HOT_UPDATE: 'Update a tuple on its heap page (HOT)', DELETE: 'Delete a heap tuple', LOCK: 'Lock a heap tuple', INPLACE: 'Update a system tuple in place', MULTI_INSERT: 'Insert several heap tuples', PRUNE_ON_ACCESS: 'Prune a heap page', PRUNE_VACUUM_SCAN: 'Prune tuples during vacuum', PRUNE_VACUUM_CLEANUP: 'Clean a heap page after vacuum', VISIBLE: 'Mark a heap page all-visible' };
  const btree: Record<string, string> = { INSERT_LEAF: 'Insert an index entry', INSERT_UPPER: 'Insert a B-tree downlink', INSERT_META: 'Insert a downlink and update the metapage', SPLIT_L: 'Split a B-tree page (insert on the left)', SPLIT_R: 'Split a B-tree page (insert on the right)', NEWROOT: 'Create a new B-tree root', DEDUP: 'Combine duplicate index keys', VACUUM: 'Remove dead index entries', DELETE: 'Delete index entries', UNLINK_PAGE: 'Unlink an empty B-tree page', UNLINK_PAGE_META: 'Unlink a page and update the metapage', MARK_PAGE_HALFDEAD: 'Mark a B-tree page for removal', REUSE_PAGE: 'Reuse a deleted B-tree page' };
  if (rm === 'Heap' || rm === 'Heap2') return heap[name] ?? `${rm}: ${name.toLowerCase().replaceAll('_', ' ')}`;
  if (rm === 'Btree') return btree[name] ?? `B-tree: ${name.toLowerCase().replaceAll('_', ' ')}`;
  if (rm === 'Transaction' && name.startsWith('COMMIT')) return 'Commit transaction';
  if (rm === 'Transaction' && name.startsWith('ABORT')) return 'Abort transaction';
  if (rm === 'XLOG' && name.startsWith('CHECKPOINT')) return 'Write a checkpoint';
  if (rm === 'Standby' && name === 'RUNNING_XACTS') return 'Record running transactions';
  if (rm === 'Storage' && name === 'CREATE') return 'Create relation storage';
  return `${rm}: ${name.toLowerCase().replaceAll('_', ' ')}`;
}
/** Same-XID is an association, not proof that an index record encodes a particular row. */
export function relatedChanges(record: PhysicalRecord, changes: LogicalRecord[]): { match: 'lsn' | 'transaction' | 'none'; changes: LogicalRecord[] } {
  if (record.xid === '0') return { match: 'none', changes: [] };
  const same = changes.filter(c => c.xid === record.xid && c.data.startsWith('table '));
  const exact = same.filter(c => c.lsn === record.start_lsn || c.lsn === record.end_lsn);
  // Only tuple rmgr records can directly correspond to logical row changes.
  if (['Heap', 'Heap2'].includes(record.resource_manager) && exact.length) return { match: 'lsn', changes: exact };
  return { match: same.length ? 'transaction' : 'none', changes: same };
}
