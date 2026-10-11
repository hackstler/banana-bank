import type {
  CalculationResult,
  Projection,
  ViewedScenarioId,
} from '../../../src/spend-lab/contracts';
import { projectionInsight, eventNames, viewNames } from '../../../src/spend-lab/insights';
import { money, shortDate } from './form';

export const scenarioNames = viewNames;
export const scenarioColors = {
  buy_now: '#194f43',
  sell_first: '#96640c',
  wait: '#576fb1',
  baseline: '#9ba69a',
};

export function minimumMoment(projection: Projection) {
  const point = projection.trajectory.find(
    (day) => day.minimumBalanceCents === projection.minimumBalanceCents,
  )!;
  const index =
    point.openingBalanceCents === projection.minimumBalanceCents
      ? -1
      : projection.events.findIndex(
          (event) =>
            event.date === point.date && event.balanceCents === projection.minimumBalanceCents,
        );
  return {
    date: point.date,
    eventIndex: index < 0 ? null : index,
    event: index < 0 ? null : projection.events[index],
    balanceCents: projection.minimumBalanceCents,
  };
}

export function scenarioVerdict(calculation: CalculationResult, id: ViewedScenarioId) {
  const { projection, firstBudgetProblem } = projectionInsight(calculation, id);
  if (projection.financialClass === 'cash_shortfall')
    return 'Not enough money for planned payments';
  if (projection.financialClass === 'reserve_breach') return 'Below your safety cushion';
  return firstBudgetProblem
    ? 'Fits after buying · earlier budget risk'
    : 'Keeps your safety cushion';
}

export function purchaseSummary(calculation: CalculationResult) {
  const insight = projectionInsight(calculation, 'buy_now');
  const problem = insight.firstBudgetProblem;
  if (!problem)
    return 'Buying now keeps enough money for your planned payments and your chosen safety cushion over these 90 days, if your estimates hold.';
  const baseline = calculation.baseline.trajectory[problem.day].minimumBalanceCents;
  const dailyLow = insight.projection.trajectory[problem.day].minimumBalanceCents;
  const problemBalance = problem.event ? problem.balanceCents : dailyLow;
  const consequence =
    problem.kind === 'cash_shortfall'
      ? 'not enough to cover your planned payments'
      : `below your ${money(calculation.reserveCents)} safety cushion`;
  const start =
    insight.canPayAndKeepReserveAtPurchase && problem.date > calculation.simulationStartDate
      ? 'You can pay today, but'
      : 'If you buy now,';
  const existing = problem.alsoWithoutPurchase
    ? ` Without buying, your budget also crosses this limit that day${dailyLow < baseline ? `, but buying lowers the daily low from ${money(baseline)} to ${money(dailyLow)}` : ''}.`
    : '';
  const alternatives = calculation.scenarios.filter(
    (scenario) =>
      scenario.available &&
      scenario.id !== 'buy_now' &&
      scenario.financialClass === 'within_limits',
  );
  const alternativeText = alternatives.length
    ? ` ${alternatives.map((scenario) => scenarioNames[scenario.id]).join(' or ')} keeps your cushion from purchase onward${alternatives.some((scenario) => scenario.id === 'sell_first') ? ' (selling first depends on receiving payment)' : ''}.${alternatives.some((scenario) => projectionInsight(calculation, scenario.id).firstBudgetProblem) ? ' Earlier budget risks remain in some alternatives.' : ''}`
    : ' No available purchase alternative meets your chosen limits in this projection.';
  const wait = calculation.scenarios.find((scenario) => scenario.id === 'wait')!;
  const waitExplanation =
    !wait.available && wait.reason === 'no_viable_date'
      ? ' Wait found no compatible purchase date within the next 60 days.'
      : '';
  return `${start} on ${shortDate(problem.date)} your balance would reach ${money(problemBalance)}, ${consequence}.${existing}${alternativeText}${waitExplanation}`;
}

export function scenarioConclusion(calculation: CalculationResult, selected: ViewedScenarioId) {
  const { projection, firstBudgetProblem } = projectionInsight(calculation, selected);
  if (firstBudgetProblem) {
    if (projection.financialClass === 'within_limits')
      return `Buying on ${shortDate(projection.purchaseDate!)} fits from that point onward. Before buying, your budget still falls below your safety cushion. This timing does not fix that earlier problem.`;
    return selected === 'baseline'
      ? 'Your budget has a problem even without this purchase.'
      : 'Here is when this choice would put pressure on your money.';
  }
  return selected === 'baseline'
    ? 'Without this purchase, your planned payments and chosen safety cushion stay covered over these 90 days.'
    : `Buying on ${shortDate(projection.purchaseDate!)} keeps your planned payments and chosen safety cushion covered over these 90 days.${selected === 'sell_first' ? ' This depends on receiving the sale payment first.' : ''}`;
}

export type TimelineMoment = {
  date: string;
  eventIndex: number | null;
  event: Projection['events'][number] | null;
  balanceCents: number;
  labels: string[];
  description: string;
};

