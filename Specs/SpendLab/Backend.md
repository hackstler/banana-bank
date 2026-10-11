# SpendLab backend

The backend runs a small workflow: validate, fetch context, check the budget, calculate three scenarios and interpret the decision with a single AI call. [Plan](Plan.md) defines the scope and [Frontend](Frontend.md) consumes the contract.

The V1 section documents the original implementation saved in `d87a68e`. V1.1 describes the implemented extension, awaiting user review and a commit. Persistence is assessed separately and is not part of V1.1 unless explicitly decided. Checks and the demo are in [HowToDemo](../../docs/demo/HowToDemo.md).

## V1 · Original implementation

### Integration and sources

Logic stays in `src/spend-lab/`: shared schemas and types, context, pure engine, interpretation and workflow function. The existing API only dispatches its two endpoints to the module. Do not create a workflow framework or an additional architecture.

Reuse `actor`, `sameOrigin`, `HttpError`, `bankRequest`, `openai()`, `config.chatModel` and `traceLog`. Calculations and schemas used by the preview do not import the filesystem, SQLite, OpenAI SDK or server configuration. Do not modify `simulator/`, the existing agent or transfers.

Distinguish three sources:

| Source | Use                                                                 |
| ------ | ------------------------------------------------------------------- |
| `bank` | Current account balance and observed activity over HTTP.            |
| `demo` | Lucía's fictional budget, identified as demo assumptions.           |
| `user` | Price, motive, context, manual budget, reserve and expected resale. |

`GET /v1/accounts` is essential. Selected IDs must belong to the accounts returned for the session. `GET /v1/movements` provides limited context: preserve its coverage of up to 100 transactions and actual dates, without inferring recurring income or a complete monthly budget from descriptions. If only this read fails, report that history is unavailable and allow analysis to continue with balance and budget; if accounts fail, evaluation cannot continue.

Transactions do not feed a new expense classification and are not added to the balance or budget. Do not create synthetic five-month histories. Keep transaction dates unchanged, even when old relative to the current simulation.

### One demo budget and manual input

`fixtures/spend-lab/lucia.json` contains only Lucía's budget, version `spend-lab-demo-v1`: monthly income of 175000 cents, essential expenses of 90000 and discretionary expenses of 30000, with expected income on day 2 and the aggregated essential payment on day 25. Generate upcoming dates from today, using the next strictly future occurrence of each day of the month. These are demo assumptions, not guaranteed salary or verified charges.

Do not modify seed, setup, reset or tables. Other customers have no preloaded budget: request a manual one. Everyone can adjust the budget through the same five fields:

- `monthlyIncomeCents`: expected monthly income.
- `monthlyEssentialExpensesCents`: monthly essential commitments, including existing repayments if the user includes them.
- `monthlyDiscretionaryExpensesCents`: expected monthly discretionary spending.
- `nextIncomeDate`: next receipt date; null only when income is zero.
- `nextEssentialExpensesDate`: next payment date for the essential aggregate; null only when essentials are zero.

The user confirms that the aggregate includes their known commitments; do not develop a bill editor, list of extra expenses or loan calculation. Aggregating expenses on one date is a visible model simplification. Spread discretionary expenses across calendar days to produce an understandable projection, without claiming this is the actual spending pattern.

GET returns `demoBudget` for Lucía and null for everyone else. POST accepts `budget: null` to use the demo or a complete object to use a manual budget, labelled `user`. Editing any demo field turns it into a declared budget for that evaluation, without changing the fixture. The starting balance always comes from the bank and sums only selected accounts.

### Current date and reproducible calculation

Each request captures the actual clock once through a `now(): Date` dependency. The default is the server clock; tests inject a fixed date. `simulationStartDate` is the current UTC date, `YYYY-MM-DD`; do not import or use the documentation's `referenceDate` to start purchases.

The horizon includes the starting day and the following 90 days. Validate resale and initial budget dates relative to that date: resale between today and day 60; upcoming monthly dates between today and the next 31 days. Buy now always means the starting day; do not add a purchase-date selector.

