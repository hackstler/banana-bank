import test from 'node:test';
import assert from 'node:assert/strict';
import { calculationInputSchema, evaluationInputSchema } from '../src/spend-lab/contracts';
import { captureSimulationClock } from '../src/spend-lab/dates';
import { resolveBudget } from '../src/spend-lab/budget';
import { calculateScenarios } from '../src/spend-lab/engine';
import type { CalculationInput } from '../src/spend-lab/contracts';

const start = '2026-10-09';
const sample = (): CalculationInput => ({
  simulationStartDate: start,
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
  purchase: { amountCents: 100000, motive: 'treat', context: '' },
  reserveCents: 150000,
  resale: { amountCents: 50000, date: '2026-10-16' },
});

test('SpendLab reproduces the three agreed scenarios over the full horizon', () => {
  const result = calculateScenarios(sample());
  assert.equal(result.horizonEnd, '2027-01-07');
  assert.equal(result.baseline.trajectory.length, 91);
  const [buy, sell, wait] = result.scenarios;
  assert.equal(buy.available, true);
  assert.equal(sell.available, true);
  assert.equal(wait.available, true);
  if (!buy.available || !sell.available || !wait.available) assert.fail('Missing scenario');
  assert.equal(buy.minimumBalanceCents, 120000);
  assert.equal(buy.financialClass, 'reserve_breach');
  assert.equal(sell.minimumBalanceCents, 170000);
  assert.equal(sell.financialClass, 'within_limits');
  assert.equal(wait.purchaseDate, '2026-10-21');
  assert.equal(wait.financialClass, 'within_limits');
  assert.equal(buy.metrics.netOutlayCents, 100000);
  assert.equal(sell.metrics.netOutlayCents, 50000);
  assert.equal(buy.metrics.marginSacrificedMonths, 100000 / 120000);
  assert.equal(result.suggestedReserveCents, 240000);
  assert.equal(result.startingBalanceSource, 'bank');
});

test('SpendLab captures the actual UTC clock once and allows a fixed test clock', () => {
  let calls = 0;
  const fixed = captureSimulationClock(() => {
    calls++;
    return new Date('2026-12-31T23:30:00-02:00');
  });
  assert.equal(calls, 1);
  assert.deepEqual(fixed, {
    observedAt: '2027-01-01T01:30:00.000Z',
    simulationStartDate: '2027-01-01',
    horizonEnd: '2027-04-01',
  });
  const before = Date.now();
  const actual = captureSimulationClock();
  assert.ok(Date.parse(actual.observedAt) >= before);
  assert.ok(Date.parse(actual.observedAt) <= Date.now());
  assert.equal(actual.simulationStartDate, actual.observedAt.slice(0, 10));
});

test('SpendLab only gives Lucía a demo budget and tags every manual budget as user', () => {
  const demo = resolveBudget('lucia', null, start);
  assert.ok(demo);
  assert.equal(demo.source, 'demo');
  assert.equal(demo.version, 'spend-lab-demo-v1');
  assert.equal(demo.values.nextIncomeDate, '2026-11-02');
  assert.equal(demo.values.nextEssentialExpensesDate, '2026-10-25');
  assert.equal(resolveBudget('bruno', null, start), null);
  assert.equal(resolveBudget('omar', null, start), null);
  const manual = sample().budget.values;
  assert.equal(resolveBudget('lucia', manual, start)?.source, 'user');
  assert.equal(resolveBudget('bruno', manual, start)?.source, 'user');
  assert.equal(
    resolveBudget('lucia', null, '2026-10-25')?.values.nextEssentialExpensesDate,
    '2026-11-25',
  );
  const changed = resolveBudget('lucia', null, start)!;
  changed.values.monthlyIncomeCents = 1;
  assert.equal(resolveBudget('lucia', null, start)?.values.monthlyIncomeCents, 175000);
});

