import { buildSchema } from 'graphql';

// Keep SDL in the bundle so desktop and web builds use exactly the same schema.
export const graphqlSchemaSource = ` 
  enum DatabaseEngine { mysql mongo postgres mssql redis }
  enum DatabaseFamily { mysql mariadb mongo postgres mssql redis }
  enum MigrationMode { transfer upgrade }
  enum ColumnKind { text boolean integer decimal float date datetime binary json }
  enum ObjectFormat { rows documents redis }
  enum MigrationState { running done failed cancelled }
  enum MigrationPhase { connecting copying committing finished }

  """Connection settings are input-only and never returned by this API."""
  input DatabaseConnectionInput {
    engine: DatabaseEngine!
    host: String
    port: Int
    user: String
    password: String
    """Required for catalogs and migrations; optional for a connection check."""
    database: String
    uri: String
    encrypt: Boolean
    trustServerCertificate: Boolean
  }

  input ObjectSelectionInput {
    sourceId: String!
    targetName: String!
  }

  input MigrationPlanInput {
    mode: MigrationMode = transfer
    source: DatabaseConnectionInput!
    target: DatabaseConnectionInput!
    objects: [ObjectSelectionInput!]!
    targetSchema: String
    redisPrefix: String
  }

  type DatabaseConnectionInfo {
    serverVersion: String!
    databases: [String!]!
    connector: String!
    elapsedMs: Float
  }

  type MigrationColumn {
    name: String!
    kind: ColumnKind!
    nullable: Boolean!
    precision: Int
    scale: Int
    primaryKey: Boolean
  }

  type PlannedColumn {
    name: String!
    kind: ColumnKind!
    nullable: Boolean!
    precision: Int
    scale: Int
    primaryKey: Boolean
    targetType: String!
  }

  type MigrationObject {
    id: String!
    schema: String!
    name: String!
    format: ObjectFormat!
    columns: [MigrationColumn!]!
  }

  type DatabaseCatalog {
    objects: [MigrationObject!]!
  }

  type PlannedObject {
    source: MigrationObject!
    targetName: String!
    targetSchema: String!
    columns: [PlannedColumn!]!
  }

  type ServerVersion {
    family: DatabaseFamily!
    version: String!
  }

  type MigrationPlan {
    id: ID!
    expiresAt: String!
    mode: MigrationMode!
    sourceEngine: DatabaseEngine!
    targetEngine: DatabaseEngine!
    sourceVersion: ServerVersion
    targetVersion: ServerVersion
    objects: [PlannedObject!]!
    redisPrefix: String!
    warnings: [String!]!
  }

  type MigrationStatus {
    id: ID!
    state: MigrationState!
    phase: MigrationPhase!
    object: String
    """Counters use Float to support exact integer counts above GraphQL Int's 32-bit range."""
    read: Float!
    written: Float!
    skipped: Float!
    startedAt: String!
    finishedAt: String
    error: String
    warnings: [String!]!
  }

  type Query {
    """Authenticate and list available databases using the existing Rust connector."""
    databaseConnection(connection: DatabaseConnectionInput!): DatabaseConnectionInfo!
    """List source tables, collections or Redis keys metadata without copying records."""
    databaseCatalog(connection: DatabaseConnectionInput!): DatabaseCatalog!
    """Poll a job started through GraphQL or REST."""
    migrationStatus(id: ID!): MigrationStatus!
  }

  type Mutation {
    """Create a reviewable plan; does not write destination data."""
    prepareMigration(input: MigrationPlanInput!): MigrationPlan!
    """Start a server-held plan exactly once, using its ID after reviewing it."""
    startMigration(planId: ID!): MigrationStatus!
    """Request cancellation before commit. Partial-write rules depend on the engine."""
    cancelMigration(jobId: ID!): MigrationStatus!
  }
`;

export const graphqlSchema = buildSchema(graphqlSchemaSource);
