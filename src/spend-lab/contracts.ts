import { z } from 'zod';
import { addDays, isISODate, MAX_WAIT_DAYS } from './dates';
import type { Account } from '../types';

const safeCents = z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const budgetCents = safeCents.min(0).max(10000000);
const positiveCents = budgetCents.min(1);
const isoDate = z.string().refine(isISODate, 'Use a valid YYYY-MM-DD date');

const legacyPurchaseSchema = z.strictObject({
  amountCents: positiveCents,
  motive: z.enum(['replace_broken', 'work_study', 'upgrade', 'treat']),
  context: z.string().trim().max(1000).optional().default(''),
});

export const productCategorySchema = z.enum(['mobile', 'computer', 'gaming', 'other_tech']);
const productNameSchema = z.string().trim().min(1, 'Name the product you have in mind.').max(160);
export const purchaseV11Schema = legacyPurchaseSchema.extend({
  category: productCategorySchema,
  productName: productNameSchema,
});
export const purchaseSchema = legacyPurchaseSchema
  .extend({ category: productCategorySchema.optional(), productName: productNameSchema.optional() })
  .superRefine((purchase, ctx) => {
    if (purchase.category === undefined && purchase.productName !== undefined)
      ctx.addIssue({ code: 'custom', path: ['category'], message: 'Choose a product category.' });
    if (purchase.productName === undefined && purchase.category !== undefined)
      ctx.addIssue({
        code: 'custom',
        path: ['productName'],
        message: 'Name the product you have in mind.',
      });
  })
  .transform((purchase) => ({
    ...purchase,
    category: purchase.category ?? 'mobile',
    productName: purchase.productName ?? null,
  }));
const normalizedPurchaseSchema = legacyPurchaseSchema
  .extend({ category: productCategorySchema, productName: productNameSchema.nullable() })
  .refine((purchase) => purchase.productName !== null || purchase.category === 'mobile');
export const calculationPurchaseSchema = z.union([purchaseSchema, normalizedPurchaseSchema]);
export type Purchase = z.infer<typeof purchaseSchema>;
export type ProductCategory = z.infer<typeof productCategorySchema>;

function futureDate(start: string, maxDays: number) {
  const end = addDays(start, maxDays);
  return isoDate.refine(
    (value) => value >= start && value <= end,
    `Choose a date between ${start} and ${end}`,
  );
}

export function budgetSchema(start: string) {
  const nextDate = futureDate(start, 31).nullable();
  return z
    .strictObject({
      monthlyIncomeCents: budgetCents,
      monthlyEssentialExpensesCents: budgetCents,
      monthlyDiscretionaryExpensesCents: budgetCents,
      nextIncomeDate: nextDate,
      nextEssentialExpensesDate: nextDate,
    })
    .superRefine((values, ctx) => {
      for (const [amount, date] of [
        ['monthlyIncomeCents', 'nextIncomeDate'],
        ['monthlyEssentialExpensesCents', 'nextEssentialExpensesDate'],
      ] as const) {
        if ((values[amount] === 0) !== (values[date] === null))
          ctx.addIssue({
            code: 'custom',
            path: [date],
            message: 'A positive monthly amount needs a pending date; use null for zero.',
          });
      }
    });
}

function resaleSchema(start: string) {
  return z
    .strictObject({ amountCents: positiveCents, date: futureDate(start, MAX_WAIT_DAYS) })
    .nullable();
}

export function evaluationInputSchema(start: string) {
  return z.strictObject({
    purchase: purchaseSchema,
    accountIds: z
      .array(z.string().min(1))
      .max(12)
      .refine((ids) => new Set(ids).size === ids.length, 'Select each account once'),
    budget: budgetSchema(start).nullable(),
    reserveCents: safeCents.min(0).nullable(),
    resale: resaleSchema(start),
  });
}

export function calculationInputSchema(start: string) {
  return z.strictObject({
    simulationStartDate: z.literal(start),
    startingBalanceCents: safeCents,
    budget: z.strictObject({
      source: z.enum(['demo', 'user']),
      version: z.string().nullable(),
      values: budgetSchema(start),
    }),
    purchase: calculationPurchaseSchema,
    reserveCents: safeCents.min(0),
    resale: resaleSchema(start),
  });
}

export type Budget = z.infer<ReturnType<typeof budgetSchema>>;
export type EvaluationInput = z.infer<ReturnType<typeof evaluationInputSchema>>;
// Engine callers may still provide a legacy V1 purchase; parsing normalizes its metadata.
export type CalculationInput = z.input<ReturnType<typeof calculationInputSchema>>;
export type ResolvedBudget = CalculationInput['budget'];
export type Source = 'bank' | 'demo' | 'user';
export type ScenarioId = 'buy_now' | 'sell_first' | 'wait';
export type ViewedScenarioId = ScenarioId | 'baseline';
export type Evidence = {
  id: string;
  value: number | string | null;
  sources: Source[];
  meaning: string;
};
export type FinancialClass = 'cash_shortfall' | 'reserve_breach' | 'within_limits';

