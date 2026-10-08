import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';

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
const { sessionToken } = await import('../src/auth');
const { bankRequest, BankError } = await import('../src/banking/client');
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
});

after(async () => {
  if (bank && bank.exitCode === null && bank.signalCode === null) {
    const stopped = once(bank, 'exit');
    bank.kill('SIGTERM');
    await stopped;
  }
  closeAppDb();
  fs.rmSync(temp, { recursive: true, force: true });
});
