# GraphQL database API

The gateway exposes **POST /dbf/graphql** in development, desktop and web builds. It uses the same database connectors, migration plans and running jobs as the REST API, for MySQL/MariaDB, MongoDB, PostgreSQL, Microsoft SQL Server and Redis.

Send a JSON object with query, optional variables and optional operationName. Use Content-Type: application/json and Accept: application/graphql-response+json (application/json is also supported). Check the response errors array even when the HTTP status is 200. GET requests to the operation endpoint are refused, so database credentials belong in the JSON body rather than URLs.

The schema is available at **GET /dbf/graphql/schema** as SDL and through standard POST introspection. These endpoints use the existing web authentication and Origin restrictions. In web mode, authenticate using the same HTTP Basic account as the application. Use the existing HTTPS deployment for remote access; desktop/development mode remains on its configured local API address.

## Operations

| Operation | Purpose |
| --- | --- |
| Query databaseConnection(connection) | Test authentication and list databases, using the Rust connector |
| Query databaseCatalog(connection) | List tables/collections and their columns; Redis exposes its keys object |
| Query migrationStatus(id) | Poll progress and outcome of a GraphQL- or REST-started migration |
| Mutation prepareMigration(input) | Create a plan to review, with destination types, warnings and detected upgrade versions |
| Mutation startMigration(planId) | Start a reviewed, server-held plan once; returns a job ID immediately |
| Mutation cancelMigration(jobId) | Request cancellation before commit |

The schema documents the inputs and output fields. The database field is optional for connection checks and required for catalogs and migrations. The Rust connector must be built for databaseConnection, as for the existing connection-check panel. Migration/catalog operations use the gateway's existing Node.js drivers.

## Check a connection and read metadata

Send the following query and variables together in one JSON POST body:

~~~graphql
query Connect($connection: DatabaseConnectionInput!) {
  databaseConnection(connection: $connection) {
    serverVersion
    databases
    connector
    elapsedMs
  }
}
~~~

~~~json
{
  "connection": {
    "engine": "mysql",
    "host": "127.0.0.1",
    "port": 3306,
    "user": "migration_user",
    "password": "YOUR_DATABASE_PASSWORD"
  }
}
~~~

Add database to those variables to read the catalog:

~~~graphql
query Catalog($connection: DatabaseConnectionInput!) {
  databaseCatalog(connection: $connection) {
    objects {
      id
      schema
      name
      format
      columns { name kind nullable precision scale }
    }
  }
}
~~~

Use the returned object id verbatim in the migration selection. SQL object IDs encode both schema and table names. MongoDB and Redis connections use uri; Redis also requires database to match the numeric database index in the URI.

## Prepare, review and start a migration

~~~graphql
mutation Plan($input: MigrationPlanInput!) {
  prepareMigration(input: $input) {
    id
    mode
    expiresAt
    sourceEngine
    targetEngine
    sourceVersion { family version }
    targetVersion { family version }
    objects {
      source { id name }
      targetName
      targetSchema
      columns { name kind targetType nullable }
    }
    warnings
  }
}
~~~

Example variables for moving selected MySQL data to a newer server:

~~~json
{
  "input": {
    "mode": "upgrade",
    "source": {
      "engine": "mysql",
      "host": "old-db.internal",
      "port": 3306,
      "user": "migration_user",
      "password": "SOURCE_PASSWORD",
      "database": "legacy"
    },
    "target": {
      "engine": "mysql",
      "host": "new-db.internal",
      "port": 3306,
      "user": "migration_user",
      "password": "DESTINATION_PASSWORD",
      "database": "destination"
    },
    "objects": [
      { "sourceId": "[\"legacy\",\"items\"]", "targetName": "items" }
    ]
  }
}
~~~

Review the returned columns and warnings before submitting startMigration with the returned plan ID. The transfer mode is the default; upgrade requires the same database family and a strictly newer destination, and rechecks server versions before writing. Databases and any destination SQL schema must already exist. All data conversion, transaction, partial-write and schema recreation limits in [MIGRATIONS.md](MIGRATIONS.md) apply.

~~~graphql
mutation Start($id: ID!) {
  startMigration(planId: $id) { id state phase }
}
~~~

Poll with the job ID returned by startMigration:

~~~graphql
query Progress($id: ID!) {
  migrationStatus(id: $id) {
    id state phase object
    read written skipped
    startedAt finishedAt error warnings
  }
}
~~~

~~~graphql
mutation Cancel($id: ID!) {
  cancelMigration(jobId: $id) { id state phase warnings }
}
~~~

Counters use GraphQL Float so jobs above the 32-bit GraphQL Int limit remain readable. They are the same integer-valued JavaScript counters as in REST. Dates are ISO strings. Plans expire after 15 minutes and are single-use. Completed jobs remain available for one hour in the running process. Restarting the gateway clears both plans and jobs.

## Request handling and limits

Send one root database operation per request; use separate requests for a connection check, planning, start and status. Aliases and fragments cannot combine several database actions into one operation. Multiple named operations in a document are supported when operationName selects one. Standard introspection queries are supported.

The endpoint accepts JSON POST requests, without batching, subscriptions or multipart uploads. Documents are limited to 32 KiB, 5000 parser tokens, depth 20 and 1000 selections after fragment expansion. Existing HTTP body size, DTO validation, 200-object selection, metadata concurrency, plan cache and running-job limits remain in force. Schema input fields reject unknown fields; DTOs also validate lengths, ports and required database names.

Errors include an extensions.code such as BAD_USER_INPUT, NOT_FOUND, SERVICE_UNAVAILABLE or INTERNAL_SERVER_ERROR. Invalid GraphQL syntax, variable coercion and unexpected driver errors are masked so input values, connection strings and stack traces are not echoed. Use the schema to correct invalid fields or variable types. The endpoint sets Cache-Control: no-store. Connection inputs are not fields of any output type and are kept only for the existing plan/job lifetime.

## Verification

Gateway tests exercise the endpoint with real GraphQL parsing/execution and mocked database drivers: all five connection/catalog adapters, shared REST/GraphQL jobs, version upgrades, cancellation, large counters, input validation, introspection, fragment/alias limits and credential masking. The web smoke check tests actual startup, authentication, Origin restrictions, schema access and introspection. Live database access still depends on the selected drivers, credentials, server versions and installed Rust binary.

Implementation references: [GraphQL.js server documentation](https://www.graphql-js.org/docs/running-an-express-graphql-server/) and the [graphql-http HTTP adapter](https://github.com/graphql/graphql-http).
