import { z } from 'zod';
import { HttpError } from '../auth';
import { bankRequest, BankError } from '../banking/client';
import { resolveBudget } from './budget';
import type { SpendLabContext } from './contracts';
import type { captureSimulationClock } from './dates';

export type BankReader = (
  userId: string,
  path: '/v1/accounts' | '/v1/movements',
) => Promise<unknown>;
const readBank: BankReader = (userId, path) => bankRequest(userId, path);
const cents = z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const accountSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  label: z.string(),
  iban: z.string(),
  balanceCents: cents,
});
const movementSchema = z.object({
  id: z.string().min(1),
  accountId: z.string().min(1),
  operationId: z.string().nullable(),
  amountCents: cents,
  description: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
});

export async function loadContext(
  userId: string,
  clock: ReturnType<typeof captureSimulationClock>,
  reader: BankReader = readBank,
): Promise<SpendLabContext> {
  const [accountResponse, movementResponse] = await Promise.allSettled([
    reader(userId, '/v1/accounts'),
    reader(userId, '/v1/movements'),
  ]);
  if (accountResponse.status === 'rejected') {
    const error = accountResponse.reason;
    throw new HttpError(
      error instanceof BankError && error.status === 504 ? 504 : 503,
      'Bank balances are unavailable. Please retry.',
    );
  }
  const accounts = z.array(accountSchema).safeParse(accountResponse.value);
  if (
    !accounts.success ||
    accounts.data.some((account) => account.userId !== userId) ||
    new Set(accounts.data.map((account) => account.id)).size !== accounts.data.length
  )
    throw new HttpError(502, 'The bank returned invalid account data.');
  const ownedIds = new Set(accounts.data.map((account) => account.id));
  const movements =
    movementResponse.status === 'fulfilled'
      ? z.array(movementSchema).max(100).safeParse(movementResponse.value)
      : null;
  const historyAvailable =
    !!movements?.success && movements.data.every((movement) => ownedIds.has(movement.accountId));
  const observed = historyAvailable && movements?.success ? movements.data : [];
  observed.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return {
    userId,
    ...clock,
    accounts: accounts.data.map((account) => ({ ...account, source: 'bank' })),
    activity: observed.slice(0, 5).map((movement) => ({ ...movement, source: 'bank' })),
    history: {
      source: 'bank',
      status: historyAvailable ? 'available' : 'unavailable',
      count: observed.length,
      limit: 100,
      from: observed.at(-1)?.createdAt ?? null,
      to: observed[0]?.createdAt ?? null,
      mayBeTruncated: observed.length === 100,
    },
    demoBudget: resolveBudget(userId, null, clock.simulationStartDate),
  };
}
