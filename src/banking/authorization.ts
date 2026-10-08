import { bankRequest } from './client';
import { HttpError } from '../auth';
import { randomUUID } from 'node:crypto';
import { appDb } from '../db';
import { recordEvent } from '../telemetry';
import { storedIntent, existingIntentResult } from './intents';
import type { Account, ActionResult, ToolContext, TransferInput } from '../types';
export async function authorizeTransfer(
  ctx: ToolContext,
  input: TransferInput,
): Promise<ActionResult | null> {
  const accounts = await bankRequest<Account[]>(ctx.userId, '/v1/accounts');
  if (!accounts.some((a) => a.id === input.fromAccountId))
    throw new HttpError(403, 'This account does not belong to this person.');
  const db = appDb();
  return db
    .transaction(() => {
      const approval = ctx.approvalId
        ? (db
            .prepare(
              'SELECT payload,consumed_at FROM approvals WHERE id=? AND user_id=? AND intent_id=?',
            )
            .get(ctx.approvalId, ctx.userId, ctx.intentId) as
            { payload: string; consumed_at: string | null } | undefined)
        : undefined;
      if (ctx.approvalId && !approval)
        throw new HttpError(403, 'Customer confirmation is required.');
      // Ownership lookup awaited the bank. Re-read under the lock before changing any intent state.
      const intent = storedIntent(ctx, input);
      const existing = existingIntentResult(ctx, intent);
      if (existing) return existing;
      if (!intent) throw new HttpError(409, 'Intent not found.');
      if (ctx.approvalId) {
        if (!approval) throw new HttpError(403, 'Customer confirmation is required.');
        if (approval.consumed_at) throw new HttpError(409, 'This proposal was already confirmed.');
        const reviewed = JSON.parse(approval.payload) as TransferInput;
        if (
          reviewed.fromAccountId !== input.fromAccountId ||
          reviewed.toAccountId !== input.toAccountId ||
          reviewed.amountCents !== input.amountCents ||
          reviewed.concept !== input.concept
        )
          throw new HttpError(409, 'Confirmation does not match the reviewed operation.');
        // Claim once before network effects; dispatch retries belong to this same execution.
        const claimed = db
          .prepare(
            'UPDATE approvals SET consumed_at=? WHERE id=? AND user_id=? AND intent_id=? AND consumed_at IS NULL',
          )
          .run(new Date().toISOString(), ctx.approvalId, ctx.userId, ctx.intentId);
        if (!claimed.changes) throw new HttpError(409, 'This proposal was already confirmed.');
        const processing = db
          .prepare(
            "UPDATE intents SET status='processing' WHERE id=? AND status='requires_confirmation'",
          )
          .run(ctx.intentId);
        if (!processing.changes)
          throw new HttpError(409, 'This intent is no longer awaiting confirmation.');
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
      db.prepare('UPDATE intents SET status=? WHERE id=?').run(
        'requires_confirmation',
        ctx.intentId,
      );
      recordEvent(ctx, 'transfer.requires_confirmation', {
        status: 'requires_confirmation',
        intentId: ctx.intentId,
        approvalId,
        input,
      });
      return {
        status: 'requires_confirmation',
        intentId: ctx.intentId,
        approvalId,
        payload: input,
      };
    })
    .immediate();
}
