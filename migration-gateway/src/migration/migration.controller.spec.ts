/* Async protocol fakes implement driver contracts; method references are used only in Jest assertions. */
/* eslint-disable @typescript-eslint/require-await */
import type { Server } from 'node:http';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { MigrationController } from './migration.controller';
import { MigrationService } from './migration.service';
import type { MigrationPlanRequest } from './migration.types';

describe('migration HTTP API', () => {
  let app: INestApplication<Server>;
  const service = {
    catalog: jest.fn(async () => ({ objects: [] })),
    prepare: jest.fn<Promise<{ id: string }>, [MigrationPlanRequest]>(
      async () => ({ id: 'plan' }),
    ),
    start: jest.fn(() => ({ id: 'job', state: 'running' })),
    status: jest.fn(() => ({ id: 'job', state: 'done' })),
    cancel: jest.fn(() => ({ id: 'job', state: 'running' })),
  };
  const source = {
    engine: 'mysql',
    host: 'localhost',
    user: 'user',
    database: 'test',
  };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [MigrationController],
      providers: [{ provide: MigrationService, useValue: service }],
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
  test('validates nested connections, selections and unknown fields', async () => {
    await request(app.getHttpServer())
      .post('/dbf/migration/plan')
      .send({
        source,
        target: { ...source, engine: 'mongo', uri: 'mongodb://localhost' },
        objects: [{ sourceId: 'items', targetName: 'copy' }],
      })
      .expect(200);
    await request(app.getHttpServer())
      .post('/dbf/migration/plan')
      .send({
        source: { ...source, arbitrarySql: 'DROP DATABASE test' },
        target: source,
        objects: [{ sourceId: 'items', targetName: 'copy' }],
      })
      .expect(400);
    await request(app.getHttpServer())
      .post('/dbf/migration/plan')
      .send({ source, target: source, objects: [] })
      .expect(400);
    await request(app.getHttpServer())
      .post('/dbf/migration/catalog')
      .send({ ...source, engine: 'oracle' })
      .expect(400);
    await request(app.getHttpServer())
      .post('/dbf/migration/catalog')
      .send({ ...source, port: 70000 })
      .expect(400);
  });
  test('validates and forwards the version upgrade mode', async () => {
    await request(app.getHttpServer())
      .post('/dbf/migration/plan')
      .send({
        mode: 'upgrade',
        source,
        target: source,
        objects: [{ sourceId: 'items', targetName: 'copy' }],
      })
      .expect(200);
    expect(service.prepare.mock.calls.at(-1)?.[0]).toMatchObject({
      mode: 'upgrade',
    });
    await request(app.getHttpServer())
      .post('/dbf/migration/plan')
      .send({
        mode: 'unknown',
        source,
        target: source,
        objects: [{ sourceId: 'items', targetName: 'copy' }],
      })
      .expect(400);
  });
  test('starts only a server-held plan and routes progress and cancellation', async () => {
    await request(app.getHttpServer())
      .post('/dbf/migration/plan/plan/start')
      .expect(202);
    expect(service.start).toHaveBeenCalledWith('plan');
    await request(app.getHttpServer())
      .get('/dbf/migration/jobs/job')
      .expect(200);
    await request(app.getHttpServer())
      .delete('/dbf/migration/jobs/job')
      .expect(200);
    expect(service.cancel).toHaveBeenCalledWith('job');
  });
});
