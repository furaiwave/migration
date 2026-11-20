/** Keep every untrusted metadata line inside its SQL or JavaScript line comment. */
export function exportComment(text: string, prefix: '--' | '//'): string {
  return (
    text
      .split(/\r\n|[\r\n\u2028\u2029]/)
      .map((line) => prefix + ' ' + line)
      .join('\n') + '\n'
  );
}