Recurrences retain the day of the month from their first declared date and clamp to the last day of shorter months. The first declared date represents an event still pending, even if today; the user must specify the next payment/receipt, not one already reflected in the balance. Do not generate events before the start date.

For discretionary expenses, divide the integer monthly amount by the number of days in the month and distribute remaining cents over its final days. Include only days within the horizon, including assumed future spending today. Present this distribution as a budget approximation, not bank transactions.

The engine uses ISO dates and UTC arithmetic. `observedAt` and `evaluatedAt` are actual timestamps. The frontend shows the date sent by the server; a POST after a day change captures today again and returns updated context. If a declared date has become past, return a field error so it can be corrected.

Money uses safe integer cents. Price and resale amounts are positive, up to 10000000 cents as a technical input limit. Monthly budget amounts are non-negative, with that limit per field. The reserve is a non-negative safe integer. Validate sums; round ratios only for presentation.

### API and shared contract

Keep two endpoints in the catch-all, with `Cache-Control: no-store`, a customer session and 405 for unsupported methods. Identity comes from the cookie, never the body.

`GET /api/spend-lab/context` returns `userId`, `observedAt`, `simulationStartDate`, `horizonEnd`, accounts, bank activity and coverage/availability, `demoBudget` and demo version. Visible activity may be limited to the five most recent transactions; it does not require an additional history screen.

`POST /api/spend-lab/evaluate` applies `sameOrigin` and strict Zod schemas. Input:

| Field              | Contract                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------- |
| `purchase`         | `{amountCents, motive, context}`; phone as the fixed category.                                                |
| `purchase.motive`  | `replace_broken`, `work_study`, `upgrade` or `treat`.                                                         |
| `purchase.context` | Optional text up to 1000 characters; may describe the existing phone and the problem the user wants to solve. |
| `accountIds`       | Unique IDs of selected owned accounts; maximum 12.                                                            |
| `budget`           | Null for the demo budget, or the five manual-budget fields.                                                   |
| `reserveCents`     | Non-negative integer or null if not yet set.                                                                  |
| `resale`           | Null or `{amountCents, date}`, supplied by the user.                                                          |

POST fetches the bank again. It does not accept balances, a start date, trajectories or diagnoses calculated by the browser. Expected budget and resale are simulation inputs, not bank facts.

HTTP 200 returns `needs_input` for missing accounts, budget or reserve, without calling the model; or `complete` with normalised input, updated context, baseline, three scenarios, metrics, methodology and `assessment`. All responses include `runId` and `userId`.

Shape, date and amount errors: 400 with an associated field; session: 401; role, origin or another person's account: 403; invalid bank account response shape: 502; account unavailability/timeout: 503/504. AI errors do not remove valid calculations: `assessment.status: 'unavailable'` identifies the cause and allows retrying. An invalid owned fixture is a configuration failure; a customer without a fixture needs a manual budget.

### Three scenarios and calculated sacrifices

The baseline shows the budget without replacing the phone; it is a chart reference, not a fourth interactive alternative. Calculate:

1. `buy_now`: pay the price today without counting resale proceeds. This exposes the outlay and reserve required to buy immediately.
2. `sell_first`: receive the expected resale proceeds and then buy on the same day. Available only if the user declares an amount and date; it depends on selling and receiving payment first. Resale is not credited to the starting balance or other scenarios.
3. `wait`: the first day between tomorrow and day 60 when paying without resale preserves liquidity throughout the entire horizon and the reserve from purchase onward. If none exists, report no viable date within the horizon.

Do not add a separate buy-then-sell variant. Comparison is limited to these three stories. Moving the resale date moves the purchase and receipt in `sell_first` and recalculates their effects.

Balance per event: `previous balance + income - expense`. Also evaluate balances between events: daily closing balance cannot hide an intraday negative balance. Conservative order: commitments, purchase and expected income; in `sell_first`, resale is placed immediately before its purchase. This order is a declared assumption, not verified banking timing.

Each scenario returns availability, purchase date, events, trajectory, minimum over the full horizon, minimum from purchase onward, final balance and flags. Classification: `cash_shortfall` if any balance is negative; otherwise, `reserve_breach` if the minimum after payment falls below the reserve; otherwise, `within_limits`. Problems before the purchase are shown as preexisting and compared with the baseline. A scenario with a negative balance or compromised reserve cannot be presented as compatible with the chosen conditions.

