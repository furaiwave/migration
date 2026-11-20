# Rust module capabilities

Module: native/db-connector. It ships with the Electron application as a separate executable. End users do not need Rust installed.

## New features

### DNS and TCP diagnostics

The diagnose command checks one specified server without a username, password or SQL queries. The selected server panel provides a **Network diagnostics** button.

The response contains a status, elapsedMs and resolvedAddresses:

| Status | Meaning |
| --- | --- |
| reachable | The TCP port accepts connections |
| refused | The connection was refused |
| timeout | The TCP connection timed out |
| unreachable | A network error occurred or no route is available |
| dnsError | The hostname could not be resolved |
| dnsTimeout | DNS lookup timed out |

DNS lookup is limited to two seconds and each TCP address check to three seconds. Up to eight unique IPv4/IPv6 addresses are checked concurrently; the first successful address completes the operation. An open port does not verify the database engine, password or import permissions.

Example JSON request sent to the Rust module's stdin:

~~~json
{"command":"diagnose","endpoint":{"host":"127.0.0.1","port":5432}}
~~~

Application API: POST /dbf/native/diagnose. Body: {"host":"127.0.0.1","port":5432}.

### Database catalog before choosing a destination

The catalog command connects with the supplied credentials and requests accessible database names. In the PostgreSQL and MSSQL forms, **Load database list** works before a destination database is filled in. Returned names appear in a selector; no database is automatically chosen for import.

If no database is specified, PostgreSQL initially connects to postgres and MSSQL to master. If that database is unavailable or the user lacks access, enter a known accessible database manually and retry.

The API also supports MySQL/MariaDB and MongoDB. Names are sorted, duplicates and empty names are removed. If listing permissions are limited, the result may contain only the database used for the connection; a complete catalog is not guaranteed.

~~~json
{"command":"catalog","connection":{"engine":"postgres","host":"localhost","port":5432,"user":"postgres","password":"<password>","encrypt":true,"trustServerCertificate":false}}
~~~

API: POST /dbf/native/catalog. The body is the connection object without an outer wrapper. For MongoDB, supply engine: mongo and uri instead of SQL server credentials.

### Destination structure inspection

The inspect command reads metadata from the selected database. Each import form includes a **Destination database structure** panel with a **View structure** button. For SQL engines, specify an existing destination database first.

- PostgreSQL, MySQL/MariaDB and MSSQL: schemas, tables, views, column names, data types, nullability and column order.
- MongoDB: collection and view names. Documents are not read and fields are not inferred. It uses the explicitly specified database, the URI database or admin when no name is supplied.
- PostgreSQL and MSSQL show base type names without every parameter, index, foreign key or constraint. This is a metadata overview rather than executable DDL.
- Only metadata visible to the current user is returned. An object missing from the report is not proof that it does not exist.

The report includes engine, database, elapsedMs, objects and truncated. Each column in objects has name, dataType, nullable and ordinal. Table rows, document values, passwords and URIs are not included.

Limits are 200 objects, 2000 metadata rows and 768,000 bytes for the objects JSON array. When a limit is reached, truncated=true and the last table may have an incomplete column list. The interface displays a warning. The operation is limited to 12 seconds. It does not automatically import data, modify structures or read table rows.

The connected database tree is also available inside both connection forms in **Between databases**. Expand a database, schema, table or view to browse its column metadata. Search by schema, object, column or data type; matches retain their ancestors. **Expand all** and **Collapse all** control the branches. Arrow keys, Home, End, Enter and Space work within the tree. **Refresh structure** reads a new snapshot. Table names remain distinct across schemas, and metadata limit warnings remain visible.

MySQL uses its selected database as the schema level. MongoDB shows collections/views without reading documents or inventing SQL columns. Redis connections show their selected database and a keys node through the existing migration catalog; the tree does not scan or display key values.

**Download structure .json** saves the current snapshot as schema-<database>.json. Changing connection settings hides the previous report. Request a new snapshot after server-side schema changes.

~~~json
{"command":"inspect","connection":{"engine":"postgres","host":"localhost","port":5432,"user":"postgres","password":"<password>","database":"legacy","encrypt":true,"trustServerCertificate":false}}
~~~

API: POST /dbf/native/inspect. The body is the connection object. MongoDB accepts engine: mongo, uri and an optional database.

SQL metadata sources: [PostgreSQL information_schema](https://www.postgresql.org/docs/current/infoschema-columns.html), [MySQL information_schema](https://dev.mysql.com/doc/refman/8.4/en/information-schema-columns-table.html) and MSSQL sys.objects/sys.columns. Connections use the same Rust TLS and authentication settings as test and catalog.

### Connection check timing

Responses from test, catalog and inspect include elapsedMs: total time for connection establishment, TLS, authentication, metadata retrieval and disconnection. This is not a pure network ping. The database selector shows the timing beside the returned names.

## Existing capabilities

- Discovery of local Windows services, database processes, configuration files and SQL Server registry instances.
- Detection of custom ports from configuration and process IDs; loopback IPv4/IPv6 checks.
- Distinguishing an open TCP port from a database protocol response.
- Authenticated MySQL/MariaDB, MongoDB, PostgreSQL and MSSQL connections through Rust drivers.
- TLS and explicit server certificate trust settings.
- Server selection before source upload, with the endpoint copied into the future import form.
- Time-limited operations, JSON response validation and password-free logging.

## What Rust does not handle

Existing server services still transfer rows, create tables and manage import transactions. Discovery and metadata commands do not create or delete databases or tables. The SQL editor query command executes explicitly submitted SQL, including data and schema changes, through Rust drivers. See [SQL_EDITOR.md](SQL_EDITOR.md) for query lifetime, limits and cancellation semantics. Service discovery primarily targets Windows. Automatic discovery does not resolve Unix sockets, LocalDB named pipes or every form of included configuration; enter a TCP address manually for those cases.

Passwords go to the child process through stdin rather than command-line arguments, files or logs. Saved server selections contain only non-secret endpoint settings. Diagnostics and catalog retrieval do not start imports automatically.

## Checks from the repository root

~~~powershell
cargo test --locked --manifest-path native/db-connector/Cargo.toml
cargo clippy --locked --manifest-path native/db-connector/Cargo.toml --all-targets -- -D warnings
npm.cmd --prefix migration-gateway test -- --runInBand
npm.cmd --prefix client run test:native
npm.cmd --prefix client run test:i18n
npm.cmd --prefix client run build
npm.cmd --prefix desktop run build
~~~

For the complete browser scenario, run node client/scripts/smoke-i18n.cjs after building the client. Local TCP socket checks do not need an installed database server. Actual database authentication checks require valid user credentials.

## Redis

Redis is included in the engine list, with redis-server/valkey-server discovery and local port checks for 6379/6380. The Rust driver supports redis:// and rediss://, ACL/password authentication, database indexes, PING and optional INFO server. The catalog returns the selected index without scanning keys; the SQL inspector does not apply to Redis. source transfer runs in the server service using the official node-redis client. See [REDIS_IMPORT.md](REDIS_IMPORT.md).
