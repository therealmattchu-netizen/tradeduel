/** Application error reporting for independent deployments. */
export function reportApplicationError(error: unknown, context: Record<string, unknown> = {}) {
  console.error("TradeDuel application error", context, error);
}
