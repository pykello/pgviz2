# pgviz 2

PostgreSQL physical storage, in a browser. Gray B-tree frames, white key boxes, black arrows and the original heap palette, with a relation picker and an inspector that opens on selection. A TypeScript rewrite of [the original Racket pgviz](../pgviz), preserving its first-two-and-last btree summaries and on-demand page inspection.

The initial screen lists heap tables and B-tree indexes. Select a relation to
inspect it, or click **pgviz** to return to the searchable list.

The URL preserves the relation, view, heap block, page-map range, B-tree
subtree, depth, and key display mode. Refresh, bookmarks, and browser Back
and Forward restore that location. For example, `/?view=heap&oid=123&block=4`
opens block 4 of relation 123 in the connected database. Relation OIDs are
specific to that database; links do not survive dropping and recreating a
relation. WAL links preserve the display mode and filter, but captured
records and active captures are not restored. Click **Start capture** to
watch new activity after refreshing.

Heap data cells show decoded tuple values where supported, clipped with an
ellipsis to fit the available space. Hover a tuple cell or select it for
full values and column names. Labels use the captured page bytes, including
older tuple versions. Unknown types and compressed/external TOAST values
remain raw; columns absent from an older tuple are marked as not stored.

## Run

Requires Node.js 22.12+ (24 recommended).

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:5433**. Without a connection string, pgviz opens an explicitly labeled, illustrative demo. No database is needed to try the interface.

For your database, install `pageinspect` once **in that database** as a superuser:

```sql
CREATE EXTENSION pageinspect;
```

Then start pgviz with a libpq-style connection URL:

```sh
DATABASE_URL='postgresql://postgres:password@localhost:5432/my_database' npm run dev
```

The URL stays on the server. The app binds to loopback, rejects foreign Host/Origin headers, uses read-only transactions for inspection, a four-connection pool, and query/lock timeouts. The Commands menu runs fixed write templates only against a separate, generated playground table. Extensions are never installed automatically. PostgreSQL requires superuser access for these physical inspection functions. This is a local development/diagnostic tool, not an authenticated service for public deployment.

Build and run the bundled browser assets:

```sh
npm run build
DATABASE_URL='postgresql://postgres:password@localhost/my_database' npm start
```

`PORT=5434` changes the local port. `npm run dev -- --demo` explicitly selects demo mode even when `DATABASE_URL` exists. `scripts/lab.sql` creates sample tables and indexes in a new `pgviz_lab` schema; run it manually in a scratch database to experiment with duplicates, updates, text keys, leaf roots and empty indexes.

For a remote machine, forward its pgviz port over SSH:

```sh
ssh -N -L 127.0.0.1:8000:127.0.0.1:5433 user@remote-host
```

Open **http://127.0.0.1:8000** on your computer. The browser port can differ from the remote server port. Loopback Host headers are accepted; any supplied Origin must match the browser's host and port.

## Explore

- **B-tree:** a metapage, succinct page cards, child links and visible sibling links. The first two and last real entries are shown. Click an ellipsis or “+ N more…” to expand entries or branches in place; use Collapse to return to the summary. Start with two levels; choose up to four. Initial reads are limited to 40 sampled pages. Expansion loads branches in batches, with a 200-page limit per view; explore a subtree for larger indexes. Select a node for all entries, filter them, inspect an omitted downlink, or make it the root of a new view. Drag to pan, scroll to zoom, or use the zoom/Fit controls. Keyboard users can focus and activate cards.
- **Heap page:** a byte-proportional free-space strip and a memory map at 16 bytes per cell. Inspect the page header, every line pointer, tuple headers, raw attributes, flags, null bitmap metadata, and tuple hex bytes. Follow heap TIDs from index entries, `ctid` links, and HOT redirects. Null attributes, unused/dead pointers, and redirect pointers are preserved.
- **Page map:** bounded, paginated occupancy tiles for heap tables and btree indexes. Open a page from the map. Color measures occupied physical space; it is not a bloat estimate or MVCC visibility indicator.
- **Refresh comparisons:** use More → Pin baseline, change the database in your SQL client, and refresh. Amber outlines identify changed or newly encountered pages among the pages currently shown. This does not detect changes in unvisited branches or track removed pages.
- **Snapshot export:** download the current tree, heap page, map, or WAL window as JSON, including full loaded items and raw metadata. This is a data export, not an offline snapshot viewer. Treat exports as database contents.

