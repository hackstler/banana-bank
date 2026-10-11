import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { actor, HttpError, sameOrigin } from '../auth';
import { traceLog, errorDetails } from '../trace';
import { resolveBudget } from './budget';
import { evaluationInputSchema } from './contracts';
import type { CalculationInput, EvaluationResult } from './contracts';
import { loadContext } from './context';
import type { BankReader } from './context';
import { captureSimulationClock } from './dates';
import { calculateScenarios } from './engine';
import { buildInterpretationInput, interpretPurchase } from './interpretation';
import type { ModelCall } from './interpretation';
import { methodology } from './methodology';

type Dependencies = { now?: () => Date; readBank?: BankReader; callModel?: ModelCall };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });

export async function handleSpendLabRequest(
  request: Request,
  route: string,
  deps: Dependencies = {},
): Promise<Response> {
  const runId = randomUUID();
  const started = Date.now();
  let userId: string | null = null;
  try {
    const current = actor(request);
    userId = current.id;
    if (current.role !== 'customer')
      throw new HttpError(403, 'Spend Lab requires a customer account.');
    const expectedMethod =
      route === 'spend-lab/context' ? 'GET' : route === 'spend-lab/evaluate' ? 'POST' : null;
    if (expectedMethod === null) throw new HttpError(404, 'Spend Lab route not found.');
    if (request.method !== expectedMethod)
      return json({ error: 'Method not allowed.', runId, userId }, 405, { Allow: expectedMethod });
    if (request.method === 'POST') {
      try {
        sameOrigin(request);
      } catch {
        throw new HttpError(403, 'Origin not allowed.');
      }
    }
    const clock = captureSimulationClock(deps.now);
    traceLog('spend-lab', 'run.started', {
      runId,
      userId,
      route,
      simulationStartDate: clock.simulationStartDate,
    });
    if (request.method === 'GET') {
      const context = await loadContext(userId, clock, deps.readBank);
      traceLog('spend-lab', 'context.completed', {
        runId,
        userId,
        durationMs: Date.now() - started,
        history: context.history.status,
      });
      return json({ ...context, runId });
    }
    const input = evaluationInputSchema(clock.simulationStartDate).parse(await request.json());
    const context = await loadContext(userId, clock, deps.readBank);
    const ownAccounts = new Map(context.accounts.map((account) => [account.id, account]));
    if (input.accountIds.some((id) => !ownAccounts.has(id)))
      throw new HttpError(403, 'Select only your own accounts.');
    const budget = resolveBudget(userId, input.budget, clock.simulationStartDate);
    const missingFields: Extract<EvaluationResult, { status: 'needs_input' }>['missingFields'] = [];
    if (input.accountIds.length === 0) missingFields.push('accountIds');
    if (budget === null) missingFields.push('budget');
    if (input.reserveCents === null) missingFields.push('reserveCents');
    if (missingFields.length || budget === null || input.reserveCents === null) {
      traceLog('spend-lab', 'run.needs_input', {
        runId,
        userId,
        missingFields,
        durationMs: Date.now() - started,
      });
      const result: EvaluationResult = {
        status: 'needs_input',
        runId,
        userId,
        context,
        missingFields,
      };
      return json(result);
    }
    let startingBalanceCents = 0;
    for (const id of input.accountIds) {
      startingBalanceCents += ownAccounts.get(id)!.balanceCents;
      if (!Number.isSafeInteger(startingBalanceCents))
        throw new HttpError(502, 'Bank balances cannot be safely combined.');
    }
    const calculationInput: CalculationInput = {
      simulationStartDate: clock.simulationStartDate,
      startingBalanceCents,
      budget,
      purchase: input.purchase,
      reserveCents: input.reserveCents,
      resale: input.resale,
    };
    const calculation = calculateScenarios(calculationInput);
    const interpretationInput = buildInterpretationInput(
      calculationInput,
      calculation,
      context,
      input.accountIds,
    );
    const assessment = await interpretPurchase(interpretationInput, deps.callModel);
    traceLog('spend-lab', 'run.completed', {
      runId,
      userId,
      durationMs: Date.now() - started,
      budgetSource: budget.source,
      demoVersion: budget.version,
      methodologyVersion: methodology.version,
      assessmentStatus: assessment.status,
      ...(assessment.status === 'unavailable' ? { assessmentReason: assessment.reason } : {}),
      scenarios: calculation.scenarios.map((scenario) => ({
        id: scenario.id,
        available: scenario.available,
        ...(scenario.available
          ? { flags: scenario.flags, financialClass: scenario.financialClass }
          : {}),
      })),
    });
    const result: EvaluationResult = {
      status: 'complete',
      runId,
      userId,
      evaluatedAt: clock.observedAt,
      input,
      context,
      calculationInput,
      calculation,
      assessment,
      evidence: interpretationInput.evidence,
      methodology,
    };
    return json(result);
  } catch (error) {
    traceLog('spend-lab', 'run.failed', {
      runId,
      userId,
      durationMs: Date.now() - started,
      error: errorDetails(error),
    });
    if (error instanceof z.ZodError)
      return json(
        {
          error: 'Check the purchase and budget fields.',
          runId,
          userId,
          fields: error.issues.map((issue) => ({
            field: issue.path.join('.'),
            message: issue.message,
          })),
        },
        400,
      );
    if (error instanceof SyntaxError || error instanceof RangeError)
      return json(
        {
          error: 'Invalid simulation data.',
          runId,
          userId,
          fields: [
            {
              field: '',
              message:
                error instanceof RangeError
                  ? 'These amounts cannot be projected safely.'
                  : 'Send valid JSON.',
            },
          ],
        },
        400,
      );
    if (error instanceof HttpError)
      return json({ error: error.message, runId, userId }, error.status);
    return json(
      { error: 'Spend Lab could not complete the evaluation. Please retry.', runId, userId },
      500,
    );
  }
}
