import { HttpError } from '../auth';
import { appDb } from '../db';
import { traceLog } from '../trace';
import type { ActionResult, Operation, ToolContext, TransferInput } from '../types';

type StoredIntent = {
  user_id: string;
  payload: string;
  status: string;
  bank_reference: string | null;
  operation_id: string | null;
  error: string | null;
};

export function storedIntent(ctx: ToolContext, input: TransferInput) {
  const intent = appDb().prepare('SELECT * FROM intents WHERE id=?').get(ctx.intentId) as
    StoredIntent | undefined;
  if (intent && (intent.user_id !== ctx.userId || intent.payload !== JSON.stringify(input)))
    throw new HttpError(409, 'This intent belongs to a different payload.');
  return intent;
}

export function existingIntentResult(
  ctx: ToolContext,
  intent: StoredIntent | undefined,
): ActionResult | null {
  if (!intent || ['created', 'requires_confirmation'].includes(intent.status)) return null;
  if (intent.status === 'cancelled') throw new HttpError(409, 'This intent was cancelled.');
  if (ctx.approvalId) throw new HttpError(409, 'This intent is no longer awaiting confirmation.');
  traceLog('transfer', 'intent.result_reused', {
    runId: ctx.runId,
    userId: ctx.userId,
    intentId: ctx.intentId,
    status: intent.status,
    bankReference: intent.bank_reference,
    operationId: intent.operation_id,
  });
  if (intent.status === 'completed') {
    const event = appDb()
      .prepare(
        `SELECT json_extract(data,'$.operation') AS operation FROM events
        WHERE user_id=? AND kind='transfer.completed'
          AND json_extract(data,'$.intentId')=? AND json_extract(data,'$.operation.id')=?
          AND json_extract(data,'$.operation.reference')=?
        ORDER BY rowid DESC LIMIT 1`,
      )
      .get(ctx.userId, ctx.intentId, intent.operation_id, intent.bank_reference) as
      { operation: string } | undefined;
    if (event)
      return {
        status: 'completed',
        intentId: ctx.intentId,
        operation: JSON.parse(event.operation) as Operation,
      };
    // Older events omitted the operation: expose only facts actually stored, without inventing dates.
    return {
      status: 'completed',
      intentId: ctx.intentId,
      operationId: intent.operation_id,
      bankReference: intent.bank_reference,
      payload: JSON.parse(intent.payload),
    };
  }
  if (intent.status === 'failed')
    return { status: 'failed', intentId: ctx.intentId, error: intent.error };
  if (['processing', 'pending_verification'].includes(intent.status))
    return {
      status: intent.status,
      intentId: ctx.intentId,
      bankReference: intent.bank_reference,
      ...(intent.error ? { error: intent.error } : {}),
    };
  throw new HttpError(409, 'This intent cannot start another execution.');
}
