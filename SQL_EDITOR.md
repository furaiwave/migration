# SQL editor

Open **Source data → SQL editor** to work with PostgreSQL, MySQL/MariaDB or Microsoft SQL Server. SQL runs through the Rust connector; the TypeScript interface provides CodeMirror editing, a schema explorer, query tabs and virtualized results.

## Workflow

1. Enter connection settings, optionally load the database list, and click **Connect**. Expand **Connection** to change settings or save a profile. Profiles contain endpoint, database, user and TLS settings; passwords remain in memory.
2. Write SQL, open a UTF-8 .sql file, or use the play button beside a table to open its bounded SELECT in a new tab.
3. **Ctrl+Enter** executes selected text, or the entire script when nothing is selected. SQL completion includes accessible schemas, tables and columns. Use the editor's standard find, undo and redo shortcuts.
4. Inspect result sets, sort columns, filter the retained rows, double-click a cell for its full retained value, or export CSV/JSON. Values are strings or null, preserving large integers and decimal precision. JSON exports use separate columns and rows arrays, retaining duplicate column names.
5. **Stop** aborts the HTTP request and terminates its native worker. It does not undo already committed SQL; inspect the database before repeating writes.

INSERT, UPDATE, DELETE and DDL execute with the connected user's permissions. The result grid is read-only; modify data by submitting SQL. DDL changes appear in the tree after **Refresh structure**.

Each run opens a dedicated connection. Submit BEGIN/COMMIT and related statements as one script; transactions, connection-local settings and temporary tables do not carry across executions. Closing a connection rolls back an uncommitted transaction. Query buffers and history remain in memory; use **Save SQL file** for a durable script.

## Responsiveness and limits

- The editor loads lazily when opened. The grid virtualizes rows and columns instead of mounting every cell. Its browser test exercises 5000 × 16 cells while rendering around 300 cells.
- Rust reads driver responses incrementally. It retains up to the selected row limit (1–5000) per result set, at most 16 sets and 512 columns per set, within a shared 2,000,000-byte data budget. The result may therefore contain fewer rows than requested.
- Cell text is capped at 16,384 UTF-8 bytes, column labels at 256 bytes and type labels at 128 bytes. Clipped cells/columns and truncated results are marked; exports contain only the retained data.
- Execution is limited to 30 seconds. Remaining rows are drained to finish the submitted batch; a display limit does not make an unrestricted database query cheap. Use WHERE/LIMIT/TOP for database-side limits.
- A statement batch is at most 196,608 UTF-8 bytes, and its full native request at most 262,144 bytes. Interactive SQL files may be up to 2 MB. The separate SQL dump inspector supports larger files.
- SQL Server completion does not expose affected-row counts through the current streaming adapter; a command without a result set reports completion. PostgreSQL and MySQL report available command counts.
- Each native worker uses two runtime threads. The bridge admits up to four concurrent native operations and bounds query response transport to 4 MB.
- Driver error details, SQL text, passwords and result values are not written to the activity log. PostgreSQL SQLSTATE and error positions are returned alongside sanitized error categories.

## Checks

~~~powershell
npm.cmd --prefix client run test:editor
npm.cmd --prefix client run test:english
npm.cmd --prefix client run test:editor:browser
npm.cmd --prefix migration-gateway test -- --runInBand
npm.cmd --prefix migration-gateway run build
cargo test --offline --locked --manifest-path native/db-connector/Cargo.toml
cargo clippy --offline --locked --manifest-path native/db-connector/Cargo.toml --all-targets -- -D warnings
cargo build --offline --release --locked --manifest-path native/db-connector/Cargo.toml
node native/db-connector/scripts/test-query-protocol.cjs
~~~

The native protocol test uses a local PostgreSQL protocol fixture and the actual Rust driver, not a production database. Browser tests mock API responses to verify editing, selection, tabs, completion, virtualization, exports, localization, cancellation and credential privacy. Real server authentication, SQL semantics and vendor-specific behavior still require testing against the intended database.
