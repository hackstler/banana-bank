import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import OpenAI from 'openai';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-spend-lab-'));
process.env.DATA_DIR = temp;
process.env.TRACE_LOGS = '0';
const { config } = await import('../src/config');
const { sessionToken } = await import('../src/auth');
const { BankError } = await import('../src/banking/client');
const { handleSpendLabRequest } = await import('../src/spend-lab/workflow');
const { callOpenAI, buildInterpretationInput, reflectionInstructions } =
  await import('../src/spend-lab/interpretation');
const { GET, POST } = await import('../app/api/[...path]/route');
import type { BankReader } from '../src/spend-lab/context';
import type { ModelCall } from '../src/spend-lab/interpretation';
import type { EvaluationResult, Reflection, SpendLabContext } from '../src/spend-lab/contracts';

const now = () => new Date('2026-10-09T12:00:00Z');
const account = (userId = 'lucia', balanceCents = 300000, id = `acc-${userId}`) => ({
  id,
  userId,
  balanceCents,
  label: 'Current account',
  iban: 'ES91-test',
});
const input = () => ({
  purchase: {
    amountCents: 100000,
    motive: 'treat',
    context: 'I want a better camera for my hobby.',
  },
  accountIds: ['acc-lucia'],
  budget: {
    monthlyIncomeCents: 200000,
    monthlyEssentialExpensesCents: 80000,
    monthlyDiscretionaryExpensesCents: 0,
    nextIncomeDate: '2026-10-20',
    nextEssentialExpensesDate: '2026-10-10',
  },
  reserveCents: 150000,
  resale: { amountCents: 50000, date: '2026-10-16' },
});
const bank: BankReader = async (userId, endpoint) =>
  endpoint === '/v1/accounts'
    ? [account(userId)]
    : [
        {
          id: 'old-movement',
          accountId: `acc-${userId}`,
          operationId: null,
          amountCents: -999999,
          description: 'Old observed spending, not a future commitment',
          createdAt: '2026-09-01T12:00:00Z',
        },
      ];
function reflection(motive = 'treat'): Reflection {
  return {
    headline:
      motive === 'treat' ? 'Make room for what you enjoy' : 'Balance urgency with protection',
    motiveInterpretation:
      motive === 'treat'
        ? 'You want a better camera for your hobby; enjoyment is a valid reason.'
        : 'You describe a broken phone needed for work; the urgency matters.',
    preferredScenarioId: 'sell_first',
    recommendation:
      'Selling first protects the chosen reserve if you receive the expected proceeds.',
    financialTradeoffs: [
      {
        text: 'Selling first reduces the purchase outlay to €500.',
        evidenceIds: ['sell_first.netOutlayCents'],
      },
    ],
    reflectionQuestion:
      motive === 'treat'
        ? 'Which photos can you not take with your current phone?'
        : 'Can you manage the work need until the expected sale date?',
  };
}
const model: ModelCall = async (payload) => reflection(payload.purchase.motive);

