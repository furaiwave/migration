import { All, Controller, Get, Header, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { GraphqlService } from './graphql.service';
import { graphqlSchemaSource } from './schema';

@Controller('dbf/graphql')
export class GraphqlController {
  constructor(private readonly graphql: GraphqlService) {}

  @Get('schema')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  schema() {
    return graphqlSchemaSource;
  }

  @All()
  async request(@Req() request: Request, @Res() response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    // Connection credentials belong in a JSON body, never URL query parameters.
    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST');
      response.status(405).json({
        errors: [
          {
            message: 'Use POST with a JSON GraphQL request body.',
            extensions: { code: 'METHOD_NOT_ALLOWED' },
          },
        ],
      });
      return;
    }
    try {
      const [body, init] = await this.graphql.handle({
        method: request.method,
        url: request.originalUrl,
        headers: request.headers,
        body: request.body as Record<string, unknown> | null,
        raw: request,
        context: undefined,
      });
      for (const [name, value] of Object.entries(init.headers ?? {}))
        response.setHeader(name, value);
      response.status(init.status).end(body);
    } catch {
      // The HTTP adapter must never log or serialize raw exceptions/connection input.
      response.status(500).json({
        errors: [
          {
            message: 'GraphQL request failed.',
            extensions: { code: 'INTERNAL_SERVER_ERROR' },
          },
        ],
      });
    }
  }
}
