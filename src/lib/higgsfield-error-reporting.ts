/** Independent error reporting fallback. This app no longer calls Higgsfield's injected browser event bridge. */
export function reportHiggsfieldError(error: unknown, context: Record<string, unknown> = {}) {
  console.error("TradeDuel application error", context, error);
}
