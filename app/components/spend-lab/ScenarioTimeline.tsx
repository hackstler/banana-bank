import { useId } from 'react';
import type { CalculationResult, ViewedScenarioId } from '../../../src/spend-lab/contracts';
import { money, shortDate } from './form';
import { scenarioNames, scenarioConclusion, timelineMoments } from './presentation';

export default function ScenarioTimeline({
  calculation,
  selected,
  onSelect,
}: {
  calculation: CalculationResult;
  selected: ViewedScenarioId;
  onSelect: (id: ViewedScenarioId) => void;
}) {
  const id = useId();
  const moments = timelineMoments(calculation, selected);
  // The short answer above the cards already covers a safe buy-now choice.
  if (selected === 'buy_now' && moments.length === 0) return null;
  const alternatives =
    selected === 'buy_now' && moments.length
      ? calculation.scenarios.filter(
          (scenario) =>
            scenario.available &&
            scenario.id !== 'buy_now' &&
            scenario.financialClass === 'within_limits',
        )
      : [];
  return (
    <section className="spend-lab-consequences" aria-labelledby={id} aria-live="polite">
      <span className="eyebrow">{scenarioNames[selected]} · WHAT HAPPENS NEXT</span>
      <h2 id={id}>{scenarioConclusion(calculation, selected)}</h2>
      {moments.length > 0 && (
        <ol
          className="spend-lab-moments"
          aria-label={`${scenarioNames[selected]} relevant moments`}
        >
          {moments.map((moment) => (
            <li
              key={`${moment.date}-${moment.eventIndex}`}
              className={
                moment.labels.some((label) => /crossed|problem|Not enough/.test(label))
                  ? 'spend-lab-moment-risk'
                  : ''
              }
            >
              <time dateTime={moment.date}>{shortDate(moment.date)}</time>
              <div>
                <h3>{moment.labels.join(' · ')}</h3>
                <strong>{money(moment.balanceCents)}</strong>
                {moment.description && <p>{moment.description}</p>}
              </div>
            </li>
          ))}
        </ol>
      )}
      {alternatives.length > 0 && (
        <div className="spend-lab-timeline-alternatives">
          <h3>Compare a different timing</h3>
          {alternatives.map((scenario) => {
            if (!scenario.available) return null;
            return (
              <button
                type="button"
                className="secondary-button"
                key={scenario.id}
                onClick={() => onSelect(scenario.id)}
              >
                View {scenarioNames[scenario.id]} ↗
              </button>
            );
          })}
        </div>
      )}
      <p className="spend-lab-help">
        Based on your estimates over 90 days. Scheduled expenses are budget assumptions, not
        verified bank charges.
        {moments.length > 0 &&
          ' Low balances include moments before income arrives, even if the day ends higher.'}
      </p>
    </section>
  );
}
