import { Controller, Post, Get, Delete, Body, Param, UploadedFiles, UseInterceptors, HttpCode, HttpStatus, BadRequestException, StreamableFile } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer'
import type { Express } from 'express';
import { DbfService } from './dbf.service';
import type { ParseMultipleResult } from './dbf.service';
import { DbfSessionService } from './dbf-session.service';
import { DbfRelationshipService } from './dbf.relationship.service';
import { MysqlExportService } from './mysql-export.service';
import { MysqlImportService } from './mysql-import.service';
import type { DbfRelationshipGraph } from '../types/dbf-relationship.types';
import type { MysqlConnectionInfo, MysqlConnectionInput, MysqlExportOptions, MysqlExportPlan, MysqlImportResult } from '../types/mysql-export.types';
import { toSessionId, toFileName } from '../types/dbf-relationship.types';
import { IsOptional, IsInt, Min, Max, IsString, IsBoolean, Matches, IsNotEmpty } from 'class-validator'
import { Type } from 'class-transformer';

class ParseQueryDto {
    @IsOptional()
    @IsInt()
    @Min(0)
    @Max(500)
    @Type(() => Number)
    previewRows?: number
}

class AddManualRelDto {
    @IsString() sessionId!: string
    @IsString() sourceFile!: string
    @IsString() sourceField!: string
    @IsString() targetFile!: string
    @IsString() targetField!: string
    @IsOptional()
    @IsString()
    label?: string
}

class MysqlExportDto {
    @IsOptional()
    @Matches(/^[A-Za-z0-9_]{0,64}$/, { message: 'database: letters, digits and _ only, up to 64 characters' })
    database?: string
    @IsOptional() @IsString() encoding?: string
    @IsOptional() @IsBoolean() includeData?: boolean
    @IsOptional() @IsBoolean() foreignKeys?: boolean
    @IsOptional() @IsBoolean() dropExisting?: boolean
    @IsOptional() @IsBoolean() emptyStringsAsNull?: boolean
}

class MysqlConnectionDto {
    @IsString() @IsNotEmpty() host!: string
    @Type(() => Number) @IsInt() @Min(1) @Max(65535) port!: number
    @IsString() @IsNotEmpty() user!: string
    @IsOptional() @IsString() password?: string
}

class MysqlImportDto extends MysqlExportDto {
    @IsString() @IsNotEmpty() host!: string
    @Type(() => Number) @IsInt() @Min(1) @Max(65535) port!: number
    @IsString() @IsNotEmpty() user!: string
    @IsOptional() @IsString() password?: string
}

function toConnection(dto: MysqlConnectionDto): MysqlConnectionInput {
    return { host: dto.host, port: dto.port, user: dto.user, password: dto.password ?? '' }
}

function toExportOptions(dto: MysqlExportDto): MysqlExportOptions {
    return {
        database: dto.database || undefined,
        encoding: dto.encoding || 'auto',
        includeData: dto.includeData ?? true,
        foreignKeys: dto.foreignKeys ?? true,
        dropExisting: dto.dropExisting ?? true,
        emptyStringsAsNull: dto.emptyStringsAsNull ?? true,
    }
}

@Controller('dbf')
export class DbfController {
    constructor(
        private readonly dbfService: DbfService,
        private readonly sessionService: DbfSessionService,
        private readonly relationshipService: DbfRelationshipService,
        private readonly mysqlExportService: MysqlExportService,
        private readonly mysqlImportService: MysqlImportService,
    ) {}

    @Post('parse-multiple')
    @HttpCode(HttpStatus.OK)
    // 20 tables, each with an optional .fpt/.dbt memo file.
    @UseInterceptors(FilesInterceptor('files', 40, {
        storage: memoryStorage(),
        // Browsers send UTF-8 names; the latin1 default turns "Сотрудники.dbf" into mojibake.
        defParamCharset: 'utf8',
        fileFilter: (_req, file, cb) => {
            const ok = /\.(dbf|fpt|dbt)$/i.test(file.originalname)
            cb(ok ? null : new BadRequestException(`Not a .dbf/.fpt/.dbt file: ${file.originalname}`), ok)
        },
        limits: { fileSize: 100 * 1024 * 1024 }
    }))
    parseMultiple(
        @UploadedFiles() files: Express.Multer.File[],
        @Body() dto: ParseQueryDto,
    ): ParseMultipleResult {
        if(!files?.length)
            throw new BadRequestException('No files uploaded')

        return this.dbfService.parseMultipleFiles(
            files.map(f => ({
                originalName: f.originalname,
                buffer: f.buffer,
                size: f.size
            })),
            dto.previewRows,
        )
    }

    @Get('session/:id/graph')
    getGraph(@Param('id') id: string): DbfRelationshipGraph {
        return this.dbfService.getSessionGraph(id)
    }

    @Post('session/relationship')
    @HttpCode(HttpStatus.OK)
    addRelationship(@Body() dto: AddManualRelDto): DbfRelationshipGraph {
        const session = this.sessionService.addManualRelationship({
            sessionId: toSessionId(dto.sessionId),
            sourceFile: toFileName(dto.sourceFile.toUpperCase()),
            sourceField: dto.sourceField,
            targetFile: toFileName(dto.targetFile.toUpperCase()),
            targetField: dto.targetField,
            label: dto.label,
        })
        return this.relationshipService.buildGraph(session.files, session.manualRels)
    }

    @Post('session/:id/mysql/plan')
    @HttpCode(HttpStatus.OK)
    mysqlPlan(@Param('id') id: string, @Body() dto: MysqlExportDto): MysqlExportPlan {
        const session = this.sessionService.getSession(toSessionId(id))
        const graph = this.relationshipService.buildGraph(session.files, session.manualRels)
        return this.mysqlExportService.plan(session, graph.relationships, toExportOptions(dto))
    }

    @Post('session/:id/mysql/export')
    @HttpCode(HttpStatus.OK)
    mysqlExport(@Param('id') id: string, @Body() dto: MysqlExportDto): StreamableFile {
        const session = this.sessionService.getSession(toSessionId(id))
        const graph = this.relationshipService.buildGraph(session.files, session.manualRels)
        const options = toExportOptions(dto)
        const stream = this.mysqlExportService.exportSql(session, graph.relationships, options)
        return new StreamableFile(stream, {
            type: 'application/sql; charset=utf-8',
            disposition: `attachment; filename="${options.database ?? 'dbf_export'}.sql"`,
        })
    }

    @Post('mysql/test-connection')
    @HttpCode(HttpStatus.OK)
    mysqlTestConnection(@Body() dto: MysqlConnectionDto): Promise<MysqlConnectionInfo> {
        return this.mysqlImportService.testConnection(toConnection(dto))
    }

    @Post('session/:id/mysql/import')
    @HttpCode(HttpStatus.OK)
    mysqlImport(@Param('id') id: string, @Body() dto: MysqlImportDto): Promise<MysqlImportResult> {
        const session = this.sessionService.getSession(toSessionId(id))
        const graph = this.relationshipService.buildGraph(session.files, session.manualRels)
        return this.mysqlImportService.importSession(session, graph.relationships, toExportOptions(dto), toConnection(dto))
    }

    @Delete('session/:id')
    @HttpCode(HttpStatus.NO_CONTENT)
    closeSession(@Param('id') id: string): void {
        this.sessionService.deleteSession(toSessionId(id))
    }
}
