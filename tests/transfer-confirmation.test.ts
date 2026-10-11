import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

Object.assign(globalThis, { React });
const { default: TransferApprovals } = await import('../app/components/TransferApprovals');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-confirmation-'));
process.env.DATA_DIR = temp;
process.env.BANK_DATA_DIR = temp;
let bank: ChildProcess | undefined;
const probe = net.createServer();
await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
const port = (probe.address() as net.AddressInfo).port;
await new Promise<void>((resolve, reject) =>
  probe.close((error) => (error ? reject(error) : resolve())),
);
process.env.BANK_PORT = String(port);
process.env.BANK_URL = `http://127.0.0.1:${port}`;

const { config } = await import('../src/config');
const { appDb, closeAppDb } = await import('../src/db');
const { sessionToken, HttpError } = await import('../src/auth');
const { bankRequest, BankError } = await import('../src/banking/client');
const { authorizeTransfer } = await import('../src/banking/authorization');
const { POST, GET } = await import('../app/api/[...path]/route');
const { runTool } = await import('../src/agent/tools');
const input = {
  fromAccountId: 'acc-ines',
  toAccountId: 'acc-carla',
  amountCents: 1000,
  concept: 'test',
};

async function api(route: string, body?: unknown, userId = 'ines') {
  const response = await (body === undefined ? GET : POST)(
    new Request(`http://localhost/api/${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: `banana_actor=${sessionToken(userId)}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve({ path: route.split('/') }) },
  );
  return { status: response.status, data: await response.json() };
}

before(async () => {
  appDb();
  bank = spawn(process.execPath, ['--import', 'tsx', 'simulator/server.ts'], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Test bank startup timed out.')), 10000);
    bank!.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    bank!.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Test bank exited: ${code}`));
    });
    bank!.stderr!.on('data', (chunk) => process.stderr.write(chunk));
    bank!.stdout!.on('data', (chunk) => {
      if (String(chunk).includes('Simulated bank:')) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
  const response = await fetch(`${config.bankUrl}/admin/scenario`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.adminSecret}` },
    body: JSON.stringify({ profile: 'normal' }),
  });
  assert.equal(response.status, 200);
});

test('normal: no bank effects until the customer confirms the reviewed proposal', async () => {
  const conversation = await api('conversations', {});
  const otherConversation = await api('conversations', {});
  const before = await api('dashboard');
  const destinationBefore = await bankRequest<any[]>('carla', '/v1/accounts');
  const operationsBefore = await bankRequest<any>('marta', '/v1/operator/customer?id=ines');
  assert.equal(before.status, 200);
  const proposal = await api('actions', {
    name: 'transfer_money',
    arguments: input,
    intentId: 'confirmation-api',
    conversationId: conversation.data.id,
  });
  const pending = await api('dashboard');
  const intent = appDb().prepare('SELECT * FROM intents WHERE id=?').get('confirmation-api') as any;
  console.log(
    'confirmation.evidence',
    JSON.stringify({
      profile: 'normal',
      phase: 'before-confirmation',
      result: proposal.data,
      intent,
      balanceBefore: before.data.accounts[0].balanceCents,
      balanceAfter: pending.data.accounts[0].balanceCents,
      newMovements: pending.data.movements.filter(
        (m: any) => !before.data.movements.some((old: any) => old.id === m.id),
      ),
    }),
  );
  assert.equal(proposal.status, 200);
  assert.equal(proposal.data.status, 'requires_confirmation');
  assert.deepEqual(pending.data.accounts, before.data.accounts);
  assert.deepEqual(pending.data.movements, before.data.movements);
  assert.equal(intent.status, 'requires_confirmation');
  assert.equal(intent.operation_id, null);
  const approval = pending.data.approvals.find((a: any) => a.id === proposal.data.approvalId);
  assert.ok(approval);
  assert.deepEqual(approval.payload, input);
  assert.equal(approval.conversationId, conversation.data.id);
  assert.equal(approval.runId, intent.run_id);
  assert.deepEqual((await api(`conversations/${conversation.data.id}`)).data.messages, []);
  await assert.rejects(
    bankRequest('ines', `/v1/operations/${intent.bank_reference}`),
    (error: unknown) => error instanceof BankError && error.status === 404,
  );

  const confirmed = await api(`approvals/${approval.id}/confirm`, {});
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.data.status, 'completed');
  const after = await api('dashboard');
  const operation = await bankRequest<any>('ines', `/v1/operations/${intent.bank_reference}`);
  console.log(
    'confirmation.evidence',
    JSON.stringify({
      profile: 'normal',
      phase: 'after-confirmation',
      result: confirmed.data,
      operation,
      accounts: after.data.accounts,
    }),
  );
  assert.equal(operation.id, confirmed.data.operation.id);
  for (const key of Object.keys(input) as (keyof typeof input)[])
    assert.equal(operation[key], input[key]);
  assert.equal(after.data.accounts[0].balanceCents, before.data.accounts[0].balanceCents - 1000);
  assert.equal(after.data.movements.filter((m: any) => m.operationId === operation.id).length, 1);
  const newMovements = after.data.movements.filter(
    (m: any) => !before.data.movements.some((old: any) => old.id === m.id),
  );
  assert.equal(newMovements.length, 1);
  assert.equal(newMovements[0].amountCents, -1000);
  const destinationAfter = await bankRequest<any[]>('carla', '/v1/accounts');
  assert.equal(
    destinationAfter.find((a) => a.id === input.toAccountId).balanceCents,
    destinationBefore.find((a) => a.id === input.toAccountId).balanceCents + 1000,
  );
  const operationsAfter = await bankRequest<any>('marta', '/v1/operator/customer?id=ines');
  assert.equal(operationsAfter.operations.length, operationsBefore.operations.length + 1);
  const destinationMovements = await bankRequest<any[]>('carla', '/v1/movements');
  const credit = destinationMovements.filter((m) => m.operationId === operation.id);
  assert.equal(credit.length, 1);
  assert.equal(credit[0].amountCents, 1000);
  assert.ok(!after.data.approvals.some((a: any) => a.id === approval.id));
  const history = await api(`conversations/${conversation.data.id}`);
  assert.equal(history.data.messages.length, 1);
  assert.equal(history.data.messages[0].role, 'assistant');
  assert.match(history.data.messages[0].content, /Transfer completed/);
  assert.ok(history.data.messages[0].content.includes(operation.reference));
  assert.deepEqual(
    (await api(`conversations/${conversation.data.id}`)).data.messages,
    history.data.messages,
  );
  assert.deepEqual((await api(`conversations/${otherConversation.data.id}`)).data.messages, []);
});

