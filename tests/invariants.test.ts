import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-tests-'));
process.env.DATA_DIR = temp;
process.env.BANK_DATA_DIR = temp;
const { seedBank } = await import('../simulator/seed');
const { bankDb, closeBankDb } = await import('../simulator/db');
const { transfer, listAccounts, setScenario, operationByReference } =
  await import('../simulator/bank');
const { seedApp } = await import('../src/seed');
const { appDb, closeAppDb } = await import('../src/db');
const { actor, sessionToken, sameOrigin } = await import('../src/auth');
const { documents, readDocument } = await import('../src/ingestion/pipeline');
const { allChunks } = await import('../src/retrieval/store');
const { transferMoney } = await import('../src/banking/actions');
const input = {
  fromAccountId: 'acc-lucia',
  toAccountId: 'acc-bruno',
  amountCents: 1000,
  concept: 'Test',
};
function snapshot() {
  return {
    accounts: bankDb().prepare('SELECT * FROM accounts ORDER BY id').all(),
    movements: bankDb().prepare('SELECT * FROM movements ORDER BY id').all(),
    operations: bankDb().prepare('SELECT * FROM operations ORDER BY id').all(),
  };
}
const jsonResponse = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { 'Content-Type': 'application/json' } });
function transferContext(intentId: string) {
  return {
    userId: 'lucia',
    conversationId: null,
    runId: `run-${intentId}`,
    intentId,
  };
}
async function confirmedTransfer(intentId: string) {
  const ctx = transferContext(intentId);
  const proposal = await transferMoney(ctx, input);
  assert.equal(proposal.status, 'requires_confirmation');
  return transferMoney({ ...ctx, approvalId: proposal.approvalId as string }, input);
}
test('reset reproduces consistent accounts and transactions', () => {
  seedBank();
  const before = snapshot();
  setScenario('normal');
  transfer('lucia', 'test-reset', input);
  seedBank();
  assert.deepEqual(snapshot(), before);
  for (const a of before.accounts as any[]) {
    const sum = (
      bankDb()
        .prepare('SELECT SUM(amountCents) AS total FROM movements WHERE accountId=?')
        .get(a.id) as { total: number }
    ).total;
    assert.equal(sum, a.balanceCents);
  }
});
test('a transfer debits and credits without creating money', () => {
  seedBank();
  setScenario('normal');
  const total = () => bankDb().prepare('SELECT SUM(balanceCents) AS total FROM accounts').get();
  const before = total(),
    balance = listAccounts('lucia')[0].balanceCents;
  const result = transfer('lucia', 'test-normal', input);
  assert.equal(result.operation.status, 'completed');
  assert.deepEqual(total(), before);
  assert.equal(listAccounts('lucia')[0].balanceCents, balance - 1000);
});
test('the bank guarantees idempotency by actor and reference', () => {
  seedBank();
  setScenario('normal');
  const first = transfer('lucia', 'stable', input),
    before = snapshot();
  const second = transfer('lucia', 'stable', input);
  assert.equal(second.operation.id, first.operation.id);
  assert.equal(second.replay, true);
  assert.deepEqual(snapshot(), before);
  assert.throws(
    () => transfer('lucia', 'stable', { ...input, amountCents: 1200 }),
    /different operation/,
  );
});
test('different intents with the same payload remain separate transfers', () => {
  seedBank();
  setScenario('normal');
  const a = transfer('lucia', 'one', input),
    b = transfer('lucia', 'two', input);
  assert.notEqual(a.operation.id, b.operation.id);
});
test("insufficient funds and another holder's account leave the ledger unchanged", () => {
  seedBank();
  setScenario('normal');
  const before = snapshot();
  assert.throws(() => transfer('bruno', 'foreign', input), /not authorized/);
  assert.throws(
    () => transfer('diego', 'low', { ...input, fromAccountId: 'acc-diego', amountCents: 10000 }),
    /Insufficient/,
  );
  assert.throws(() => transfer('marta', 'operator', input), /account holder/);
  assert.deepEqual(snapshot(), before);
});
test('non-integer amounts, negative amounts, and invalid destinations are rejected', () => {
  seedBank();
  setScenario('normal');
  const before = snapshot();
  for (const amountCents of [-1, 0, 0.5, Infinity, 10000001])
    assert.throws(() => transfer('lucia', 'invalid', { ...input, amountCents }));
  assert.throws(() => transfer('lucia', 'same', { ...input, toAccountId: 'acc-lucia' }));
  assert.deepEqual(snapshot(), before);
});
test('a failure before commit does not move money', () => {
  seedBank();
  setScenario('reject-before');
  const before = snapshot();
  assert.equal(transfer('lucia', 'reject', input).fault, 'reject-before');
  assert.deepEqual(snapshot(), before);
});
test('a lost response preserves a single queryable effect', () => {
  seedBank();
  setScenario('lost-response');
  const first = transfer('lucia', 'lost', input);
  assert.equal(first.fault, 'lost-response');
  assert.equal(operationByReference('lucia', 'lost')?.id, first.operation.id);
  assert.equal(operationByReference('bruno', 'lost'), undefined);
  assert.equal(transfer('lucia', 'lost', input).replay, true);
});
test('intermittent scenarios repeat with the same seed', () => {
  const run = () => {
    seedBank();
    setScenario('intermittent', 17);
    return Array.from({ length: 8 }, (_, i) => transfer('lucia', `sequence-${i}`, input).fault);
  };
  assert.deepEqual(run(), run());
  assert.ok(run().includes('lost-response'));
});
test('application retries reuse the persisted bank reference', async () => {
  seedApp();
  const originalFetch = globalThis.fetch,
    references: string[] = [];
  let postCount = 0;
  globalThis.fetch = (async (resource: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(resource));
    if (url.pathname === '/v1/accounts')
      return jsonResponse([{ id: input.fromAccountId, userId: 'lucia' }]);
    if (url.pathname === '/v1/transfers') {
      const body = JSON.parse(String(init?.body));
      references.push(body.reference);
      postCount += 1;
      if (postCount === 1) return jsonResponse({ error: 'Service unavailable' }, 503);
      return jsonResponse({ ...body, id: 'operation-retry', userId: 'lucia', status: 'completed' });
    }
    if (url.pathname.startsWith('/v1/operations/'))
      return jsonResponse({ error: 'Operation not found' }, 404);
    throw new Error(`Unexpected bank request: ${url.pathname}`);
  }) as typeof fetch;
  try {
    const result = await confirmedTransfer('intent-stable-reference');
    assert.equal(result.status, 'completed');
    assert.equal(postCount, 2);
    assert.equal(references[0], references[1]);
    const intent = appDb()
      .prepare('SELECT bank_reference FROM intents WHERE id=?')
      .get('intent-stable-reference') as { bank_reference: string };
    assert.equal(intent.bank_reference, references[0]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test('application verifies a committed operation after an ambiguous response', async () => {
  seedApp();
  const originalFetch = globalThis.fetch;
  let postCount = 0,
    committed: any;
  globalThis.fetch = (async (resource: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(resource));
    if (url.pathname === '/v1/accounts')
      return jsonResponse([{ id: input.fromAccountId, userId: 'lucia' }]);
    if (url.pathname === '/v1/transfers') {
      const body = JSON.parse(String(init?.body));
      postCount += 1;
      committed = { ...body, id: 'operation-lost-response', userId: 'lucia', status: 'completed' };
      return jsonResponse({ error: 'Upstream request timed out' }, 504);
    }
    if (url.pathname.startsWith('/v1/operations/')) return jsonResponse(committed);
    throw new Error(`Unexpected bank request: ${url.pathname}`);
  }) as typeof fetch;
  try {
    const result = await confirmedTransfer('intent-verified');
    assert.equal(result.status, 'completed');
    assert.equal((result.operation as any).id, 'operation-lost-response');
    assert.equal(postCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test('application keeps an unverifiable transfer pending', async () => {
  seedApp();
  const originalFetch = globalThis.fetch;
  let postCount = 0;
  globalThis.fetch = (async (resource: string | URL | Request) => {
    const url = new URL(String(resource));
    if (url.pathname === '/v1/accounts')
      return jsonResponse([{ id: input.fromAccountId, userId: 'lucia' }]);
    if (url.pathname === '/v1/transfers') {
      postCount += 1;
      return jsonResponse({ error: 'Upstream request timed out' }, 504);
    }
    if (url.pathname.startsWith('/v1/operations/'))
      return jsonResponse({ error: 'Query temporarily unavailable' }, 503);
    throw new Error(`Unexpected bank request: ${url.pathname}`);
  }) as typeof fetch;
  try {
    const result = await confirmedTransfer('intent-pending-verification');
    assert.equal(result.status, 'pending_verification');
    assert.equal(postCount, 1);
    const intent = appDb()
      .prepare('SELECT status,bank_reference FROM intents WHERE id=?')
      .get('intent-pending-verification') as { status: string; bank_reference: string };
    assert.equal(intent.status, 'pending_verification');
    assert.equal(result.bankReference, intent.bank_reference);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
for (const failure of ['interrupted stream', 'invalid JSON'] as const) {
  for (const lookupAvailable of [true, false]) {
    test(`bank response read failure (${failure}): ${lookupAvailable ? 'reconciles the committed operation' : 'keeps the committed operation pending'}`, async () => {
      seedApp();
      const intentId = `body-read-${failure}-${lookupAvailable}`;
      const originalFetch = globalThis.fetch;
      let postCount = 0,
        lookupCount = 0;
      let committed: any;
      globalThis.fetch = (async (resource, init) => {
        const url = new URL(String(resource));
        if (url.pathname === '/v1/accounts')
          return jsonResponse([{ id: input.fromAccountId, userId: 'lucia' }]);
        if (url.pathname === '/v1/transfers') {
          const body = JSON.parse(String(init?.body));
          postCount += 1;
          // The mock records a completed bank operation before returning an unreadable body.
          committed = {
            ...body,
            id: `operation-${intentId}`,
            userId: 'lucia',
            status: 'completed',
          };
          if (failure === 'invalid JSON') return new Response('{"id":', { status: 200 });
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new TypeError('Bank response stream interrupted.'));
              },
            }),
            { status: 200 },
          );
        }
        if (url.pathname.startsWith('/v1/operations/')) {
          lookupCount += 1;
          assert.equal(
            decodeURIComponent(url.pathname.slice('/v1/operations/'.length)),
            committed.reference,
          );
          return lookupAvailable
            ? jsonResponse(committed)
            : jsonResponse({ error: 'Query temporarily unavailable' }, 503);
        }
        throw new Error(`Unexpected bank request: ${url.pathname}`);
      }) as typeof fetch;
      try {
        const result = await confirmedTransfer(intentId);
        const intent = appDb().prepare('SELECT * FROM intents WHERE id=?').get(intentId) as any;
        console.log(
          'body-read.evidence',
          JSON.stringify({
            failure,
            lookupAvailable,
            mockOperationStatus: committed.status,
            resultStatus: result.status,
            persistedStatus: intent.status,
            postCount,
            lookupCount,
          }),
        );
        const expectedStatus = lookupAvailable ? 'completed' : 'pending_verification';
        assert.equal(result.status, expectedStatus);
        assert.equal(intent.status, expectedStatus);
        assert.equal(postCount, 1);
        assert.equal(lookupCount, 1);
        assert.equal(intent.bank_reference, committed.reference);
        const approval = appDb()
          .prepare('SELECT consumed_at FROM approvals WHERE intent_id=?')
          .get(intentId) as any;
        assert.ok(approval.consumed_at);
        if (lookupAvailable) {
          assert.deepEqual(result.operation, committed);
          assert.equal(intent.operation_id, committed.id);
        } else {
          assert.equal(result.bankReference, committed.reference);
          assert.equal(intent.operation_id, null);
        }
        const events = appDb()
          .prepare('SELECT kind,data FROM events WHERE run_id=?')
          .all(`run-${intentId}`) as any[];
        assert.ok(events.some((event) => event.kind === `transfer.${expectedStatus}`));
        assert.ok(!events.some((event) => event.kind === 'transfer.failed'));
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  }
}

test('the application seed preserves reproducible histories and index', () => {
  const first = seedApp();
  assert.equal(first.indexLoaded, true);
  assert.equal(
    (appDb().prepare('SELECT COUNT(*) n FROM conversations').get() as { n: number }).n,
    47,
  );
  const histories = appDb().prepare('SELECT * FROM conversations ORDER BY id').all();
  const messages = appDb().prepare('SELECT * FROM messages ORDER BY id').all();
  assert.equal(first.incidents, 17);
  assert.equal(
    (
      appDb().prepare("SELECT COUNT(*) n FROM incidents WHERE status='closed'").get() as {
        n: number;
      }
    ).n,
    8,
  );
  assert.equal(
    (
      appDb()
        .prepare(
          'SELECT COUNT(*) n FROM conversations c WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id=c.id)',
        )
        .get() as { n: number }
    ).n,
    0,
  );
  const chunks = allChunks();
  assert.ok(chunks.length > 300);
  assert.ok(chunks.every((c) => c.vector?.length === 1536));
  seedApp();
  assert.deepEqual(allChunks(), chunks);
  assert.deepEqual(appDb().prepare('SELECT * FROM conversations ORDER BY id').all(), histories);
  assert.deepEqual(appDb().prepare('SELECT * FROM messages ORDER BY id').all(), messages);
});
test('the signed session determines the actor and rejects forged identities', () => {
  const req = (cookie: string) =>
    new Request('http://localhost/api', { headers: { cookie, 'x-user-id': 'bruno' } });
  assert.equal(actor(req(`banana_actor=${sessionToken('lucia')}`)).id, 'lucia');
  assert.throws(() => actor(req('banana_actor=bruno.invalid')));
  assert.throws(() => actor(req('')));
  assert.doesNotThrow(() =>
    sameOrigin(
      new Request('http://localhost/api', {
        headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' },
      }),
    ),
  );
  assert.throws(() =>
    sameOrigin(
      new Request('http://localhost/api', {
        headers: { host: '127.0.0.1:3000', origin: 'https://example.com' },
      }),
    ),
  );
});
test('corpus originals exist and have unique sources', () => {
  const docs = documents();
  assert.equal(docs.length, 80);
  assert.equal(new Set(docs.map((d) => d.id)).size, 80);
  assert.ok(docs.some((d) => d.audience === 'internal'));
  assert.ok(docs.some((d) => d.validTo));
  assert.ok(docs.every((d) => readDocument(d).length > 1000));
});
test('search without an API key returns actionable configuration guidance', async () => {
  seedApp();
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = ' ';
  try {
    const { POST } = await import('../app/api/[...path]/route');
    const response = await POST(
      new Request('http://localhost/api/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          cookie: `banana_actor=${sessionToken('lucia')}`,
        },
        body: JSON.stringify({ query: `configuration-check-${Date.now()}` }),
      }),
      { params: Promise.resolve({ path: ['search'] }) },
    );
    assert.equal(response.status, 503);
    const result = await response.json();
    assert.equal(result.code, 'missing_openai_api_key');
    assert.match(result.error, /OPENAI_API_KEY/);
    assert.match(result.error, /restart/);
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});
after(() => {
  closeAppDb();
  closeBankDb();
  fs.rmSync(temp, { recursive: true, force: true });
});
