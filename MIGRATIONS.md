# Database-to-database migrations

Table files remain the default source and keep their existing workflow. Select **Between databases** in the source selector to migrate between MySQL/MariaDB, MongoDB, PostgreSQL, Microsoft SQL Server and Redis. All five engines can be a source or destination, including separate servers using the same engine.

## Workflow

1. Enter source and destination connection settings. Select an existing database on each server. For Redis, the database name is its numeric index and must match the URI.
2. Load the source structure. Choose up to 200 tables or collections and edit destination names. Redis exposes its selected database as a single keys object.
3. For PostgreSQL or MSSQL choose a destination schema, which must already exist (public or dbo by default). For Redis choose a key prefix.
4. Build and review the plan, including destination types and conversion warnings. Building a plan reads metadata and checks destination availability; it does not copy data.
5. Start the reviewed plan. Progress shows records read, written and skipped. Stop requests cancel the job before commit. The last job ID survives a browser reload.

Plans expire after 15 minutes and can start only once. Starting rechecks the source schema and destination names. Credentials stay in process memory for the plan/job lifetime and are never included in plan/status responses, browser storage or activity logs. Unused expired plans are removed by a timer. Completed job status remains available for one hour in the running gateway process; jobs and plans do not survive a gateway restart.

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
- POST /dbf/migration/plan: source, target, objects, optional targetSchema and redisPrefix → reviewed plan.
- POST /dbf/migration/plan/:id/start: starts a server-held plan; returns HTTP 202 and a job ID.
- GET /dbf/migration/jobs/:id: current job status.
- DELETE /dbf/migration/jobs/:id: requests cancellation; commit cannot be interrupted.

The server allows three concurrent metadata/plan operations, thirty cached plans and two running migrations. HTTP DTOs reject unknown fields and validate nested connections and selections.

## Verification

Gateway tests cover all 25 adapter direction combinations at the orchestration layer, API validation, source schema changes, insert-only behavior, cancellation/rollback, SQL parameter binding, exact numbers, BSON round-trips and binary Redis keys/TTL. Driver I/O in these tests is mocked. A browser smoke test exercises selection, plan review, start, cancellation, refresh recovery and checks that connection secrets never reach local storage.
