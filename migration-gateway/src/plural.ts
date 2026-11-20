/** English count forms for server messages; UI pluralization follows the selected language. */
export function plural(n: number, one: string, many: string): string {
  return Math.abs(n) === 1 ? one : many;
}
