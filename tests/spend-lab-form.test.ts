import test from 'node:test';
import assert from 'node:assert/strict';
import {
  demoFields,
  emptyForm,
  euroCents,
  evaluationFromForm,
  previewFromForm,
  validatePurchase,
} from '../app/components/spend-lab/form';
import type { CompleteEvaluation, FormValues } from '../app/components/spend-lab/form';
import type { SpendLabContext } from '../src/spend-lab/contracts';
import { resolveBudget } from '../src/spend-lab/budget';
import { calculateScenarios } from '../src/spend-lab/engine';

const context: SpendLabContext = {
  userId: 'lucia',
  observedAt: '2026-10-09T12:00:00Z',
  simulationStartDate: '2026-10-09',
  horizonEnd: '2027-01-07',
  accounts: [
    {
      id: 'current',
      userId: 'lucia',
      label: 'Current',
      iban: 'test',
      balanceCents: 300000,
      source: 'bank',
    },
    {
      id: 'savings',
      userId: 'lucia',
      label: 'Savings',
      iban: 'test',
      balanceCents: 500000,
      source: 'bank',
    },
  ],
  activity: [],
  history: {
    source: 'bank',
    status: 'available',
    count: 0,
    limit: 100,
    from: null,
    to: null,
    mayBeTruncated: false,
  },
  demoBudget: resolveBudget('lucia', null, '2026-10-09'),
};
function manual(): FormValues {
  return {
    ...emptyForm,
    price: '1000',
    motive: 'treat',
    accountIds: ['current'],
    income: '2000',
    essentials: '800',
    discretionary: '0',
    incomeDate: '2026-10-20',
    essentialsDate: '2026-10-10',
    reserve: '1500',
    selling: true,
    saleAmount: '500',
    saleDate: '2026-10-16',
  };
}
function evaluation(form = manual()): CompleteEvaluation {
  const parsed = evaluationFromForm(form, context);
  assert.ok(parsed.success);
  const calculationInput = {
    simulationStartDate: context.simulationStartDate,
    startingBalanceCents: 300000,
    budget: { source: 'user' as const, version: null, values: parsed.input.budget! },
    purchase: parsed.input.purchase,
    reserveCents: parsed.input.reserveCents!,
    resale: parsed.input.resale,
  };
  return {
    status: 'complete',
    runId: 'test',
    userId: 'lucia',
    evaluatedAt: context.observedAt,
    input: parsed.input,
    context,
    calculationInput,
    calculation: calculateScenarios(calculationInput),
    assessment: { status: 'unavailable', reason: 'missing_key' },
    methodology: { version: 'test', assumptions: [], sources: [] },
  };
}

test('SpendLab form converts euro text to exact cents and rejects ambiguous or malformed money', () => {
  assert.equal(euroCents('0.29'), 29);
  assert.equal(euroCents(' 1000,99 '), 100099);
  assert.equal(euroCents('12.5'), 1250);
  assert.equal(euroCents('0'), 0);
  for (const invalid of [
    '',
    '-5',
    '0.001',
    '1e3',
    '1,000.00',
    'Infinity',
    'abc',
    '9007199254740991',
  ])
    assert.ok(Number.isNaN(euroCents(invalid)), invalid);
});

test('SpendLab form requires an explicit reason and account choice before evaluation', () => {
  assert.ok(validatePurchase({ ...emptyForm })['purchase.motive']);
  const noAccounts = evaluationFromForm({ ...manual(), accountIds: [] }, context);
  assert.ok(!noAccounts.success);
  assert.ok(noAccounts.errors.accountIds);
  assert.deepEqual(emptyForm.accountIds, []);
  assert.equal(emptyForm.motive, '');
  const foreign = evaluationFromForm({ ...manual(), accountIds: ['another-holder'] }, context);
  assert.ok(!foreign.success);
  assert.ok(foreign.errors.accountIds);
});

test('SpendLab form preserves demo provenance until the budget is edited and cannot invent a demo for another customer', () => {
  const form = { ...manual(), ...demoFields(context) };
  const demo = evaluationFromForm(form, context);
  assert.ok(demo.success);
  assert.equal(demo.input.budget, null);
  const changed = evaluationFromForm({ ...form, income: '1900', useDemo: false }, context);
  assert.ok(changed.success);
  assert.equal(changed.input.budget?.monthlyIncomeCents, 190000);
  const other = { ...context, demoBudget: null };
  assert.deepEqual(demoFields(other), {});
  const missing = evaluationFromForm(
    {
      ...emptyForm,
      useDemo: true,
      price: '1000',
      motive: 'treat',
      accountIds: ['current'],
      reserve: '0',
    },
    other,
  );
  assert.ok(!missing.success);
  assert.ok(missing.errors['budget.monthlyIncomeCents']);
});

test('SpendLab manual form accepts zero income, zero essentials and explicit zero reserve without pending dates', () => {
  const zero = evaluationFromForm(
    { ...manual(), income: '0', essentials: '0', incomeDate: '', essentialsDate: '', reserve: '0' },
    context,
  );
  assert.ok(zero.success);
  assert.equal(zero.input.reserveCents, 0);
  assert.equal(zero.input.budget?.nextIncomeDate, null);
  assert.equal(zero.input.budget?.nextEssentialExpensesDate, null);
  const missingReserve = evaluationFromForm({ ...manual(), reserve: '' }, context);
  assert.ok(!missingReserve.success);
  assert.ok(missingReserve.errors.reserveCents);
});

test('SpendLab preview reuses the bank snapshot and pure engine without mutating the submitted evaluation', () => {
  const result = evaluation();
  const original = structuredClone(result);
  const preview = previewFromForm(
    { ...manual(), price: '1200', reserve: '0', accountIds: ['current', 'savings'] },
    result,
  );
  assert.ok(preview.calculation);
  assert.equal(preview.calculation.startingBalanceCents, 800000);
  assert.equal(
    preview.calculation.scenarios[0].available &&
      preview.calculation.scenarios[0].metrics.netOutlayCents,
    120000,
  );
  assert.equal(preview.calculation.reserveCents, 0);
  assert.deepEqual(result, original);
  const delayed = previewFromForm({ ...manual(), saleDate: '2026-10-18' }, result);
  assert.ok(delayed.calculation?.scenarios[1].available);
  assert.equal(delayed.calculation.scenarios[1].purchaseDate, '2026-10-18');
});

test('SpendLab invalid preview hides dependent calculations and disabled sale never reuses stale proceeds', () => {
  const result = evaluation();
  for (const form of [
    { ...manual(), price: '' },
    { ...manual(), saleAmount: '' },
    { ...manual(), saleDate: '2026-10-08' },
  ])
    assert.equal(previewFromForm(form, result).calculation, null);
  const disabledSale = previewFromForm({ ...manual(), selling: false }, result);
  assert.ok(disabledSale.calculation);
  assert.equal(disabledSale.calculation.scenarios[1].available, false);
  assert.equal(result.calculation.scenarios[1].available, true);
});
