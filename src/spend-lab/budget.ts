import { z } from 'zod';
import fixture from '../../fixtures/spend-lab/lucia.json';
import { budgetSchema } from './contracts';
import type { Budget, ResolvedBudget } from './contracts';
import { nextMonthlyDate } from './dates';

const demoSchema = z.strictObject({
  userId: z.literal('lucia'),
  version: z.literal('spend-lab-demo-v1'),
  monthlyIncomeCents: z.number().int().min(1).max(10000000),
  monthlyEssentialExpensesCents: z.number().int().min(1).max(10000000),
  monthlyDiscretionaryExpensesCents: z.number().int().min(0).max(10000000),
  incomeDay: z.number().int().min(1).max(31),
  essentialExpensesDay: z.number().int().min(1).max(31),
});

export function resolveBudget(
  userId: string,
  manual: Budget | null,
  start: string,
  demoInput: unknown = fixture,
): ResolvedBudget | null {
  if (manual !== null)
    return { source: 'user', version: null, values: budgetSchema(start).parse(manual) };
  if (userId !== 'lucia') return null;
  const parsedDemo = demoSchema.safeParse(demoInput);
  if (!parsedDemo.success) return null;
  const demo = parsedDemo.data;
  return {
    source: 'demo',
    version: demo.version,
    values: budgetSchema(start).parse({
      monthlyIncomeCents: demo.monthlyIncomeCents,
      monthlyEssentialExpensesCents: demo.monthlyEssentialExpensesCents,
      monthlyDiscretionaryExpensesCents: demo.monthlyDiscretionaryExpensesCents,
      nextIncomeDate: nextMonthlyDate(start, demo.incomeDay),
      nextEssentialExpensesDate: nextMonthlyDate(start, demo.essentialExpensesDay),
    }),
  };
}
