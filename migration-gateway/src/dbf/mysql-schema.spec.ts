import { canRepresentMysqlType, mysqlColumnProblem } from './mysql-schema';
test.each([
  ['INT', 'int(11)'],
  ['INTEGER(11)', 'INT'],
  ['NUMERIC(12)', 'decimal(12,0)'],
  ['TINYINT(1)', 'tinyint(4)'],
  ['INT', 'BIGINT'],
  ['INT UNSIGNED', 'BIGINT'],
  ['BIGINT UNSIGNED', 'DECIMAL(20,0)'],
  ['INT', 'DECIMAL(12,2)'],
  ['DECIMAL(8,0)', 'INT'],
  ['DECIMAL(12,2)', 'DECIMAL(15,4)'],
  ['VARCHAR(40)', 'VARCHAR(100)'],
  ['VARCHAR(40)', 'TEXT'],
  ['TINYTEXT', 'TEXT'],
  ['TEXT', 'LONGTEXT'],
  ['VARBINARY(40)', 'VARBINARY(100)'],
  ['VARBINARY(40)', 'BLOB'],
  ['BLOB', 'LONGBLOB'],
  ['FLOAT', 'DOUBLE'],
  ['DATETIME', 'DATETIME(6)'],
  ['DATETIME(3)', 'DATETIME(6)'],
  ['TIME(3)', 'TIME(6)'],
])('accepts lossless schema capacity %s to %s', (planned, existing) => {
  expect(canRepresentMysqlType(planned, existing)).toBe(true);
});
test.each([
  ['VARCHAR(6)', 'INT'],
  ['INT', 'VARCHAR(40)'],
  ['BIGINT', 'INT'],
  ['INT', 'INT UNSIGNED'],
  ['BIGINT UNSIGNED', 'BIGINT'],
  ['INT', 'DECIMAL(10,2)'],
  ['DECIMAL(10,2)', 'DECIMAL(10,1)'],
  ['DECIMAL(10,0)', 'INT'],
  ['DECIMAL(10,2)', 'DOUBLE'],
  ['VARCHAR(40)', 'VARCHAR(4)'],
  ['VARCHAR(100)', 'TINYTEXT'],
  ['TEXT', 'VARCHAR(20000)'],
  ['VARBINARY(40)', 'VARBINARY(4)'],
  ['VARBINARY(4)', 'BINARY(40)'],
  ['BINARY(4)', 'BINARY(40)'],
  ['LONGTEXT', 'TEXT'],
  ['LONGBLOB', 'BLOB'],
  ['DOUBLE', 'FLOAT'],
  ['DATETIME', 'TIMESTAMP'],
  ['DATETIME(3)', 'DATETIME'],
  ['DATETIME(3)', 'DATETIME(2)'],
  ['TIME(6)', 'TIME(3)'],
  ['VARCHAR(40)', "enum('private-source-value')"],
])(
  'rejects lossy or identity-changing schema capacity %s to %s',
  (planned, existing) => {
    expect(canRepresentMysqlType(planned, existing)).toBe(false);
  },
);
test('an unsupported destination type never appears verbatim in diagnostics', () => {
  const message = mysqlColumnProblem(
    { name: 'id', type: 'VARCHAR(40)', collation: 'utf8mb4_bin' },
    {
      type: "enum('private-source-value')",
      charset: 'utf8mb4',
      collation: 'utf8mb4_bin',
    },
  );
  expect(message).toContain('type');
  expect(message).not.toContain('private-source-value');
});