export type ProjectionEvent = {
  date: string;
  kind: 'essential' | 'discretionary' | 'purchase' | 'resale' | 'income';
  amountCents: number;
  balanceCents: number;
  source: Source;
};

export type DayBalance = {
  date: string;
  openingBalanceCents: number;
  closingBalanceCents: number;
  minimumBalanceCents: number;
};

export type Projection = {
  available: true;
  id: ScenarioId | 'baseline';
  purchaseDate: string | null;
  events: ProjectionEvent[];
  trajectory: DayBalance[];
  minimumBalanceCents: number;
  minimumAfterPurchaseCents: number | null;
  finalBalanceCents: number;
  financialClass: FinancialClass;
  flags: {
    preexistingCashShortfall: boolean;
    preexistingReserveBreach: boolean;
    addedCashShortfall: boolean;
    addedReserveBreach: boolean;
    dependsOnResale: boolean;
  };
  metrics: {
    netOutlayCents: number;
    marginSacrificedMonths: number | null;
    reserveGapCents: number;
    essentialCoverageMonths: number | null;
  };
};

export type UnavailableScenario = {
  available: false;
  id: ScenarioId;
  purchaseDate: null;
  reason: 'no_resale' | 'no_viable_date';
};

export type Scenario = Projection | UnavailableScenario;
export type CalculationResult = {
  simulationStartDate: string;
  horizonEnd: string;
  startingBalanceCents: number;
  startingBalanceSource: 'bank';
  budgetSource: ResolvedBudget['source'];
  budgetVersion: string | null;
  monthlyMarginCents: number;
  reserveCents: number;
  suggestedReserveCents: number;
  baseline: Projection;
  scenarios: [Scenario, Scenario, Scenario];
};

export const reflectionSchema = z.strictObject({
  headline: z.string().min(1).max(100),
  motiveInterpretation: z.string().min(1).max(400),
  preferredScenarioId: z.enum(['baseline', 'buy_now', 'sell_first', 'wait']).nullable(),
  recommendation: z.string().min(1).max(400),
  financialTradeoffs: z
    .array(
      z.strictObject({
        text: z.string().min(1).max(250),
        evidenceIds: z.array(z.string().min(1)).min(1).max(6),
      }),
    )
    .min(1)
    .max(2),
  reflectionQuestion: z.string().min(1).max(200),
});

export type Reflection = z.infer<typeof reflectionSchema>;
export type Assessment =
  | { status: 'available'; reflection: Reflection }
  | {
      status: 'unavailable';
      reason:
        'missing_key' | 'timeout' | 'refusal' | 'incomplete' | 'invalid_output' | 'provider_error';
    };

export type BankMovement = {
  id: string;
  accountId: string;
  operationId: string | null;
  amountCents: number;
  description: string;
  createdAt: string;
  source: 'bank';
};

export type SpendLabContext = {
  userId: string;
  observedAt: string;
  simulationStartDate: string;
  horizonEnd: string;
  accounts: (Account & { source: 'bank' })[];
  activity: BankMovement[];
  history: {
    source: 'bank';
    status: 'available' | 'unavailable';
    count: number;
    limit: 100;
    from: string | null;
    to: string | null;
    mayBeTruncated: boolean;
  };
  demoBudget: ResolvedBudget | null;
  budgetEvidence: BudgetEvidence;
};

export type ActivityGroup = {
  accountId: string;
  month: string;
  creditsCents: number;
  debitsCents: number;
  movementCount: number;
  from: string;
  to: string;
};
export type BudgetEvidence = {
  source: 'bank';
  status: 'available' | 'unavailable';
  coverage: SpendLabContext['history'];
  groups: ActivityGroup[];
};

export type EvaluationResult =
  | {
      status: 'complete';
      runId: string;
      userId: string;
      evaluatedAt: string;
      input: EvaluationInput;
      context: SpendLabContext;
      calculationInput: CalculationInput;
      calculation: CalculationResult;
      assessment: Assessment;
      evidence: Evidence[];
      methodology: {
        version: string;
        principles: readonly string[];
        assumptions: readonly string[];
        sources: readonly { title: string; url: string }[];
      };
    }
  | {
      status: 'needs_input';
      runId: string;
      userId: string;
      context: SpendLabContext;
      missingFields: ('accountIds' | 'budget' | 'reserveCents')[];
    };
