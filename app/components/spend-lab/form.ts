import { z } from 'zod';
import { evaluationInputSchema, purchaseV11Schema } from '../../../src/spend-lab/contracts';
import type {
  EvaluationInput,
  EvaluationResult,
  SpendLabContext,
  ProductCategory,
} from '../../../src/spend-lab/contracts';
import { calculateScenarios } from '../../../src/spend-lab/engine';

export type FormValues = {
  category: ProductCategory | '';
  productName: string;
  price: string;
  motive: EvaluationInput['purchase']['motive'] | '';
  context: string;
  accountIds: string[];
  income: string;
  essentials: string;
  discretionary: string;
  incomeDate: string;
  essentialsDate: string;
  reserve: string;
  selling: boolean;
  saleAmount: string;
  saleDate: string;
  useDemo: boolean;
};
export const emptyForm: FormValues = {
  category: '',
  productName: '',
  price: '',
  motive: '',
  context: '',
  accountIds: [],
  income: '',
  essentials: '',
  discretionary: '',
  incomeDate: '',
  essentialsDate: '',
  reserve: '',
  selling: false,
  saleAmount: '',
  saleDate: '',
  useDemo: false,
};
export type FieldErrors = Record<string, string>;
export type CompleteEvaluation = Extract<EvaluationResult, { status: 'complete' }>;

export const productOptions = [
  {
    id: 'mobile',
    label: 'Phones',
    icon: 'phone',
    placeholder: 'iPhone 17',
    context: 'How would you use it? What would change from what you have now?',
  },
  {
    id: 'computer',
    label: 'Computers',
    icon: 'computer',
    placeholder: 'MacBook Air',
    context: 'What work, study or personal use would it help with? What is missing today?',
  },
  {
    id: 'gaming',
    label: 'Gaming & consoles',
    icon: 'gaming',
    placeholder: 'Nintendo Switch 2',
    context: 'What would you like to play or enjoy? How would it fit into your free time?',
  },
  {
    id: 'other_tech',
    label: 'Other tech',
    icon: 'other',
    placeholder: 'Headphones…',
    context: 'What would you use it for? What would it add to your everyday life?',
  },
] as const;

export const money = (cents: number) =>
  new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(cents / 100);
export const shortDate = (value: string) =>
  new Intl.DateTimeFormat('en-IE', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(new Date(`${value.slice(0, 10)}T00:00:00Z`));

// Parse decimal text, not floating-point euro arithmetic. No thousands or exponent notation.
export function euroCents(value: string): number {
  const normalized = value.trim().replace(',', '.');
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return NaN;
  const [whole, decimal = ''] = normalized.split('.');
  const cents = Number(whole) * 100 + Number(decimal.padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : NaN;
}

export function demoFields(context: SpendLabContext): Partial<FormValues> {
  const budget = context.demoBudget?.values;
  if (!budget) return {};
  return {
    income: (budget.monthlyIncomeCents / 100).toFixed(2),
    essentials: (budget.monthlyEssentialExpensesCents / 100).toFixed(2),
    discretionary: (budget.monthlyDiscretionaryExpensesCents / 100).toFixed(2),
    incomeDate: budget.nextIncomeDate ?? '',
    essentialsDate: budget.nextEssentialExpensesDate ?? '',
    useDemo: true,
  };
}

function issues(error: z.ZodError, prefix = ''): FieldErrors {
  return Object.fromEntries(
    error.issues.map((issue) => [`${prefix}${issue.path.join('.')}`, issue.message]),
  );
}

export function validatePurchase(form: FormValues): FieldErrors {
  const parsed = purchaseV11Schema.safeParse({
    category: form.category,
    productName: form.productName,
    amountCents: euroCents(form.price),
    motive: form.motive,
    context: form.context,
  });
  return parsed.success ? {} : issues(parsed.error, 'purchase.');
}

export function evaluationFromForm(
  form: FormValues,
  context: SpendLabContext,
): { success: true; input: EvaluationInput } | { success: false; errors: FieldErrors } {
  const income = euroCents(form.income);
  const essentials = euroCents(form.essentials);
  const parsed = evaluationInputSchema(context.simulationStartDate).safeParse({
    purchase: {
      category: form.category,
      productName: form.productName,
      amountCents: euroCents(form.price),
      motive: form.motive,
      context: form.context,
    },
    accountIds: form.accountIds,
    budget:
      form.useDemo && context.demoBudget
        ? null
        : {
            monthlyIncomeCents: income,
            monthlyEssentialExpensesCents: essentials,
            monthlyDiscretionaryExpensesCents: euroCents(form.discretionary),
            nextIncomeDate: income === 0 ? null : form.incomeDate,
            nextEssentialExpensesDate: essentials === 0 ? null : form.essentialsDate,
          },
    reserveCents: form.reserve.trim() === '' ? null : euroCents(form.reserve),
    resale: form.selling ? { amountCents: euroCents(form.saleAmount), date: form.saleDate } : null,
  });
  if (!parsed.success) return { success: false, errors: issues(parsed.error) };
  const errors: FieldErrors = {};
  if (!parsed.data.accountIds.length) errors.accountIds = 'Choose at least one account to use.';
  if (parsed.data.accountIds.some((id) => !context.accounts.some((account) => account.id === id)))
    errors.accountIds = 'Choose an account from the current bank data.';
  if (parsed.data.reserveCents === null)
    errors.reserveCents = 'Choose your reserve, including zero if intended.';
  return Object.keys(errors).length
    ? { success: false, errors }
    : { success: true, input: parsed.data };
}

export function previewFromForm(form: FormValues, result: CompleteEvaluation) {
  const parsed = evaluationFromForm(form, result.context);
  if (!parsed.success) return { calculation: null, errors: parsed.errors };
  const budget = parsed.input.budget
    ? { source: 'user' as const, version: null, values: parsed.input.budget }
    : result.context.demoBudget;
  if (!budget || parsed.input.reserveCents === null)
    return {
      calculation: null,
      errors: { budget: 'Complete your budget to compare the alternatives.' },
    };
  try {
    const startingBalanceCents = parsed.input.accountIds.reduce(
      (sum, id) => sum + result.context.accounts.find((account) => account.id === id)!.balanceCents,
      0,
    );
    return {
      calculation: calculateScenarios({
        simulationStartDate: result.context.simulationStartDate,
        startingBalanceCents,
        budget,
        purchase: parsed.input.purchase,
        reserveCents: parsed.input.reserveCents,
        resale: parsed.input.resale,
      }),
      errors: {} as FieldErrors,
    };
  } catch {
    return { calculation: null, errors: { '': 'These amounts cannot be projected safely.' } };
  }
}
