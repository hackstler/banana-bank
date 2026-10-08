import { randomUUID } from 'node:crypto';
import { appDb } from './db';
import type { ToolContext } from './types';
import { traceLog } from './trace';
export function recordEvent(ctx: ToolContext, kind: string, data: Record<string, unknown>) {
  const eventId = randomUUID();
  appDb()
    .prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?)')
    .run(
      eventId,
      ctx.runId,
      ctx.userId,
      ctx.conversationId,
      kind,
      JSON.stringify(data),
      new Date().toISOString(),
    );
  traceLog('event', kind, {
    eventId,
    runId: ctx.runId,
    userId: ctx.userId,
    conversationId: ctx.conversationId,
    intentId: ctx.intentId,
    callId: ctx.callId,
    ...data,
  });
}