test('SpendLab rejects invented server fields, invalid money, duplicate accounts and stale dates', () => {
  const input = sample();
  const payload = {
    purchase: input.purchase,
    accountIds: ['acc-lucia'],
    budget: input.budget.values,
    reserveCents: input.reserveCents,
    resale: input.resale,
  };
  const schema = evaluationInputSchema(start);
  assert.ok(schema.safeParse(payload).success);
  assert.ok(
    schema.safeParse({ ...payload, accountIds: [], budget: null, reserveCents: null }).success,
  );
  for (const amountCents of [-1, 0, 0.5, Infinity, 10000001]) {
    assert.equal(
      schema.safeParse({ ...payload, purchase: { ...input.purchase, amountCents } }).success,
      false,
    );
  }
  for (const extra of [
    { userId: 'bruno' },
    { startingBalanceCents: 1000000 },
    { simulationStartDate: start },
  ])
    assert.equal(schema.safeParse({ ...payload, ...extra }).success, false);
  assert.equal(
    schema.safeParse({ ...payload, accountIds: ['acc-lucia', 'acc-lucia'] }).success,
    false,
  );
  assert.equal(
    schema.safeParse({ ...payload, resale: { amountCents: 10, date: '2026-10-08' } }).success,
    false,
  );
  assert.equal(
    schema.safeParse({ ...payload, resale: { amountCents: 10, date: '2026-12-09' } }).success,
    false,
  );
  assert.equal(
    schema.safeParse({ ...payload, resale: { amountCents: 10, date: '2026-02-30' } }).success,
    false,
  );
  assert.equal(schema.safeParse({ ...payload, resale: { amountCents: 10 } }).success, false);
  const stale = schema.safeParse({
    ...payload,
    budget: { ...input.budget.values, nextIncomeDate: '2026-10-08' },
  });
  assert.equal(stale.success, false);
  if (!stale.success)
    assert.ok(stale.error.issues.some((issue) => issue.path.join('.') === 'budget.nextIncomeDate'));
  assert.equal(
    schema.safeParse({ ...payload, budget: { ...input.budget.values, nextIncomeDate: null } })
      .success,
    false,
  );
  assert.equal(
    schema.safeParse({ ...payload, purchase: { ...input.purchase, context: 'x'.repeat(1001) } })
      .success,
    false,
  );
});

test('SpendLab detects an intraday shortage even when income restores the day-end balance', () => {
  const input = sample();
  input.startingBalanceCents = 90000;
  input.budget.values.nextIncomeDate = start;
  input.budget.values.nextEssentialExpensesDate = '2026-10-10';
  input.reserveCents = 0;
  const buy = calculateScenarios(input).scenarios[0];
  assert.ok(buy.available);
  assert.equal(buy.minimumBalanceCents, -10000);
  assert.equal(buy.financialClass, 'cash_shortfall');
  assert.equal(buy.trajectory[0].closingBalanceCents, 190000);
  assert.deepEqual(
    buy.events.filter((event) => event.date === start).map((event) => event.kind),
    ['purchase', 'income'],
  );
});

test('SpendLab credits a sale only in sell-first, before its purchase and after commitments', () => {
  const input = sample();
  input.budget.values.nextEssentialExpensesDate = start;
  input.resale!.date = start;
  const result = calculateScenarios(input);
  const sell = result.scenarios[1];
  assert.ok(sell.available);
  assert.deepEqual(
    sell.events.filter((event) => event.date === start).map((event) => event.kind),
    ['essential', 'resale', 'purchase'],
  );
  assert.equal(sell.events.find((event) => event.kind === 'resale')?.source, 'user');
  assert.equal(
    result.baseline.events.some((event) => event.kind === 'resale'),
    false,
  );
  assert.equal(
    result.scenarios[0].available &&
      result.scenarios[0].events.some((event) => event.kind === 'resale'),
    false,
  );
  input.resale = null;
  assert.deepEqual(calculateScenarios(input).scenarios[1], {
    id: 'sell_first',
    available: false,
    purchaseDate: null,
    reason: 'no_resale',
  });
});

