import { bankRequest } from './client';
import { HttpError } from '../auth';
import { randomUUID } from 'node:crypto';
import { appDb } from '../db';
import { recordEvent } from '../telemetry';
import type { Account, ActionResult, ToolContext, TransferInput } from '../types';
export async function authorizeTransfer(
  ctx: ToolContext,
  input: TransferInput,
): Promise<ActionResult | null> {
  const accounts = await bankRequest<Account[]>(ctx.userId, '/v1/accounts');
  if (!accounts.some((a) => a.id === input.fromAccountId))
    throw new HttpError(403, 'This account does not belong to this person.');
  const db = appDb();
  const intent = db.prepare('SELECT status FROM intents WHERE id=?').get(ctx.intentId) as {
    status: string;
  };
  if (intent.status === 'cancelled') throw new HttpError(409, 'This intent was cancelled.');
  if (ctx.approvalId) {
    const approval = db
      .prepare('SELECT id FROM approvals WHERE id=? AND user_id=? AND intent_id=?')
      .get(ctx.approvalId, ctx.userId, ctx.intentId);
    if (!approval) throw new HttpError(403, 'Customer confirmation is required.');
    recordEvent(ctx, 'transfer.confirmed', {
      status: 'confirmed',
      intentId: ctx.intentId,
      approvalId: ctx.approvalId,
    });
    return null;
  }
  const previous = db
    .prepare('SELECT id FROM approvals WHERE intent_id=? AND user_id=? AND consumed_at IS NULL')
    .get(ctx.intentId, ctx.userId) as { id: string } | undefined;
  const approvalId = previous?.id || randomUUID();
  if (!previous) {
    db.prepare('INSERT INTO approvals VALUES(?,?,?,?,?,?)').run(
      approvalId,
      ctx.userId,
      ctx.intentId,
      JSON.stringify(input),
      // The existing dashboard requires this column; expiry policy is outside this task.
      '9999-12-31T23:59:59.999Z',
      null,
    );
  }
  db.prepare('UPDATE intents SET status=? WHERE id=?').run('requires_confirmation', ctx.intentId);
  recordEvent(ctx, 'transfer.requires_confirmation', {
    status: 'requires_confirmation',
    intentId: ctx.intentId,
    approvalId,
    input,
  });
  return { status: 'requires_confirmation', intentId: ctx.intentId, approvalId, payload: input };
}
