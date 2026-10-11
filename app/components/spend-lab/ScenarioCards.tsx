import type { CalculationResult, ViewedScenarioId } from '../../../src/spend-lab/contracts';
import type { CSSProperties } from 'react';
import { money, shortDate } from './form';
import { scenarioNames, scenarioColors, minimumMoment, scenarioVerdict } from './presentation';

export default function ScenarioCards({
  calculation,
  selected,
  onSelect,
}: {
  calculation: CalculationResult;
  selected: ViewedScenarioId;
  onSelect: (id: ViewedScenarioId) => void;
}) {
  return (
    <>
      <div className="spend-lab-scenarios" aria-label="Choose a scenario to inspect">
        {calculation.scenarios.map((scenario) => (
          <button
            type="button"
            key={scenario.id}
            disabled={!scenario.available}
            className={`spend-lab-scenario ${scenario.available && selected === scenario.id ? 'spend-lab-selected' : ''}`}
            style={{ '--scenario-color': scenarioColors[scenario.id] } as CSSProperties}
            aria-pressed={scenario.available && selected === scenario.id}
            onClick={() => onSelect(scenario.id)}
          >
            <span className="spend-lab-scenario-title">
              <i />
              {scenarioNames[scenario.id]} <span aria-hidden="true">↗</span>
            </span>
            {scenario.available ? (
              <>
                <span className={`spend-lab-verdict spend-lab-${scenario.financialClass}`}>
                  {scenarioVerdict(calculation, scenario.id)}
                </span>
                <span className="spend-lab-help">Buy on {shortDate(scenario.purchaseDate!)}</span>
                <strong className="spend-lab-scenario-min">
                  {money(scenario.minimumBalanceCents)}
                </strong>
                <span className="spend-lab-help">
                  Lowest in 90 days · {shortDate(minimumMoment(scenario).date)}
                </span>
                <small className="spend-lab-scenario-detail">
                  {scenario.id === 'sell_first'
                    ? 'Depends on selling and receiving payment first.'
                    : scenario.id === 'wait'
                      ? 'First date that fits after buying. Earlier budget risks can remain.'
                      : 'Pay today, without counting on a sale.'}
                </small>
              </>
            ) : (
              <>
                <strong>
                  {scenario.reason === 'no_viable_date' ? 'No compatible date' : 'Unavailable'}
                </strong>
                <span className="spend-lab-help">
                  {scenario.reason === 'no_resale'
                    ? 'Declare a sale and payment date to compare.'
                    : 'Wait found no purchase date that meets your chosen limits within the next 60 days.'}
                </span>
              </>
            )}
          </button>
        ))}
      </div>
      <button
        type="button"
        className="secondary-button spend-lab-baseline-button"
        aria-pressed={selected === 'baseline'}
        onClick={() => onSelect('baseline')}
      >
        {selected === 'baseline' ? 'Viewing: ' : 'Compare: '}Without this purchase
      </button>
    </>
  );
}