Keys default to **readable values**, decoded from the stored index tuple. Supported types include signed integers (including exact 64-bit values), numeric, floating-point, boolean, UUID, text/varchar/char, and composite or expression keys built from these types. NULLs, posting lists, INCLUDE columns and suffix-truncated pivots are handled. The server's byte order is detected from the metapage. Labels never use a lookup of the current heap row, so older index entries are not relabeled with newer values.

Use **Keys → Raw bytes** to inspect hex. Unsupported types (such as dates, arrays, and custom types), compressed values, and unsupported text encodings fall back to hex. UTF-8 and Latin-1 are decoded; other encodings are limited to ASCII. Full labels and original bytes remain in the inspector.

## Commands playground

On a live connection, open **Commands → Open playground → Run**. This creates a separate `pgviz_play_<random>.keys` table with 100 rows and a B-tree index. Reopening it in the same server process returns the existing table. The app selects its index automatically.

Choose a template and adjust the row count: random inserts, ascending inserts, duplicate keys, indexed-key updates, payload updates (to explore HOT), deletes, or vacuum. SQL preview shows the fixed statement. **Run** executes once; **Repeat** executes once per second after the previous operation completes, until you press **Stop**, close the Commands menu, switch views/relations, or hide the browser tab. Each completed operation refreshes the active view and highlights changed tree pages. The preview allows parameter changes, not arbitrary SQL execution.

Commands always target the process's own playground, regardless of which relation you are viewing. Inputs are bounded to 10,000 rows per operation and 100,000 total rows. Autovacuum is disabled on that table so you can observe changes and run vacuum explicitly. PostgreSQL decides when splits, deduplication, pruning and HOT updates occur; templates demonstrate opportunities, not guaranteed physical outcomes.

The playground schema persists after shutdown so it can be inspected later. Its name appears in the Commands menu; you can drop that specific schema in your SQL client when finished. A new server process gets a new schema. The fixture-only demo has no SQL engine; start with `DATABASE_URL` to enable commands.

## WAL stream

Open **WAL → Start capture** for a live, human-readable physical WAL view. Each row shows the operation (for example, “Split a B-tree page”), relation/block references, LSN and transaction ID. Select a record for PostgreSQL's full description, size, full-page-image information, and related logical changes. Switch **Show → Logical changes** for the reverse view. The filter searches relations, transaction IDs and values. You can run playground commands while staying in WAL view; it polls once per second.

Physical inspection requires this extension in the connected database:

```sql
CREATE EXTENSION pg_walinspect;
```

For logical row values alongside physical records, the server also needs `wal_level=logical`, a free replication slot, and the bundled `test_decoding` output plugin. Setting `wal_level` requires a PostgreSQL restart. Use a superuser or appropriately granted inspection/replication privileges. If logical decoding is unavailable, physical capture still works and the view explains why. pgviz does not change these server settings automatically.

The stream begins at capture time; it does not replay older history. Physical WAL is **cluster-wide** on the current timeline; logical decoding covers the **connected database** and emits row changes after commit. Rollbacks can have physical records but no committed logical row changes. DDL, vacuum, and many system/index records have no logical row event. UPDATE/DELETE old-row contents depend on the table's replica identity.

“LSN match” identifies a heap record at the logical change's LSN boundary. “Same transaction” is explicitly a transaction-level association, not a claim of one logical row per index record. Subtransactions, records outside the capture window, and truncated history can leave unmatched entries. Relation names are resolved against the current catalog; files that were dropped, rewritten or belong to another database may display as file identifiers instead.

