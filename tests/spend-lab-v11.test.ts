import test from 'node:test';
import assert from 'node:assert/strict';
import { purchaseSchema, purchaseV11Schema } from '../src/spend-lab/contracts';
import type { BankMovement, CalculationInput, SpendLabContext } from '../src/spend-lab/contracts';
import { summarizeActivity, selectBudgetEvidence } from '../src/spend-lab/activity';
import { resolveBudget } from '../src/spend-lab/budget';
import { calculateScenarios } from '../src/spend-lab/engine';

const base = { amountCents: 100000, motive: 'treat', context: '' } as const;
const history: SpendLabContext['history'] = {
  source: 'bank',
  status: 'available',
  count: 0,
  limit: 100,
  from: null,
  to: null,
  mayBeTruncated: false,
};
const movement = (accountId: string, amountCents: number, createdAt: string): BankMovement => ({
  id: `${accountId}-${createdAt}`,
  accountId,
  amountCents,
  createdAt,
  operationId: null,
  description: 'Observed entry',
  source: 'bank',
});

test('SpendLab V1.1 requires a concrete product while retaining legacy mobile requests', () => {
  assert.deepEqual(purchaseSchema.parse(base), { ...base, category: 'mobile', productName: null });
  for (const category of ['mobile', 'computer', 'gaming', 'other_tech']) {
    const input = { ...base, category, productName: '  The product I chose  ' };
    assert.equal(purchaseV11Schema.parse(input).productName, 'The product I chose');
    assert.equal(purchaseSchema.parse(input).category, category);
  }
  for (const extra of [
    { category: 'computer' },
    { productName: 'Laptop' },
    { category: 'loan', productName: 'Laptop' },
    { category: 'computer', productName: '' },
    { category: 'computer', productName: null },
    { category: 'computer', productName: 'x'.repeat(161) },
    { category: 'computer', productName: 'Laptop', marketPrice: 100 },
  ])
    assert.equal(purchaseSchema.safeParse({ ...base, ...extra }).success, false);
  assert.equal(purchaseV11Schema.safeParse(base).success, false);
});

test('SpendLab V1.1 does not change financial projections by product or category', () => {
  const input: CalculationInput = {
    simulationStartDate: '2026-10-09',
    startingBalanceCents: 300000,
    budget: {
      source: 'user',
      version: null,
      values: {
        monthlyIncomeCents: 200000,
        monthlyEssentialExpensesCents: 80000,
        monthlyDiscretionaryExpensesCents: 0,
        nextIncomeDate: '2026-10-20',
        nextEssentialExpensesDate: '2026-10-10',
      },
    },
    purchase: base,
    reserveCents: 150000,
    resale: { amountCents: 50000, date: '2026-10-16' },
  };
  const legacy = calculateScenarios(input);
  for (const category of ['mobile', 'computer', 'gaming', 'other_tech'] as const)
    assert.deepEqual(
      calculateScenarios({
        ...input,
        purchase: {
          ...base,
          category,
          productName: 'A specific product',
          motive: 'work_study',
        },
      }),
      legacy,
    );
});

test('SpendLab activity totals actual UTC months, including openings and transfers, without extrapolating', () => {
  const observed = [
    movement('current', 300000, '2026-08-01T00:00:00Z'),
    movement('current', 170000, '2026-09-01T00:30:00+02:00'), // August in UTC
    movement('current', -5000, '2026-09-10T12:00:00Z'),
    movement('current', 5000, '2026-09-11T12:00:00Z'),
    movement('savings', -5000, '2026-09-11T12:00:00Z'),
  ];
  const original = structuredClone(observed);
  const result = summarizeActivity(observed, { ...history, count: observed.length });
  assert.equal(result.status, 'available');
  const selected = selectBudgetEvidence(result, ['current']);
  assert.deepEqual(
    selected.groups.map(({ month, creditsCents, debitsCents, movementCount }) => ({
      month,
      creditsCents,
      debitsCents,
      movementCount,
    })),
    [
      { month: '2026-09', creditsCents: 5000, debitsCents: 5000, movementCount: 2 },
      { month: '2026-08', creditsCents: 470000, debitsCents: 0, movementCount: 2 },
    ],
  );
  assert.equal(
    selected.groups.some((group) => group.accountId === 'savings'),
    false,
  );
  assert.equal(
    selected.groups.some((group) => group.month === '2026-10'),
    false,
  );
  assert.deepEqual(observed, original);
});

test('SpendLab activity preserves missing and truncated coverage, and guards unsafe totals', () => {
  assert.equal(summarizeActivity([], { ...history, status: 'unavailable' }).status, 'unavailable');
  assert.deepEqual(summarizeActivity([], history).groups, []);
  const observed = [movement('current', 100, '2026-09-10T12:00:00Z')];
  const result = summarizeActivity(observed, { ...history, count: 100, mayBeTruncated: true });
  assert.equal(selectBudgetEvidence(result, []).coverage.mayBeTruncated, true);
  assert.deepEqual(selectBudgetEvidence(result, ['unobserved']).groups, []);
  const overflow = summarizeActivity(
    [
      movement('current', Number.MAX_SAFE_INTEGER, '2026-09-01T12:00:00Z'),
      movement('current', 1, '2026-09-02T12:00:00Z'),
    ],
    history,
  );
  assert.equal(overflow.status, 'unavailable');
  assert.deepEqual(overflow.groups, []);
});

test('SpendLab optional demo cannot block a valid manual budget or invent an example', () => {
  const manual = {
    monthlyIncomeCents: 0,
    monthlyEssentialExpensesCents: 0,
    monthlyDiscretionaryExpensesCents: 0,
    nextIncomeDate: null,
    nextEssentialExpensesDate: null,
  };
  assert.equal(resolveBudget('lucia', null, '2026-10-09', {}), null);
  assert.equal(resolveBudget('lucia', manual, '2026-10-09', {})?.source, 'user');
  assert.equal(resolveBudget('bruno', null, '2026-10-09'), null);
});
