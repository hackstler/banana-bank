import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { calculateScenarios } from '../src/spend-lab/engine';
import type { CalculationInput, ViewedScenarioId } from '../src/spend-lab/contracts';
import {
  purchaseSummary,
  timelineMoments,
  minimumMoment,
  scenarioVerdict,
} from '../app/components/spend-lab/presentation';

// tsx's JSX-preserve transform uses React here; Next uses its own JSX runtime in production.
Object.assign(globalThis, { React });
const { default: ScenarioTimeline } = await import('../app/components/spend-lab/ScenarioTimeline');
const { default: ScenarioCards } = await import('../app/components/spend-lab/ScenarioCards');
const { default: EvidenceDetails } = await import('../app/components/spend-lab/EvidenceDetails');
const input: CalculationInput = {
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
  purchase: { amountCents: 100000, motive: 'treat', context: '' },
  reserveCents: 150000,
  resale: { amountCents: 50000, date: '2026-10-18' },
};
const render = (value: CalculationInput, selected: ViewedScenarioId) =>
  renderToStaticMarkup(
    React.createElement(ScenarioTimeline, {
      calculation: calculateScenarios(value),
      selected,
      onSelect: () => {},
    }),
  );

test('SpendLab risk timeline merges the causal drop and minimum, with no chart or daily noise', () => {
  const calculation = calculateScenarios(input);
  const original = structuredClone(calculation);
  const moments = timelineMoments(calculation, 'buy_now');
  assert.equal(moments.length, 2);
  assert.equal(moments[0].date, '2026-10-11');
  assert.equal(moments[0].balanceCents, 200000);
  assert.equal(moments[1].date, '2026-10-18');
  assert.equal(moments[1].event?.kind, 'essential');
  assert.equal(moments[1].balanceCents, 120000);
  assert.deepEqual(moments[1].labels, [
    'Safety cushion crossed',
    'Lowest balance in these 90 days',
  ]);
  const html = render(input, 'buy_now');
  assert.match(html, /<ol/);
  assert.match(html, /dateTime="2026-10-18"/i);
  assert.match(html, /Planned essentials \(monthly total\)/);
  assert.match(html, /€2,000\.00 → €1,200\.00/);
  assert.match(html, /Sell first/);
  assert.match(html, /Wait/);
  assert.doesNotMatch(html, /<svg|type="range"|Day-end balance|rent payment/i);
  assert.match(purchaseSummary(calculation), /You can pay today, but/);
  assert.deepEqual(calculation, original);
});

test('SpendLab safe scenarios show a short conclusion without a timeline or another scenario risk', () => {
  for (const selected of ['baseline', 'sell_first', 'wait'] as const) {
    const html = render(input, selected);
    assert.doesNotMatch(html, /<ol|Safety cushion crossed|Buy now: first problem|<svg/);
    assert.match(html, /90 days/);
  }
  const affordable = render(
    { ...input, purchase: { ...input.purchase, amountCents: 2000 } },
    'buy_now',
  );
  assert.doesNotMatch(affordable, /<ol/);
  assert.equal(affordable, '');
  assert.match(
    purchaseSummary(
      calculateScenarios({ ...input, purchase: { ...input.purchase, amountCents: 2000 } }),
    ),
    /Buying now keeps enough money/,
  );
});

test('SpendLab keeps an intraday shortfall visible when later income restores the closing balance', () => {
  const value = structuredClone(input);
  value.purchase.amountCents = 250000;
  value.reserveCents = 0;
  value.budget.values.nextIncomeDate = '2026-10-18';
  const calculation = calculateScenarios(value);
  const buy = calculation.scenarios[0];
  assert.ok(buy.available);
  assert.equal(buy.trajectory[7].closingBalanceCents, 170000);
  assert.equal(timelineMoments(calculation, 'buy_now')[1].balanceCents, -30000);
  assert.match(render(value, 'buy_now'), /Not enough for planned payments/);
});

test('SpendLab discloses budget problems before a compatible deferred purchase and worsening when buying now', () => {
  const value = structuredClone(input);
  value.purchase.amountCents = 50000;
  value.budget.values.monthlyIncomeCents = 300000;
  value.budget.values.monthlyEssentialExpensesCents = 200000;
  value.budget.values.nextEssentialExpensesDate = '2026-10-12';
  value.budget.values.nextIncomeDate = '2026-10-20';
  value.resale = { amountCents: 50000, date: '2026-10-21' };
  const calculation = calculateScenarios(value);
  const wait = calculation.scenarios[2];
  assert.ok(wait.available);
  assert.equal(wait.financialClass, 'within_limits');
  assert.equal(wait.purchaseDate, '2026-10-21');
  assert.equal(wait.minimumBalanceCents, 100000);
  assert.equal(wait.minimumAfterPurchaseCents, 150000);
  assert.equal(minimumMoment(wait).date, '2026-10-12');
  assert.match(scenarioVerdict(calculation, 'wait'), /earlier budget risk/);
  const html = render(value, 'wait');
  assert.match(html, /Budget problem before buying/);
  assert.match(html, /fits from that point onward/);
  assert.doesNotMatch(html, /No projected cash shortfall|stay covered over these 90 days/);
  assert.match(purchaseSummary(calculation), /from €1,000\.00 to €500\.00/);
});