test('manual and agent proposals stay separate through dashboard refresh, cancellation and confirmation', async () => {
  const first = (await api('conversations', {})).data.id;
  const second = (await api('conversations', {})).data.id;
  const before = await api('dashboard');
  const manual = await api('actions', {
    name: 'transfer_money',
    arguments: { ...input, concept: 'manual-scope' },
    intentId: 'manual-scope',
    conversationId: null,
  });
  const cancelledChat = (await runTool('transfer_money', input, {
    userId: 'ines',
    conversationId: first,
    runId: 'chat-scope-cancel',
    intentId: 'chat-scope-cancel',
  })) as any;
  const confirmedChat = (await runTool('transfer_money', input, {
    userId: 'ines',
    conversationId: second,
    runId: 'chat-scope-confirm',
    intentId: 'chat-scope-confirm',
  })) as any;
  assert.equal(manual.data.status, 'requires_confirmation');
  assert.equal(cancelledChat.status, 'requires_confirmation');
  assert.equal(confirmedChat.status, 'requires_confirmation');

  const renderPending = (approvals: Record<string, any>[]) =>
    renderToStaticMarkup(
      React.createElement(TransferApprovals, {
        approvals,
        renderApproval: (approval) => React.createElement('p', { key: approval.id }, approval.id),
      }),
    );
  const pending = await api('dashboard');
  assert.deepEqual(pending.data.accounts, before.data.accounts);
  assert.equal(
    pending.data.approvals.find((a: any) => a.id === manual.data.approvalId).conversationId,
    null,
  );
  assert.deepEqual(
    pending.data.approvals.filter((a: any) => a.conversationId === first).map((a: any) => a.id),
    [cancelledChat.approvalId],
  );
  assert.deepEqual(
    pending.data.approvals.filter((a: any) => a.conversationId === second).map((a: any) => a.id),
    [confirmedChat.approvalId],
  );
  const html = renderPending(pending.data.approvals);
  assert.ok(html.includes(manual.data.approvalId));
  assert.ok(!html.includes(cancelledChat.approvalId));
  assert.ok(!html.includes(confirmedChat.approvalId));

  assert.equal(
    (await api(`approvals/${cancelledChat.approvalId}/cancel`, {})).data.status,
    'cancelled',
  );
  const afterCancel = await api('dashboard');
  assert.deepEqual(afterCancel.data.accounts, before.data.accounts);
  assert.ok(!afterCancel.data.approvals.some((a: any) => a.id === cancelledChat.approvalId));
  assert.equal(renderPending(afterCancel.data.approvals), html);
  assert.match(
    (await api(`conversations/${first}`)).data.messages[0].content,
    /proposal cancelled/,
  );

  assert.equal(
    (await api(`approvals/${confirmedChat.approvalId}/confirm`, {})).data.status,
    'completed',
  );
  const afterConfirm = await api('dashboard');
  assert.ok(!afterConfirm.data.approvals.some((a: any) => a.id === confirmedChat.approvalId));
  assert.equal(renderPending(afterConfirm.data.approvals), html);
  assert.equal(
    afterConfirm.data.accounts[0].balanceCents,
    before.data.accounts[0].balanceCents - input.amountCents,
  );
  const secondHistory = (await api(`conversations/${second}`)).data.messages;
  assert.match(secondHistory[0].content, /Transfer completed/);

  assert.equal(
    (await api(`approvals/${manual.data.approvalId}/cancel`, {})).data.status,
    'cancelled',
  );
  const afterManualCancel = await api('dashboard');
  assert.deepEqual(afterManualCancel.data.accounts, afterConfirm.data.accounts);
  assert.ok(!renderPending(afterManualCancel.data.approvals).includes(manual.data.approvalId));
  assert.deepEqual((await api(`conversations/${second}`)).data.messages, secondHistory);
});

test('agent transfer tool proposes without executing; model arguments cannot supply approval', async () => {
  const before = await bankRequest('ines', '/v1/accounts');
  const result = (await runTool('transfer_money', input, {
    userId: 'ines',
    conversationId: null,
    runId: 'agent-proposal',
    intentId: 'agent-proposal',
  })) as any;
  assert.equal(result.status, 'requires_confirmation');
  assert.deepEqual(await bankRequest('ines', '/v1/accounts'), before);
  const forged = await api('actions', {
    name: 'transfer_money',
    arguments: { ...input, approvalId: result.approvalId },
    intentId: 'forged-approval',
  });
  assert.equal(forged.data.status, 'failed');
  assert.deepEqual(await bankRequest('ines', '/v1/accounts'), before);
  const foreign = await api(`approvals/${result.approvalId}/confirm`, {}, 'bruno');
  assert.equal(foreign.status, 404);
  const operator = await api('actions', { name: 'transfer_money', arguments: input }, 'marta');
  assert.equal(operator.status, 403);
});

