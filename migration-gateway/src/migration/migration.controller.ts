import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDefined,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { MigrationService } from './migration.service';
import type { Engine, MigrationMode } from './migration.types';

export class ConnectionDto {
  @IsIn(['mysql', 'mongo', 'postgres', 'mssql', 'redis']) engine!: Engine;
  @IsOptional() @IsString() @MaxLength(255) host?: string;
  @IsOptional() @IsInt() @Min(1) @Max(65535) port?: number;
  @IsOptional() @IsString() @MaxLength(256) user?: string;
  @IsOptional() @IsString() @MaxLength(8192) password?: string;
  @IsString() @MinLength(1) @MaxLength(128) database!: string;
  @IsOptional() @IsString() @MaxLength(8192) uri?: string;
  @IsOptional() @IsBoolean() encrypt?: boolean;
  @IsOptional() @IsBoolean() trustServerCertificate?: boolean;
}
class SelectionDto {
  @IsString() @MinLength(1) @MaxLength(1024) sourceId!: string;
  @IsString() @MinLength(1) @MaxLength(128) targetName!: string;
}
export class PlanDto {
  @IsOptional() @IsIn(['transfer', 'upgrade']) mode?: MigrationMode;
  @IsDefined()
  @ValidateNested()
  @Type(() => ConnectionDto)
  source!: ConnectionDto;
  @IsDefined()
  @ValidateNested()
  @Type(() => ConnectionDto)
  target!: ConnectionDto;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => SelectionDto)
  objects!: SelectionDto[];
  @IsOptional() @IsString() @MaxLength(128) targetSchema?: string;
  @IsOptional() @IsString() @MaxLength(64) redisPrefix?: string;
}
@Controller('dbf/migration')
export class MigrationController {
  constructor(private readonly migrations: MigrationService) {}
  @Post('catalog') @HttpCode(200) catalog(@Body() input: ConnectionDto) {
    return this.migrations.catalog(input);
  }
  @Post('plan') @HttpCode(200) plan(@Body() input: PlanDto) {
    return this.migrations.prepare(input);
  }
  @Post('plan/:id/start') @HttpCode(202) start(@Param('id') id: string) {
    return this.migrations.start(id);
  }
  @Get('jobs/:id') status(@Param('id') id: string) {
    return this.migrations.status(id);
  }
  @Delete('jobs/:id') cancel(@Param('id') id: string) {
    return this.migrations.cancel(id);
  }
}
