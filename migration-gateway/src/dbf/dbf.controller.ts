import { Controller, Post, Get, Patch, Delete, Body, Param, UploadedFiles, UseInterceptors, HttpCode, HttpStatus, BadRequestException, StreamableFile } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer'
import type { Express } from 'express';
import { DbfService, MAX_TABLES } from './dbf.service';
import type { DbfFilePreview, ParseMultipleResult } from './dbf.service';
import { toPreview } from './dbf-parse';
import { isSupportedEncoding } from '../addon';
import { DbfSessionService } from './dbf-session.service';
import { DbfRelationshipService } from './dbf.relationship.service';
import { MysqlExportService } from './mysql-export.service';
import { MysqlImportService } from './mysql-import.service';
import type { DbfRelationship, DbfRelationshipGraph } from '../types/dbf-relationship.types';
import type { DbfSession } from '../types/dbf-session.types';
import type { MysqlConnectionInfo, MysqlConnectionInput, MysqlExportOptions, MysqlExportPlan, MysqlImportStatus, MysqlWriteMode } from '../types/mysql-export.types';
import { toSessionId, toFileName } from '../types/dbf-relationship.types';
import { IsOptional, IsInt, Min, Max, IsString, IsBoolean, Matches, IsNotEmpty, IsObject, IsIn } from 'class-validator'
import { normalizeOverrides } from './mysql-types';
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

class ToggleRelationshipDto {
    @IsBoolean() disabled!: boolean
}

class FileEncodingDto {
    /** A TextDecoder label, or null to go back to the code page mark / detection. */
    @IsOptional() @IsString() encoding!: string | null
}

class MysqlExportDto {
    @IsOptional()
    @Matches(/^[A-Za-z0-9_]{0,64}$/, { message: 'Назва бази даних: лише латинські літери, цифри та _, до 64 символів' })
    database?: string
    @IsOptional() @IsBoolean() includeData?: boolean
    @IsOptional() @IsBoolean() foreignKeys?: boolean
    @IsOptional() @IsIn(['replace', 'append', 'sync']) writeMode?: MysqlWriteMode
    @IsOptional() @IsBoolean() syncDeletes?: boolean
    @IsOptional() @IsBoolean() keepDeleted?: boolean
    @IsOptional() @IsBoolean() indexes?: boolean
    @IsOptional() @IsBoolean() emptyStringsAsNull?: boolean
    // Free-form here; normalizeOverrides checks every name and type before they reach DDL.
    @IsOptional() @IsObject() overrides?: Record<string, unknown>
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
        includeData: dto.includeData ?? true,
        foreignKeys: dto.foreignKeys ?? true,
        writeMode: dto.writeMode ?? 'replace',
        syncDeletes: dto.syncDeletes ?? false,
        keepDeleted: dto.keepDeleted ?? false,
        indexes: dto.indexes ?? true,
        emptyStringsAsNull: dto.emptyStringsAsNull ?? true,
        overrides: normalizeOverrides(dto.overrides),
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
    // Every table may bring an .fpt/.dbt memo file and a .cdx index file along.
    @UseInterceptors(FilesInterceptor('files', MAX_TABLES * 3, {
        storage: memoryStorage(),
        // Browsers send UTF-8 names; the latin1 default turns "Сотрудники.dbf" into mojibake.
        defParamCharset: 'utf8',
        fileFilter: (_req, file, cb) => {
            const ok = /\.(dbf|fpt|dbt|cdx)$/i.test(file.originalname)
            cb(ok ? null : new BadRequestException(`Це не файл .dbf/.fpt/.dbt/.cdx: ${file.originalname}`), ok)
        },
        limits: { fileSize: 100 * 1024 * 1024 }
    }))
    parseMultiple(
        @UploadedFiles() files: Express.Multer.File[],
        @Body() dto: ParseQueryDto,
    ): ParseMultipleResult {
        if(!files?.length)
            throw new BadRequestException('Файли не завантажено')

        return this.dbfService.parseMultipleFiles(
            files.map(f => ({
                originalName: f.originalname,
                buffer: f.buffer,
                size: f.size
            })),
            dto.previewRows,
        )
    }

