import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { InputError } from '../shared/tree';
import { lsnNumber, lsnText, physicalSummary, type LogicalRecord, type PhysicalRecord, type WalBatch, type WalCapture, type WalStatus } from '../shared/wal';
interface Session { client: pg.Client; capture: WalCapture; cursor: string; ext: string; databaseOid: number; touched: number; busy: boolean }
const quote = (s: string) => '"' + s.replaceAll('"', '""') + '"';
export class WalReader {
  private sessions = new Map<string, Session>();
  private starting = 0;
  private reaper: ReturnType<typeof setInterval>;
  constructor(private dsn: string) {
    this.reaper = setInterval(() => { for (const [token, s] of this.sessions) if (!s.busy && Date.now() - s.touched > 60000) void this.stop(token); }, 10000); this.reaper.unref();
  }
  private connection() { return new pg.Client({ connectionString: this.dsn, connectionTimeoutMillis: 5000, options: '-c default_transaction_read_only=off -c statement_timeout=10000 -c lock_timeout=1500 -c search_path=pg_catalog' }); }
  private async settings(c: pg.Client) {
    const { rows } = await c.query<{ ext: string | null; database: string; databaseOid: number; walLevel: string; logical: boolean; slots: number; primary: boolean }>(`SELECT
      (SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pg_walinspect') AS ext,
      current_database() AS database,(SELECT oid::int FROM pg_database WHERE datname=current_database()) AS "databaseOid",
      current_setting('wal_level') AS "walLevel",(SELECT rolsuper OR rolreplication FROM pg_roles WHERE rolname=current_user) AS logical,
      current_setting('max_replication_slots')::int AS slots,NOT pg_is_in_recovery() AS primary`);
    return rows[0]!;
  }
  async status(): Promise<WalStatus> {
    const c = this.connection();
    try {
      await c.connect(); const s = await this.settings(c);
      const physical = !!s.ext && s.primary, logical = physical && s.logical && s.walLevel === 'logical' && s.slots > 0;
      return { physical, logical, database: s.database, walLevel: s.walLevel, reason: !s.primary ? 'Capture currently requires a PostgreSQL primary.' : !s.ext ? 'Install pg_walinspect in this database: CREATE EXTENSION pg_walinspect;' : !logical ? 'Physical records available. For row values, set wal_level=logical, allow replication slots, and connect with replication privileges.' : 'Physical records with test_decoding row changes. Capture starts now; earlier history is not replayed.' };
    } finally { await c.end().catch(() => {}); }
  }
  async start(): Promise<WalCapture> {
    if (this.sessions.size + this.starting >= 2) throw new InputError('Two WAL captures are already active. Stop one or wait for its 60-second idle timeout.');
    this.starting++;
    const c = this.connection();
    try {
      await c.connect(); const s = await this.settings(c);
      if (!s.ext || !s.primary) throw new InputError(!s.ext ? 'CREATE EXTENSION pg_walinspect; is required in this database.' : 'WAL capture requires a primary.');
      const token = randomBytes(16).toString('hex'); let slot: string | null = null, note = '';
      if (s.logical && s.walLevel === 'logical' && s.slots > 0) {
        slot = 'pgviz_wal_' + randomBytes(8).toString('hex');
        try { await c.query("SELECT * FROM pg_create_logical_replication_slot($1,'test_decoding',true)", [slot]); }
        catch (e) { slot = null; note = `Physical capture only: ${e instanceof Error ? e.message : 'logical decoding unavailable'}`; }
      } else note = 'Physical capture only. Logical decoding needs wal_level=logical and replication privileges.';
      const { rows } = await c.query<{ lsn: string }>('SELECT pg_current_wal_lsn()::text AS lsn');
      const capture = { token, slot, startLsn: rows[0]!.lsn, logical: slot !== null, note };
      this.sessions.set(token, { client: c, capture, cursor: capture.startLsn, ext: s.ext, databaseOid: s.databaseOid, touched: Date.now(), busy: false });
      c.on('error', () => { void this.stop(token); });
      return capture;
    } catch (e) { await c.end().catch(() => {}); throw e; }
    finally { this.starting--; }
  }
  async stop(token: string): Promise<void> { const s = this.sessions.get(token); if (!s) return; this.sessions.delete(token); await s.client.end().catch(() => {}); }
  async close() { clearInterval(this.reaper); await Promise.all([...this.sessions.keys()].map(t => this.stop(t))); }
  async poll(token: string): Promise<WalBatch> {
    const s = this.sessions.get(token); if (!s) throw new InputError('Capture expired or stopped. Start a new capture.');
    if (s.busy) throw new InputError('WAL capture is already being polled.');
    s.busy = true; s.touched = Date.now();
    try {
      const c = s.client;
      const { rows: positions } = await c.query<{ lsn: string; lag: string | null }>(`SELECT pg_current_wal_lsn()::text AS lsn,
        (SELECT pg_wal_lsn_diff(pg_current_wal_lsn(),restart_lsn)::text FROM pg_replication_slots WHERE slot_name=$1) AS lag`, [s.capture.slot]);
      const end = positions[0]!.lsn;
      if (Number(positions[0]!.lag ?? 0) > 64 * 1024 * 1024 || lsnNumber(end) - lsnNumber(s.cursor) > 64n * 1024n * 1024n) throw new InputError('Capture fell more than 64 MiB behind and was stopped. Start again to follow current WAL.');
      let logical: LogicalRecord[] = [], omittedLogical = 0;
      if (s.capture.slot) {
        const { rows } = await c.query<{ total: number; events: LogicalRecord[] }>(`WITH changes AS MATERIALIZED (
          SELECT lsn::text,xid::text,left(data,4096) AS data,length(data)>4096 AS truncated,seq
          FROM pg_logical_slot_get_changes($1,NULL,500,'include-timestamp','on','skip-empty-xacts','on') WITH ORDINALITY AS d(lsn,xid,data,seq))
          SELECT count(*)::int AS total,coalesce((SELECT jsonb_agg(to_jsonb(t)-'seq' ORDER BY seq) FROM (SELECT * FROM changes ORDER BY seq DESC LIMIT 1000) t),'[]') AS events FROM changes`, [s.capture.slot]);
        logical = rows[0]!.events; omittedLogical = rows[0]!.total - logical.length;
      }
      let physical: PhysicalRecord[] = [], omittedPhysical = 0;
      if (lsnNumber(end) > lsnNumber(s.cursor)) {
        const cap = lsnNumber(s.cursor) + 4n * 1024n * 1024n;
        const until = lsnText(lsnNumber(end) < cap ? lsnNumber(end) : cap);
        const { rows } = await c.query<{ total: number; events: PhysicalRecord[]; last: string | null }>(`WITH records AS MATERIALIZED (
          SELECT start_lsn::text,end_lsn::text,prev_lsn::text,xid::text,resource_manager,record_type,record_length,main_data_length,fpi_length,coalesce(description,'') AS description,coalesce(block_ref,'') AS block_ref
          FROM ${quote(s.ext)}.pg_get_wal_records_info($1::pg_lsn,$2::pg_lsn))
          SELECT count(*)::int AS total,max(end_lsn::pg_lsn)::text AS last,
          coalesce((SELECT jsonb_agg(t ORDER BY start_lsn::pg_lsn) FROM (SELECT * FROM records ORDER BY start_lsn::pg_lsn DESC LIMIT 1000) t),'[]') AS events FROM records`, [s.cursor, until]);
        physical = rows[0]!.events; omittedPhysical = rows[0]!.total - physical.length;
        s.cursor = rows[0]!.last ?? until;
        await this.describe(s, physical);
      }
      return { physical, logical, omittedPhysical, omittedLogical, cursor: s.cursor };
    } catch (e) { await this.stop(token); throw e; }
    finally { s.busy = false; }
  }
  private async describe(s: Session, records: PhysicalRecord[]) {
    const refs = new Map<string, { tablespace: number; file: number }>();
    for (const record of records) for (const m of record.block_ref.matchAll(/rel (\d+)\/(\d+)\/(\d+)/g)) if (Number(m[2]) === s.databaseOid) refs.set(m[0], { tablespace: Number(m[1]), file: Number(m[3]) });
    const names = new Map<string, string>();
    // Resolve only current-database files, and bound catalog work per poll.
    const entries = [...refs.entries()].slice(0, 128);
    if (entries.length) {
      const { rows } = await s.client.query<{ key: string; name: string | null }>(`SELECT r.key,pg_filenode_relation(r.tablespace,r.file)::text AS name
        FROM unnest($1::text[],$2::oid[],$3::oid[]) AS r(key,tablespace,file)`, [entries.map(e => e[0]), entries.map(e => e[1].tablespace), entries.map(e => e[1].file)]);
      for (const r of rows) if (r.name) names.set(r.key, r.name);
    }
    for (const r of records) {
      r.summary = physicalSummary(r.resource_manager, r.record_type); r.relations = [];
      for (const m of r.block_ref.matchAll(/rel (\d+)\/(\d+)\/(\d+) fork (\w+) blk (\d+)/g)) r.relations.push(`${names.get(`rel ${m[1]}/${m[2]}/${m[3]}`) ?? `file ${m[1]}/${m[2]}/${m[3]}`} · ${m[4]} block ${m[5]}`);
    }
  }
}
