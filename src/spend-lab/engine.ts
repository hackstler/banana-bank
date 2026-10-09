import { calculationInputSchema } from './contracts';
import type {
  CalculationInput,
  CalculationResult,
  Projection,
  ProjectionEvent,
  Scenario,
} from './contracts';
import { addDays, daysInMonth, HORIZON_DAYS, MAX_WAIT_DAYS, monthlyOccurrence } from './dates';

type ScheduledEvent = Pick<ProjectionEvent, 'kind' | 'amountCents' | 'source'>;

function safe(value: number): number {
  if (!Number.isSafeInteger(value))
    throw new RangeError('Projected money must remain a safe integer');
  return value;
}

function budgetEvents(input: CalculationInput, end: string): Map<string, ScheduledEvent[]> {
  const schedule = new Map<string, ScheduledEvent[]>();
  const budget = input.budget.values;
  const source = input.budget.source;
  const add = (date: string, event: ScheduledEvent) => {
    if (event.amountCents !== 0) schedule.set(date, [...(schedule.get(date) ?? []), event]);
  };
  for (const [anchor, amount, kind] of [
    [budget.nextEssentialExpensesDate, -budget.monthlyEssentialExpensesCents, 'essential'],
    [budget.nextIncomeDate, budget.monthlyIncomeCents, 'income'],
  ] as const) {
    if (anchor === null) continue;
    for (let offset = 0; ; offset++) {
      const date = monthlyOccurrence(anchor, offset);
      if (date > end) break;
      add(date, { kind, amountCents: amount, source });
    }
  }
  for (let day = 0; day <= HORIZON_DAYS; day++) {
    const date = addDays(input.simulationStartDate, day);
    const days = daysInMonth(date);
    const dayOfMonth = Number(date.slice(8, 10));
    const monthly = budget.monthlyDiscretionaryExpensesCents;
    const amount = Math.floor(monthly / days) + (dayOfMonth > days - (monthly % days) ? 1 : 0);
    add(date, { kind: 'discretionary', amountCents: -amount, source });
  }
  return schedule;
}

function project(
  input: CalculationInput,
  schedule: Map<string, ScheduledEvent[]>,
  id: Projection['id'],
  purchaseDate: string | null,
  monthlyMargin: number,
  baseline?: Projection,
): Projection {
  let balance = input.startingBalanceCents;
  let minimum = balance;
  let minimumAfterPurchase: number | null = null;
  const events: ProjectionEvent[] = [];
  const trajectory: Projection['trajectory'] = [];
  for (let day = 0; day <= HORIZON_DAYS; day++) {
    const date = addDays(input.simulationStartDate, day);
    const opening = balance;
    let dailyMinimum = balance;
    const apply = (event: ScheduledEvent) => {
      balance = safe(balance + event.amountCents);
      minimum = Math.min(minimum, balance);
      dailyMinimum = Math.min(dailyMinimum, balance);
      if (minimumAfterPurchase !== null)
        minimumAfterPurchase = Math.min(minimumAfterPurchase, balance);
      events.push({ date, ...event, balanceCents: balance });
    };
    const planned = schedule.get(date) ?? [];
    for (const event of planned.filter((event) => event.kind !== 'income')) apply(event);
    if (date === purchaseDate) {
      if (id === 'sell_first' && input.resale)
        apply({ kind: 'resale', amountCents: input.resale.amountCents, source: 'user' });
      apply({ kind: 'purchase', amountCents: -input.purchase.amountCents, source: 'user' });
      minimumAfterPurchase = balance;
    }
    for (const event of planned.filter((event) => event.kind === 'income')) apply(event);
    trajectory.push({
      date,
      openingBalanceCents: opening,
      closingBalanceCents: balance,
      minimumBalanceCents: dailyMinimum,
    });
  }
  const protectedMinimum = minimumAfterPurchase ?? minimum;
  const financialClass =
    minimum < 0
      ? 'cash_shortfall'
      : protectedMinimum < input.reserveCents
        ? 'reserve_breach'
        : 'within_limits';
  const netOutlay =
    purchaseDate === null
      ? 0
      : input.purchase.amountCents - (id === 'sell_first' ? input.resale!.amountCents : 0);
  const preexistingCashShortfall = (baseline?.minimumBalanceCents ?? minimum) < 0;
  const preexistingReserveBreach = (baseline?.minimumBalanceCents ?? minimum) < input.reserveCents;
  return {
    available: true,
    id,
    purchaseDate,
    events,
    trajectory,
    minimumBalanceCents: minimum,
    minimumAfterPurchaseCents: minimumAfterPurchase,
    finalBalanceCents: balance,
    financialClass,
    flags: {
      preexistingCashShortfall,
      preexistingReserveBreach,
      addedCashShortfall: minimum < 0 && !preexistingCashShortfall,
      addedReserveBreach: protectedMinimum < input.reserveCents && !preexistingReserveBreach,
      dependsOnResale: id === 'sell_first',
    },
    metrics: {
      netOutlayCents: netOutlay,
      marginSacrificedMonths: monthlyMargin > 0 ? Math.max(0, netOutlay) / monthlyMargin : null,
      reserveGapCents: safe(protectedMinimum - input.reserveCents),
      essentialCoverageMonths:
        input.budget.values.monthlyEssentialExpensesCents > 0
          ? Math.max(0, protectedMinimum) / input.budget.values.monthlyEssentialExpensesCents
          : null,
    },
  };
}

// Pure shared engine: no bank requests, model calls, documentary clock or persistence.
export function calculateScenarios(rawInput: CalculationInput): CalculationResult {
  const input = calculationInputSchema(rawInput.simulationStartDate).parse(rawInput);
  const horizonEnd = addDays(input.simulationStartDate, HORIZON_DAYS);
  const budget = input.budget.values;
  const monthlyMarginCents = safe(
    budget.monthlyIncomeCents -
      budget.monthlyEssentialExpensesCents -
      budget.monthlyDiscretionaryExpensesCents,
  );
  const schedule = budgetEvents(input, horizonEnd);
  const baseline = project(input, schedule, 'baseline', null, monthlyMarginCents);
  const buy = project(
    input,
    schedule,
    'buy_now',
    input.simulationStartDate,
    monthlyMarginCents,
    baseline,
  );
  const sell: Scenario = input.resale
    ? project(input, schedule, 'sell_first', input.resale.date, monthlyMarginCents, baseline)
    : { id: 'sell_first', available: false, purchaseDate: null, reason: 'no_resale' };
  let wait: Scenario = {
    id: 'wait',
    available: false,
    purchaseDate: null,
    reason: 'no_viable_date',
  };
  for (let day = 1; day <= MAX_WAIT_DAYS; day++) {
    const candidate = project(
      input,
      schedule,
      'wait',
      addDays(input.simulationStartDate, day),
      monthlyMarginCents,
      baseline,
    );
    if (candidate.financialClass === 'within_limits') {
      wait = candidate;
      break;
    }
  }
  return {
    simulationStartDate: input.simulationStartDate,
    horizonEnd,
    startingBalanceCents: input.startingBalanceCents,
    startingBalanceSource: 'bank',
    budgetSource: input.budget.source,
    budgetVersion: input.budget.version,
    monthlyMarginCents,
    reserveCents: input.reserveCents,
    suggestedReserveCents: safe(budget.monthlyEssentialExpensesCents * 3),
    baseline,
    scenarios: [buy, sell, wait],
  };
}
