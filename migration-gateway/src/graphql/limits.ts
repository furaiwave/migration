import {
  GraphQLError,
  Kind,
  type DocumentNode,
  type FragmentDefinitionNode,
  type SelectionSetNode,
} from 'graphql';

export const MAX_QUERY_BYTES = 32 * 1024;
export const MAX_QUERY_TOKENS = 5000;

export class PublicGraphqlError extends GraphQLError {
  constructor(message: string, code = 'BAD_USER_INPUT') {
    super(message, { extensions: { code } });
  }
}

// Check fragment expansion before GraphQL validation or any resolver runs.
export function operationLimitErrors(document: DocumentNode): GraphQLError[] {
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const definition of document.definitions)
    if (definition.kind === Kind.FRAGMENT_DEFINITION)
      fragments.set(definition.name.value, definition);
  let selections = 0;
  try {
    for (const definition of document.definitions) {
      if (definition.kind !== Kind.OPERATION_DEFINITION) continue;
      const roots = new Set<string>();
      const visiting = new Set<string>();
      const walk = (set: SelectionSetNode, depth: number) => {
        if (depth > 20)
          throw new PublicGraphqlError('GraphQL selection depth exceeds 20.');
        for (const selection of set.selections) {
          if (++selections > 1000)
            throw new PublicGraphqlError(
              'GraphQL operation exceeds 1000 expanded selections.',
            );
          if (selection.kind === Kind.FIELD) {
            if (depth === 1 && selection.name.value !== '__typename') {
              roots.add(selection.alias?.value ?? selection.name.value);
              if (roots.size > 1)
                throw new PublicGraphqlError(
                  'Use one root field per operation. Send separate requests for separate database actions.',
                );
            }
            if (selection.selectionSet) walk(selection.selectionSet, depth + 1);
          } else if (selection.kind === Kind.INLINE_FRAGMENT) {
            walk(selection.selectionSet, depth);
          } else {
            const name = selection.name.value;
            if (visiting.has(name))
              throw new PublicGraphqlError(
                'Cyclic GraphQL fragments are not supported.',
              );
            const fragment = fragments.get(name);
            if (fragment) {
              visiting.add(name);
              walk(fragment.selectionSet, depth);
              visiting.delete(name);
            }
          }
        }
      };
      walk(definition.selectionSet, 1);
    }
    return [];
  } catch (error) {
    if (error instanceof PublicGraphqlError) return [error];
    throw error;
  }
}

// GraphQL's default coercion errors can echo complete input objects, including passwords.
export function formatGraphqlError(
  error: Readonly<GraphQLError | Error>,
): GraphQLError {
  const graphqlError = error instanceof GraphQLError ? error : undefined;
  const safe =
    error instanceof PublicGraphqlError
      ? error
      : graphqlError?.originalError instanceof PublicGraphqlError
        ? graphqlError.originalError
        : undefined;
  return new GraphQLError(
    safe?.message ??
      'GraphQL operation failed. Check the schema, field names and input types.',
    {
      path: graphqlError?.path,
      extensions: {
        code:
          safe?.extensions.code ??
          (graphqlError?.path ? 'INTERNAL_SERVER_ERROR' : 'BAD_USER_INPUT'),
      },
    },
  );
}
