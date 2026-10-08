import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { appDb } from '../db';
import { HttpError } from '../auth';
import { person } from '../people';
import { authorizeTransfer } from './authorization';
import { dispatchTransfer, PendingVerificationError } from './dispatch';
import { recordEvent } from '../telemetry';
import type { ActionResult, ToolContext } from '../types';
import { traceLog } from '../trace';
export const transferSchema = z
  .object({
    fromAccountId: z.string().min(1),
    toAccountId: z.string().min(1),
    amountCents: z.number().int().positive().max(10000000),
    concept: z.string().max(200),
  })
  .strict();
export async function transferMoney(ctx: ToolContext, args: unknown): Promise<ActionResult> {
  if (person(ctx.userId)?.role !== 'customer')
    throw new HttpError(403, 'A customer account is required.');
  const input = transferSchema.parse(args),
    db = appDb();
  traceLog('transfer', 'request.validated', {
    runId: ctx.runId,
    conversationId: ctx.conversationId,
    intentId: ctx.intentId,
    userId: ctx.userId,
    input,
  });
  const previous = db
    .prepare('SELECT user_id,payload,bank_reference FROM intents WHERE id=?')
    .get(ctx.intentId) as
    { user_id: string; payload: string; bank_reference: string | null } | undefined;
  if (previous && (previous.user_id !== ctx.userId || previous.payload !== JSON.stringify(input)))
    throw new HttpError(409, 'This intent belongs to a different payload.');
  const proposedReference = previous?.bank_reference || randomUUID();
  traceLog('transfer', previous ? 'intent.reused' : 'intent.created', {
    runId: ctx.runId,
    conversationId: ctx.conversationId,
    intentId: ctx.intentId,
    userId: ctx.userId,
    previous,
    proposedReference,
  });
  db.prepare('INSERT OR IGNORE INTO intents VALUES(?,?,?,?,?,?,?,?,?,?)').run(
    ctx.intentId,
    ctx.userId,
    ctx.conversationId,
    ctx.runId,
    JSON.stringify(input),
    'created',
    proposedReference,
    null,
    null,
    new Date().toISOString(),
  );
  db.prepare('UPDATE intents SET bank_reference=? WHERE id=? AND bank_reference IS NULL').run(
    proposedReference,
    ctx.intentId,
  );
  const bankReference = (
    db.prepare('SELECT bank_reference FROM intents WHERE id=?').get(ctx.intentId) as {
      bank_reference: string;
    }
  ).bank_reference;
  traceLog('transfer', 'authorization.started', {
    runId: ctx.runId,
    intentId: ctx.intentId,
    userId: ctx.userId,
    fromAccountId: input.fromAccountId,
  });
  const permission = await authorizeTransfer(ctx, input);
  traceLog('transfer', 'authorization.completed', {
    runId: ctx.runId,
    intentId: ctx.intentId,
    userId: ctx.userId,
    permission: permission || 'authorized',
  });
  if (permission) return permission;
  db.prepare('UPDATE intents SET status=? WHERE id=?').run('processing', ctx.intentId);
  recordEvent(ctx, 'transfer.started', { status: 'processing', input, intentId: ctx.intentId });
  try {
    traceLog('transfer', 'dispatch.started', {
      runId: ctx.runId,
      intentId: ctx.intentId,
      userId: ctx.userId,
    });
    const operation = await dispatchTransfer(ctx, input, bankReference);
    db.prepare('UPDATE intents SET status=?,operation_id=?,error=NULL WHERE id=?').run(
      'completed',
      operation.id,
      ctx.intentId,
    );
    recordEvent(ctx, 'transfer.completed', {
      status: 'completed',
      operation,
      intentId: ctx.intentId,
    });
    return { status: 'completed', operation, intentId: ctx.intentId };
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Transfer error';
    if (e instanceof PendingVerificationError) {
      db.prepare('UPDATE intents SET status=?,error=? WHERE id=?').run(
        'pending_verification',
        message,
        ctx.intentId,
      );
      recordEvent(ctx, 'transfer.pending_verification', {
        status: 'pending_verification',
        error: message,
        intentId: ctx.intentId,
        bankReference: e.reference,
      });
      // TODO: Reconcile pending_verification intents automatically after application restarts.
      return {
        status: 'pending_verification',
        error: message,
        intentId: ctx.intentId,
        bankReference: e.reference,
      };
    }
    db.prepare('UPDATE intents SET status=?,error=? WHERE id=?').run(
      'failed',
      message,
      ctx.intentId,
    );
    recordEvent(ctx, 'transfer.failed', {
      status: 'failed',
      error: message,
      intentId: ctx.intentId,
    });
    return { status: 'failed', error: message, intentId: ctx.intentId };
  }
}
