import { Test } from '@nestjs/testing';
import { DbfController } from './dbf.controller';
import { DbfService } from './dbf.service';
import { DbfSessionService } from './dbf-session.service';
import { DbfRelationshipService } from './dbf.relationship.service';
import { MysqlExportService } from './mysql-export.service';
import { MysqlImportService } from './mysql-import.service';
import { MongoExportService } from './mongo-export.service';
import { MongoImportService } from './mongo-import.service';
test('DBF controller resolves its required services', async () => {
  const module = await Test.createTestingModule({
    controllers: [DbfController],
    providers: [
      DbfService,
      DbfSessionService,
      DbfRelationshipService,
      MysqlExportService,
      MysqlImportService,
      MongoExportService,
      MongoImportService,
    ].map((provide) => ({ provide, useValue: {} })),
  }).compile();
  expect(module.get(DbfController)).toBeDefined();
  await module.close();
});
