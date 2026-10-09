import { useId, useState } from 'react';
import type { CalculationResult, Projection, ScenarioId } from '../../../src/spend-lab/contracts';
import { money, shortDate } from './form';

export const scenarioNames = {
  buy_now: 'Buy now',
  sell_first: 'Sell first',
  wait: 'Wait',
  baseline: 'Without this purchase',
};
export const scenarioColors = {
  buy_now: '#194f43',
  sell_first: '#96640c',
  wait: '#576fb1',
  baseline: '#9ba69a',
};
export const classNames = {
  within_limits: 'Within your limits',
  reserve_breach: 'Reserve compromised',
  cash_shortfall: 'Cash shortfall',
};
const width = 920,
  height = 310,
  left = 78,
  right = 20,
  top = 24,
  bottom = 40;

export default function ScenarioChart({
  calculation,
  selected,
}: {
  calculation: CalculationResult;
  selected: ScenarioId;
}) {
  const id = useId();
  const [day, setDay] = useState(0);
  const projections = [
    calculation.baseline,
    ...calculation.scenarios.filter((scenario): scenario is Projection => scenario.available),
  ];
  const values = projections.flatMap((projection) => [
    calculation.startingBalanceCents,
    ...projection.events.map((event) => event.balanceCents),
  ]);
  const low = Math.min(0, ...values),
    high = Math.max(calculation.reserveCents, ...values);
  const pad = Math.max(1000, (high - low) * 0.08);
  const min = low - pad,
    max = high + pad;
  const x = (index: number) => left + (index / 90) * (width - left - right);
  const y = (amount: number) => top + ((max - amount) / (max - min)) * (height - top - bottom);
  const current = projections.find((projection) => projection.id === selected) ?? projections[1];
  const balance = current.trajectory[day];
  function path(projection: Projection): string {
    let d = `M ${x(0)} ${y(calculation.startingBalanceCents)}`;
    const events = new Map<string, number[]>();
    for (const event of projection.events)
      events.set(event.date, [...(events.get(event.date) ?? []), event.balanceCents]);
    for (const [index, point] of projection.trajectory.entries()) {
      d += ` H ${x(index)}`;
      for (const amount of events.get(point.date) ?? []) d += ` V ${y(amount)}`;
    }
    return d;
  }
  return (
    <section className="spend-lab-chart" aria-labelledby={`${id}-heading`}>
      <div className="spend-lab-section-heading">
        <div>
          <span className="eyebrow">YOUR NEXT 90 DAYS</span>
          <h2 id={`${id}-heading`}>One purchase. Three possible futures.</h2>
        </div>
        <span className="spend-lab-tag">
          {shortDate(calculation.simulationStartDate)} — {shortDate(calculation.horizonEnd)}
        </span>
      </div>
      <div className="spend-lab-legend">
        {projections.map((projection) => (
          <span key={projection.id}>
            <i style={{ background: scenarioColors[projection.id] }} />
            {scenarioNames[projection.id]}
          </span>
        ))}
        <span>
          <i className="spend-lab-reserve-key" />
          Chosen reserve
        </span>
      </div>
      <div className="spend-lab-plot">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-labelledby={`${id}-title ${id}-description`}
          onPointerMove={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            const svgX = ((event.clientX - rect.left) / rect.width) * width;
            setDay(
              Math.max(0, Math.min(90, Math.round(((svgX - left) / (width - left - right)) * 90))),
            );
          }}
        >
          <title id={`${id}-title`}>Projected bank balances, including intraday lows</title>
          <desc id={`${id}-description`}>
            Three alternatives share the same scale. The dashed reserve is{' '}
            {money(calculation.reserveCents)}. Use the day slider below to inspect balances; the
            scenario cards provide dates and lowest balances.
          </desc>
          {[0, 1, 2, 3].map((tick) => {
            const amount = low + (tick / 3) * (high - low);
            return (
              <g key={tick}>
                <line x1={left} x2={width - right} y1={y(amount)} y2={y(amount)} stroke="#e5e9df" />
                <text x={left - 12} y={y(amount) + 4} textAnchor="end">
                  {new Intl.NumberFormat('en-IE', {
                    style: 'currency',
                    currency: 'EUR',
                    maximumFractionDigits: 0,
                  }).format(amount / 100)}
                </text>
              </g>
            );
          })}
          <rect
            x={left}
            y={y(calculation.reserveCents)}
            width={width - left - right}
            height={Math.max(0, y(0) - y(calculation.reserveCents))}
            fill="#f5d94b"
            opacity=".09"
          />
          <line
            x1={left}
            x2={width - right}
            y1={y(calculation.reserveCents)}
            y2={y(calculation.reserveCents)}
            stroke="#9b8050"
            strokeDasharray="6 5"
          />
          {projections
            .sort((a, b) => Number(a.id === selected) - Number(b.id === selected))
            .map((projection) => (
              <path
                key={projection.id}
                d={path(projection)}
                fill="none"
                stroke={scenarioColors[projection.id]}
                strokeWidth={projection.id === selected ? 3 : 1.8}
                opacity={projection.id === selected || projection.id === 'baseline' ? 1 : 0.45}
                strokeDasharray={projection.id === 'baseline' ? '4 5' : undefined}
              />
            ))}
          {[0, 30, 60, 90].map((index) => (
            <text
              key={index}
              x={x(index)}
              y={height - 12}
              textAnchor={index === 0 ? 'start' : index === 90 ? 'end' : 'middle'}
            >
              {shortDate(calculation.baseline.trajectory[index].date)}
            </text>
          ))}
          <line
            x1={x(day)}
            x2={x(day)}
            y1={top}
            y2={height - bottom}
            stroke="#879585"
            strokeDasharray="3 4"
          />
          <circle
            cx={x(day)}
            cy={y(balance.closingBalanceCents)}
            r="5"
            fill={scenarioColors[current.id]}
            stroke="white"
            strokeWidth="2"
          />
        </svg>
      </div>
      <div className="spend-lab-inspection" aria-live="polite" aria-atomic="true">
        <strong>
          {shortDate(balance.date)} · {scenarioNames[current.id]}
        </strong>
        <span>
          Lowest that day <b>{money(balance.minimumBalanceCents)}</b>
        </span>
        <span>
          Day-end balance <b>{money(balance.closingBalanceCents)}</b>
        </span>
      </div>
      <label className="spend-lab-timeline">
        Explore a day
        <input
          type="range"
          min="0"
          max="90"
          value={day}
          onChange={(event) => setDay(Number(event.target.value))}
          aria-label="Explore a projection day"
          aria-valuetext={`${shortDate(balance.date)}, lowest balance ${money(balance.minimumBalanceCents)}`}
        />
        <span>
          <small>Today</small>
          <small>In 90 days</small>
        </span>
      </label>
    </section>
  );
}
