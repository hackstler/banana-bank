import type { Evidence } from '../../../src/spend-lab/contracts';
import { describeEvidence } from '../../../src/spend-lab/insights';

export default function EvidenceDetails({
  evidence,
  ids,
  explanation = 'Figures cited for this conclusion.',
}: {
  evidence: Evidence[];
  ids: string[];
  explanation?: string;
}) {
  const rows = [...new Set(ids)]
    .map((id) => evidence.find((item) => item.id === id))
    .filter(
      (item): item is Evidence => !!item && item.value !== null && !item.id.endsWith('Months'),
    );
  if (rows.length === 0) return null;
  return (
    <details className="spend-lab-why">
      <summary>Why?</summary>
      <p>{explanation}</p>
      <dl>
        {rows.map((item) => {
          const row = describeEvidence(item);
          return (
            <div key={item.id}>
              <dt>{row.label}</dt>
              <dd>
                <strong>{row.value}</strong>
                <small>{row.sources}</small>
                {item.id.startsWith('bank.activity.') && <small>{item.meaning}</small>}
              </dd>
            </div>
          );
        })}
      </dl>
    </details>
  );
}
