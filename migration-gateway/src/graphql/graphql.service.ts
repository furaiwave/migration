import {
  BadRequestException,
  HttpException,
  Injectable,
  ValidationPipe,
  type Type,
} from '@nestjs/common';
import type { Request } from 'express';
import { parse, validate } from 'graphql';
import { createHandler, type Handler } from 'graphql-http';
import { NativeConnectionDto } from '../dbf/native-connector.controller';
import { NativeConnectorService } from '../dbf/native-connector.service';
import { ConnectionDto, PlanDto } from '../migration/migration.controller';
import { MigrationService } from '../migration/migration.service';
import { graphqlSchema } from './schema';
import {
  formatGraphqlError,
  MAX_QUERY_BYTES,
  MAX_QUERY_TOKENS,
  operationLimitErrors,
  PublicGraphqlError,
} from './limits';

@Injectable()
export class GraphqlService {
  readonly handle: Handler<Request>;
  private readonly inputs = new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    exceptionFactory: () =>
      new BadRequestException(
        'Invalid database input. Check required fields, lengths, ports and object selection limits.',
      ),
  });

  constructor(
    private readonly migrations: MigrationService,
    private readonly connector: NativeConnectorService,
  ) {
    this.handle = createHandler<Request>({
      schema: graphqlSchema,
      parse: (source, options) => {
        const text = typeof source === 'string' ? source : source.body;
        if (Buffer.byteLength(text, 'utf8') > MAX_QUERY_BYTES)
          throw new PublicGraphqlError('GraphQL query exceeds 32 KiB.');
        return parse(source, { ...options, maxTokens: MAX_QUERY_TOKENS });
      },
      validate: (schema, document, rules, options) => {
        const errors = operationLimitErrors(document);
        return errors.length
          ? errors
          : validate(schema, document, rules, { ...options, maxErrors: 10 });
      },
      formatError: formatGraphqlError,
      rootValue: {
        databaseConnection: ({ connection }: { connection: unknown }) =>
          this.call(async () =>
            this.connector.test(
              await this.input(connection, NativeConnectionDto),
            ),
          ),
        databaseCatalog: ({ connection }: { connection: unknown }) =>
          this.call(async () =>
            this.migrations.catalog(
              await this.input(connection, ConnectionDto),
            ),
          ),
        migrationStatus: ({ id }: { id: string }) =>
          this.call(() => this.migrations.status(this.id(id))),
        prepareMigration: ({ input }: { input: unknown }) =>
          this.call(async () =>
            this.migrations.prepare(await this.input(input, PlanDto)),
          ),
        startMigration: ({ planId }: { planId: string }) =>
          this.call(() => this.migrations.start(this.id(planId))),
        cancelMigration: ({ jobId }: { jobId: string }) =>
          this.call(() => this.migrations.cancel(this.id(jobId))),
      },
    });
  }

  private async input<T extends object>(
    value: unknown,
    metatype: Type<T>,
  ): Promise<T> {
    // GraphQL coercion checks shapes; the same DTOs as REST enforce semantic limits.
    return this.inputs.transform(value, {
      type: 'body',
      metatype,
    }) as Promise<T>;
  }

  private id(value: string): string {
    if (!value || value.length > 128)
      throw new PublicGraphqlError(
        'A plan or job ID of 1 to 128 characters is required.',
      );
    return value;
  }

  private async call<T>(operation: () => T | Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof PublicGraphqlError) throw error;
      if (error instanceof HttpException) {
        const codes: Record<number, string> = {
          400: 'BAD_USER_INPUT',
          404: 'NOT_FOUND',
          503: 'SERVICE_UNAVAILABLE',
        };
        if (codes[error.getStatus()])
          throw new PublicGraphqlError(error.message, codes[error.getStatus()]);
      }
      throw new PublicGraphqlError(
        'Database operation failed. Check connection settings, permissions and server availability.',
        'INTERNAL_SERVER_ERROR',
      );
    }
  }
}
