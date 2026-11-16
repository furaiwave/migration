import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { RedisImportService } from './redis-import.service';
import { DbfSessionService } from './dbf-session.service';
import { DbfRelationshipService } from './dbf.relationship.service';
import { toSessionId } from '../types/dbf-relationship.types';
class OptionsDto {
  @IsString() @Matches(/^[A-Za-z0-9_-]{1,64}$/) prefix!: string;
  @IsIn(['new', 'update']) writeMode!: 'new' | 'update';
  @IsBoolean() keepDeleted!: boolean;
  @IsInt() @Min(0) @Max(2147483647) ttlSeconds!: number;
}
class ImportDto extends OptionsDto {
  @IsString() @MaxLength(8192) uri!: string;
}
const options = (dto: OptionsDto): OptionsDto => ({
  prefix: dto.prefix,
  writeMode: dto.writeMode,
  keepDeleted: dto.keepDeleted,
  ttlSeconds: dto.ttlSeconds,
});
@Controller('dbf')
export class RedisImportController {
  constructor(
    private readonly imports: RedisImportService,
    private readonly sessions: DbfSessionService,
    private readonly relationships: DbfRelationshipService,
  ) {}
  private context(id: string) {
    const session = this.sessions.getSession(toSessionId(id));
    const links = this.relationships
      .buildGraph(session.files, session.manualRels, session.disabledRels)
      .relationships.filter((r) => !r.disabled);
    return { session, links };
  }
  @Post('session/:id/redis/plan')
  @HttpCode(200)
  plan(@Param('id') id: string, @Body() dto: OptionsDto) {
    const { session, links } = this.context(id);
    return this.imports.prepare(session, links, options(dto)).plan;
  }
  @Post('session/:id/redis/import')
  @HttpCode(200)
  start(@Param('id') id: string, @Body() dto: ImportDto) {
    const { session, links } = this.context(id);
    return this.imports.startImport(session, links, options(dto), dto.uri);
  }
  @Get('redis/import/:jobId') status(@Param('jobId') id: string) {
    return this.imports.getStatus(id);
  }
  @Delete('redis/import/:jobId') @HttpCode(200) cancel(
    @Param('jobId') id: string,
  ) {
    return this.imports.cancel(id);
  }
}
