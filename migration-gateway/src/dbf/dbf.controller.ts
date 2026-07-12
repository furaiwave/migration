import { Controller, Post, Get, Delete, Body, Param, UploadedFiles, UseInterceptors, HttpCode, HttpStatus, BadRequestException } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer'
import type { Express } from 'express';
import { DbfService } from './dbf.service';
import type { ParseMultipleResult } from './dbf.service';
import { DbfSessionService } from './dbf-session.service';
import { DbfRelationshipService } from './dbf.relationship.service';
import type { DbfRelationshipGraph } from '../types/dbf-relationship.types';
import { toSessionId, toFileName } from '../types/dbf-relationship.types';
import { IsOptional, IsInt, Min, Max, IsString } from 'class-validator'
import { Type } from 'class-transformer';

class ParseQueryDto {
    @IsOptional()
    @IsInt()
    @Min(0)
    @Max(500)
    @Type(() => Number)
    previewRows?: number
}

class ADdManualRelDto {
    @IsString() sessionId!: string
    @IsString() sourceFile!: string
    @IsString() sourceField!: string
    @IsString() targetFile!: string
    @IsString() taegetField!: string
    @IsOptional()
    @IsString()
    label?: string
}

@Controller('dbf')
export class DbfController {
    constructor(
        private readonly dbfService: DbfService,
        private readonly sessionService: DbfSessionService,
        private readonly relationshipService: DbfRelationshipService,
    ) {}

    @Post('parse-multiple')
    @HttpCode(HttpStatus.OK)
    @UseInterceptors(FilesInterceptor('files', 20, {
        storage: memoryStorage(),
        fileFilter: (_req, file, cb) => {
            const ok = /\.dbf$/i.test(file.originalname)
            cb(ok ? null : new BadRequestException(`Not a .dbf file: ${file.originalname}`), ok)
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

    @Post('srssion/relationship')
    @HttpCode(HttpStatus.OK)
    addRelationship(@Body() dto: ADdManualRelDto): DbfRelationshipGraph {
        const session = this.sessionService.addManualRelationship({
            sessionId: toSessionId(dto.sessionId),
            sourceFile: toFileName(dto.sourceFile.toUpperCase()),
            sourceField: dto.sourceField,
            targetFile: toFileName(dto.targetFile.toUpperCase()),
            targetField: dto.taegetField,
            label: dto.label,
        })
        return this.relationshipService.buildGraph(session.files, session.manualRels)
    }

    @Delete('session/:id')
    @HttpCode(HttpStatus.NO_CONTENT)
    closeSession(@Param('id') id: string): void {
        this.sessionService.deleteSession(toSessionId(id))
    }
}