test('normal: cancelling a proposal preserves balances and prevents later confirmation', async () => {
  const conversation = await api('conversations', {});
  const before = await api('dashboard');
  const operationsBefore = await bankRequest<any>('marta', '/v1/operator/customer?id=ines');
  const proposal = await api('actions', {
    name: 'transfer_money',
    arguments: input,
    intentId: 'cancel-proposal',
    conversationId: conversation.data.id,
  });
  const approvalId = proposal.data.approvalId;
  assert.equal((await api(`approvals/${approvalId}/cancel`, {}, 'bruno')).status, 404);
  const cancelled = await api(`approvals/${approvalId}/cancel`, {});
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.data.status, 'cancelled');
  const intent = appDb().prepare('SELECT * FROM intents WHERE id=?').get('cancel-proposal') as any;
  assert.equal(intent.status, 'cancelled');
  assert.equal(intent.operation_id, null);
  assert.equal((await api(`approvals/${approvalId}/confirm`, {})).status, 409);
  const repeated = await api('actions', {
    name: 'transfer_money',
    arguments: input,
    intentId: 'cancel-proposal',
  });
  assert.equal(repeated.data.status, 'failed');
  const after = await api('dashboard');
  assert.deepEqual(after.data.accounts, before.data.accounts);
  assert.deepEqual(after.data.movements, before.data.movements);
  assert.ok(!after.data.approvals.some((a: any) => a.id === approvalId));
  assert.deepEqual(
    (await bankRequest<any>('marta', '/v1/operator/customer?id=ines')).operations,
    operationsBefore.operations,
  );
  await assert.rejects(
    bankRequest('ines', `/v1/operations/${intent.bank_reference}`),
    (error: unknown) => error instanceof BankError && error.status === 404,
  );
  const history = await api(`conversations/${conversation.data.id}`);
  assert.equal(history.data.messages.length, 1);
  assert.match(history.data.messages[0].content, /proposal cancelled/);
  assert.deepEqual(
    (await api(`conversations/${conversation.data.id}`)).data.messages,
    history.data.messages,
  );
  assert.equal((await api(`approvals/${approvalId}/cancel`, {})).data.status, 'cancelled');
  assert.deepEqual(
    (await api(`conversations/${conversation.data.id}`)).data.messages,
    history.data.messages,
  );
  const completed = before.data.movements.find((m: any) => m.description === 'Transfer · test');
  assert.ok(completed);
  const consumed = appDb()
    .prepare('SELECT id FROM approvals WHERE intent_id=?')
    .get('confirmation-api') as { id: string };
  assert.equal((await api(`approvals/${consumed.id}/cancel`, {})).status, 409);
});

for (const concurrent of [false, true]) {
  test(`normal: an approval is single-use (${concurrent ? 'concurrent' : 'sequential'} confirmations)`, async () => {
    const intentId = `single-use-${concurrent ? 'concurrent' : 'sequential'}`;
    const conversation = await api('conversations', {});
    const before = await api('dashboard');
    const destinationBefore = await bankRequest<any[]>('carla', '/v1/accounts');
    const operationsBefore = await bankRequest<any>('marta', '/v1/operator/customer?id=ines');
    const proposal = await api('actions', {
      name: 'transfer_money',
      arguments: input,
      intentId,
      conversationId: conversation.data.id,
    });
    const approvalId = proposal.data.approvalId;
    assert.equal(proposal.data.status, 'requires_confirmation');
    const originalFetch = globalThis.fetch;
    const transferRequests: any[] = [];
    const consumedAtDispatch: (string | null)[] = [];
    // Observe real HTTP requests; do not replace the bank's responses or behavior.
    globalThis.fetch = (async (resource, init) => {
      if (new URL(String(resource)).pathname === '/v1/transfers' && init?.method === 'POST') {
        transferRequests.push(JSON.parse(String(init.body)));
        consumedAtDispatch.push(
          (appDb().prepare('SELECT consumed_at FROM approvals WHERE id=?').get(approvalId) as any)
            .consumed_at,
        );
      }
      return originalFetch(resource, init);
    }) as typeof fetch;
    let responses;
    try {
      const confirm = () => api(`approvals/${approvalId}/confirm`, {});
      responses = concurrent
        ? await Promise.all([confirm(), confirm()])
        : [await confirm(), await confirm()];
    } finally {
      globalThis.fetch = originalFetch;
    }
    const intent = appDb().prepare('SELECT * FROM intents WHERE id=?').get(intentId) as any;
    const approval = appDb().prepare('SELECT * FROM approvals WHERE id=?').get(approvalId) as any;
    const confirmedEvents = appDb()
      .prepare("SELECT data FROM events WHERE kind='transfer.confirmed'")
      .all()
      .filter((event: any) => JSON.parse(event.data).intentId === intentId);
    const after = await api('dashboard');
    const destinationAfter = await bankRequest<any[]>('carla', '/v1/accounts');
    const operation = await bankRequest<any>('ines', `/v1/operations/${intent.bank_reference}`);
    const operationsAfter = await bankRequest<any>('marta', '/v1/operator/customer?id=ines');
    const history = await api(`conversations/${conversation.data.id}`);
    console.log(
      'approval.evidence',
      JSON.stringify({
        profile: 'normal',
        scenario: concurrent ? 'concurrent' : 'sequential',
        intentId,
        approvalId,
        responses,
        transferRequests,
        confirmedEvents: confirmedEvents.length,
        intentStatus: intent.status,
        bankReference: intent.bank_reference,
        operationId: operation.id,
        consumedAt: approval.consumed_at,
        consumedAtDispatch,
        balanceBefore: before.data.accounts[0].balanceCents,
        balanceAfter: after.data.accounts[0].balanceCents,
        newOperations: operationsAfter.operations.length - operationsBefore.operations.length,
        conversationMessages: history.data.messages.length,
      }),
    );
    assert.equal(
      after.data.accounts[0].balanceCents,
      before.data.accounts[0].balanceCents - input.amountCents,
    );
    assert.equal(
      destinationAfter[0].balanceCents,
      destinationBefore[0].balanceCents + input.amountCents,
    );
    const newMovements = after.data.movements.filter(
      (m: any) => !before.data.movements.some((old: any) => old.id === m.id),
    );
    assert.equal(newMovements.length, 1);
    assert.equal(newMovements[0].amountCents, -input.amountCents);
    assert.equal(newMovements[0].operationId, operation.id);
    const credits = (await bankRequest<any[]>('carla', '/v1/movements')).filter(
      (m) => m.operationId === operation.id,
    );
    assert.equal(credits.length, 1);
    assert.equal(credits[0].amountCents, input.amountCents);
    assert.equal(operationsAfter.operations.length, operationsBefore.operations.length + 1);
    for (const key of Object.keys(input) as (keyof typeof input)[])
      assert.equal(operation[key], input[key]);
    assert.equal(operation.id, intent.operation_id);
    assert.equal(intent.status, 'completed');
    assert.ok(approval.consumed_at);
    assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
    assert.equal(responses.find((r) => r.status === 200)?.data.operation.id, operation.id);
    assert.equal(transferRequests.length, 1);
    assert.ok(consumedAtDispatch[0]);
    assert.equal(transferRequests[0].reference, intent.bank_reference);
    assert.equal(confirmedEvents.length, 1);
    assert.equal(history.data.messages.length, 1);
    assert.match(history.data.messages[0].content, /Transfer completed/);
    assert.ok(history.data.messages[0].content.includes(intent.bank_reference));
  });
}

