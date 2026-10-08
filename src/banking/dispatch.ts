import { bankRequest, BankError } from './client';
import type { Operation, ToolContext, TransferInput } from '../types';
import { errorDetails, traceLog } from '../trace';
export class PendingVerificationError extends Error {
  constructor(
    public reference: string,
    public dispatchError: unknown,
    public verificationError: unknown,
  ) {
    super('The bank result could not be verified. The operation is pending verification.');
    this.name = 'PendingVerificationError';
  }
}
export async function dispatchTransfer(
  ctx: ToolContext,
  input: TransferInput,
  reference: string,
): Promise<Operation> {
  for (let attempt = 0; attempt < 2; attempt++) {
    traceLog('transfer', 'dispatch.attempt.started', {
      runId: ctx.runId,
      intentId: ctx.intentId,
      userId: ctx.userId,
      attempt: attempt + 1,
      reference,
      input,
    });
    try {
      const operation = await bankRequest<Operation>(ctx.userId, '/v1/transfers', 'POST', {
        ...input,
        reference,
      });
      traceLog('transfer', 'dispatch.attempt.completed', {
        runId: ctx.runId,
        intentId: ctx.intentId,
        userId: ctx.userId,
        attempt: attempt + 1,
        reference,
        operation,
      });
      return operation;
    } catch (e) {
      const ambiguous = e instanceof BankError && e.status >= 500;
      traceLog('transfer', 'dispatch.attempt.failed', {
        runId: ctx.runId,
        intentId: ctx.intentId,
        userId: ctx.userId,
        attempt: attempt + 1,
        reference,
        ambiguous,
        error: errorDetails(e),
      });
      if (!ambiguous) throw e;
      traceLog('transfer', 'verification.started', {
        runId: ctx.runId,
        intentId: ctx.intentId,
        userId: ctx.userId,
        attempt: attempt + 1,
        reference,
      });
      try {
        const operation = await bankRequest<Operation>(
          ctx.userId,
          `/v1/operations/${encodeURIComponent(reference)}`,
        );
        traceLog('transfer', 'verification.completed', {
          runId: ctx.runId,
          intentId: ctx.intentId,
          userId: ctx.userId,
          attempt: attempt + 1,
          reference,
          operation,
        });
        return operation;
      } catch (verificationError) {
        if (verificationError instanceof BankError && verificationError.status === 404) {
          const retrying = attempt === 0;
          traceLog('transfer', 'verification.not_found', {
            runId: ctx.runId,
            intentId: ctx.intentId,
            userId: ctx.userId,
            attempt: attempt + 1,
            reference,
            retrying,
          });
          if (retrying) continue;
          throw e;
        }
        traceLog('transfer', 'verification.pending', {
          runId: ctx.runId,
          intentId: ctx.intentId,
          userId: ctx.userId,
          attempt: attempt + 1,
          reference,
          dispatchError: errorDetails(e),
          verificationError: errorDetails(verificationError),
        });
        throw new PendingVerificationError(reference, e, verificationError);
      }
    }
  }
  throw new BankError(504, 'The operation could not be completed.');
}
