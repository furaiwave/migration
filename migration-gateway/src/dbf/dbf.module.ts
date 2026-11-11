import { Module } from '@nestjs/common';
import { DbfController } from './dbf.controller';
import { DbfService } from './dbf.service';
import { DbfSessionService } from './dbf-session.service';
import { DbfRelationshipService } from './dbf.relationship.service';
import { MysqlExportService } from './mysql-export.service';
import { MysqlImportService } from './mysql-import.service';
import { MongoExportService } from './mongo-export.service';
import { MongoImportService } from './mongo-import.service';

@Module({
    controllers: [DbfController],
    providers: [
        DbfService,
        DbfSessionService,
        DbfRelationshipService,
        MysqlExportService,
        MysqlImportService,
        MongoExportService,
        MongoImportService,
    ],
    exports: [DbfService, DbfSessionService],
})
export class DbfModule {}