test('SpendLab scenario cards separate the purchase date and actual minimum date and preserve baseline selection', () => {
  const html = renderToStaticMarkup(
    React.createElement(ScenarioCards, {
      calculation: calculateScenarios(input),
      selected: 'baseline',
      onSelect: () => {},
    }),
  );
  assert.match(html, /Buy on 11 Oct/);
  assert.match(html, /Lowest in 90 days · 18 Oct/);
  assert.doesNotMatch(html, /Lowest in 90 days · 11 Oct/);
  assert.match(html, /aria-pressed="true">Viewing: Without this purchase/);
  assert.doesNotMatch(html, /spend-lab-selected/);
});

test('SpendLab Why removes undefined and month metrics, deduplicates sources and keeps meaningful zero euros', () => {
  const evidence = [
    {
      id: 'buy_now.reserveGapCents',
      value: -30000,
      sources: ['bank', 'user', 'user'] as const,
      meaning: '',
    },
    { id: 'wait.marginSacrificedMonths', value: 0, sources: ['user'] as const, meaning: '' },
    { id: 'wait.minimumAfterPurchaseCents', value: null, sources: ['bank'] as const, meaning: '' },
    { id: 'reserveCents', value: 0, sources: ['user'] as const, meaning: '' },
    {
      id: 'bank.startingBalanceCents',
      value: 999999,
      sources: ['bank'] as const,
      meaning: 'Uncited',
    },
  ].map((item) => ({ ...item, sources: [...item.sources] }));
  const html = renderToStaticMarkup(
    React.createElement(EvidenceDetails, {
      evidence,
      ids: [
        'buy_now.reserveGapCents',
        'wait.marginSacrificedMonths',
        'wait.minimumAfterPurchaseCents',
        'reserveCents',
        'unknown',
      ],
    }),
  );
  assert.match(html, /€300\.00 below your reserve/);
  assert.match(html, /Bank records \+ Your declarations/);
  assert.match(html, /€0\.00/);
  assert.doesNotMatch(
    html,
    /months|Unavailable|Not defined|Your declarations \+ Your declarations|€9,999\.99/,
  );
  assert.equal(
    renderToStaticMarkup(
      React.createElement(EvidenceDetails, {
        evidence,
        ids: ['unknown', 'wait.marginSacrificedMonths'],
      }),
    ),
    '',
  );
});

test('SpendLab November minimum explains essential and daily spending before the later income', () => {
  const value = structuredClone(input);
  value.budget.values.monthlyIncomeCents = 200000;
  value.budget.values.monthlyEssentialExpensesCents = 100000;
  value.budget.values.monthlyDiscretionaryExpensesCents = 50000;
  value.budget.values.nextEssentialExpensesDate = '2026-11-01';
  value.budget.values.nextIncomeDate = '2026-11-01';
  value.reserveCents = 180000;
  value.resale = null;
  const calculation = calculateScenarios(value);
  const original = structuredClone(calculation);
  const minimum = timelineMoments(calculation, 'buy_now').find((moment) =>
    moment.labels.includes('Lowest balance in these 90 days'),
  )!;
  assert.equal(minimum.date, '2026-11-01');
  assert.equal(minimum.event?.kind, 'discretionary');
  assert.equal(minimum.balanceCents, 64461);
  const explanation = minimum.description;
  assert.match(
    explanation,
    /Planned essentials \(monthly total\): -€1,000\.00 \(€1,661\.27 → €661\.27\)/,
  );
  assert.match(
    explanation,
    /Daily share of planned discretionary spending: -€16\.66 \(€661\.27 → €644\.61\)/,
  );
  assert.match(explanation, /Later that day: Expected income: €2,000\.00 → €2,644\.61/);
  assert.ok(explanation.indexOf('Planned essentials') < explanation.indexOf('Daily share'));
  assert.ok(explanation.indexOf('Daily share') < explanation.indexOf('Expected income'));
  const html = render(value, 'buy_now');
  assert.match(html, /These operations come after the low/);
  const wait = calculation.scenarios[2];
  assert.ok(!wait.available && wait.reason === 'no_viable_date');
  assert.match(
    purchaseSummary(calculation),
    /Wait found no compatible purchase date within the next 60 days/,
  );
  const cards = renderToStaticMarkup(
    React.createElement(ScenarioCards, { calculation, selected: 'buy_now', onSelect: () => {} }),
  );
  assert.match(cards, /No compatible date/);
  assert.match(
    cards,
    /Wait found no purchase date that meets your chosen limits within the next 60 days/,
  );
  assert.deepEqual(calculation, original);
});

test('SpendLab merged minimum retains the full day sequence and the existing budget warning', () => {
  const value = structuredClone(input);
  value.budget.values.nextIncomeDate = '2026-10-18';
  value.budget.values.monthlyEssentialExpensesCents = 150000;
  value.reserveCents = 190000;
  const calculation = calculateScenarios(value);
  const minimum = timelineMoments(calculation, 'buy_now').find((moment) =>
    moment.labels.includes('Lowest balance in these 90 days'),
  )!;
  assert.equal(minimum.date, '2026-10-18');
  assert.match(minimum.description, /Operations leading to this low/);
  assert.match(minimum.description, /Later that day: Expected income/);
  assert.match(minimum.description, /Your budget also crosses this limit without buying/);
  assert.doesNotMatch(purchaseSummary(calculateScenarios(input)), /Wait found no compatible/);
});
