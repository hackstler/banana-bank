import type { ReactNode } from 'react';

type Approval = Record<string, any>;

export default function TransferApprovals({
  approvals,
  renderApproval,
}: {
  approvals: Approval[];
  renderApproval: (approval: Approval) => ReactNode;
}) {
  const manualApprovals = approvals.filter((approval) => approval.conversationId === null);
  if (manualApprovals.length === 0) return null;

  return (
    <section className="panel approvals">
      <h2>Proposals awaiting confirmation</h2>
      {manualApprovals.map(renderApproval)}
    </section>
  );
}
