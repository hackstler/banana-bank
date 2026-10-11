import type {
  CalculationResult,
  Evidence,
  Projection,
  ProjectionEvent,
  ViewedScenarioId,
} from './contracts';

export const eventNames: Record<ProjectionEvent['kind'], string> = {
  essential: 'Planned essentials (monthly total)',
  discretionary: 'Daily share of planned discretionary spending',
  purchase: 'Purchase payment',
  resale: 'Expected sale proceeds',
  income: 'Expected income',
};
export const viewNames: Record<ViewedScenarioId, string> = {
  baseline: 'Without this purchase',
  buy_now: 'Buy now',
  sell_first: 'Sell first',
  wait: 'Wait',
};

export function selectedProjection(
  calculation: CalculationResult,
  selected: ViewedScenarioId,
): Projection {
  if (selected === 'baseline') return calculation.baseline;
  return (
    calculation.scenarios.find(
      (scenario): scenario is Projection => scenario.available && scenario.id === selected,
    ) ??
    calculation.scenarios.find(
      (scenario): scenario is Projection => scenario.available && scenario.id === 'buy_now',
    )!
  );
}

export type ProjectionProblem = {
  kind: 'cash_shortfall' | 'reserve_breach';
  date: string;
  day: number;
  event: ProjectionEvent | null;
  eventIndex: number | null;
  beforeBalanceCents: number;
  balanceCents: number;
  alsoWithoutPurchase: boolean;
};

// Reads the existing event order and balances. It neither schedules nor projects anything.
export function projectionInsight(calculation: CalculationResult, selected: ViewedScenarioId) {
  const projection = selectedProjection(calculation, selected);
  const purchase = projection.events.find((event) => event.kind === 'purchase');
  const purchaseBalanceCents = purchase?.balanceCents ?? null;
  let firstProblem: ProjectionProblem | null = null;
  const problem = (
    balance: number,
    date: string,
    before: number,
    event: ProjectionEvent | null,
    eventIndex: number | null,
  ): ProjectionProblem => {
    const kind = balance < 0 ? 'cash_shortfall' : 'reserve_breach';
    const day = projection.trajectory.findIndex((point) => point.date === date);
    const baseline = calculation.baseline.trajectory[day];
    return {
      kind,
      date,
      day,
      event,
      eventIndex,
      beforeBalanceCents: before,
      balanceCents: balance,
      alsoWithoutPurchase:
        baseline.minimumBalanceCents < (kind === 'cash_shortfall' ? 0 : calculation.reserveCents),
    };
  };
  if (
    calculation.startingBalanceCents < 0 ||
    (projection.id === 'baseline' && calculation.startingBalanceCents < calculation.reserveCents)
  ) {
    firstProblem = problem(
      calculation.startingBalanceCents,
      calculation.simulationStartDate,
      calculation.startingBalanceCents,
      null,
      null,
    );
  } else {
    let afterPurchase = projection.id === 'baseline';
    let before = calculation.startingBalanceCents;
    for (const [index, event] of projection.events.entries()) {
      if (event.kind === 'purchase') afterPurchase = true;
      if (
        event.balanceCents < 0 ||
        (afterPurchase && event.balanceCents < calculation.reserveCents)
      ) {
        firstProblem = problem(event.balanceCents, event.date, before, event, index);
        break;
      }
      before = event.balanceCents;
    }
  }
  return {
    projection,
    firstProblem,
    // The classification protects reserve from purchase onward. The UI must also disclose
    // budget problems before that date, without changing eligibility or recalculating money.
    firstBudgetProblem:
      calculation.startingBalanceCents < calculation.reserveCents ||
      calculation.startingBalanceCents < 0
        ? problem(
            calculation.startingBalanceCents,
            calculation.simulationStartDate,
            calculation.startingBalanceCents,
            null,
            null,
          )
        : (() => {
            const index = projection.events.findIndex(
              (event) => event.balanceCents < calculation.reserveCents || event.balanceCents < 0,
            );
            if (index < 0) return null;
            const event = projection.events[index];
            return problem(
              event.balanceCents,
              event.date,
              index === 0
                ? calculation.startingBalanceCents
                : projection.events[index - 1].balanceCents,
              event,
              index,
            );
          })(),
    purchaseBalanceCents,
    canPayAndKeepReserveAtPurchase:
      purchaseBalanceCents !== null &&
      purchaseBalanceCents >= 0 &&
      purchaseBalanceCents >= calculation.reserveCents,
  };
}

const metricLabels: Record<string, string> = {
  minimumBalanceCents: 'Lowest balance over 90 days',
  minimumAfterPurchaseCents: 'Lowest balance from purchase onward',
  finalBalanceCents: 'Balance at the end of 90 days',
  netOutlayCents: 'Purchase outlay (sale only if collected)',
  marginSacrificedMonths: 'Equivalent months of budget margin used',
  reserveGapCents: 'Difference from your chosen reserve',
  essentialCoverageMonths: 'Essential expenses covered by the lowest balance',
  'firstProblem.date': 'First projected problem',
  'firstProblem.balanceCents': 'Balance at that moment',
  'firstProblem.eventAmountCents': 'Payment causing that moment',
  'firstBudgetProblem.date': 'Earlier or current budget problem',
  'firstBudgetProblem.balanceCents': 'Balance at that budget problem',
};
export function describeEvidence(evidence: Evidence) {
  const [prefix, ...rest] = evidence.id.split('.');
  const metric = rest.join('.');
  const fixed: Record<string, string> = {
    'bank.startingBalanceCents': 'Current selected bank balance',
    'budget.monthlyMarginCents': 'Monthly budget margin',
    'purchase.amountCents': 'Declared purchase price',
    reserveCents: 'Your chosen reserve',
    'budget.suggestedReserveCents': 'Three-month reference suggestion',
  };
  const scenario = viewNames[prefix as ViewedScenarioId];
  const label =
    fixed[evidence.id] ??
    (scenario && metricLabels[metric]
      ? `${scenario} · ${metricLabels[metric]}`
      : evidence.id.startsWith('bank.activity.')
        ? `Observed bank ${evidence.id.endsWith('creditsCents') ? 'inflows' : 'outflows'}`
        : 'Supporting evidence');
  const cents = (value: number) =>
    new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(value / 100);
  let value: string;
  if (evidence.value === null) value = 'Not defined with this budget';
  else if (typeof evidence.value === 'string') value = evidence.value;
  else if (metric === 'reserveGapCents')
    value = `${cents(Math.abs(evidence.value))} ${evidence.value < 0 ? 'below' : evidence.value > 0 ? 'above' : 'at'} your reserve`;
  else if (evidence.id.endsWith('Months'))
    value = `${new Intl.NumberFormat('en-IE', { maximumFractionDigits: 2 }).format(evidence.value)} months`;
  else value = cents(evidence.value);
  return {
    label,
    value,
    sources: [...new Set(evidence.sources)]
      .map((source) =>
        source === 'bank'
          ? 'Bank records'
          : source === 'demo'
            ? 'Demo assumptions'
            : 'Your declarations',
      )
      .join(' + '),
  };
}