The suggested reserve is three months of essential expenses, visible and editable; POST uses the value accepted by the user, including explicit zero. This is methodological guidance, not bank policy or a universal boundary of responsibility.

To explain sacrifices, also calculate:

- Monthly room: income minus essential and discretionary expenses from the declared or demo budget.
- Upgrade outlay: price, subtracting resale only in `sell_first`, conditional on receiving payment. Do not present it as the phone's financial return.
- Room sacrificed: non-negative outlay divided by positive monthly room, expressed as an equivalent number of months; null when room is not positive. This does not promise a recovery date.
- Remaining protection: difference relative to the reserve and months of essentials covered by the non-negative minimum; null when essentials are zero.

Deliver these metrics and flags to AI with evidence identifiers. Do not calculate a moral score, probability of selling or economic benefit attributed to the phone.

### One AI call with distinct value

AI must develop three things the chart cannot explain on its own: what the person hopes to achieve with the phone, what financial room or protection they sacrifice and what specific reflection helps them decide. It may propose buying, selling first, waiting or keeping the current phone, depending on the data and motive.

Input includes the user's motive and context, budget with provenance, engine metrics and scenarios, historical coverage and a brief versioned methodology. A phone failing at work and one being upgraded for enjoyment can justify different interpretations with identical figures, without assuming new income or product features.

Structured output: `headline`, `motiveInterpretation`, nullable `preferredScenarioId`, `recommendation`, one or two `financialTradeoffs` and a mandatory `reflectionQuestion`. Each tradeoff references metrics/evidence from that evaluation. Limits: headline 100 characters, interpretation and recommendation 400 each, tradeoff 250 and question 200. Preference references available `baseline`, `buy_now`, `sell_first` or `wait`.

Interpretation distinguishes user declarations from assumptions. It may say a change could support a described need; it does not assert higher income, hours saved or greater satisfaction without evidence. If context does not identify a concrete need, the reflection question explores it rather than filling the gap. Do not invent a savings goal the user has not mentioned.

Expected behaviour: for enjoyment, explain that wanting the phone is legitimate and specify the room it consumes; for work, consider that need and weigh urgency against waiting or selling first. The question must connect with the case rather than always asking “do you really need it?”.

Use `openai().responses.parse()` with `zodTextFormat`, `config.chatModel`, `store: false`, low effort, a maximum of 1800 tokens, a 30-second timeout and zero retries for this call. Do not change shared-client defaults. An evaluation with sufficient data makes one call; insufficient data makes none. No repair loop, browsing or model-selected tools.

Validate the schema, evidence references and preferred scenario. The schema sent to the model restricts evidence IDs and preferences to those valid for the evaluation: keeping the phone and available purchase alternatives within the limits. Each metric includes units and meaning; a positive difference relative to the reserve means surplus, a negative one means deficit. Do not accept a purchase recommendation marked incompatible by the engine. Structural validation does not establish the correctness of every free-text sentence: also check content through tests and demo review. Refusal, timeout, format incompatibility, provider error or invalid output leave figures and flags available, without pretending to offer personalised analysis. [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses).

