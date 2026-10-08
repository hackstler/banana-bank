import { config } from './config';

export function traceLog(scope: string, event: string, data: Record<string, unknown> = {}) {
  if (!config.traceLogs) return;
  const entry = {
    timestamp: new Date().toISOString(),
    scope,
    event,
    ...data,
  };
  try {
    console.log(`[banana.trace] ${JSON.stringify(entry)}`);
  } catch {
    console.log('[banana.trace]', entry);
  }
}

export function errorDetails(error: unknown) {
  if (error instanceof Error)
    return {
      name: error.name,
      message: error.message,
      status: 'status' in error ? (error as Error & { status?: unknown }).status : undefined,
    };
  return { message: String(error) };
}
