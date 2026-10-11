import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateScenarios } from '../src/spend-lab/engine';
import type { CalculationInput } from '../src/spend-lab/contracts';
import { projectionInsight, selectedProjection, describeEvidence } from '../src/spend-lab/insights';

const sample = (): CalculationInput => ({
  simulationStartDate: '2026-10-11',
  startingBalanceCents: 300000,
  budget: {
    source: 'user',
    version: null,
    values: {
      monthlyIncomeCents: 200000,
      monthlyEssentialExpensesCents: 80000,
      monthlyDiscretionaryExpensesCents: 0,
      nextIncomeDate: '2026-10-25',
      nextEssentialExpensesDate: '2026-10-18',
    },
  },
  purchase: { amountCents: 100000, motive: 'treat', context: 'Photography on weekend walks.' },
  reserveCents: 150000,
  resale: { amountCents: 50000, date: '2026-10-18' },
});

test('SpendLab preserves baseline selection and falls back only for unavailable scenarios', () => {
  const calculation = calculateScenarios({ ...sample(), resale: null });
  assert.equal(selectedProjection(calculation, 'baseline').id, 'baseline');
  assert.equal(selectedProjection(calculation, 'sell_first').id, 'buy_now');
});

test('SpendLab discovers a purchase that preserves reserve today but breaches it seven days later', () => {
  const calculation = calculateScenarios(sample());
  const original = structuredClone(calculation);
  const insight = projectionInsight(calculation, 'buy_now');
  assert.equal(insight.purchaseBalanceCents, 200000);
  assert.equal(insight.canPayAndKeepReserveAtPurchase, true);
  assert.ok(insight.firstProblem);
  assert.equal(insight.firstProblem.date, '2026-10-18');
  assert.equal(insight.firstProblem.day, 7);
  assert.equal(insight.firstProblem.kind, 'reserve_breach');
  assert.equal(insight.firstProblem.event?.kind, 'essential');
  assert.equal(insight.firstProblem.event?.amountCents, -80000);
  assert.equal(insight.firstProblem.beforeBalanceCents, 200000);
  assert.equal(insight.firstProblem.balanceCents, 120000);
  assert.equal(insight.firstProblem.alsoWithoutPurchase, false);
  assert.equal(projectionInsight(calculation, 'sell_first').firstProblem, null);
  const wait = selectedProjection(calculation, 'wait');
  assert.equal(wait.purchaseDate, '2026-10-26');
  assert.equal(projectionInsight(calculation, 'wait').firstProblem, null);
  const day = insight.firstProblem.day;
  assert.equal(
    selectedProjection(calculation, 'baseline').trajectory[day].minimumBalanceCents,
    220000,
  );
  assert.equal(
    selectedProjection(calculation, 'sell_first').trajectory[day].minimumBalanceCents,
    170000,
  );
  assert.deepEqual(calculation, original);
  console.log(
    'spend-lab.future-demo',
    JSON.stringify({
      firstProblem: insight.firstProblem,
      sellMinimum: selectedProjection(calculation, 'sell_first').minimumBalanceCents,
      waitDate: wait.purchaseDate,
    }),
  );
});

test('SpendLab highlights the causal intraday event even if later income restores the closing balance', () => {
  const input = sample();
  input.purchase.amountCents = 250000;
  input.reserveCents = 0;
  input.budget.values.nextIncomeDate = '2026-10-18';
  const calculation = calculateScenarios(input);
  const insight = projectionInsight(calculation, 'buy_now');
  assert.equal(insight.firstProblem?.kind, 'cash_shortfall');
  assert.equal(insight.firstProblem?.event?.kind, 'essential');
  assert.equal(insight.firstProblem?.balanceCents, -30000);
  assert.equal(insight.projection.trajectory[7].closingBalanceCents, 170000);
});

test('SpendLab distinguishes initial and preexisting problems, exact reserve, and undefined ratios', () => {
  const input = sample();
  input.startingBalanceCents = -1;
  const initial = projectionInsight(calculateScenarios(input), 'baseline');
  assert.equal(initial.firstProblem?.event, null);
  assert.equal(initial.firstProblem?.day, 0);
  assert.equal(initial.firstProblem?.alsoWithoutPurchase, true);
  input.startingBalanceCents = 160000;
  const existing = projectionInsight(calculateScenarios(input), 'buy_now');
  assert.equal(existing.firstProblem?.alsoWithoutPurchase, false); // Purchase makes the earlier problem.
  const baseline = projectionInsight(calculateScenarios(input), 'baseline');
  assert.equal(baseline.firstProblem?.event?.kind, 'essential');
  assert.equal(baseline.firstProblem?.alsoWithoutPurchase, true);
  input.startingBalanceCents = 330000;
  const exact = projectionInsight(calculateScenarios(input), 'buy_now');
  assert.equal(exact.projection.minimumBalanceCents, 150000);
  assert.equal(exact.firstProblem, null);
  assert.equal(
    describeEvidence({
      id: 'buy_now.marginSacrificedMonths',
      value: null,
      sources: ['user'],
      meaning: '',
    }).value,
    'Not defined with this budget',
  );
  assert.match(
    describeEvidence({
      id: 'buy_now.reserveGapCents',
      value: -30000,
      sources: ['user'],
      meaning: '',
    }).value,
    /300.*below/i,
  );
  assert.match(
    describeEvidence({ id: 'wait.reserveGapCents', value: 90000, sources: ['user'], meaning: '' })
      .value,
    /900.*above/i,
  );
});
