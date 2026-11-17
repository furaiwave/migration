# Importing table files into Redis

Redis supports hashes: records containing named fields. Select Redis in **Export to**. Each active source record is written to a separate hash. Redis does not create foreign keys, SQL tables or indexes; relationship values are stored as ordinary fields.

## Connection and import

1. Enter a URI such as redis://localhost:6379/0. Use redis://user:password@host:6379/0 for ACL/password authentication or rediss://user:password@host:6380/0 for TLS. URL-encode special characters in usernames and passwords. The URI path selects the database index, which defaults to 0.
2. Click **Test connection**. The Rust driver checks authentication and TLS. The server must respond to PING. INFO server is read if ACL permissions allow it; otherwise a successful PING is sufficient.
3. Set a prefix containing 1–64 Latin letters, digits, underscores or hyphens. The plan shows tables, columns and key formats.
4. Choose a mode, TTL and whether to include deleted records, then start the import. Progress and results appear in the panel and log. The URI and password are not saved in the server profile or activity log.

In cloud mode, the connection originates from the container/VPS. localhost refers to the application container. For a remote database, use a network or VPN reachable from the server; rediss:// enables TLS with certificate verification.

## Data format

| Source | Redis |
| --- | --- |
| Record with a primary key | prefix:table:pk:SHA256(JSON string of the primary key value) |
| Record without a primary key | prefix:table:row:source-record-number |
| Deleted record | prefix:table_deleted:row:source-record-number |
| NULL field | JSON null, stored as the four-character string null |
| Any other field | A JSON string containing the exact canonical value |

For example, the name Alice is stored as the JSON string `"Alice"`, empty text as `""`, and the number 9007199254740993 as `"9007199254740993"`. Decode values returned by HGET with JSON.parse. Dates are canonical text and binary data is hexadecimal text; the plan shows each field type. Numbers are not rounded through JavaScript Number. The import handles source fields supported by the existing decoder; unsupported fields are identified in the plan.

The primary key comes from a suitable single-field CDX candidate tag after uniqueness checks. Without such a tag, the record number is used.

Record numbers refer to the original source and retain gaps caused by deleted rows. For a table without a primary key, reordering or PACK in the source system changes key correspondence. Deleted records always use record numbers so repeated historical primary keys do not lose data.

## Modes and limitations

- **New keys only:** any existing key is skipped without changing its value or TTL. Written and skipped records are counted separately.
- **Update hashes:** updates imported fields in an existing hash and preserves other fields. A key of another type is not overwritten; the import fails, and you should choose another prefix.
- TTL is specified in seconds for the entire written key. In update mode, 0 removes an existing expiry and a positive value sets a new expiry. Skipped keys are unchanged.
- The import does not run FLUSHDB or FLUSHALL, search for or delete unrelated keys, or delete records that disappeared from source. Use a separate prefix for each independent dataset.
- Each record's Lua operation is isolated from concurrent commands. The entire import is not a rollback-capable transaction: records already written remain after an error or cancellation. If the connection breaks, the last request may have completed without its acknowledgement reaching the client.
- Each record is limited to 1024 fields and 4 MiB of fields/values. Two Redis imports may run concurrently. Completed task states stay in server memory for one hour.
- A single Redis endpoint is used. Redis Cluster through a cluster-aware driver and Sentinel are not implemented. The Rust catalog returns only the selected database index; SQL structure inspection does not apply to Redis.
- Required permissions include PING, SELECT for the selected database, EVAL and the script's TYPE, HSET, EXPIRE and PERSIST commands. The client may send CLIENT SETINFO; INFO server is optional. ACL rules must allow the chosen prefix. This mode does not support servers that prohibit EVAL.

Redis normally keeps data in memory. Durability across restarts or memory pressure depends on the server's persistence, eviction policy and other Redis settings. TTL also removes data when it expires.

## Verification

Server tests cover key identity, exact values, NULL versus empty strings, TTL, skipping, cancellation and secret-safe errors. The browser check covers Redis in the engine selector, plan review, Rust connection testing and import completion.

To test against a real, dedicated Redis instance, build migration-gateway, set REDIS_TEST_URL and run npm run test:redis in migration-gateway. The script creates a random test prefix and cleans only its known test keys. If DBF_CONNECTOR_BIN is set, it also checks the Rust driver. Cloud checks include Redis 7 and verification inside the Linux image. No local Redis server was available in the development environment, so a real-server integration test was not run there.

Sources: [Redis hashes](https://redis.io/docs/latest/develop/data-types/hashes/), [connecting with node-redis](https://redis.io/docs/latest/develop/clients/nodejs/connect/), [Lua/EVAL](https://redis.io/docs/latest/commands/eval/).
