import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  NativeConnectorService,
  type NativeEngine,
} from './native-connector.service';
class NativeConnectionDto {
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
class NativeEndpointDto {
  @IsString() @MaxLength(255) host!: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(65535) port!: number;
}
@Controller('dbf/native')
export class NativeConnectorController {
  constructor(private readonly connector: NativeConnectorService) {}
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
