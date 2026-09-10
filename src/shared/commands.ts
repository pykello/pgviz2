export const templates = [
  { id: 'create', label: 'Open playground', count: 100, description: 'Open a separate table and B-tree; creates 100 initial keys on first use.' },
  { id: 'random', label: 'Insert random keys', count: 1000, description: 'Scatter inserts across leaf pages; enough inserts cause page splits.' },
  { id: 'append', label: 'Append keys', count: 1000, description: 'Grow the right edge of the tree.' },
  { id: 'duplicates', label: 'Insert duplicate keys', count: 1000, description: 'Add key 42 repeatedly to explore deduplication and posting lists.' },
  { id: 'update', label: 'Update random keys', count: 100, description: 'Change indexed keys, creating new index entries and tuple versions.' },
  { id: 'hot', label: 'Update payload', count: 100, description: 'Change an unindexed column. HOT updates are possible when the page has room.' },
  { id: 'delete', label: 'Delete random rows', count: 1000, description: 'Delete rows. Their physical storage remains until cleanup.' },
  { id: 'vacuum', label: 'Vacuum', count: 0, description: 'Clean up dead tuples and index entries; page reuse depends on PostgreSQL.' },
] as const;
export type Command = typeof templates[number]['id'];
export interface CommandResult { schema: string; indexOid: number; tableOid: number; rows: number; affected: number; sql: string; command: Command }
export function commandSql(command: Command, table: string, count: number): string {
  switch (command) {
    case 'create': return `CREATE TABLE ${table} (key integer, payload integer NOT NULL DEFAULT 0) WITH (fillfactor=70, autovacuum_enabled=false);\nCREATE INDEX keys_idx ON ${table}(key);\nINSERT INTO ${table}(key) SELECT generate_series(1, 100);`;
    case 'random': return `INSERT INTO ${table}(key) SELECT floor(random()*100000)::integer FROM generate_series(1, ${count});`;
    case 'append': return `INSERT INTO ${table}(key) SELECT (SELECT coalesce(max(key),0) FROM ${table}) + i FROM generate_series(1, ${count}) AS s(i);`;
    case 'duplicates': return `INSERT INTO ${table}(key) SELECT 42 FROM generate_series(1, ${count});`;
    case 'update': return `UPDATE ${table} SET key = floor(random()*100000)::integer WHERE ctid IN (SELECT ctid FROM ${table} ORDER BY random() LIMIT ${count});`;
    case 'hot': return `UPDATE ${table} SET payload = payload + 1 WHERE ctid IN (SELECT ctid FROM ${table} ORDER BY random() LIMIT ${count});`;
    case 'delete': return `DELETE FROM ${table} WHERE ctid IN (SELECT ctid FROM ${table} ORDER BY random() LIMIT ${count});`;
    case 'vacuum': return `VACUUM (ANALYZE) ${table};`;
  }
}
