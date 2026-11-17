# Native database connector

Rust sidecar for local database discovery and authenticated, read-only connection checks. Electron ships the compiled executable alongside its resources; NestJS sends one JSON request over stdin and reads one JSON response from stdout. Passwords and URIs are never passed in command arguments, written to disk or included in error messages.

Build and test:

    cargo test --locked
    cargo clippy --locked --all-targets -- -D warnings
    cargo build --release --locked

Desktop builds invoke Cargo automatically. Development API launches look for target/release/db-connector.exe (db-connector on other platforms); DBF_CONNECTOR_BIN can specify an absolute executable path.

Commands:

    {"command":"discover"}
    {"command":"test","connection":{"engine":"postgres","host":"localhost","port":5432,"user":"postgres","password":"...","database":"legacy","encrypt":true,"trustServerCertificate":false}}

Engines: mysql (including MariaDB), mongo, postgres, mssql, redis. MongoDB checks take a uri field. Connection checks authenticate, read the server version and list accessible databases where permissions allow; they create no databases or tables and disconnect afterward. Import execution remains in the existing migration services.

On Windows discovery reads service definitions, SQL Server instance/TCP configuration from the registry, and DB server process command lines. It correlates numeric listening ports to process IDs and reads the referenced local configuration file for custom ports. UNC configuration paths are ignored. It probes only loopback IPv4/IPv6 endpoints; it does not search the LAN, guess passwords, start services or modify the registry. Default ports are shown only after a matching protocol response. Installed services can be shown as unavailable; an open port is distinct from a successful authenticated connection. Config includes and Unix socket-only/LocalDB named-pipe instances are not resolved automatically; manual TCP configuration remains available.

Drivers: [mysql_async](https://docs.rs/mysql_async/0.36.2/mysql_async/), [tokio-postgres](https://docs.rs/tokio-postgres/latest/tokio_postgres/), [tiberius](https://docs.rs/tiberius/0.12.3/tiberius/), [mongodb](https://docs.rs/mongodb/3.3.0/mongodb/).

The inspect command reads database structure without reading table rows or MongoDB documents. Metadata reports can be downloaded from each import form. Limits and examples: [RUST_FEATURES.md](../../RUST_FEATURES.md).

Redis supports redis:// and rediss:// URIs, ACL authentication, database indexes, PING and optional INFO server. Discovery includes redis-server/valkey-server and ports 6379/6380; the catalog reports the selected database index. SQL structure inspection is not supported for Redis. See [REDIS_IMPORT.md](../../REDIS_IMPORT.md) for the import format.
