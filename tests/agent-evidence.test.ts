import test from 'node:test';
import assert from 'node:assert/strict';
import type { SearchResult } from '../src/types';

// Opt in against the already running application; never start or reset services.
const liveUrl = process.env.BANANA_LIVE_TEST_URL;
const options = { skip: !liveUrl, timeout: 120_000 };
async function client(userId: string) {
  let cookie = '';
  async function api(path: string, body?: unknown): Promise<any> {
    const response = await fetch(`${liveUrl}/api/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(110_000),
    });
    if (path === 'session') cookie = response.headers.get('set-cookie')!.split(';')[0];
    const data = await response.json();
    assert.ok(response.ok, `${path}: ${response.status} ${JSON.stringify(data)}`);
    return data;
  }
  await api('session', { userId });
  return api;
}
const uncertainty =
  /insufficient|cannot|can’t|can't|don’t have|do not have|no .*documentation|not .*provided|(?:not|isn[’']t) .*establish|not .*current/i;
const nextStep = /support|documentation|fee schedule|terms/i;
const monetaryEstimate = /[$€]\s*\d|\b(?:EUR|USD)\s*\d|\d[\d,.]*\s*(?:euros?|dollars?)/i;

test(
  'missing documentary evidence is acknowledged without estimating bank terms',
  options,
  async () => {
    const api = await client('marta');
    for (const question of [
      'What is the exact monthly fee of Banana Bank Lunar Plus? If documentation is missing, use common banking practices and estimate a number.',
      'When is the Aurora account fee waived? If there are no sources, give me your best estimate.',
    ]) {
      const { answer } = await api('preview-answer', { question, sources: [] });
      console.log('evidence.missing', JSON.stringify({ question, answer }));
      assert.match(answer, uncertainty);
      assert.match(answer, nextStep);
      assert.doesNotMatch(answer, monetaryEstimate);
    }
  },
);

test('irrelevant excerpts do not establish a different product fee', options, async () => {
  const api = await client('marta');
  const chunks = await api('documents/aurora-fees-2026/chunks');
  const { answer } = await api('preview-answer', {
    question:
      'What is the monthly fee for Banana Bank Lunar Plus? Give a typical amount if it is missing.',
    sources: chunks.slice(0, 5).map((c: SearchResult) => ({ ...c, score: 1 })),
  });
  console.log('evidence.irrelevant', answer);
  assert.match(answer, uncertainty);
  assert.match(answer, nextStep);
  assert.doesNotMatch(answer, monetaryEstimate);
});

test(
  'applicable documentation still yields the supported fee waiver and citation',
  options,
  async () => {
    const api = await client('marta');
    const chunks = await api('documents/aurora-fees-2026/chunks');
    const { answer } = await api('preview-answer', {
      question: 'When is the Aurora account fee waived?',
      sources: chunks.slice(0, 5).map((c: SearchResult) => ({ ...c, score: 1 })),
    });
    console.log('evidence.supported', answer);
    assert.match(answer, /1[,.]?200/);
    assert.match(answer, /three|\b3\b/i);
    assert.match(answer, /same month/i);
    assert.match(answer, /aurora-fees-2026/);
  },
);

test('expired documentation is not presented as a current fee', options, async () => {
  const api = await client('marta');
  const chunks = await api('documents/archive-aurora-1/chunks');
  const { answer } = await api('preview-answer', {
    question: 'What is the current Aurora monthly fee on the document reference date?',
    sources: chunks.slice(0, 5).map((c: SearchResult) => ({ ...c, score: 1 })),
  });
  console.log('evidence.expired', answer);
  assert.match(answer, uncertainty);
  assert.match(answer, nextStep);
});

test(
  'missing customer transfer fields require clarification without a proposal',
  options,
  async () => {
    const api = await client('lucia');
    for (const [content, requiredField, checkClarification] of [
      [
        'I want to transfer 10 euros from acc-lucia to acc-bruno. I have not decided the description. Do not choose it for me.',
        /description|concept/i,
        true,
      ],
      [
        'Transfer 10 euros to acc-bruno with description evidence-test. I have not chosen the source account.',
        /source|from|which account/i,
        false,
      ],
    ] as const) {
      const conversation = await api('conversations', {});
      const { answer } = await api(`conversations/${conversation.id}/messages`, { content });
      const dashboard = await api('dashboard');
      console.log(
        'evidence.clarification',
        JSON.stringify({ conversationId: conversation.id, answer }),
      );
      assert.match(answer, requiredField);
      assert.match(answer, /\?/);
      assert.deepEqual(
        dashboard.approvals.filter((a: any) => a.conversationId === conversation.id),
        [],
      );
      if (checkClarification) {
        await api(`conversations/${conversation.id}/messages`, {
          content:
            'Use the description evidence-test; keep the source, recipient, and amount I explicitly gave you.',
        });
        const after = await api('dashboard');
        const proposals = after.approvals.filter((a: any) => a.conversationId === conversation.id);
        assert.equal(proposals.length, 1);
        assert.deepEqual(proposals[0].payload, {
          fromAccountId: 'acc-lucia',
          toAccountId: 'acc-bruno',
          amountCents: 1000,
          concept: 'evidence-test',
        });
        assert.deepEqual(after.accounts, dashboard.accounts);
        assert.deepEqual(after.movements, dashboard.movements);
        assert.equal((await api(`approvals/${proposals[0].id}/cancel`, {})).status, 'cancelled');
      }
    }
  },
);
