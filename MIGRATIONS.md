# Database-to-database migrations

Table-file imports keep their existing workflow. Open **Between databases** from the homepage or navigation bar to migrate between MySQL/MariaDB, MongoDB, PostgreSQL, Microsoft SQL Server and Redis. All five engines can be a source or destination, including separate servers using the same engine.

## Workflow

1. Enter source and destination connection settings. Select an existing database on each server. For Redis, the database name is its numeric index and must match the URI.
2. Load the source structure. Choose up to 200 tables or collections and edit destination names. Redis exposes its selected database as a single keys object.
3. For PostgreSQL or MSSQL choose a destination schema, which must already exist (public or dbo by default). For Redis choose a key prefix.
4. Build and review the plan, including destination types and conversion warnings. Building a plan reads metadata and checks destination availability; it does not copy data.
5. Start the reviewed plan. Progress shows records read, written and skipped. Stop requests cancel the job before commit. The last job ID survives a browser reload.

Plans expire after 15 minutes and can start only once. Starting rechecks the source schema and destination names. Credentials stay in process memory for the plan/job lifetime and are never included in plan/status responses, browser storage or activity logs. Unused expired plans are removed by a timer. Completed job status remains available for one hour in the running gateway process; jobs and plans do not survive a gateway restart.

## Older-to-newer versions

Open **Version upgrade** directly from the homepage or navigation bar (`?view=upgrade`). Choose the source engine and enter the **Old server** and **New server** connections. The destination engine follows the source. Install the new server and create its destination database before building the plan.

The plan reads actual server versions using SQL version queries, MongoDB buildInfo or Redis INFO server. These metadata permissions are required. It displays the detected versions, requires the same database family and a strictly newer destination, and rechecks versions before creating any destination objects. A changed version invalidates the reviewed plan. MySQL and MariaDB are checked as separate families; use regular transfer for migrations between them. Equal-version transfers and downgrades remain available in regular transfer mode.

