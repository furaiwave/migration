import { runInNewContext } from 'node:vm';
import { MysqlExportService } from './mysql-export.service';
import { MongoExportService } from './mongo-export.service';
import { parseTable } from './dbf-parse';
import { toFileName, toSessionId } from '../types/dbf-relationship.types';
import type { DbfSession } from '../types/dbf-session.types';
import type { MysqlExportOptions } from '../types/mysql-export.types';
const options: MysqlExportOptions = {
  database: 'legacy',
  writeMode: 'append',
  includeData: false,
  foreignKeys: false,
  indexes: false,
  keepDeleted: false,
  syncDeletes: false,
  emptyStringsAsNull: false,
  orphansAsNull: false,
  overrides: {},
};
function source(fieldName: string): DbfSession {
  const bytes = Buffer.alloc(97 + 13 + 1);
  bytes[0] = 3;
  bytes.writeUInt32LE(1, 4);
  bytes.writeUInt16LE(97, 8);
  bytes.writeUInt16LE(13, 10);
  bytes.write('ID', 32, 'ascii');
  bytes[43] = 78;
  bytes[48] = 6;
  Buffer.from(fieldName, 'utf8').copy(bytes, 64, 0, 11);
  bytes[75] = 90;
  bytes[80] = 6;
  bytes[96] = 13;
  bytes.write('      1xxxxxx', 97, 'ascii');
  bytes[110] = 26;
  const name = toFileName('CLIENTS.DBF');
  return {
    id: toSessionId('export-safety'),
    createdAt: new Date(),
    previewRows: 0,
    files: new Map([[name, parseTable(name, bytes, null, null, 0, 'utf-8')]]),
    sources: new Map([[name, { dbf: bytes, memo: null, index: null }]]),
    manualRels: [],
    disabledRels: new Set(),
    encodings: new Map(),
  };
}
async function read(stream: AsyncIterable<unknown>) {
  let output = '';
  for await (const chunk of stream) output += String(chunk);
  return output;
}
test.each(['\n', '\r', '\r\n', '\u2028', '\u2029'])(
  'SQL comments keep metadata line separators %j from becoming executable statements',
  async (separator) => {
    const session = source('X' + separator + 'DO 1;#');
    const exporter = new MysqlExportService();
    const dump = await read(exporter.exportSql(session, [], options));
    expect(dump).toContain('DO 1;#');
    const lines = dump.split(/[\r\n\u2028\u2029]/);
    expect(
      lines
        .filter((line) => line.includes('DO 1;#'))
        .every((line) => line.trimStart().startsWith('--')),
    ).toBe(true);
    for (const chunk of exporter.statements(session, [], options).chunks) {
      const executable = chunk.sql
        .split(/[\r\n\u2028\u2029]/)
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n');
      expect(executable).not.toContain('DO 1;#');
    }
  },
);
test.each(['\n', '\r', '\r\n', '\u2028', '\u2029'])(
  'mongosh comments keep metadata separator %j inside comments',
  async (separator) => {
    const exporter = new MongoExportService(new MysqlExportService());
    const script = await read(
      exporter.exportScript(source('X' + separator + 'x=1;//'), [], options),
    );
    const target = {
      getCollectionNames: () => [],
      createCollection: () => {},
      getCollection: () => ({}),
    };
    const context = {
      x: 0,
      db: { getSiblingDB: () => target },
      print: () => {},
    };
    runInNewContext(script, context, { timeout: 1000 });
    expect(context.x).toBe(0);
  },
);
test('MySQL dumps enable strict conversion rules and restore the previous session mode', () => {
  const exporter = new MysqlExportService();
  const chunks = [
    ...exporter.statements(source('IGNORED'), [], options).chunks,
  ];
  const setup = chunks.find((chunk) =>
    chunk.sql.includes('SET @DBF_OLD_SQL_MODE'),
  )!.sql;
  expect(setup).toContain('STRICT_ALL_TABLES');
  expect(setup).toContain('NO_BACKSLASH_ESCAPES');
  expect(chunks.at(-1)?.sql).toContain(
    'SET SESSION sql_mode = @DBF_OLD_SQL_MODE',
  );
});
