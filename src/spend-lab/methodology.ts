export const methodology = {
  version: 'spend-lab-method-v1',
  assumptions: [
    'This is a cash-flow projection from current bank balances, not a profit forecast or bank policy.',
    'Budget amounts and future dates are demo or user assumptions, not verified recurring bank transactions.',
    'Monthly essentials are aggregated on one date; discretionary spending is spread across calendar days.',
    'Each day applies commitments, purchase and then income. Sell first credits the declared sale immediately before purchase.',
    'The suggested reserve is three months of essential expenses; the customer chooses the actual reserve.',
    'Wait searches the next 60 days and checks liquidity through a common 90-day horizon, including intraday lows.',
    'A phone can be worth buying for personal reasons. Financial capacity and its personal value are separate questions.',
  ],
  sources: [
    {
      title: 'CFPB — Cash flow budget',
      url: 'https://files.consumerfinance.gov/f/documents/cfpb_your-money-your-goals_cash_flow_budget_tool_2018-11_ADA.pdf',
    },
    {
      title: 'Banco de España — Savings and goals',
      url: 'https://clientebancario.bde.es/f/webcb/RCL/ActualidadEducacionFinanciera/EducacionFinanciera/QueSeHace/Actividades/02_Ahorro_y_objetivos.pdf',
    },
    {
      title: 'CFPB — Financial well-being',
      url: 'https://www.consumerfinance.gov/consumer-tools/financial-well-being/about/',
    },
    {
      title: 'OpenStax — Choices under a budget constraint',
      url: 'https://openstax.org/books/principles-economics-2e/pages/2-1-how-individuals-make-choices-based-on-their-budget-constraint',
    },
  ],
} as const;
