// Uses a dedicated test schema and removes it afterward. Never runs unless TEST_DATABASE_URL is set.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { Database } from '../src/server/db';
import { Playground } from '../src/server/playground';
import { WalReader } from '../src/server/wal';
import { relatedChanges } from '../src/shared/wal';
import type { RelationSummary } from '../src/shared/types';
const dsn = process.env.TEST_DATABASE_URL;
const db = dsn ? new Database(dsn) : undefined;
const wal = dsn ? new WalReader(dsn) : undefined;
const playground = dsn ? new Playground(dsn) : undefined;
const client = dsn ? new pg.Client({ connectionString: dsn }) : undefined;
const schema = `pgviz_test_${process.pid}`;
let relations: RelationSummary[];
const oid = (name: string) => String(relations.find(r => r.name === name)!.oid);
before(async () => {
  if (!client || !db) return;
  await client.connect();
  await client.query('CREATE EXTENSION IF NOT EXISTS pageinspect');
  await client.query('CREATE EXTENSION IF NOT EXISTS pg_walinspect');
  await client.query(`CREATE SCHEMA "${schema}";
    CREATE TABLE "${schema}".empty (id int); CREATE INDEX empty_idx ON "${schema}".empty(id);
    CREATE TABLE "${schema}".small (id int, note text); INSERT INTO "${schema}".small VALUES (-10,'a'),(0,NULL),(42,'z'); CREATE INDEX small_idx ON "${schema}".small(id);
    CREATE TABLE "${schema}".many (id int, v text); INSERT INTO "${schema}".many SELECT i%100, repeat(i::text,20) FROM generate_series(1,40000) i;
    CREATE INDEX many_idx ON "${schema}".many(id); CREATE INDEX text_idx ON "${schema}".many(v);
    CREATE INDEX composite_idx ON "${schema}".many(id,v);
    CREATE TABLE "${schema}"."odd' table" (id int); INSERT INTO "${schema}"."odd' table" VALUES(1); CREATE INDEX "odd index" ON "${schema}"."odd' table"(id);`);
  relations = await db.request('relations', { q: schema });
});
after(async () => { await wal?.close(); if (client) { await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await client.query(`DROP SCHEMA IF EXISTS "${playground!.schema}" CASCADE`); await client.end(); } await db?.close(); });
test('live pageinspect integration', { skip: !dsn }, async t => {
  await t.test('status identifies server and extension', async () => { const s = await db!.request('status', {}); assert.ok(s.version_num >= 180000 && s.version_num < 190000); assert.ok(s.pageinspect); });
  await t.test('relation URLs resolve an exact OID independently of the list', async () => {
    const result = await db!.request('relations', { oid: oid('odd index') });
    assert.equal(result.length, 1); assert.equal(result[0]!.name, 'odd index');
    assert.deepEqual(await db!.request('relations', { oid: '4294967295' }), []);
    await assert.rejects(db!.request('relations', { oid: 'invalid' }));
  });
  await t.test('empty indexes have no root or invented nodes', async () => { const s = await db!.request('tree', { oid: oid('empty_idx') }); assert.equal(s.root, 0); assert.deepEqual(s.nodes, []); });
  await t.test('small root is a leaf', async () => { const s = await db!.request('tree', { oid: oid('small_idx') }); assert.equal(s.nodes.length, 1); assert.equal(s.nodes[0]!.leaf, true); assert.equal(s.nodes[0]!.items.length, 3); });
  await t.test('multi-page duplicate keys use real posting TIDs', async () => { const s = await db!.request('tree', { oid: oid('many_idx'), depth: '3' }); assert.ok(s.nodes.length > 1); assert.ok(s.nodes.some(n => n.items.some(i => i.heapTids.length > 1))); for (const n of s.nodes) for (const i of n.items) { if (i.highKey) assert.equal(i.child, null); if (n.leaf) assert.equal(i.child, null); } });
  await t.test('text and composite keys stay inspectable', async () => { for (const name of ['text_idx', 'composite_idx']) { const s = await db!.request('tree', { oid: oid(name) }); assert.ok(s.nodes.length > 0); } });
  await t.test('quoted identifiers and schemas resolve by OID', async () => { const s = await db!.request('tree', { oid: oid('odd index') }); assert.equal(s.nodes.length, 1); });
  await t.test('heap captures bytes, nulls, and PostgreSQL decoded flags', async () => { const h = await db!.request('heap', { oid: oid('small'), block: '0' }); assert.equal(h.raw.length, h.header.pagesize * 2); assert.equal(h.items.length, 3); assert.ok(h.items[0]!.raw_flags); assert.equal(h.items[1]!.t_attrs![1], null); });
  await t.test('heap labels preserve physical values, dropped columns and absent defaults', async () => {
    await client!.query(`CREATE TABLE "${schema}".heap_values (id int, gone text, big bigint, label text, amount numeric, flag boolean, u uuid, d date, external text, compressed text, optional text) WITH (autovacuum_enabled=false);
      ALTER TABLE "${schema}".heap_values ALTER COLUMN external SET STORAGE EXTERNAL;
      INSERT INTO "${schema}".heap_values VALUES (-42,'dropped',9223372036854775807,repeat('héllo',36),-12345678901234567890.00120,true,'12345678-1234-5678-9012-123456789abc','2026-01-01',repeat('external',2000),repeat('compressed',2000),NULL);
      ALTER TABLE "${schema}".heap_values DROP COLUMN gone;
      ALTER TABLE "${schema}".heap_values ADD COLUMN added int DEFAULT 7;`);
    const [rel] = await db!.request('relations', { q: schema + '.heap_values' });
    const args = { oid: String(rel!.oid), block: '0' };
    const h = await db!.request('heap', args);
    const values = Object.fromEntries(h.items[0]!.values!.map(v => [v.name, v]));
    assert.equal(values.id!.value, '-42'); assert.equal(values.big!.value, '9223372036854775807');
    assert.equal(values.label!.value, JSON.stringify('héllo'.repeat(36)));
    assert.equal(values.amount!.value, '-12345678901234567890.00120');
    assert.equal(values.flag!.value, 'true'); assert.equal(values.u!.value, '12345678-1234-5678-9012-123456789abc');
    assert.equal(values.optional!.value, 'NULL'); assert.equal(values.added!.state, 'absent');
    for (const name of ['d', 'external', 'compressed']) assert.equal(values[name]!.state, 'raw');
    assert.equal(values.gone, undefined);
    await client!.query(`UPDATE "${schema}".heap_values SET label='changed'`);
    const changed = await db!.request('heap', args);
    const labels = changed.items.flatMap(i => i.values?.filter(v => v.name === 'label').map(v => v.value) ?? []);
    assert.ok(labels.includes(JSON.stringify('héllo'.repeat(36))));
    assert.ok(labels.includes('"changed"'));
  });
  await t.test('maps and boundary validation', async () => { const m = await db!.request('map', { oid: oid('many_idx'), count: '4' }); assert.equal(m.pages.length, 4); await assert.rejects(db!.request('heap', { oid: oid('empty'), block: '0' })); await assert.rejects(db!.request('tree', { oid: oid('small') })); await assert.rejects(db!.request('node', { oid: oid('small_idx'), block: '0' })); });
  await t.test('readable stored values include nulls, text, large integers, numeric and composite keys', async () => {
    await client!.query(`CREATE TABLE "${schema}".typed_keys (id integer, big bigint, small smallint, t text, n numeric, b boolean, u uuid, f double precision, d date);
      INSERT INTO "${schema}".typed_keys VALUES (-10, 9223372036854775807, -32768, 'héllo', -12345678901234567890.00120, true, '12345678-1234-5678-9012-123456789abc', -1.25, '2026-01-01'), (42,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL);
      CREATE INDEX typed_id ON "${schema}".typed_keys(id) INCLUDE(t);
      CREATE INDEX typed_big ON "${schema}".typed_keys(big);
      CREATE INDEX typed_small ON "${schema}".typed_keys(small);
      CREATE INDEX typed_t ON "${schema}".typed_keys(t);
      CREATE INDEX typed_n ON "${schema}".typed_keys(n);
      CREATE INDEX typed_b ON "${schema}".typed_keys(b);
      CREATE INDEX typed_u ON "${schema}".typed_keys(u);
      CREATE INDEX typed_f ON "${schema}".typed_keys(f);
      CREATE INDEX typed_d ON "${schema}".typed_keys(d);
      CREATE INDEX typed_composite ON "${schema}".typed_keys(b,t,id,n);
      CREATE INDEX typed_expression ON "${schema}".typed_keys(lower(t));`);
    const read = async (name: string) => {
      const r = await client!.query<{ oid: number }>('SELECT $1::regclass::oid::int AS oid', [`"${schema}".${name}`]);
      return db!.request('tree', { oid: String(r.rows[0]!.oid) });
    };
    const values = async (name: string) => (await read(name)).nodes.flatMap(n => n.items.filter(i => !i.highKey).map(i => i.value));
    assert.deepEqual(await values('typed_id'), ['-10', '42']);
    for (const [name, expected] of [['typed_big', '9223372036854775807'], ['typed_small', '-32768'], ['typed_t', '"héllo"'], ['typed_n', '-12345678901234567890.00120'], ['typed_b', 'true'], ['typed_u', '12345678-1234-5678-9012-123456789abc'], ['typed_f', '-1.25'], ['typed_expression', '"héllo"']]) {
      assert.deepEqual(await values(name!), [expected, 'NULL']);
    }
    assert.deepEqual(await values('typed_composite'), ['(true, "héllo", -10, -12345678901234567890.00120)', '(NULL, NULL, 42, NULL)']);
    assert.equal((await values('typed_d'))[0], undefined); // unsupported date encoding falls back to raw bytes
    await client!.query(`INSERT INTO "${schema}".typed_keys(id,t,n) VALUES (99, repeat('abc',60), 0.0000123), (100, '', 'NaN'), (101,'NULL','Infinity'), (102,'x','-Infinity');`);
    const text = await values('typed_t'); assert.ok(text.includes(JSON.stringify('abc'.repeat(60)))); assert.ok(text.includes('""')); assert.ok(text.includes('"NULL"'));
    const numbers = await values('typed_n'); for (const n of ['0.0000123','NaN','Infinity','-Infinity']) assert.ok(numbers.includes(n), n);
    const original = await db!.request('tree', { oid: oid('small_idx') }); assert.deepEqual(original.nodes[0]!.items.map(i => i.value), ['-10','0','42']);
    const posting = await db!.request('tree', { oid: oid('many_idx') }); assert.ok(posting.nodes.every(n => n.items.every(i => i.value !== undefined)));
    const composite = await db!.request('tree', { oid: oid('composite_idx') }); assert.ok(composite.nodes.every(n => n.items.every(i => i.value !== undefined)));
    await client!.query(`CREATE TABLE "${schema}".pivot_keys AS SELECT i AS id, repeat('x',32) AS t FROM generate_series(1,3000) AS s(i); CREATE INDEX pivot_keys_idx ON "${schema}".pivot_keys(id,t);`);
    const pivots = await read('pivot_keys_idx');
    assert.ok(pivots.nodes.some(n => n.items.some(i => i.value?.includes(', −∞'))));
  });
  await t.test('command templates mutate only the generated playground and visibly grow the tree', async () => {
    await assert.rejects(playground!.execute({ command: 'delete', count: 10 }));
    const initial = await playground!.execute({ command: 'create' });
    assert.equal(initial.rows, 100);
    const before = await db!.request('tree', { oid: String(initial.indexOid) });
    assert.equal(before.nodes[0]!.leaf, true);
    const inserted = await playground!.execute({ command: 'append', count: 3000 });
    assert.equal(inserted.rows, 3100); assert.equal(inserted.affected, 3000);
    const after = await db!.request('tree', { oid: String(initial.indexOid) });
    assert.ok(after.relation.pages > before.relation.pages); assert.ok(after.meta.level > 0);
    for (const command of ['random', 'duplicates', 'update', 'hot', 'delete']) {
      const result = await playground!.execute({ command, count: 50 }); assert.equal(result.affected, 50);
    }
    const vacuum = await playground!.execute({ command: 'vacuum', count: 0 }); assert.ok(vacuum.rows > 0);
    await assert.rejects(playground!.execute({ command: 'drop', count: 1 }));
    await assert.rejects(playground!.execute({ command: 'append', count: '1; DROP TABLE keys' }));
    await assert.rejects(playground!.execute({ command: 'append', count: 10001 }));
    const untouched = await client!.query(`SELECT count(*)::int AS n FROM "${schema}".small`); assert.equal(untouched.rows[0].n, 3);
  });

  await t.test('physical WAL and committed logical changes correlate and temporary slots are cleaned up', async t => {
    const status = await wal!.status();
    assert.ok(status.physical);
    if (!status.logical) { t.skip('Set wal_level=logical and restart the scratch server for logical WAL tests.'); return; }
    await client!.query(`CREATE TABLE "${schema}".wal_keys (id integer PRIMARY KEY, note text);`);
    const capture = await wal!.start(); assert.ok(capture.logical); assert.ok(capture.slot);
    try {
      await client!.query(`INSERT INTO "${schema}".wal_keys VALUES(1,'hello WAL'); UPDATE "${schema}".wal_keys SET note='changed WAL' WHERE id=1;`);
      await client!.query(`BEGIN; INSERT INTO "${schema}".wal_keys VALUES(99,'rolled back'); ROLLBACK;`);
      await client!.query(`DELETE FROM "${schema}".wal_keys WHERE id=1;`);
      const batch = await wal!.poll(capture.token);
      assert.ok(batch.physical.some(r => r.resource_manager === 'Heap'));
      assert.ok(batch.physical.some(r => r.resource_manager === 'Btree' && r.summary === 'Insert an index entry'));
      assert.ok(batch.physical.some(r => r.relations.some(n => n.includes('wal_keys'))));
      assert.ok(batch.logical.some(r => r.data.includes('hello WAL')));
      assert.ok(batch.logical.some(r => r.data.includes('changed WAL')));
      assert.ok(!batch.logical.some(r => r.data.includes('rolled back')));
      assert.ok(batch.physical.some(r => relatedChanges(r, batch.logical).match === 'lsn'));
      assert.ok(batch.physical.some(r => r.resource_manager === 'Btree' && relatedChanges(r, batch.logical).match === 'transaction'));
      const next = await wal!.poll(capture.token); assert.equal(next.logical.length, 0);
      await assert.rejects(wal!.poll('invalid-token'));
    } finally { await wal!.stop(capture.token); }
    const slots = await client!.query('SELECT * FROM pg_replication_slots WHERE slot_name=$1', [capture.slot]); assert.equal(slots.rows.length, 0);
  });

});
