import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { commandSql, templates, type Command, type CommandResult } from '../shared/commands';
import { InputError, integer } from '../shared/tree';

/** Fixed templates can only touch the table this process creates, never the selected relation. */
export class Playground {
  readonly schema = `pgviz_play_${randomBytes(6).toString('hex')}`;
  private ready = false;
  private busy = false;
  constructor(private dsn: string) {}
  async execute(input: { command?: unknown; count?: unknown }): Promise<CommandResult> {
    if (!templates.some(t => t.id === input.command)) throw new InputError('Unknown command template.');
    const command = input.command as Command;
    const count = integer(input.count ?? 1000, 'Rows', 0, 10000);
    if (this.busy) throw new InputError('A playground command is already running.');
    if (!this.ready && command !== 'create') throw new InputError('Create the playground first.');
    this.busy = true;
    const client = new pg.Client({ connectionString: this.dsn, connectionTimeoutMillis: 5000,
      options: '-c default_transaction_read_only=off -c statement_timeout=10000 -c lock_timeout=1500 -c search_path=pg_catalog' });
    const table = `"${this.schema}".keys`, sql = commandSql(command, table, count);
    try {
      await client.connect();
      let affected = 0;
      if (command === 'create' && this.ready) { /* Reopen this process's playground after a browser reload. */ }
      else if (command === 'vacuum') await client.query(sql); // VACUUM cannot run inside a transaction.
      else {
        await client.query('BEGIN');
        try {
          if (command === 'create') await client.query(`CREATE SCHEMA "${this.schema}"`);
          else if (['random', 'append', 'duplicates'].includes(command)) {
            const size = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
            if (size.rows[0]!.n + count > 100000) throw new InputError('Playground limit: 100,000 rows. Delete some rows before inserting more.');
          }
          // Identifiers are generated internally; the only substituted input is a validated integer.
          const results = await client.query(sql);
          affected = Array.isArray(results) ? results.reduce((n, r) => n + (r.rowCount ?? 0), 0) : results.rowCount ?? 0;
          await client.query('COMMIT');
          if (command === 'create') this.ready = true;
        } catch (e) { await client.query('ROLLBACK'); throw e; }
      }
      const result = await client.query<{ indexOid: number; tableOid: number; rows: number }>(`SELECT $1::regclass::oid::int AS "indexOid", $2::regclass::oid::int AS "tableOid", (SELECT count(*)::int FROM ${table}) AS rows`, [`"${this.schema}".keys_idx`, table]);
      return { ...result.rows[0]!, schema: this.schema, affected, sql, command };
    } finally { await client.end().catch(() => {}); this.busy = false; }
  }
}
