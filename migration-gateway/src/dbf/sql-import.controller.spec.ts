import type { Server } from 'http';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { SqlImportController } from './sql-import.controller';
import { SqlImportService } from './sql-import.service';
import { DbfSessionService } from './dbf-session.service';
import { DbfRelationshipService } from './dbf.relationship.service';
describe('SQL import API validation', () => {
  let app: INestApplication<Server>;
  const imports = {
    testConnection: jest
      .fn()
      .mockResolvedValue({ serverVersion: 'test', databases: ['legacy'] }),
    getStatus: jest.fn(() => ({ state: 'done' })),
    startImport: jest.fn(),
  };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [SqlImportController],
      providers: [
        { provide: SqlImportService, useValue: imports },
        {
          provide: DbfSessionService,
          useValue: {
            getSession: () => ({
              files: new Map(),
              manualRels: [],
              disabledRels: new Set(),
            }),
          },
        },
        {
          provide: DbfRelationshipService,
          useValue: { buildGraph: () => ({ relationships: [] }) },
        },
      ],
    }).compile();
    app = module.createNestApplication<INestApplication<Server>>();
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });
  const connection = {
    host: 'localhost',
    port: 5432,
    user: 'user',
    password: 'secret',
    database: 'legacy',
    encrypt: true,
    trustServerCertificate: false,
  };
  test.each(['postgres', 'mssql'])(
    '%s is routed with the correct engine',
    async (dialect) => {
      await request(app.getHttpServer())
        .post('/dbf/sql/' + dialect + '/test-connection')
        .send(connection)
        .expect(200);
      expect(imports.testConnection).toHaveBeenLastCalledWith(
        dialect,
        connection,
      );
    },
  );
  test('invalid engines and ports are rejected', async () => {
    await request(app.getHttpServer())
      .post('/dbf/sql/oracle/test-connection')
      .send(connection)
      .expect(400);
    await request(app.getHttpServer())
      .post('/dbf/sql/postgres/test-connection')
      .send({ ...connection, port: 70000 })
      .expect(400);
  });
  test('unsupported synchronization and undeclared fields are rejected', async () => {
    await request(app.getHttpServer())
      .post('/dbf/session/test/sql/mssql/import')
      .send({ ...connection, writeMode: 'sync' })
      .expect(400);
    await request(app.getHttpServer())
      .post('/dbf/sql/postgres/test-connection')
      .send({ ...connection, arbitrarySql: 'DROP DATABASE legacy' })
      .expect(400);
    expect(imports.startImport).not.toHaveBeenCalled();
  });
});