Built-in knowledge includes short summaries and sources on [CFPB cash flow](https://files.consumerfinance.gov/f/documents/cfpb_your-money-your-goals_cash_flow_budget_tool_2018-11_ADA.pdf), [Banco de España emergency reserves](https://clientebancario.bde.es/f/webcb/RCL/ActualidadEducacionFinanciera/EducacionFinanciera/QueSeHace/Actividades/02_Ahorro_y_objetivos.pdf), [CFPB financial well-being](https://www.consumerfinance.gov/consumer-tools/financial-well-being/about/) and [OpenStax choice under a budget constraint](https://openstax.org/books/principles-economics-2e/pages/2-1-how-individuals-make-choices-based-on-their-budget-constraint). These are external principles and references, not Banana Bank conditions or scientific validation of the algorithm. Do not modify the RAG corpus or index; runtime web search is unnecessary.

### Validation and tracing

Reuse `traceLog` with scope `spend-lab`, runId, actor, duration, demo/methodology version, flags and analysis status. Do not create conversations, intents, approvals, tables, workers or durable runs. Results and traces correlate the request; do not develop decision history.

Tests use `node:test` and injectable dependencies, without new ports:

- Current and injected clock, month/day changes and dates independent of `referenceDate`; no projected event occurs before the start.
- Cents and sums, payments before receipt, intraday minimum, exact or compromised reserve and a zero-room budget.
- Three alternatives, hypothetical resale, waiting without a viable date and problems already present in the baseline.
- Lucía with demo and other customers with manual budgets; distinct sources and no reapplication of history.
- Session, ownership and banking errors; unavailable history without inventing it, and mandatory balance.
- One AI call, no call with incomplete data, invalid output and fallback.
- Two different motives with identical figures: contextual interpretation and reflection, tradeoffs tied to metrics and no invented benefit.
- No bank POSTs or writes to conversations, intents or approvals.

Example fixture with fixed date `2026-10-09`: balance 300000, monthly income 200000 with next receipt on the 20th, essentials 80000 with next payment on the 10th, zero discretionary spending, phone 100000 and reserve 150000. Buying today has a minimum of 120000. Selling for 50000 on the 16th and buying afterwards keeps a minimum of 170000. Waiting finds the 21st: income on the 20th cannot fund a purchase placed before that receipt by the conservative order. The test covers the full 90 days, not only the first month.

## V1.1 · Implemented changes, awaiting review

### Specific purchase contract and compatibility

Keep `GET /api/spend-lab/context` and `POST /api/spend-lab/evaluate`, authentication, financial validations, `needs_input`/`complete` states and fallback. Do not create category-specific routes or another workflow.

The new `purchase` input adds two fields:

| Field                              | V1.1 rule                                                                                                                                                                          |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `category`                         | Enum `mobile`, `computer`, `gaming`, `other_tech`. These correspond to phones, computers, gaming/consoles and other technology devices.                                            |
| `productName`                      | Declared, trimmed text, 1 to 160 characters. May be an exact model or a concrete description: “a laptop for editing that I am considering”. No catalogue or external verification. |
| `amountCents`, `motive`, `context` | Keep V1 rules: positive price, four motives and optional context up to 1000 characters.                                                                                            |

The new interface requires category and product. To preserve valid V1 requests, the shared schema also accepts the previous shape with neither field: normalise it to `category: 'mobile'`, `productName: null`, without inventing a model. If either new field is supplied, require the complete pair; an invalid category or empty name must not become a legacy request. Unknown keys are still rejected. URL versioning is unnecessary; V1 tests retain their payloads and results.

Normalised types must carry these fields through to the response and `buildInterpretationInput`. The shared calculation input schema must accept normalised metadata; the `engine.ts` algorithm still uses amount, balance, budget, reserve and resale. Do not introduce category-specific financial rules. Price/motive/context in V1 requests retain the same behaviour; new clients send the complete V1.1 shape.

### Bank evidence for budget preparation

`context.ts` keeps HTTP reads of accounts and transactions, ownership and source separation. Before reducing visible activity to five transactions, a pure function summarises all valid returned transactions, at most 100. It does not query simulator SQLite, generate rows or use customer-specific amounts.

Extend context with `budgetEvidence`, identified as `source: 'bank'`, with coverage and groups by account/UTC month. Each group contains `accountId`, `month` (`YYYY-MM`), `creditsCents`, `debitsCents` (positive magnitude), `movementCount`, `from` and `to`. Create groups only for observed transactions; a missing month does not become a zero-spending month. Sums use safe cents; when reliable summarisation is impossible, mark evidence unavailable without replacing it with demo data.

Coverage retains availability, limit, count, dates and possible history truncation. `available` means the read was valid, not that a month is complete. Account selection determines which groups are shown and included in the LLM payload; the 100 limit applies to the customer's combined read and may exclude transactions from selected accounts. POST refreshes the summary alongside the rest of the context.

Observed inflows/outflows are not called salary/consumption expenses: they may include opening balances and transfers. Do not infer their nature from words in `description` or reconstruct incomplete transfers. Show these limitations. No extrapolated monthly averages, recurrence detector, AI classification or future dates inferred from history.

Evidence helps review the same five V1 fields, but does not replace them or get added to the projection again. Those fields are a forecast `user` budget confirmed by the customer. Keep explicit zero amounts and upcoming-date rules. If accounts, budget or reserve are missing, `needs_input` prevents interpretation; empty or unavailable history does not prevent calculation with sufficient balance and budget.

`demoBudget` may still be offered exclusively to Lucía as an optional example. Its absence or invalidity must not block banking context or an evaluation with a declared budget: identify the example as unavailable. Null without a valid example requests a budget. The new flow does not send `budget: null` by default: it sends the reviewed budget. Explicitly loading the valid example retains V1 null/demo behaviour; editing it produces an object/user. For any other customer, null still returns `needs_input`. Preserve the valid contract without creating profiles or hardcoded defaults. The API uses the actor, not a fixed list of eight IDs, to grant access to all existing customers.

### More useful interpretation within the same workflow

The pipeline remains validation → context → gate → calculation → interpretation → output validation. The only context additions are product/category and observed evidence; do not add a classification or product-research step.

`buildInterpretationInput` sends category, name, price, motive and declared context, budget and sources, scenarios, metrics with IDs and meaning, coverage and a banking summary for selected accounts. Continue excluding IBAN, identity and complete trajectories from the model payload. If a summary supports a numerical claim, it must have its own banking evidence ID; do not mix it with budget metrics or present it as a forecast.

Keep the current structured output without adding fields that repeat its content:

| Output field                            | V1.1 responsibility                                                                      |
| --------------------------------------- | ---------------------------------------------------------------------------------------- |
| `headline`                              | Introduce the product decision without imposing a moral judgement.                       |
| `motiveInterpretation`                  | What the person wants to buy, why and how it could be useful according to their account. |
| `financialTradeoffs`                    | One or two verifiable financial consequences, with evidence.                             |
| `preferredScenarioId`, `recommendation` | Explain which alternative fits and what other conditional options to consider.           |
| `reflectionQuestion`                    | A concrete question about usefulness, urgency or sacrifice in this case.                 |

Update instructions and meanings currently referring to “phone”. `baseline` now means not making this purchase; it does not assume ownership of an equivalent product. Resale means selling a device the person declares they own, without assuming replacement. User text, including product name and banking descriptions, is untrusted data, never instructions.

A model name does not authorise claims about specifications, compatibility, performance, market price, discounts or resale. Do not infer profession, future income, satisfaction or availability of another device either. If the person declares their computer fails during work, consider that problem as a declaration; do not promise the proposed purchase will solve it. If they only write “I want a console”, ask about expected use without inventing it.

Numerical alternatives remain restricted to those available and compatible with the engine. Keeping something the user says they own, exploring repair or considering a cheaper option are conditional ideas, without additional calculated costs, savings or scenarios. Do not offer financing. Enjoyment remains a valid motive and preexisting financial problems remain visible.

Reuse `responses.parse`, the configured model, `store: false`, current limits, one call and zero retries. Keep valid IDs, compatible preferences and fallback. Current limits allow a brief reflection; measure quality with examples before proposing another model, more tokens, another call or a loop. The schema does not certify the truth of free text: tests and review must check personalisation and absence of invented data.

### Change surface and tests

Affected files: `contracts.ts` (raw/normalised purchase and evidence), `context.ts`, pure helpers `activity.ts` and `insights.ts`, `budget.ts` (optional invalid example), `interpretation.ts`, `workflow.ts`, neutral wording and version `spend-lab-method-v1.1` in `methodology.ts`, and SpendLab tests. `engine.ts` retains its rules and figures. Do not modify auth, catch-all, simulator, agent, SQLite or transfers.

The V1.1 closure returns in `complete.evidence` the same evidence supplied to the single model call, to resolve `evidenceIds` on screen. `insights.ts` reads existing events, balances and dates to locate the first applicable negative balance or reserve breach; it does not generate projections or change formulas. It includes the event, balance before/after and comparison with baseline on that day, distinguishing initial and preexisting problems. Essentials remain a declared monthly aggregate, never an identified bill.

Interpretation receives that first problem and its date, balance and amount IDs when present. The prompt connects personal use, sacrifice and alternative; it explains what happens when buying now against the recommendation and allows recommending a compatible treat. Keep one call, the model and current limits.

The final clarity adjustment adds `firstBudgetProblem`, derived from the full horizon, including reserve breaches before buying, and date/balance evidence. `firstProblem` retains the original classification scope; do not modify `engine.ts`. `within_limits` requires non-negative balance throughout the horizon and the reserve from purchase onward, not throughout the preceding period. Preexisting-problem flags do not prove that buying cannot worsen it. AI must acknowledge earlier risk and use simple figures/dates; it does not cite ratios in months. Sources are deduplicated. The methodology response separates general `principles` from simulation `assumptions`: 90/60 days, recurrence, aggregation/distribution and conservative ordering are our decisions; three months of essentials is a simplified, editable suggestion.

- Preserve V1 scenarios and legacy payloads; identical projections when changing only category, name, motive or context.
- Evaluate for every customer in `src/people.ts`, without a demo budget, using injected banking reads and a declared budget. Do not create profile fixtures for each person.
- Summaries with actual partial/old transactions, opening balances, transfers, selected accounts, global limit, missing month and history-only failure. No inferred salary or duplicated projected transactions.
- Valid categories, empty/long name, incomplete pair, unknown fields and product sent in full to the model. A motive without a declared benefit produces a question, not an invented feature.
- Same figures for a computer with a declared work need and a phone for enjoyment: distinct interpretation/question; gaming and other devices with contextual personal usefulness. Include a case without a previous device and another with sparse context.
- One call, or none when data is missing; fallback and compatible preferences. Deterministic tests verify contract/payload/rules; evaluation with the actual model and human review check content without presenting it as a universal guarantee.

### History · Separate proposal, pending a decision

V1 and the base V1.1 proposal do not save decisions. `runId` and logs are not retrievable storage; the workflow does not open `appDb()` and model output uses `store: false`. There are no endpoints to list, retrieve or compare evaluations.

If later history is approved, reuse the application's SQLite with a dedicated evaluations table and access by `user_id`. This modifies `src/db.ts`, adds a repository in `src/spend-lab/`, authorised list/detail routes and saving the complete result in the workflow. Do not write to the bank or reuse conversational runs, conversations, messages, intents or approvals tables.

The minimum record would need ID, customer, evaluation date, contract/calculation/methodology/prompt version and model, normalised input and a snapshot of selected balance, budget, dates, calculation and assessment. Saving only input and AI text cannot recover original figures if balance or algorithm changes. Store only necessary context, avoiding copies of IBAN and all customer activity. A `complete` result with unavailable AI may also be viewable; `needs_input` and previews are not complete decisions. Saving policy remains pending and is not implemented here.

Filter each read by actor; a reference to someone else must not reveal their decision. Recovery reuses editable inputs, checks current account ownership and refreshes balance/clock; it requires reviewing past dates and assumptions. The new evaluation does not overwrite the previous one. A link to the original record would allow comparing both without treating the old snapshot as current.

Minimal comparison can return price, balance, budget, reserve, dates, metrics and analysis for both records, showing condition and version changes. It does not require another model call or overlapping curves with different dates. Viewing history does not require recalculation or paying for a call. Reevaluation does not guarantee reproducing the old reflection verbatim.

Additional medium complexity: schema/record compatibility, authorisation, write errors, retention/deletion, stale-data recovery and isolation/comparison tests. Also define how reset handles the new table without accidentally changing existing behaviour. A saving failure must be distinguished from an evaluation failure; this new state needs a contract and interface.

Recommendation: deliver V1.1 without persistence first and consider history as V1.2. Pending approval: bring it forward or postpone it, explicit/automatic saving, snapshot and versions, retention/deletion, and comparison in the first delivery or later. Do not add a table, dependency, endpoint or reset change before resolving those decisions.