function request(
  route: string,
  method: string,
  body?: unknown,
  userId: string | null = 'lucia',
  extraHeaders = {},
) {
  return new Request(`http://localhost/api/${route}`, {
    method,
    headers: {
      host: 'localhost',
      'Content-Type': 'application/json',
      ...(userId ? { cookie: `banana_actor=${sessionToken(userId)}` } : {}),
      ...extraHeaders,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
async function evaluate(
  body: unknown = input(),
  deps: { readBank?: BankReader; callModel?: ModelCall; now?: () => Date } = {},
  userId = 'lucia',
) {
  const response = await handleSpendLabRequest(
    request('spend-lab/evaluate', 'POST', body, userId),
    'spend-lab/evaluate',
    { now, readBank: bank, callModel: model, ...deps },
  );
  return { response, result: (await response.json()) as EvaluationResult };
}

test('SpendLab context exposes current bank data and a labeled demo budget without persistence', async () => {
  const response = await handleSpendLabRequest(
    request('spend-lab/context', 'GET'),
    'spend-lab/context',
    { now, readBank: bank },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const context = (await response.json()) as SpendLabContext;
  assert.equal(context.simulationStartDate, '2026-10-09');
  assert.equal(context.accounts[0].source, 'bank');
  assert.equal(context.accounts[0].balanceCents, 300000);
  assert.equal(context.demoBudget?.source, 'demo');
  assert.equal(context.history.from, '2026-09-01T12:00:00Z');
  assert.equal(context.history.count, 1);
  assert.equal(context.activity[0].source, 'bank');
  assert.deepEqual(fs.readdirSync(temp), []);
});

test('SpendLab workflow calls the model once and does not reapply historical spending', async () => {
  let calls = 0;
  let clocks = 0;
  const { response, result } = await evaluate(input(), {
    now: () => {
      clocks++;
      return now();
    },
    callModel: async (payload) => {
      calls++;
      assert.equal(payload.observations[0].amountCents, -999999);
      assert.equal(payload.budget.source, 'user');
      assert.equal(
        payload.evidence.find((evidence) => evidence.id === 'buy_now.minimumBalanceCents')?.value,
        120000,
      );
      assert.match(
        payload.evidence.find((evidence) => evidence.id === 'wait.reserveGapCents')!.meaning,
        /€900\.00 ABOVE/,
      );
      return reflection();
    },
  });
  assert.equal(response.status, 200);
  assert.equal(result.status, 'complete');
  if (result.status !== 'complete') assert.fail('Missing evaluation');
  assert.equal(calls, 1);
  assert.equal(clocks, 1);
  assert.equal(result.userId, 'lucia');
  assert.ok(result.runId);
  assert.equal(result.calculation.startingBalanceCents, 300000);
  assert.equal(result.assessment.status, 'available');
  assert.equal(
    result.calculation.scenarios[0].available &&
      result.calculation.scenarios[0].minimumBalanceCents,
    120000,
  );
  assert.deepEqual(fs.readdirSync(temp), []);
});

test('SpendLab refreshes bank balances for each evaluation and only totals selected own accounts', async () => {
  let balance = 300000;
  const reader: BankReader = async (userId, endpoint) =>
    endpoint === '/v1/accounts'
      ? [account(userId, balance), account(userId, 500000, 'savings')]
      : [];
  const first = (await evaluate(input(), { readBank: reader })).result;
  balance = 310000;
  const second = (await evaluate(input(), { readBank: reader })).result;
  assert.equal(first.status, 'complete');
  assert.equal(second.status, 'complete');
  if (first.status !== 'complete' || second.status !== 'complete') assert.fail();
  assert.equal(first.calculation.startingBalanceCents, 300000);
  assert.equal(second.calculation.startingBalanceCents, 310000);
  const both = input();
  both.accountIds.push('savings');
  const combined = (await evaluate(both, { readBank: reader })).result;
  assert.ok(combined.status === 'complete');
  assert.equal(combined.calculation.startingBalanceCents, 810000);
});

test('SpendLab asks for missing data without invoking the model and permits explicit zero reserve', async () => {
  let calls = 0;
  const callModel: ModelCall = async () => {
    calls++;
    return reflection();
  };
  const missing = await evaluate(
    { ...input(), accountIds: [], budget: null, reserveCents: null },
    { callModel },
    'bruno',
  );
  assert.equal(missing.response.status, 200);
  assert.equal(missing.result.status, 'needs_input');
  if (missing.result.status !== 'needs_input') assert.fail();
  assert.deepEqual(missing.result.missingFields, ['accountIds', 'budget', 'reserveCents']);
  assert.equal(missing.result.context.demoBudget, null);
  assert.equal(calls, 0);
  const zero = await evaluate({ ...input(), reserveCents: 0 }, { callModel });
  assert.equal(zero.result.status, 'complete');
  assert.equal(calls, 1);
});

test('SpendLab uses Lucía demo assumptions only when budget is null and accepts other customers manual input', async () => {
  const demo = await evaluate({ ...input(), budget: null });
  assert.ok(demo.result.status === 'complete');
  assert.equal(demo.result.calculationInput.budget.source, 'demo');
  const manual = await evaluate({ ...input(), accountIds: ['acc-bruno'] }, {}, 'bruno');
  assert.ok(manual.result.status === 'complete');
  assert.equal(manual.result.context.demoBudget, null);
  assert.equal(manual.result.calculationInput.budget.source, 'user');
});

test('SpendLab enforces session, customer role, origin and HTTP methods before reading bank data', async () => {
  let reads = 0;
  const readBank: BankReader = async () => {
    reads++;
    return [];
  };
  for (const [req, route, status] of [
    [request('spend-lab/context', 'GET', undefined, null), 'spend-lab/context', 401],
    [request('spend-lab/context', 'GET', undefined, 'marta'), 'spend-lab/context', 403],
    [
      request('spend-lab/evaluate', 'POST', input(), 'lucia', {
        origin: 'https://foreign.example',
      }),
      'spend-lab/evaluate',
      403,
    ],
    [
      request('spend-lab/evaluate', 'POST', input(), 'lucia', { origin: 'malformed' }),
      'spend-lab/evaluate',
      403,
    ],
    [request('spend-lab/context', 'POST', input()), 'spend-lab/context', 405],
    [request('spend-lab/evaluate', 'GET'), 'spend-lab/evaluate', 405],
    [request('spend-lab/unknown', 'GET'), 'spend-lab/unknown', 404],
  ] as const) {
    const response = await handleSpendLabRequest(req, route, { now, readBank });
    assert.equal(response.status, status);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.ok((await response.json()).runId);
  }
  assert.equal(reads, 0);
  const badSession = request('spend-lab/context', 'GET');
  badSession.headers.set('cookie', 'banana_actor=bruno.invalid');
  assert.equal(
    (await handleSpendLabRequest(badSession, 'spend-lab/context', { readBank })).status,
    401,
  );
});

test('SpendLab rejects foreign accounts and malformed fields before any model invocation', async () => {
  let calls = 0;
  const callModel: ModelCall = async () => {
    calls++;
    return reflection();
  };
  const foreign = await evaluate({ ...input(), accountIds: ['acc-bruno'] }, { callModel });
  assert.equal(foreign.response.status, 403);
  const stale = await evaluate(
    { ...input(), resale: { amountCents: 50000, date: '2026-10-08' } },
    { callModel },
  );
  assert.equal(stale.response.status, 400);
  const staleBody = stale.result as unknown as { fields: { field: string }[] };
  assert.ok(staleBody.fields.some((issue) => issue.field === 'resale.date'));
  const injected = await evaluate({ ...input(), startingBalanceCents: 99999999 }, { callModel });
  assert.equal(injected.response.status, 400);
  const malformed = new Request('http://localhost/api/spend-lab/evaluate', {
    method: 'POST',
    headers: { cookie: `banana_actor=${sessionToken('lucia')}` },
    body: '{',
  });
  assert.equal(
    (
      await handleSpendLabRequest(malformed, 'spend-lab/evaluate', {
        now,
        readBank: bank,
        callModel,
      })
    ).status,
    400,
  );
  assert.equal(calls, 0);
});

test('SpendLab can proceed without movements, but not without valid bank balances', async () => {
  const unavailableHistory: BankReader = async (userId, endpoint) => {
    if (endpoint === '/v1/movements') throw new BankError(503, 'History offline');
    return [account(userId)];
  };
  const history = await evaluate(input(), { readBank: unavailableHistory });
  assert.ok(history.result.status === 'complete');
  assert.equal(history.result.context.history.status, 'unavailable');
  assert.deepEqual(history.result.context.activity, []);
  for (const status of [503, 504]) {
    const readBank: BankReader = async () => {
      throw new BankError(status, 'Offline');
    };
    assert.equal((await evaluate(input(), { readBank })).response.status, status);
  }
  for (const invalid of [
    [account('bruno')],
    [{ ...account(), balanceCents: 1.5 }],
    [account(), account()],
  ]) {
    const readBank: BankReader = async (_userId, endpoint) =>
      endpoint === '/v1/accounts' ? invalid : [];
    assert.equal((await evaluate(input(), { readBank })).response.status, 502);
  }
});

test('SpendLab never exposes another holder movements and retains limited-history coverage', async () => {
  const readBank: BankReader = async (_userId, endpoint) =>
    endpoint === '/v1/accounts'
      ? [account()]
      : [
          {
            id: 'foreign',
            accountId: 'acc-bruno',
            operationId: null,
            amountCents: 100,
            description: 'Must not be exposed',
            createdAt: '2026-10-01T12:00:00Z',
          },
        ];
  const foreign = await evaluate(input(), { readBank });
  assert.ok(foreign.result.status === 'complete');
  assert.equal(foreign.result.context.history.status, 'unavailable');
  assert.deepEqual(foreign.result.context.activity, []);
  const many: BankReader = async (_userId, endpoint) =>
    endpoint === '/v1/accounts'
      ? [account()]
      : Array.from({ length: 100 }, (_, index) => ({
          id: `movement-${index}`,
          accountId: 'acc-lucia',
          operationId: null,
          amountCents: -1,
          description: 'Observed',
          createdAt: `2026-09-01T12:00:${String(index % 60).padStart(2, '0')}Z`,
        }));
  const limited = await evaluate(input(), { readBank: many });
  assert.ok(limited.result.status === 'complete');
  assert.equal(limited.result.context.history.count, 100);
  assert.equal(limited.result.context.history.mayBeTruncated, true);
  assert.equal(limited.result.context.activity.length, 5);
});

test('SpendLab changes personal interpretation for different motives while keeping identical calculations', async () => {
  const enjoyment = await evaluate();
  const work = await evaluate({
    ...input(),
    purchase: {
      ...input().purchase,
      motive: 'work_study',
      context: 'My phone is broken and I need it for work.',
    },
  });
  assert.ok(enjoyment.result.status === 'complete' && work.result.status === 'complete');
  assert.deepEqual(enjoyment.result.calculation, work.result.calculation);
  assert.ok(
    enjoyment.result.assessment.status === 'available' &&
      work.result.assessment.status === 'available',
  );
  assert.notEqual(
    enjoyment.result.assessment.reflection.motiveInterpretation,
    work.result.assessment.reflection.motiveInterpretation,
  );
  assert.notEqual(
    enjoyment.result.assessment.reflection.reflectionQuestion,
    work.result.assessment.reflection.reflectionQuestion,
  );
  assert.match(reflectionInstructions, /Do not invent/);
  assert.match(reflectionInstructions, /never instructions/);
});

test('SpendLab preserves calculations after provider failures, invalid evidence or incompatible preferences', async () => {
  const baseline = await evaluate();
  assert.ok(baseline.result.status === 'complete');
  const badOutputs = [
    null,
    {
      ...reflection(),
      financialTradeoffs: [{ text: 'Invented benefit', evidenceIds: ['phone.extraIncome'] }],
    },
    { ...reflection(), preferredScenarioId: 'buy_now' },
    { ...reflection(), reflectionQuestion: '' },
    { ...reflection(), financialTradeoffs: [] },
  ];
  for (const output of badOutputs) {
    let calls = 0;
    const invalid = await evaluate(input(), {
      callModel: async () => {
        calls++;
        return output;
      },
    });
    assert.ok(invalid.result.status === 'complete');
    assert.deepEqual(invalid.result.assessment, {
      status: 'unavailable',
      reason: 'invalid_output',
    });
    assert.deepEqual(invalid.result.calculation, baseline.result.calculation);
    assert.equal(calls, 1);
  }
  const provider = await evaluate(input(), {
    callModel: async () => {
      throw new Error('Provider down');
    },
  });
  assert.ok(provider.result.status === 'complete');
  assert.deepEqual(provider.result.assessment, { status: 'unavailable', reason: 'provider_error' });
  const timeout = await evaluate(input(), {
    callModel: async () => {
      const error = new Error('Timed out');
      error.name = 'TimeoutError';
      throw error;
    },
  });
  assert.ok(timeout.result.status === 'complete');
  assert.deepEqual(timeout.result.assessment, { status: 'unavailable', reason: 'timeout' });
});

test('SpendLab rejects preferences for unavailable sale or wait scenarios and allows keeping the phone', async () => {
  const noSale = await evaluate({ ...input(), resale: null });
  assert.ok(noSale.result.status === 'complete');
  assert.deepEqual(noSale.result.assessment, { status: 'unavailable', reason: 'invalid_output' });
  const noWait = await evaluate(
    { ...input(), reserveCents: 10000000 },
    {
      callModel: async () => ({ ...reflection(), preferredScenarioId: 'wait' }),
    },
  );
  assert.ok(noWait.result.status === 'complete');
  assert.deepEqual(noWait.result.assessment, { status: 'unavailable', reason: 'invalid_output' });
  const keep = await evaluate(input(), {
    callModel: async () => ({ ...reflection(), preferredScenarioId: 'baseline' }),
  });
  assert.ok(keep.result.status === 'complete');
  assert.equal(keep.result.assessment.status, 'available');
});

test('SpendLab SDK call uses structured output, configured model and no tools or stored response', async () => {
  const evaluation = (await evaluate()).result;
  assert.ok(evaluation.status === 'complete');
  const payload = buildInterpretationInput(
    evaluation.calculationInput,
    evaluation.calculation,
    evaluation.context,
    evaluation.input.accountIds,
  );
  let calls = 0;
  let sent: Record<string, any> = {};
  const client = new OpenAI({
    apiKey: 'test-only-key',
    fetch: async (_url, options) => {
      calls++;
      sent = JSON.parse(String(options!.body));
      return Response.json({
        id: 'response-test',
        status: 'completed',
        output: [
          {
            type: 'message',
            id: 'message-test',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: JSON.stringify(reflection()), annotations: [] }],
          },
        ],
      });
    },
  });
  const parsed = await callOpenAI(payload, client);
  assert.deepEqual(parsed, reflection());
  assert.equal(calls, 1);
  assert.equal(sent.model, config.chatModel);
  assert.equal(sent.store, false);
  assert.equal(sent.reasoning.effort, 'low');
  assert.equal(sent.max_output_tokens, 1800);
  assert.equal(sent.text.format.type, 'json_schema');
  assert.equal(sent.text.format.strict, true);
  assert.deepEqual(sent.text.format.schema.properties.preferredScenarioId.anyOf[0].enum, [
    'baseline',
    'sell_first',
    'wait',
  ]);
  assert.ok(
    sent.text.format.schema.properties.financialTradeoffs.items.properties.evidenceIds.items.enum.includes(
      'sell_first.netOutlayCents',
    ),
  );
  assert.equal(sent.tools, undefined);
  assert.equal(sent.previous_response_id, undefined);
  assert.equal(JSON.stringify(payload).includes('ES91-test'), false);
  let failedCalls = 0;
  const unavailable = new OpenAI({
    apiKey: 'test-only-key',
    maxRetries: 2,
    fetch: async () => {
      failedCalls++;
      return Response.json({ error: { message: 'Unavailable' } }, { status: 503 });
    },
  });
  await assert.rejects(callOpenAI(payload, unavailable));
  assert.equal(failedCalls, 1);
});

test('SpendLab detects SDK refusal and incomplete output without replacing the numeric result', async () => {
  const base = (await evaluate()).result;
  assert.ok(base.status === 'complete');
  for (const [status, content, reason] of [
    ['completed', [{ type: 'refusal', refusal: 'Cannot answer' }], 'refusal'],
    [
      'incomplete',
      [{ type: 'output_text', text: JSON.stringify(reflection()), annotations: [] }],
      'incomplete',
    ],
  ] as const) {
    const client = new OpenAI({
      apiKey: 'test-only-key',
      fetch: async () =>
        Response.json({
          id: 'response-test',
          status,
          output: [{ type: 'message', id: 'message-test', role: 'assistant', content }],
        }),
    });
    const evaluation = await evaluate(input(), {
      callModel: (payload) => callOpenAI(payload, client),
    });
    assert.ok(evaluation.result.status === 'complete');
    assert.deepEqual(evaluation.result.assessment, { status: 'unavailable', reason });
    assert.deepEqual(evaluation.result.calculation, base.calculation);
  }
});

test('SpendLab is dispatched by the real catch-all without opening app DB or sending bank POSTs', async () => {
  const originalFetch = globalThis.fetch;
  const key = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  const reads: { path: string; method: string; userId: string | null }[] = [];
  globalThis.fetch = async (url, options) => {
    const endpoint = new URL(String(url)).pathname;
    const headers = new Headers(options?.headers);
    reads.push({
      path: endpoint,
      method: options?.method ?? 'GET',
      userId: headers.get('x-bank-actor'),
    });
    assert.ok(['/v1/accounts', '/v1/movements'].includes(endpoint));
    assert.equal(options?.method, 'GET');
    return Response.json(await bank('lucia', endpoint as '/v1/accounts' | '/v1/movements'));
  };
  try {
    const route = { params: Promise.resolve({ path: ['spend-lab', 'context'] }) };
    const context = await GET(request('spend-lab/context', 'GET'), route);
    assert.equal(context.status, 200);
    const current = (await context.json()) as SpendLabContext;
    const payload = { ...input(), budget: null, resale: null };
    const evaluation = await POST(request('spend-lab/evaluate', 'POST', payload), {
      params: Promise.resolve({ path: ['spend-lab', 'evaluate'] }),
    });
    assert.equal(evaluation.status, 200);
    const result = (await evaluation.json()) as EvaluationResult;
    assert.ok(result.status === 'complete');
    assert.deepEqual(result.assessment, { status: 'unavailable', reason: 'missing_key' });
    assert.equal(result.context.simulationStartDate, current.simulationStartDate);
    assert.equal(result.calculation.startingBalanceCents, 300000);
    assert.equal(reads.length, 4);
    assert.ok(reads.every((read) => read.method === 'GET' && read.userId === 'lucia'));
    assert.deepEqual(fs.readdirSync(temp), []);
  } finally {
    globalThis.fetch = originalFetch;
    if (key !== undefined) process.env.OPENAI_API_KEY = key;
  }
});

test(
  'SpendLab live model produces contextual reflection for two motives with the same finances',
  {
    skip: process.env.BANANA_SPEND_LAB_LIVE_MODEL !== '1',
  },
  async () => {
    const liveModel: ModelCall = async (payload) => {
      const output = await callOpenAI(payload);
      console.log(
        'spend-lab.model.evidence',
        JSON.stringify({ motive: payload.purchase.motive, output }),
      );
      return output;
    };
    const enjoyment = await evaluate(input(), { callModel: liveModel });
    const work = await evaluate(
      {
        ...input(),
        purchase: {
          ...input().purchase,
          motive: 'work_study',
          context: 'My phone is broken and I need it for work.',
        },
      },
      { callModel: liveModel },
    );
    assert.ok(enjoyment.result.status === 'complete' && work.result.status === 'complete');
    assert.deepEqual(enjoyment.result.calculation, work.result.calculation);
    assert.ok(
      enjoyment.result.assessment.status === 'available',
      JSON.stringify(enjoyment.result.assessment),
    );
    assert.ok(
      work.result.assessment.status === 'available',
      JSON.stringify(work.result.assessment),
    );
    assert.notEqual(
      enjoyment.result.assessment.reflection.motiveInterpretation,
      work.result.assessment.reflection.motiveInterpretation,
    );
    assert.notEqual(
      enjoyment.result.assessment.reflection.reflectionQuestion,
      work.result.assessment.reflection.reflectionQuestion,
    );
    for (const assessment of [enjoyment.result.assessment, work.result.assessment]) {
      assert.doesNotMatch(
        JSON.stringify(assessment.reflection),
        /900[^.!?]{0,30}\bbelow\b|\bbelow[^.!?]{0,30}900/i,
        'A €900 reserve surplus must not be described as a deficit.',
      );
      for (const tradeoff of assessment.reflection.financialTradeoffs)
        assert.match(
          tradeoff.text,
          /[.!?]$/,
          'Complete the tradeoff sentence within its character limit.',
        );
    }
    console.log(
      'spend-lab.analysis.evidence',
      JSON.stringify({
        enjoyment: enjoyment.result.assessment.reflection,
        work: work.result.assessment.reflection,
      }),
    );
  },
);

after(() => fs.rmSync(temp, { recursive: true, force: true }));