test('normal: public API cannot change the reviewed operation when confirming', async () => {
  const intentId = 'reviewed-api-payload';
  const proposal = await api('actions', { name: 'transfer_money', arguments: input, intentId });
  const before = await api('dashboard');
  const changed = { ...input, amountCents: 2000, toAccountId: 'acc-bruno', concept: 'changed' };
  const altered = await api('actions', { name: 'transfer_money', arguments: changed, intentId });
  assert.equal(altered.data.status, 'failed');
  assert.deepEqual((await api('dashboard')).data.accounts, before.data.accounts);
  // The endpoint ignores browser-supplied transfer details and uses the stored proposal.
  const result = await api(`approvals/${proposal.data.approvalId}/confirm`, changed);
  assert.equal(result.data.status, 'completed');
  for (const key of Object.keys(input) as (keyof typeof input)[])
    assert.equal(result.data.operation[key], input[key]);
  const intent = appDb()
    .prepare('SELECT bank_reference FROM intents WHERE id=?')
    .get(intentId) as any;
  const operation = await bankRequest<any>('ines', `/v1/operations/${intent.bank_reference}`);
  assert.equal(operation.id, result.data.operation.id);
  for (const key of Object.keys(input) as (keyof typeof input)[])
    assert.equal(operation[key], input[key]);
});

test('authorization: approval must match every reviewed field, holder and intent', async () => {
  const intentId = 'reviewed-authorization-payload';
  const proposal = await api('actions', { name: 'transfer_money', arguments: input, intentId });
  const ctx = {
    userId: 'ines',
    conversationId: null,
    runId: 'reviewed-authorization',
    intentId,
    approvalId: proposal.data.approvalId,
  };
  const before = await api('dashboard');
  const invalidInputs = [
    { ...input, fromAccountId: 'acc-ines-savings' },
    { ...input, toAccountId: 'acc-bruno' },
    { ...input, amountCents: 2000 },
    { ...input, concept: 'changed' },
  ];
  // Focal internal-boundary test, not a claim that the public API permits payload changes.
  const attempts = [];
  for (const changed of invalidInputs) {
    try {
      attempts.push({ changed, result: await authorizeTransfer(ctx, changed) });
    } catch (error) {
      attempts.push({ changed, status: error instanceof HttpError ? error.status : null });
    }
  }
  console.log('approval.payload.evidence', JSON.stringify({ intentId, attempts }));
  assert.ok(attempts.every((attempt) => 'status' in attempt && attempt.status === 409));
  const approval = appDb()
    .prepare('SELECT consumed_at FROM approvals WHERE id=?')
    .get(ctx.approvalId) as any;
  assert.equal(approval.consumed_at, null);
  const other = await api('actions', {
    name: 'transfer_money',
    arguments: input,
    intentId: 'different-approval-intent',
  });
  await assert.rejects(
    authorizeTransfer({ ...ctx, intentId: 'different-approval-intent' }, input),
    (error: unknown) => error instanceof HttpError && error.status === 403,
  );
  await assert.rejects(
    authorizeTransfer({ ...ctx, userId: 'bruno' }, { ...input, fromAccountId: 'acc-bruno' }),
    (error: unknown) => error instanceof HttpError && error.status === 403,
  );
  assert.ok(other.data.approvalId);
  const after = await api('dashboard');
  assert.deepEqual(after.data.accounts, before.data.accounts);
  assert.deepEqual(after.data.movements, before.data.movements);
  const intent = appDb()
    .prepare('SELECT bank_reference FROM intents WHERE id=?')
    .get(intentId) as any;
  await assert.rejects(
    bankRequest('ines', `/v1/operations/${intent.bank_reference}`),
    (error: unknown) => error instanceof BankError && error.status === 404,
  );
  assert.equal((await api(`approvals/${ctx.approvalId}/confirm`, {})).data.status, 'completed');
});

