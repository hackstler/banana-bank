import type { ActivityGroup, BankMovement, BudgetEvidence, SpendLabContext } from './contracts';

// Observed cash movements only: not a classification, recurrence detector or future budget.
export function summarizeActivity(
  movements: BankMovement[],
  coverage: SpendLabContext['history'],
): BudgetEvidence {
  const result: BudgetEvidence = {
    source: 'bank',
    status: coverage.status,
    coverage: { ...coverage },
    groups: [],
  };
  if (coverage.status === 'unavailable') return result;
  const groups = new Map<string, ActivityGroup>();
  for (const movement of movements) {
    const timestamp = new Date(movement.createdAt);
    if (!Number.isFinite(timestamp.getTime()) || !Number.isSafeInteger(movement.amountCents))
      return { ...result, status: 'unavailable' };
    const month = timestamp.toISOString().slice(0, 7);
    const at = timestamp.toISOString();
    const key = JSON.stringify([movement.accountId, month]);
    const group = groups.get(key) ?? {
      accountId: movement.accountId,
      month,
      creditsCents: 0,
      debitsCents: 0,
      movementCount: 0,
      from: at,
      to: at,
    };
    group.creditsCents += Math.max(0, movement.amountCents);
    group.debitsCents += Math.max(0, -movement.amountCents);
    if (!Number.isSafeInteger(group.creditsCents) || !Number.isSafeInteger(group.debitsCents))
      return { ...result, status: 'unavailable' };
    group.movementCount++;
    group.from = at < group.from ? at : group.from;
    group.to = at > group.to ? at : group.to;
    groups.set(key, group);
  }
  result.groups = [...groups.values()].sort(
    (a, b) => b.month.localeCompare(a.month) || a.accountId.localeCompare(b.accountId),
  );
  return result;
}

export function selectBudgetEvidence(
  evidence: BudgetEvidence,
  accountIds: string[],
): BudgetEvidence {
  const selected = new Set(accountIds);
  return { ...evidence, groups: evidence.groups.filter((group) => selected.has(group.accountId)) };
}
