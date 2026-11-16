import type { Server } from 'http';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { NativeConnectorController } from './native-connector.controller';
import { NativeConnectorService } from './native-connector.service';
describe('native feature endpoints', () => {
  let app: INestApplication<Server>;
  const native = {
    inspect: jest.fn().mockResolvedValue({
      engine: 'postgres',
      database: 'legacy',
      elapsedMs: 2,
      truncated: false,
      objects: [],
    }),
    catalog: jest.fn().mockResolvedValue({
      serverVersion: 'test',
      databases: ['legacy'],
      connector: 'rust',
      elapsedMs: 10,
    }),
    diagnose: jest.fn().mockResolvedValue({
      host: 'localhost',
      port: 5432,
      status: 'reachable',
      elapsedMs: 2,
      resolvedAddresses: ['127.0.0.1'],
    }),
  };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [NativeConnectorController],
      providers: [{ provide: NativeConnectorService, useValue: native }],
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
  test('catalog permits choosing a database after authentication', async () => {
    const settings = {
      engine: 'postgres',
      host: 'localhost',
      port: 5432,
      user: 'test',
      password: 'secret',
      database: '',
    };
    await request(app.getHttpServer())
      .post('/dbf/native/catalog')
      .send(settings)
      .expect(200);
    expect(native.catalog).toHaveBeenCalledWith(settings);
  });
  test('diagnostics take only an endpoint', async () => {
    await request(app.getHttpServer())
      .post('/dbf/native/diagnose')
      .send({ host: 'localhost', port: 5432 })
      .expect(200);
    expect(native.diagnose).toHaveBeenCalledWith({
      host: 'localhost',
      port: 5432,
    });
  });
  test('invalid ports and secret fields are rejected for diagnostics', async () => {
    await request(app.getHttpServer())
      .post('/dbf/native/diagnose')
      .send({ host: 'localhost', port: 70000 })
      .expect(400);
    await request(app.getHttpServer())
      .post('/dbf/native/diagnose')
      .send({ host: 'localhost', port: 5432, password: 'secret' })
      .expect(400);
  });
  test('accepts inspection settings without accepting arbitrary SQL', async () => {
    const settings = {
      engine: 'postgres',
      host: 'localhost',
      port: 5432,
      user: 'test',
      password: 'secret',
      database: 'legacy',
    };
    await request(app.getHttpServer())
      .post('/dbf/native/inspect')
      .send(settings)
      .expect(200);
    expect(native.inspect).toHaveBeenCalledWith(settings);
    await request(app.getHttpServer())
      .post('/dbf/native/inspect')
      .send({ ...settings, query: 'DROP TABLE clients' })
      .expect(400);
  });
});
