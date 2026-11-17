import { MigrationController } from '../migration/migration.controller';
import { MigrationService } from '../migration/migration.service';
import { MigrationConnectors } from '../migration/connectors';
import { RedisImportController } from './redis-import.controller';
import { RedisImportService } from './redis-import.service';
import { NativeConnectorController } from './native-connector.controller';
import { NativeConnectorService } from './native-connector.service';
import { SqlImportController } from './sql-import.controller';
import { SqlImportService } from './sql-import.service';
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
    controllers: [MigrationController, RedisImportController, DbfController, SqlImportController, NativeConnectorController],
    providers: [MigrationService, MigrationConnectors,
        RedisImportService,
        NativeConnectorService,
        SqlImportService,
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