    /** The whole session as the upload returned it; lets a reloaded page pick up where it was. */
    @Get('session/:id')
    getSession(@Param('id') id: string): ParseMultipleResult {
        const session = this.sessionService.getSession(toSessionId(id))
        return {
            sessionId: session.id,
            files: [...session.files.entries()].map(([fileName, result]) => toPreview(fileName, result)),
            graph: this.graphOf(session),
        }
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
        return this.graphOf(session)
    }

    @Patch('session/:id/relationship/:relId')
    toggleRelationship(
        @Param('id') id: string,
        @Param('relId') relId: string,
        @Body() dto: ToggleRelationshipDto,
    ): DbfRelationshipGraph {
        return this.graphOf(this.sessionService.setRelationshipDisabled(toSessionId(id), relId, dto.disabled))
    }

    @Delete('session/:id/relationship/:relId')
    @HttpCode(HttpStatus.OK)
    deleteRelationship(@Param('id') id: string, @Param('relId') relId: string): DbfRelationshipGraph {
        return this.graphOf(this.sessionService.deleteManualRelationship(toSessionId(id), relId))
    }

    @Patch('session/:id/file/:fileName/encoding')
    setFileEncoding(
        @Param('id') id: string,
        @Param('fileName') fileName: string,
        @Body() dto: FileEncodingDto,
    ): { file: DbfFilePreview; graph: DbfRelationshipGraph } {
        const encoding = dto.encoding || null
        if(encoding !== null && !isSupportedEncoding(encoding))
            throw new BadRequestException(`Непідтримуване кодування: ${encoding}`)
        const name = toFileName(fileName)
        const session = this.sessionService.setFileEncoding(toSessionId(id), name, encoding)
        return { file: toPreview(name, session.files.get(name)!), graph: this.graphOf(session) }
    }

    @Post('session/:id/mysql/plan')
    @HttpCode(HttpStatus.OK)
    mysqlPlan(@Param('id') id: string, @Body() dto: MysqlExportDto): MysqlExportPlan {
        const session = this.sessionService.getSession(toSessionId(id))
        return this.mysqlExportService.plan(session, this.activeRelationships(session), toExportOptions(dto))
    }

    @Post('session/:id/mysql/export')
    @HttpCode(HttpStatus.OK)
    mysqlExport(@Param('id') id: string, @Body() dto: MysqlExportDto): StreamableFile {
        const session = this.sessionService.getSession(toSessionId(id))
        const options = toExportOptions(dto)
        const stream = this.mysqlExportService.exportSql(session, this.activeRelationships(session), options)
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
    mysqlImport(@Param('id') id: string, @Body() dto: MysqlImportDto): Promise<MysqlImportStatus> {
        const session = this.sessionService.getSession(toSessionId(id))
        return this.mysqlImportService.startImport(session, this.activeRelationships(session), toExportOptions(dto), toConnection(dto))
    }

    @Get('mysql/import/:jobId')
    mysqlImportStatus(@Param('jobId') jobId: string): MysqlImportStatus {
        return this.mysqlImportService.getStatus(jobId)
    }

    @Delete('mysql/import/:jobId')
    @HttpCode(HttpStatus.OK)
    cancelMysqlImport(@Param('jobId') jobId: string): MysqlImportStatus {
        return this.mysqlImportService.cancel(jobId)
    }

    @Delete('session/:id')
    @HttpCode(HttpStatus.NO_CONTENT)
    closeSession(@Param('id') id: string): void {
        this.sessionService.deleteSession(toSessionId(id))
    }

    private graphOf(session: DbfSession): DbfRelationshipGraph {
        return this.relationshipService.buildGraph(session.files, session.manualRels, session.disabledRels)
    }

    /** Links that go into the MySQL plan: everything the user has not switched off. */
    private activeRelationships(session: DbfSession): readonly DbfRelationship[] {
        return this.graphOf(session).relationships.filter(r => !r.disabled)
    }
}