This is a logical **data copy**, not a server installer or an in-place/full-schema upgrade. For example, selected MySQL 5.6 data can be read and inserted into new tables on an 8.0+ server using the normal type mappings below, subject to driver and data compatibility. Indexes, constraints, defaults, triggers, routines, events, views, users and server settings are not recreated. Review converted column types before switching applications. Native MySQL upgrades have their own [supported upgrade paths](https://dev.mysql.com/doc/refman/8.0/en/upgrade-paths.html); this tool does not implement those procedures.

All five adapters support this workflow: MySQL/MariaDB, MongoDB, PostgreSQL, MSSQL and Redis. The installed [MongoDB 6.22 driver requires MongoDB 4.2+](https://mongodb.github.io/node-mongodb-native/6.22/); older sources require an intermediate migration using compatible vendor tools. Version comparison does not certify arbitrary server pairs or application compatibility. SQL data representations and transaction behavior remain as documented below. MongoDB documents retain BSON types; collection options and indexes are not recreated. In Redis upgrade mode, original binary key names, native values and expiry are preserved without a prefix. Existing keys are never replaced; modules and [DUMP/RESTORE payload compatibility](https://redis.io/docs/latest/commands/restore/) are still required.

Upgrade version parsing also rejects development markers such as MySQL milestone (`m1`), DMR, dev and CTP suffixes. Stable vendor/package suffixes still normalize to numeric versions; family and version drift checks run again before destination creation.

PostgreSQL `numeric` declarations with a negative scale or a scale larger than precision are widened to portable decimal capacity: `numeric(2,-3)` becomes `decimal(5,0)`, and `numeric(3,5)` becomes `decimal(5,5)`. PostgreSQL uses unbounded numeric when the widened capacity exceeds its 1000-digit declaration limit; destinations with insufficient numeric capacity are rejected before writing. These mappings preserve existing values without recreating the original scale constraint. See the [PostgreSQL numeric documentation](https://www.postgresql.org/docs/17/datatype-numeric.html).

PostgreSQL monetary values are converted to exact numeric text on the source server, so currency symbols and locale-specific thousands separators cannot corrupt or block inserts. This follows the documented [lossless money-to-numeric conversion](https://www.postgresql.org/docs/12/datatype-money.html). MongoDB reads preserve BSON regular expressions directly, including nested PCRE patterns and options; the migration does not compile them as JavaScript regular expressions.

## Data representations

| Source | SQL destination | MongoDB destination | Redis destination |
| --- | --- | --- | --- |
| SQL tables | Columns with checked numeric/binary types; dates/timestamps and unsupported types as text | One BSON document per row, exact integers and decimals where BSON permits; SQL JSON remains text | One canonical Extended JSON string per row |
| MongoDB collections | An _id column and a canonical Extended JSON document column | Original nested BSON documents, including _id | One canonical Extended JSON string per document |
| Redis | Binary key, Redis type, binary DUMP payload and absolute expiry milliseconds | The same fields as BSON documents | Native values restored from DUMP, preserving type and expiry |

SQL dates and timestamps use text to preserve fractional seconds, timezone offsets and MySQL zero dates. Unbounded decimals use PostgreSQL numeric, or text on MySQL/MSSQL. Bounded decimals exceeding a destination's precision are rejected when planning. MongoDB Decimal128 has a 34-significant-digit limit: values outside its range cause a failure rather than silent rounding. SQL JSON columns remain JSON text to preserve large numeric literals. MongoDB _id uniqueness still applies when SQL rows include a column named _id.

This is a data migration. Primary/foreign key constraints, secondary indexes, triggers, users, defaults and computed expressions are not recreated. SQL views and MongoDB views are excluded. Nonstandard SQL types use their driver's textual/JSON representation. Native data type recreation can be extended through the shared column model and destination adapters.

Redis output keys are prefix:object:row for SQL/MongoDB records and prefix:object:original-key for native Redis records; the original key suffix remains binary. Existing keys are never replaced. DUMP payloads need a compatible Redis version and installed modules to be restored. Redis-to-Redis requires INFO server permission to reject the same server/database even through hostname aliases. Expired keys are skipped. SCAN may repeat keys, so the reader keeps key fingerprints in memory; record values are streamed one at a time.

Canonical Extended JSON preserves BSON types and nested structures: [MongoDB driver documentation](https://www.mongodb.com/docs/drivers/node/current/data-formats/extended-json/). Redis payloads use [DUMP](https://redis.io/docs/latest/commands/dump/) and RESTORE.

## Failure and consistency

Only new tables/collections/keys are created. There is no replacement, merge, continuous synchronization or deletion of source data.

PostgreSQL and MSSQL create tables and insert rows inside one destination transaction. MySQL creates InnoDB tables before starting the data transaction: failed/cancelled jobs roll back inserted rows but can leave empty created tables. MongoDB writes records individually into temporary collections, then publishes each collection using rename without replacing an existing destination. Failures can leave temporary collections, whose names appear in the job warnings. Redis writes records individually; partial results remain after a failure/cancellation. A failed COMMIT or rollback is reported as an uncertain outcome rather than claiming a rollback succeeded.

Source records are streamed with bounded row buffers; PostgreSQL uses a read-only cursor per table, MySQL and MSSQL use driver streams, MongoDB uses a cursor, Redis uses SCAN. A migration is not a global source snapshot. Stop application writes during migration if a consistent view across objects is required.

## API

All routes stay under /dbf so the existing web authentication and static-file routing apply:

- POST /dbf/migration/catalog: connection → source objects.
- POST /dbf/migration/plan: source, target, objects, optional mode (transfer by default or upgrade), targetSchema and redisPrefix → reviewed plan.
- POST /dbf/migration/plan/:id/start: starts a server-held plan; returns HTTP 202 and a job ID.
- GET /dbf/migration/jobs/:id: current job status.
- DELETE /dbf/migration/jobs/:id: requests cancellation; commit cannot be interrupted.

The server allows three concurrent metadata/plan operations, thirty cached plans and two running migrations. HTTP DTOs reject unknown fields and validate nested connections and selections.

The same operations are available through [GraphQL](GRAPHQL.md) at POST /dbf/graphql. REST and GraphQL share plans, jobs and limits.

## Verification

Gateway tests cover all 25 adapter direction combinations at the orchestration layer, API validation, source schema changes, insert-only behavior, cancellation/rollback, SQL parameter binding, exact numbers, BSON round-trips and binary Redis keys/TTL. Regression coverage includes MySQL 5.6 to 8.0 plans and execution through REST and GraphQL, invalidated version plans, development-version rejection, PostgreSQL numeric/money values and byte-identical MongoDB BSON regex round-trips. Driver I/O in these tests is mocked. A browser smoke test exercises selection, plan review, start, cancellation, refresh recovery and checks that connection secrets never reach local storage.