test('normal: bank rejection does not make a consumed approval reusable', async () => {
  const intentId = 'rejected-consumed-approval';
  const conversation = await api('conversations', {});
  const before = await api('dashboard');
  const operationsBefore = await bankRequest<any>('marta', '/v1/operator/customer?id=ines');
  const proposal = await api('actions', {
    name: 'transfer_money',
    arguments: { ...input, amountCents: 10000000 },
    intentId,
    conversationId: conversation.data.id,
  });
  assert.equal(proposal.data.status, 'requires_confirmation');
  const result = await api(`approvals/${proposal.data.approvalId}/confirm`, {});
  assert.equal(result.data.status, 'failed');
  assert.match(result.data.error, /Insufficient funds/);
  const approval = appDb()
    .prepare('SELECT consumed_at FROM approvals WHERE id=?')
    .get(proposal.data.approvalId) as any;
  assert.ok(approval.consumed_at);
  assert.equal((await api(`approvals/${proposal.data.approvalId}/confirm`, {})).status, 409);
  const intent = appDb().prepare('SELECT * FROM intents WHERE id=?').get(intentId) as any;
  assert.equal(intent.status, 'failed');
  assert.equal(intent.operation_id, null);
  const after = await api('dashboard');
  assert.deepEqual(after.data.accounts, before.data.accounts);
  assert.deepEqual(after.data.movements, before.data.movements);
  assert.deepEqual(
    (await bankRequest<any>('marta', '/v1/operator/customer?id=ines')).operations,
    operationsBefore.operations,
  );
  await assert.rejects(
    bankRequest('ines', `/v1/operations/${intent.bank_reference}`),
    (error: unknown) => error instanceof BankError && error.status === 404,
  );
  const history = await api(`conversations/${conversation.data.id}`);
  assert.equal(history.data.messages.length, 1);
  assert.match(history.data.messages[0].content, /Insufficient funds/);
});

