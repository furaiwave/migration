import {
  BadRequestException,
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
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { SqlImportService } from './sql-import.service';
import { DbfSessionService } from './dbf-session.service';
import { DbfRelationshipService } from './dbf.relationship.service';
import { toSessionId } from '../types/dbf-relationship.types';
import type {
  SqlConnectionInput,
  SqlDialect,
  SqlImportOptions,
} from '../types/sql-import.types';

class ConnectionDto implements SqlConnectionInput {
  @IsString() @IsNotEmpty() host!: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(65535) port!: number;
  @IsString() @IsNotEmpty() user!: string;
  @IsString() password!: string;
  @IsString() @IsNotEmpty() database!: string;
  @IsBoolean() encrypt!: boolean;
  @IsBoolean() trustServerCertificate!: boolean;
}
class OptionsDto {
  @IsIn(['replace', 'append']) writeMode: 'replace' | 'append' = 'append';
  @IsOptional() @IsBoolean() includeData = true;
  @IsOptional() @IsBoolean() foreignKeys = true;
  @IsOptional() @IsBoolean() keepDeleted = false;
  @IsOptional() @IsBoolean() indexes = true;
  @IsOptional() @IsBoolean() emptyStringsAsNull = true;
  @IsOptional() @IsBoolean() orphansAsNull = true;
}
class ImportDto extends ConnectionDto {
  @IsIn(['replace', 'append']) writeMode: 'replace' | 'append' = 'append';
  @IsOptional() @IsBoolean() includeData = true;
  @IsOptional() @IsBoolean() foreignKeys = true;
  @IsOptional() @IsBoolean() keepDeleted = false;
  @IsOptional() @IsBoolean() indexes = true;
  @IsOptional() @IsBoolean() emptyStringsAsNull = true;
  @IsOptional() @IsBoolean() orphansAsNull = true;
}
const dialectOf = (value: string): SqlDialect => {
  if (value !== 'postgres' && value !== 'mssql')
    throw new BadRequestException('Unsupported SQL engine');
  return value;
};
const optionsOf = (dto: OptionsDto): SqlImportOptions => ({
  writeMode: dto.writeMode,
  includeData: dto.includeData,
  foreignKeys: dto.foreignKeys,
  keepDeleted: dto.keepDeleted,
  indexes: dto.indexes,
  emptyStringsAsNull: dto.emptyStringsAsNull,
  orphansAsNull: dto.orphansAsNull,
  syncDeletes: false,
  overrides: {},
});
@Controller('dbf')
export class SqlImportController {
  constructor(
    private readonly imports: SqlImportService,
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
  @Post('sql/:dialect/test-connection')
  @HttpCode(200)
  test(@Param('dialect') dialect: string, @Body() dto: ConnectionDto) {
    return this.imports.testConnection(dialectOf(dialect), dto);
  }
  @Post('session/:id/sql/:dialect/plan')
  @HttpCode(200)
  plan(
    @Param('id') id: string,
    @Param('dialect') dialect: string,
    @Body() dto: OptionsDto,
  ) {
    const { session, links } = this.context(id);
    return this.imports.prepare(
      session,
      links,
      optionsOf(dto),
      dialectOf(dialect),
    ).plan;
  }
  @Post('session/:id/sql/:dialect/import')
  @HttpCode(200)
  start(
    @Param('id') id: string,
    @Param('dialect') dialect: string,
    @Body() dto: ImportDto,
  ) {
    const { session, links } = this.context(id);
    return this.imports.startImport(
      session,
      links,
      optionsOf(dto),
      dialectOf(dialect),
      dto,
    );
  }
  @Get('sql/:dialect/import/:jobId')
  status(@Param('dialect') dialect: string, @Param('jobId') id: string) {
    return this.imports.getStatus(dialectOf(dialect), id);
  }
  @Delete('sql/:dialect/import/:jobId')
  @HttpCode(200)
  cancel(@Param('dialect') dialect: string, @Param('jobId') id: string) {
    return this.imports.cancel(dialectOf(dialect), id);
  }
}