test('SpendLab preserves monthly anchors through leap years and short months', () => {
  const input = sample();
  input.simulationStartDate = '2028-01-31';
  input.budget.values.nextIncomeDate = '2028-01-31';
  input.budget.values.nextEssentialExpensesDate = '2028-02-01';
  input.resale = null;
  const baseline = calculateScenarios(input).baseline;
  assert.deepEqual(
    baseline.events.filter((event) => event.kind === 'income').map((event) => event.date),
    ['2028-01-31', '2028-02-29', '2028-03-31', '2028-04-30'],
  );
  assert.ok(baseline.events.every((event) => event.date >= input.simulationStartDate));
});

test('SpendLab distributes exact monthly cents and only projects the remaining days', () => {
  const input = sample();
  input.simulationStartDate = '2027-02-01';
  input.budget.values = {
    monthlyIncomeCents: 0,
    monthlyEssentialExpensesCents: 0,
    monthlyDiscretionaryExpensesCents: 100,
    nextIncomeDate: null,
    nextEssentialExpensesDate: null,
  };
  input.resale = null;
  const baseline = calculateScenarios(input).baseline;
  const feb = baseline.events.filter((event) => event.date < '2027-03-01');
  assert.equal(feb.length, 28);
  assert.equal(
    feb.reduce((sum, event) => sum + event.amountCents, 0),
    -100,
  );
  assert.equal(feb[0].amountCents, -3);
  assert.equal(feb.at(-1)!.amountCents, -4);
  input.simulationStartDate = '2027-02-28';
  assert.equal(calculateScenarios(input).baseline.events[0].amountCents, -4);
});

test('SpendLab reports zero-margin metrics, no viable wait date and preexisting problems', () => {
  const input = sample();
  input.startingBalanceCents = 90000;
  input.budget.values = {
    monthlyIncomeCents: 0,
    monthlyEssentialExpensesCents: 0,
    monthlyDiscretionaryExpensesCents: 0,
    nextIncomeDate: null,
    nextEssentialExpensesDate: null,
  };
  input.resale = null;
  input.reserveCents = 0;
  const result = calculateScenarios(input);
  const buy = result.scenarios[0];
  assert.ok(buy.available);
  assert.equal(buy.metrics.marginSacrificedMonths, null);
  assert.equal(buy.metrics.essentialCoverageMonths, null);
  assert.equal(buy.flags.addedCashShortfall, true);
  assert.deepEqual(result.scenarios[2], {
    id: 'wait',
    available: false,
    purchaseDate: null,
    reason: 'no_viable_date',
  });
  input.startingBalanceCents = -1;
  const preexisting = calculateScenarios(input);
  assert.equal(preexisting.baseline.financialClass, 'cash_shortfall');
  assert.ok(preexisting.scenarios[0].available);
  assert.equal(preexisting.scenarios[0].flags.preexistingCashShortfall, true);
  assert.equal(preexisting.scenarios[0].flags.addedCashShortfall, false);
});

test('SpendLab treats the exact reserve as compatible and does not mutate preview inputs', () => {
  const input = sample();
  input.reserveCents = 120000;
  const original = structuredClone(input);
  const result = calculateScenarios(input);
  assert.ok(result.scenarios[0].available);
  assert.equal(result.scenarios[0].financialClass, 'within_limits');
  assert.deepEqual(input, original);
  input.purchase.motive = 'work_study';
  input.purchase.context = 'My phone is broken and I need it for work.';
  assert.deepEqual(calculateScenarios(input), result);
});

test('SpendLab rejects unsafe arithmetic and accepts signed safe bank balances', () => {
  const input = sample();
  input.startingBalanceCents = -1;
  assert.ok(calculationInputSchema(start).safeParse(input).success);
  input.startingBalanceCents = Number.MAX_SAFE_INTEGER + 1;
  assert.equal(calculationInputSchema(start).safeParse(input).success, false);
  input.startingBalanceCents = Number.MAX_SAFE_INTEGER;
  assert.throws(() => calculateScenarios(input), /safe integer/);
});