for (const status of ['completed', 'failed'] as const) {
  test(`normal: repeating a resolved ${status} intent preserves its result without another execution`, async () => {
    const intentId = `resolved-${status}`;
    const args = { ...input, amountCents: status === 'failed' ? 10000000 : 1000 };
    const conversation = await api('conversations', {});
    const action = {
      name: 'transfer_money',
      arguments: args,
      intentId,
      conversationId: conversation.data.id,
    };
    const proposal = await api('actions', action);
    assert.equal(proposal.data.status, 'requires_confirmation');
    const first = await api(`approvals/${proposal.data.approvalId}/confirm`, {});
    assert.equal(first.data.status, status);
    const db = appDb();
    const persistedBefore = db.prepare('SELECT * FROM intents WHERE id=?').get(intentId) as any;
    const approvalsBefore = db
      .prepare('SELECT * FROM approvals WHERE intent_id=? ORDER BY rowid')
      .all(intentId);
    const before = await api('dashboard');
    const destinationBefore = await bankRequest<any[]>('carla', '/v1/accounts');
    const operationsBefore = await bankRequest<any>('marta', '/v1/operator/customer?id=ines');
    const historyBefore = await api(`conversations/${conversation.data.id}`);
    const originalFetch = globalThis.fetch;
    const bankRequests: { path: string; method: string; reference?: string }[] = [];
    globalThis.fetch = (async (resource, init) => {
      const url = new URL(String(resource));
      bankRequests.push({
        path: url.pathname,
        method: init?.method || 'GET',
        reference: init?.body ? JSON.parse(String(init.body)).reference : undefined,
      });
      return originalFetch(resource, init);
    }) as typeof fetch;
    let repeated, afterRepeat, repeatedConfirmation;
    try {
      repeated = await api('actions', action);
      afterRepeat = db.prepare('SELECT * FROM intents WHERE id=?').get(intentId);
      // Before the fix this exposes the reopened proposal and redundant bank execution.
      if (repeated.data.status === 'requires_confirmation')
        repeatedConfirmation = await api(`approvals/${repeated.data.approvalId}/confirm`, {});
    } finally {
      globalThis.fetch = originalFetch;
    }
    const after = await api('dashboard');
    const destinationAfter = await bankRequest<any[]>('carla', '/v1/accounts');
    const operationsAfter = await bankRequest<any>('marta', '/v1/operator/customer?id=ines');
    const historyAfter = await api(`conversations/${conversation.data.id}`);
    const approvalsAfter = db
      .prepare('SELECT * FROM approvals WHERE intent_id=? ORDER BY rowid')
      .all(intentId);
    console.log(
      'intent.reuse.evidence',
      JSON.stringify({
        profile: 'normal',
        intentId,
        first: first.data,
        repeated: repeated.data,
        stateBefore: persistedBefore,
        stateAfterRepeat: afterRepeat,
        repeatedConfirmation: repeatedConfirmation?.data,
        bankRequests,
        approvalsBefore: approvalsBefore.length,
        approvalsAfter: approvalsAfter.length,
        balanceBefore: before.data.accounts[0].balanceCents,
        balanceAfter: after.data.accounts[0].balanceCents,
        newOperations: operationsAfter.operations.length - operationsBefore.operations.length,
        messagesBefore: historyBefore.data.messages.length,
        messagesAfter: historyAfter.data.messages.length,
      }),
    );
    assert.deepEqual(after.data.accounts, before.data.accounts);
    assert.deepEqual(after.data.movements, before.data.movements);
    assert.deepEqual(destinationAfter, destinationBefore);
    assert.deepEqual(operationsAfter.operations, operationsBefore.operations);
    if (status === 'completed') {
      const operation = await bankRequest<any>(
        'ines',
        `/v1/operations/${persistedBefore.bank_reference}`,
      );
      assert.equal(operation.id, persistedBefore.operation_id);
      assert.equal(operation.id, first.data.operation.id);
    } else {
      assert.match(first.data.error, /Insufficient funds/);
      await assert.rejects(
        bankRequest('ines', `/v1/operations/${persistedBefore.bank_reference}`),
        (error: unknown) => error instanceof BankError && error.status === 404,
      );
    }
    assert.equal(repeated.status, 200);
    assert.equal(repeated.data.status, status);
    if (status === 'completed') assert.deepEqual(repeated.data.operation, first.data.operation);
    else assert.equal(repeated.data.error, first.data.error);
    assert.deepEqual(afterRepeat, persistedBefore);
    assert.deepEqual(approvalsAfter, approvalsBefore);
    assert.deepEqual(historyAfter.data.messages, historyBefore.data.messages);
    assert.deepEqual(bankRequests, []);
    // Re-open SQLite and make network access fail: the result must be durable and local.
    let blockedRequests = 0;
    globalThis.fetch = (async () => {
      blockedRequests += 1;
      throw new Error('Bank deliberately unavailable in the replay test.');
    }) as typeof fetch;
    try {
      closeAppDb();
      const simultaneous = await Promise.all([api('actions', action), api('actions', action)]);
      for (const result of simultaneous) assert.deepEqual(result.data, repeated.data);
      const altered = await api('actions', {
        ...action,
        arguments: { ...args, concept: 'changed' },
      });
      assert.equal(altered.data.status, 'failed');
      assert.match(altered.data.error, /different payload/);
      const foreign = await api(
        'actions',
        { name: 'transfer_money', arguments: args, intentId },
        'bruno',
      );
      assert.equal(foreign.data.status, 'failed');
      assert.equal(foreign.data.operation, undefined);
      assert.match(foreign.data.error, /different payload/);
      assert.equal((await api('actions', action, 'marta')).status, 403);
      assert.equal(blockedRequests, 0);
      assert.deepEqual(
        appDb().prepare('SELECT * FROM intents WHERE id=?').get(intentId),
        persistedBefore,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}

test('normal with controlled scheduling: a delayed proposal cannot reopen a completed intent', async () => {
  const intentId = 'resolved-delayed-proposal';
  const action = { name: 'transfer_money', arguments: input, intentId };
  const proposal = await api('actions', action);
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const originalFetch = globalThis.fetch;
  let hold = true;
  globalThis.fetch = (async (resource, init) => {
    if (hold && new URL(String(resource)).pathname === '/v1/accounts') {
      hold = false;
      entered();
      await gate;
    }
    return originalFetch(resource, init);
  }) as typeof fetch;
  let delayed: ReturnType<typeof api> | undefined;
  try {
    delayed = api('actions', action);
    await waiting;
    const confirmed = await api(`approvals/${proposal.data.approvalId}/confirm`, {});
    assert.equal(confirmed.data.status, 'completed');
    const known = appDb().prepare('SELECT * FROM intents WHERE id=?').get(intentId);
    release();
    const repeated = await delayed;
    const after = appDb().prepare('SELECT * FROM intents WHERE id=?').get(intentId);
    const approvals = appDb().prepare('SELECT id FROM approvals WHERE intent_id=?').all(intentId);
    console.log(
      'intent.race.evidence',
      JSON.stringify({ intentId, known, repeated: repeated.data, after, approvals }),
    );
    assert.equal(repeated.data.status, 'completed');
    assert.deepEqual(repeated.data.operation, confirmed.data.operation);
    assert.deepEqual(after, known);
    assert.equal(approvals.length, 1);
  } finally {
    release();
    if (delayed) await delayed;
    globalThis.fetch = originalFetch;
  }
});

test('normal with controlled scheduling: an executing intent cannot generate another approval', async () => {
  const intentId = 'resolved-in-flight';
  const action = { name: 'transfer_money', arguments: input, intentId };
  const proposal = await api('actions', action);
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const originalFetch = globalThis.fetch;
  let postCount = 0;
  globalThis.fetch = (async (resource, init) => {
    if (new URL(String(resource)).pathname === '/v1/transfers') {
      postCount += 1;
      entered();
      await gate;
    }
    return originalFetch(resource, init);
  }) as typeof fetch;
  let execution: ReturnType<typeof api> | undefined;
  try {
    execution = api(`approvals/${proposal.data.approvalId}/confirm`, {});
    await waiting;
    const known = appDb().prepare('SELECT * FROM intents WHERE id=?').get(intentId);
    const repeated = await api('actions', action);
    const after = appDb().prepare('SELECT * FROM intents WHERE id=?').get(intentId);
    const approvals = appDb().prepare('SELECT id FROM approvals WHERE intent_id=?').all(intentId);
    release();
    const result = await execution;
    console.log(
      'intent.processing.evidence',
      JSON.stringify({ intentId, known, repeated: repeated.data, after, approvals, postCount }),
    );
    assert.equal(result.data.status, 'completed');
    assert.equal(repeated.data.status, 'processing');
    assert.deepEqual(after, known);
    assert.equal(approvals.length, 1);
    assert.equal(postCount, 1);
  } finally {
    release();
    if (execution) await execution;
    globalThis.fetch = originalFetch;
  }
});

test('normal: distinct intents with identical payloads remain independent customer operations', async () => {
  const before = await api('dashboard');
  const destinationBefore = await bankRequest<any[]>('carla', '/v1/accounts');
  const operationsBefore = await bankRequest<any>('marta', '/v1/operator/customer?id=ines');
  const results: { id: string; reference: string }[] = [];
  for (const intentId of ['legitimate-intent-one', 'legitimate-intent-two']) {
    const action = { name: 'transfer_money', arguments: input, intentId };
    const proposal = await api('actions', action);
    assert.equal(proposal.data.status, 'requires_confirmation');
    const confirmed = await api(`approvals/${proposal.data.approvalId}/confirm`, {});
    assert.equal(confirmed.data.status, 'completed');
    const repeated = await api('actions', action);
    assert.deepEqual(repeated.data.operation, confirmed.data.operation);
    const lookup = await bankRequest<any>(
      'ines',
      `/v1/operations/${confirmed.data.operation.reference}`,
    );
    assert.equal(lookup.id, confirmed.data.operation.id);
    results.push(confirmed.data.operation);
  }
  assert.notEqual(results[0].id, results[1].id);
  assert.notEqual(results[0].reference, results[1].reference);
  const after = await api('dashboard');
  const destinationAfter = await bankRequest<any[]>('carla', '/v1/accounts');
  assert.equal(after.data.accounts[0].balanceCents, before.data.accounts[0].balanceCents - 2000);
  assert.equal(destinationAfter[0].balanceCents, destinationBefore[0].balanceCents + 2000);
  assert.equal(
    (await bankRequest<any>('marta', '/v1/operator/customer?id=ines')).operations.length,
    operationsBefore.operations.length + 2,
  );
  const movements = after.data.movements.filter((m: any) =>
    results.some((op) => op.id === m.operationId),
  );
  assert.equal(movements.length, 2);
  assert.ok(movements.every((m: any) => m.amountCents === -1000));
});

test('legacy telemetry fixture: a completed intent without operation details is not executed again', async () => {
  const intentId = 'resolved-legacy-event';
  const action = { name: 'transfer_money', arguments: input, intentId };
  const proposal = await api('actions', action);
  const confirmed = await api(`approvals/${proposal.data.approvalId}/confirm`, {});
  assert.equal(confirmed.data.status, 'completed');
  // The starter's telemetry retained only status/tool. Reproduce that historical app data locally.
  appDb()
    .prepare(
      "UPDATE events SET data=? WHERE kind='transfer.completed' AND json_extract(data,'$.intentId')=?",
    )
    .run(JSON.stringify({ status: 'completed' }), intentId);
  const intent = appDb().prepare('SELECT * FROM intents WHERE id=?').get(intentId) as any;
  const before = await api('dashboard');
  const originalFetch = globalThis.fetch;
  let bankRequests = 0;
  globalThis.fetch = (async () => {
    bankRequests += 1;
    throw new Error('Bank must not be needed to replay a known historical result.');
  }) as typeof fetch;
  try {
    const result = await api('actions', action);
    assert.equal(result.data.status, 'completed');
    assert.equal(result.data.operationId, confirmed.data.operation.id);
    assert.equal(result.data.bankReference, confirmed.data.operation.reference);
    assert.deepEqual(result.data.payload, input);
    assert.equal(result.data.operation, undefined);
    assert.equal(result.data.createdAt, undefined);
    assert.equal(bankRequests, 0);
    assert.deepEqual(appDb().prepare('SELECT * FROM intents WHERE id=?').get(intentId), intent);
    assert.equal(
      appDb().prepare('SELECT id FROM approvals WHERE intent_id=?').all(intentId).length,
      1,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  const after = await api('dashboard');
  assert.deepEqual(after.data.accounts, before.data.accounts);
  assert.deepEqual(after.data.movements, before.data.movements);
});

test('read-unavailable: conversational feedback preserves the unverified result', async () => {
  const profile = await fetch(`${config.bankUrl}/admin/scenario`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.adminSecret}` },
    body: JSON.stringify({ profile: 'read-unavailable' }),
  });
  assert.equal(profile.status, 200);
  const conversation = await api('conversations', {});
  const proposal = await api('actions', {
    name: 'transfer_money',
    arguments: input,
    intentId: 'pending-feedback',
    conversationId: conversation.data.id,
  });
  const result = await api(`approvals/${proposal.data.approvalId}/confirm`, {});
  assert.equal(result.data.status, 'pending_verification');
  const history = await api(`conversations/${conversation.data.id}`);
  assert.equal(history.data.messages.length, 1);
  assert.match(history.data.messages[0].content, /pending verification/);
  assert.ok(history.data.messages[0].content.includes(result.data.bankReference));
  assert.doesNotMatch(history.data.messages[0].content, /Transfer completed|rejected/);
  assert.deepEqual(
    (await api(`conversations/${conversation.data.id}`)).data.messages,
    history.data.messages,
  );
  assert.equal((await api(`approvals/${proposal.data.approvalId}/confirm`, {})).status, 409);
  const intent = appDb()
    .prepare('SELECT status FROM intents WHERE id=?')
    .get('pending-feedback') as any;
  assert.equal(intent.status, 'pending_verification');
  assert.deepEqual(
    (await api(`conversations/${conversation.data.id}`)).data.messages,
    history.data.messages,
  );
  const persisted = appDb().prepare('SELECT * FROM intents WHERE id=?').get('pending-feedback');
  const originalFetch = globalThis.fetch;
  let bankRequests = 0;
  globalThis.fetch = (async () => {
    bankRequests += 1;
    throw new Error(
      'Repeating an unresolved intent must not dispatch or reconcile it in this task.',
    );
  }) as typeof fetch;
  try {
    const repeated = await api('actions', {
      name: 'transfer_money',
      arguments: input,
      intentId: 'pending-feedback',
    });
    assert.equal(repeated.data.status, 'pending_verification');
    assert.equal(repeated.data.bankReference, result.data.bankReference);
    assert.equal(repeated.data.error, result.data.error);
    assert.equal(bankRequests, 0);
    assert.deepEqual(
      appDb().prepare('SELECT * FROM intents WHERE id=?').get('pending-feedback'),
      persisted,
    );
    assert.equal(
      appDb().prepare('SELECT id FROM approvals WHERE intent_id=?').all('pending-feedback').length,
      1,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

for (const profile of ['slow-response', 'intermittent'] as const) {
  test(`${profile}${profile === 'intermittent' ? ' 17' : ''}: real HTTP reconciles without duplicate effects`, async () => {
    const selected = await fetch(`${config.bankUrl}/admin/scenario`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.adminSecret}`,
      },
      body: JSON.stringify({ profile, seed: 17 }),
    });
    assert.equal(selected.status, 200);
    assert.ok(config.bankTimeoutMs < 2600, 'The client must time out before the slow response.');
    const snapshot = async () => {
      const response = await fetch(`${config.bankUrl}/admin/snapshot`, {
        headers: { Authorization: `Bearer ${config.adminSecret}` },
      });
      assert.equal(response.status, 200);
      return response.json();
    };
    const before = await snapshot();
    const count = profile === 'intermittent' ? 3 : 1;
    const results: any[] = [];
    const originalFetch = globalThis.fetch;
    const requests: {
      method: string;
      path: string;
      reference?: string;
      outcome?: number | string;
    }[] = [];
    // Pass through to the real bank, observing both HTTP errors and the actual timeout.
    globalThis.fetch = (async (resource, init) => {
      const pathname = new URL(String(resource)).pathname;
      if (pathname !== '/v1/transfers' && !pathname.startsWith('/v1/operations/'))
        return originalFetch(resource, init);
      const request = {
        method: init?.method || 'GET',
        path: pathname,
        reference: init?.body ? JSON.parse(String(init.body)).reference : undefined,
        outcome: undefined as number | string | undefined,
      };
      requests.push(request);
      try {
        const response = await originalFetch(resource, init);
        request.outcome = response.status;
        return response;
      } catch (error) {
        request.outcome = error instanceof Error ? error.name : String(error);
        throw error;
      }
    }) as typeof fetch;
    try {
      for (let index = 0; index < count; index++) {
        const intentId = `reconciliation-${profile}-${index}`;
        const proposal = await api('actions', {
          name: 'transfer_money',
          arguments: input,
          intentId,
        });
        assert.equal(proposal.data.status, 'requires_confirmation');
        const confirmed = await api(`approvals/${proposal.data.approvalId}/confirm`, {});
        assert.equal(confirmed.status, 200);
        assert.equal(confirmed.data.status, 'completed');
        const intent = appDb().prepare('SELECT * FROM intents WHERE id=?').get(intentId) as any;
        assert.equal(intent.status, 'completed');
        assert.equal(intent.operation_id, confirmed.data.operation.id);
        assert.equal(intent.bank_reference, confirmed.data.operation.reference);
        results.push(confirmed.data.operation);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
    const after = await snapshot();
    const newOperations = after.operations.filter(
      (operation: any) => !before.operations.some((old: any) => old.id === operation.id),
    );
    assert.equal(newOperations.length, count);
    assert.equal(after.movements.length - before.movements.length, 2 * count);
    for (const operation of results) {
      assert.deepEqual(
        newOperations.find((stored: any) => stored.id === operation.id),
        Object.fromEntries(Object.entries(operation).filter(([key]) => key !== 'replay')),
      );
      const movements = after.movements.filter(
        (movement: any) => movement.operationId === operation.id,
      );
      assert.equal(movements.length, 2);
      assert.equal(
        movements.find((movement: any) => movement.accountId === input.fromAccountId).amountCents,
        -input.amountCents,
      );
      assert.equal(
        movements.find((movement: any) => movement.accountId === input.toAccountId).amountCents,
        input.amountCents,
      );
    }
    for (const account of after.accounts) {
      const delta =
        account.id === input.fromAccountId
          ? -count * input.amountCents
          : account.id === input.toAccountId
            ? count * input.amountCents
            : 0;
      assert.equal(
        account.balanceCents,
        before.accounts.find((old: any) => old.id === account.id).balanceCents + delta,
      );
    }
    assert.equal(after.scenario.counter, count);
    assert.equal(requests.filter((request) => request.method === 'POST').length, count);
    const ambiguous = requests[count - 1];
    assert.equal(ambiguous.outcome, profile === 'intermittent' ? 504 : 'TimeoutError');
    assert.equal(requests.length, count + 1);
    assert.equal(requests[count].path, `/v1/operations/${ambiguous.reference}`);
    assert.equal(requests[count].outcome, 200);
    console.log(
      'reconciliation.evidence',
      JSON.stringify({
        profile,
        seed: 17,
        requests,
        newOperations: newOperations.length,
        newMovements: after.movements.length - before.movements.length,
        statuses: results.map((operation) => operation.status),
      }),
    );
  });
}

after(async () => {
  if (bank && bank.exitCode === null && bank.signalCode === null) {
    const stopped = once(bank, 'exit');
    bank.kill('SIGTERM');
    await stopped;
  }
  closeAppDb();
  fs.rmSync(temp, { recursive: true, force: true });
});
