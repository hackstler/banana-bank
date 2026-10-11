import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Match the JSX runtime used by the existing presentation tests.
Object.assign(globalThis, { React });
const { default: TransferApprovals } = await import('../app/components/TransferApprovals');

const render = (approvals: Record<string, any>[]) =>
  renderToStaticMarkup(
    React.createElement(TransferApprovals, {
      approvals,
      renderApproval: (approval) => React.createElement('p', { key: approval.id }, approval.id),
    }),
  );

test('Transfers renders manual proposals without leaking proposals from any conversation', () => {
  const approvals = [
    { id: 'chat-first', conversationId: 'conversation-first' },
    { id: 'manual-transfer', conversationId: null },
    { id: 'chat-second', conversationId: 'conversation-second' },
  ];
  const html = render(approvals);
  assert.match(html, /Proposals awaiting confirmation/);
  assert.match(html, /manual-transfer/);
  assert.doesNotMatch(html, /chat-first|chat-second/);
  assert.equal(approvals.length, 3);
});

test('Transfers has no pending panel when only chat proposals remain or all proposals are resolved', () => {
  assert.equal(render([{ id: 'chat-only', conversationId: 'conversation-first' }]), '');
  assert.equal(render([]), '');
});
