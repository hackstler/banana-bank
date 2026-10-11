export const methodology = {
  version: 'spend-lab-method-v1.1',
  principles: [
    'Consider when money arrives and when payments are due, not just whether the monthly total balances.',
    'Keep accessible money for unexpected costs. The appropriate cushion depends on your circumstances.',
    'Emergency-fund references discuss three to six months of normal expenses. Our three-month essentials suggestion is a simplified starting point you can change.',
    'Financial capacity and personal usefulness are separate: enjoyment can be a valid reason to buy.',
  ],
  assumptions: [
    'We project 90 days from today using selected bank balances and your estimates (or an explicitly loaded demo budget). This is not a verified forecast or bank policy.',
    'For simplicity, income and necessary expenses repeat monthly. All necessary costs are grouped into one payment on your chosen date.',
    'We divide optional monthly spending across each calendar day, including only the days remaining in the current month.',
    'With no payment times available, we assume expenses leave first, then the purchase is paid, then income arrives. This conservative order can expose a shortfall even if the day ends positive.',
    'Sell first assumes payment from the declared sale immediately before buying, after that day’s planned expenses. That sale is not guaranteed.',
    'Wait searches at most 60 days within the same 90-day window, not 90 new days after buying. Risks beyond that window are not assessed.',
    'A purchase fits when no balance is negative during the whole window and your chosen cushion is preserved from purchase onward. Earlier cushion problems remain visible and are not fixed by waiting.',
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
