import { MongoClient } from 'mongodb';
import { describeMysqlError } from './mysql-import.service';
import { describeMongoError, MongoImportService } from './mongo-import.service';
import type { MongoExportService } from './mongo-export.service';
jest.mock('mongodb', () => ({
  ...jest.requireActual<typeof import('mongodb')>('mongodb'),
  MongoClient: jest.fn(),
}));
const secret = 'private-password-and-source-value';
test.each([
  new Error(secret),
  { code: 'ER_DUP_ENTRY', sqlMessage: secret },
  { code: 'ER_ACCESS_DENIED_ERROR', message: secret },
  null,
])('MySQL errors never include driver messages or source values', (error) => {
  const text = describeMysqlError(error, {
    host: 'localhost',
    port: 3306,
    user: 'user',
    password: secret,
  });
  expect(text).not.toContain(secret);
});
test.each([
  new Error(secret),
  { name: 'MongoParseError', message: secret },
  { name: 'MongoServerSelectionError', message: secret },
  { code: 13, message: secret },
  { code: 11000, message: secret },
  null,
])('MongoDB errors never include URI options or source values', (error) => {
  expect(describeMongoError(error)).not.toContain(secret);
});
test('a failed MongoDB connection closes its driver before reporting the sanitized error', async () => {
  const close = jest.fn<Promise<void>, []>(() => Promise.resolve());
  const client = {
    connect: jest.fn(() => Promise.reject(new Error(secret))),
    close,
  };
  (MongoClient as unknown as jest.Mock).mockReturnValue(client);
  const service = new MongoImportService({} as MongoExportService);
  await expect(
    service.testConnection({
      uri: 'mongodb://user:' + secret + '@localhost/db',
    }),
  ).rejects.toThrow('Driver details are hidden');
  expect(close).toHaveBeenCalledTimes(1);
});
