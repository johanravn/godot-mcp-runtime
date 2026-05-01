/**
 * Shared assertion helpers for handler tests.
 *
 * Handlers return either a normal MCP response (`{ content: [...] }`) or an
 * error envelope (`{ content: [...], isError: true }`). `hasError` is the
 * canonical predicate — prefer it over inlining the shape check.
 */

export function hasError(result: unknown): boolean {
  return typeof result === 'object' && result !== null && 'isError' in result;
}