export function timelineMoments(
  calculation: CalculationResult,
  selected: ViewedScenarioId,
): TimelineMoment[] {
  const { projection, firstBudgetProblem, firstProblem } = projectionInsight(calculation, selected);
  if (!firstBudgetProblem) return [];
  const moments: TimelineMoment[] = [];
  function add(moment: TimelineMoment) {
    const same = moments.find(
      (item) => item.date === moment.date && item.eventIndex === moment.eventIndex,
    );
    if (same) {
      same.labels.push(...moment.labels.filter((label) => !same.labels.includes(label)));
      if (moment.description && !same.description.includes(moment.description))
        same.description = [same.description, moment.description].filter(Boolean).join(' ');
    } else moments.push(moment);
  }
  const purchaseIndex = projection.events.findIndex((event) => event.kind === 'purchase');
  if (purchaseIndex >= 0) {
    const event = projection.events[purchaseIndex];
    const resale = selected === 'sell_first' ? projection.events[purchaseIndex - 1] : null;
    add({
      date: event.date,
      eventIndex: purchaseIndex,
      event,
      balanceCents: event.balanceCents,
      labels: ['Purchase'],
      description: `${resale?.kind === 'resale' ? `Receive ${money(resale.amountCents)} from the sale first, then pay` : 'Pay'} ${money(-event.amountCents)} for the product.`,
    });
  }
  for (const problem of [firstBudgetProblem, firstProblem]) {
    if (!problem) continue;
    const beforePurchase =
      purchaseIndex >= 0 && (problem.eventIndex === null || problem.eventIndex < purchaseIndex);
    const baselineLow = calculation.baseline.trajectory[problem.day].minimumBalanceCents;
    const reason = problem.event
      ? `${eventNames[problem.event.kind]}: ${money(problem.event.amountCents)}. Balance ${money(problem.beforeBalanceCents)} → ${money(problem.balanceCents)}.`
      : 'Your starting bank balance is already below the chosen limit.';
    const comparison =
      problem.alsoWithoutPurchase && selected !== 'baseline'
        ? ` Your budget also crosses this limit without buying; its lowest balance that day is ${money(baselineLow)}.`
        : '';
    add({
      date: problem.date,
      eventIndex: problem.eventIndex,
      event: problem.event,
      balanceCents: problem.balanceCents,
      labels: [
        beforePurchase
          ? 'Budget problem before buying'
          : problem.kind === 'cash_shortfall'
            ? 'Not enough for planned payments'
            : 'Safety cushion crossed',
      ],
      description: `${reason}${comparison}`,
    });
  }
  const minimum = minimumMoment(projection);
  const day = projection.trajectory.find((point) => point.date === minimum.date)!;
  const dayEvents = projection.events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.date === minimum.date);
  const leading =
    minimum.eventIndex === null
      ? []
      : dayEvents.filter(({ index }) => index <= minimum.eventIndex!);
  const later = dayEvents.filter(
    ({ index }) => minimum.eventIndex === null || index > minimum.eventIndex,
  );
  const operations = leading
    .map(({ event, index }) => {
      const before =
        index === 0 ? calculation.startingBalanceCents : projection.events[index - 1].balanceCents;
      return `${eventNames[event.kind]}: ${money(event.amountCents)} (${money(before)} → ${money(event.balanceCents)})`;
    })
    .join('; ');
  const minimumDescription = `${operations ? `Operations leading to this low: ${operations}.` : `Starting bank balance: ${money(day.openingBalanceCents)}.`}${later.length ? ` Later that day: ${later.map(({ event }) => `${eventNames[event.kind]}: ${money(event.amountCents)} → ${money(event.balanceCents)}`).join('; ')}. These operations come after the low in this simulation.` : ''}`;
  const sameMoment = moments.find(
    (moment) => moment.date === minimum.date && moment.eventIndex === minimum.eventIndex,
  );
  if (sameMoment) {
    const baselineLow = calculation.baseline.trajectory.find(
      (point) => point.date === minimum.date,
    )!.minimumBalanceCents;
    const alsoWithoutBuying =
      selected !== 'baseline' &&
      baselineLow < (minimum.balanceCents < 0 ? 0 : calculation.reserveCents);
    sameMoment.description =
      minimumDescription +
      (alsoWithoutBuying
        ? ` Your budget also crosses this limit without buying; its lowest balance that day is ${money(baselineLow)}.`
        : '');
  }
  add({
    ...minimum,
    labels: [
      'Lowest balance in these 90 days',
      ...(minimum.balanceCents < 0 ? ['Not enough for planned payments'] : []),
    ],
    description: sameMoment ? '' : minimumDescription,
  });
  return moments.sort(
    (a, b) => a.date.localeCompare(b.date) || (a.eventIndex ?? -1) - (b.eventIndex ?? -1),
  );
}

export function recommendationEvidenceIds(
  calculation: CalculationResult,
  preferred: ViewedScenarioId | null,
) {
  if (!preferred) return ['purchase.amountCents', 'reserveCents'];
  const { projection, firstBudgetProblem } = projectionInsight(calculation, preferred);
  return [
    preferred === 'sell_first' ? 'sell_first.netOutlayCents' : 'purchase.amountCents',
    'reserveCents',
    `${preferred}.${projection.purchaseDate ? 'minimumAfterPurchaseCents' : 'minimumBalanceCents'}`,
    ...(firstBudgetProblem
      ? [`${preferred}.firstBudgetProblem.date`, `${preferred}.firstBudgetProblem.balanceCents`]
      : []),
  ];
}
