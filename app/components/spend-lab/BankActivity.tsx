import type { SpendLabContext } from '../../../src/spend-lab/contracts';
import { selectBudgetEvidence } from '../../../src/spend-lab/activity';
import { money, shortDate } from './form';

export default function BankActivity({
  context,
  accountIds,
}: {
  context: SpendLabContext;
  accountIds: string[];
}) {
  const evidence = selectBudgetEvidence(context.budgetEvidence, accountIds);
  return (
    <section className="spend-lab-bank-evidence" aria-label="Observed bank activity">
      <div className="spend-lab-section-heading">
        <h3>Observed bank activity</h3>
        <span className="spend-lab-tag">Bank records</span>
      </div>
      {evidence.status === 'unavailable' ? (
        <p>No observed activity available. You can still declare your budget.</p>
      ) : !accountIds.length ? (
        <p>Choose accounts to see their observed inflows and outflows.</p>
      ) : !evidence.groups.length ? (
        <p>
          No movements observed for these accounts in the returned history. This does not mean you
          have no expenses.
        </p>
      ) : (
        <div className="spend-lab-evidence-scroll">
          <table>
            <caption>Observed totals, not monthly forecasts</caption>
            <thead>
              <tr>
                <th scope="col">Month / account</th>
                <th scope="col">In</th>
                <th scope="col">Out</th>
              </tr>
            </thead>
            <tbody>
              {evidence.groups.map((group) => (
                <tr key={`${group.accountId}-${group.month}`}>
                  <th scope="row">
                    {group.month}
                    <small>
                      {context.accounts.find((account) => account.id === group.accountId)?.label}
                    </small>
                    <small>
                      {group.movementCount} movements · {shortDate(group.from)}–
                      {shortDate(group.to)}
                    </small>
                  </th>
                  <td>{money(group.creditsCents)}</td>
                  <td>{money(group.debitsCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="spend-lab-help">
        Up to 100 movements across all your accounts; months may be incomplete or old. Totals can
        include openings and transfers. They do not identify salary or spending categories.
      </p>
      {evidence.coverage.mayBeTruncated && (
        <p className="spend-lab-help">
          The bank returned its limit of 100. Earlier activity, including activity for your selected
          accounts, may be missing.
        </p>
      )}
    </section>
  );
}