Capture uses a randomly named **temporary** logical slot on a dedicated connection. Stop, leaving the WAL view, or hiding the tab releases it; an idle server session expires after 60 seconds. At most two captures can run per app process. Capture stops if its observed lag exceeds 64 MiB; this is a polling safeguard, not a server-enforced disk quota. No existing replication slot is used or consumed. The display retains 1,000 physical and 1,000 logical records and reports omitted records; long logical text is capped at 4,096 characters. Export saves the current captured window.

References: [pg_walinspect](https://www.postgresql.org/docs/18/pgwalinspect.html), [logical decoding](https://www.postgresql.org/docs/18/logicaldecoding-example.html). Key layouts follow PostgreSQL 18's [index tuple definitions](https://github.com/postgres/postgres/blob/REL_18_STABLE/src/include/access/itup.h) and [varlena definitions](https://github.com/postgres/postgres/blob/REL_18_STABLE/src/include/varatt.h).

## PostgreSQL compatibility and accuracy

Targets PostgreSQL **18** with the server's bundled `pageinspect` extension. The adapter resolves relations by OID and discovers the extension schema, so quoted relation names and non-public extension installations work. Partitioned parents have no physical storage and are excluded; inspect their child tables/indexes. The catalog returns at most 500 matching relations; use the search field to narrow it.

The rewrite fixes assumptions in the original:

- Metapage/statistics fields are named records, not positional Racket structures tied to one release.
- A root with level zero is a leaf, even when the page type is `r`.
- High keys never become child links; first real internal pivots are minus infinity.
- Deduplicated posting lists use `tids`/`htid`; encoded `ctid` fields are not treated as heap locations.
- Relation page counts come from relation size and the server's block size, without exception-driven binary search.
- PostgreSQL decodes heap flags, including combined flags. Heap attributes and the header come from the same raw page copy.

Physical inspection is **not an MVCC snapshot**. A heap page is internally consistent, but tree metadata, page statistics, and entries are separate reads. Concurrent splits, vacuum, truncation or relation replacement can make an overview inconsistent or a block disappear. Refresh, or inspect a quiescent database when consistency matters. Do not infer tuple visibility merely from `xmin`, `xmax`, or a normal line pointer.

Authoritative reference: [PostgreSQL 18 pageinspect documentation](https://www.postgresql.org/docs/18/pageinspect.html).

## Verify

```sh
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:browser
```

Live integration tests require a **scratch database**. They create a uniquely named test schema and drop it afterward. They may install `pageinspect` and `pg_walinspect` if absent; those extensions remain installed. Logical WAL integration tests require `wal_level=logical`; otherwise that portion is skipped.

```sh
TEST_DATABASE_URL='postgresql://postgres:password@localhost/scratch' npm run test:integration
TEST_DATABASE_URL='postgresql://postgres:password@localhost/scratch' npm run test:browser
```

Live browser tests also create and remove a playground schema to verify command execution, refresh, repeat/stop, and reopening after reload. Without `TEST_DATABASE_URL`, this test is skipped and the demo browser tests still run.

Integration coverage includes empty indexes, leaf roots, multi-page posting lists, text/composite keys, quoted identifiers, heap nulls/flags, occupancy maps and block validation. CI runs the adapter against PostgreSQL 18. Browser tests exercise drilldown, TID/ctid navigation, pagination, export, keyboard interaction, zoom, mobile layout and request restrictions.

## Structure

- `src/shared/`: strict TypeScript API models, tree normalization and explicit integer-key decoding.
- `src/server/`: PostgreSQL adapter, deterministic demo provider, local HTTP server.
- `src/client/`: TypeScript/SVG tree renderer, heap/map views and inspector. No frontend framework or CDN dependency.
- `tests/`: unit, real-database integration and Playwright tests.

New physical visualizations can extend the shared `Api` model and provider dispatch, then add a browser renderer using the existing relation browser and inspector. BRIN, GIN, GiST, visibility maps and FSM views are potential extensions; they are **not implemented** in this version.

Licensed under GPL-3.0-only, retaining the original project's GPLv3 license. This is a new implementation inspired by the original design.
