import { config } from '../config';
import { sign } from '../auth';
import { randomUUID } from 'node:crypto';
import { errorDetails, traceLog } from '../trace';
export class BankError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function bankRequest<T>(
  userId: string,
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  const raw = body === undefined ? '' : JSON.stringify(body),
    timestamp = String(Date.now()),
    bankRequestId = randomUUID(),
    started = Date.now();
  const signature = sign([method, path, userId, timestamp, raw].join('\n'), config.serviceSecret);
  traceLog('bank', 'request.started', {
    bankRequestId,
    userId,
    method,
    path,
    body,
  });
  let response: Response;
  try {
    response = await fetch(`${config.bankUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-bank-actor': userId,
        'x-bank-time': timestamp,
        'x-bank-signature': signature,
      },
      body: raw || undefined,
      signal: AbortSignal.timeout(config.bankTimeoutMs),
      cache: 'no-store',
    });
  } catch (error) {
    traceLog('bank', 'request.transport_failed', {
      bankRequestId,
      userId,
      method,
      path,
      durationMs: Date.now() - started,
      error: errorDetails(error),
    });
    throw new BankError(504, 'No response received from the bank.');
  }
  const data = await response.json();
  traceLog('bank', 'response.received', {
    bankRequestId,
    userId,
    method,
    path,
    status: response.status,
    ok: response.ok,
    durationMs: Date.now() - started,
    data,
  });
  if (!response.ok) throw new BankError(response.status, data.error || 'Bank service error.');
  return data as T;
}
