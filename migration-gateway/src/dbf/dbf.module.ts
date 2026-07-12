import { Module } from '@nestjs/common';
import { DbfController } from './dbf.controller';
import { DbfService } from './dbf.service';
import { DbfSessionService } from './dbf-session.service';
import { DbfRelationshipService } from './dbf.relationship.service';

@Module({
    controllers: [DbfController],
    providers: [
        DbfService,
        DbfSessionService,
        DbfRelationshipService,
    ],
    exports: [DbfService, DbfSessionService],
})
export class DbfModule {}
