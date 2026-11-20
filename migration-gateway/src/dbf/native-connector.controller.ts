import type { Response } from 'express';
import { Body, Controller, Get, HttpCode, Post, Res } from '@nestjs/common';
import {
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
import { Type } from 'class-transformer';
import {
  NativeConnectorService,
  type NativeEngine,
} from './native-connector.service';
export class NativeConnectionDto {
  @IsIn(['mysql', 'mongo', 'postgres', 'mssql', 'redis']) engine!: NativeEngine;
  @IsOptional() @IsString() @MaxLength(255) host?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(65535) port?: number;
  @IsOptional() @IsString() @MaxLength(256) user?: string;
  @IsOptional() @IsString() @MaxLength(8192) password?: string;
  @IsOptional() @IsString() @MaxLength(128) database?: string;
  @IsOptional() @IsBoolean() encrypt?: boolean;
  @IsOptional() @IsBoolean() trustServerCertificate?: boolean;
  @IsOptional() @IsString() @MaxLength(8192) uri?: string;
}
class NativeQueryDto {
  @IsDefined()
  @ValidateNested()
  @Type(() => NativeConnectionDto)
  connection!: NativeConnectionDto;
  @IsString() @MinLength(1) @MaxLength(196608) sql!: string;
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5000)
  maxRows?: number;
}
class NativeEndpointDto {
  @IsString() @MaxLength(255) host!: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(65535) port!: number;
}
@Controller('dbf/native')
export class NativeConnectorController {
  constructor(private readonly connector: NativeConnectorService) {}
  @Post('query')
  @HttpCode(200)
  async query(
    @Body() input: NativeQueryDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const controller = new AbortController();
    const close = () => {
      if (!response.writableEnded) controller.abort();
    };
    response.once('close', close);
    try {
      return await this.connector.query(
        input.connection,
        input.sql,
        input.maxRows ?? 1000,
        controller.signal,
      );
    } finally {
      response.removeListener('close', close);
    }
  }
  @Get('servers') discover() {
    return this.connector.discover();
  }
  @Post('test-connection')
  @HttpCode(200)
  test(@Body() connection: NativeConnectionDto) {
    return this.connector.test(connection);
  }
  @Post('catalog')
  @HttpCode(200)
  catalog(@Body() connection: NativeConnectionDto) {
    return this.connector.catalog(connection);
  }
  @Post('diagnose')
  @HttpCode(200)
  diagnose(@Body() endpoint: NativeEndpointDto) {
    return this.connector.diagnose(endpoint);
  }
  @Post('inspect')
  @HttpCode(200)
  inspect(@Body() connection: NativeConnectionDto) {
    return this.connector.inspect(connection);
  }
}
