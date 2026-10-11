# SpendLab frontend

SpendLab presents a phone purchase, its effect on the budget and a personalised reflection. The flow preserves Banana Bank's visual style and uses the contracts in [Backend](Backend.md) and the scope in [Plan](Plan.md).

V1 describes the original interface saved in `d87a68e`. V1.1 expands categories, product and budget review without replacing the existing flow. That extension is implemented, awaiting the user's visual review and a commit. History remains unimplemented. The walkthrough and checks are in [HowToDemo](../../docs/demo/HowToDemo.md).

## V1 · Original interface

### Small integration

Add `Spend Lab` to the customer menu after Assistant, with an SVG icon from the existing system. `app/page.tsx` mounts the section; dedicated components keep form, context, chart and analysis in `app/components/spend-lab/`. Do not change other tabs, operator navigation or chat and transfer flows.

Use existing colours, typography, cards, buttons and focus styles. Prefix CSS classes with `spend-lab-`, without redefining global rules. Keep English and EUR; do not add chart or UI libraries. Build the chart with SVG and the shared pure calculation.

State belongs to the section, without reusing chat `busy`, `pendingChat` or errors. Leaving the tab or switching person unmounts it and discards the local evaluation. No persistence, decision history or localStorage.

### Form and budget

Heading `Spend Lab`, subtitle `Think through your next phone`. The purchase is a phone: no category, brand or purchase-date selector. The product shows today from the server's `simulationStartDate`; it does not inherit the fixed date from Overview or the documentation system.

The first block contains:

| Field           | Control                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------- |
| New phone price | Required amount in euros, with two decimal places. Convert decimal text to cents.                       |
| Motive          | Single selection: Replace something broken, Work or study, Upgrade, Just for enjoyment.                 |
| Context         | Optional text: existing phone, what it lacks and expectations for the new one. Maximum 1000 characters. |

Do not preselect a motive. Context is a short aid to personalise analysis, not a conversation. Do not require previous model, age, original price or technical specifications.

Context loads on entry. After `Continue`, a second compact block shows accounts, budget and reserve:

- Owned accounts and current balance as checkboxes; explicit selection of at least one account and a visible total. Savings count only when selected.
- For Lucía, five preloaded budget fields with a `Demo budget` badge. For everyone else, the same fields start empty for manual completion.
- Monthly income, essential expenses, discretionary expenses and next receipt and essential payment dates. Present them as forecasts; essentials are a monthly aggregate, not a bill list.
- Editable reserve with a visible suggestion of three months of essentials and a short explanation. Use the accepted value, including explicit zero. Budget changes do not silently replace a reserve the user has already chosen.
- Optional resale of the previous phone: expected amount and receipt date, without invented values. Without declared resale, send `resale: null` and make `Sell first` unavailable. When enabled, both fields are required before evaluation.

Editing Lucía's budget identifies it as `Your budget assumptions` for that evaluation. Other customers also use that source; do not present these values as bank data. Allow zero income without requiring a receipt date, and zero essentials without requiring a payment date. No individual-expense editors, extra expenses, fictional history or secondary configuration panels.

The budget may include existing repayments or other commitments under essentials; do not promise to detect the customer's entire financial situation. Help text asks users to include known upcoming expenses so assumptions are meaningful.

`Evaluate purchase` validates and sends input. Evaluation uses today; the resale or budget date entered does not change the start date. Date ranges come from the server. If the day changes during the flow, refresh context or show the date error for correction rather than reusing an old start date.

### Chart and three alternatives

The result combines a large chart and three cards: `Buy now`, `Sell first` and `Wait`. The no-purchase baseline may appear as a neutral reference line, without a fourth card or flow. No additional comparison for buying then selling later.

The chart uses the same 90-day horizon and scale for all scenarios, showing the reserve line and stepped balance curves. Represent events and intraday minima; do not smooth drops that may cause a liquidity shortfall. Cards show effective date, minimum, reserve and dependence on assumptions.

`Buy now` pays today without counting resale. `Sell first` receives the expected amount and then buys; its card states that condition. `Wait` shows the first calculated compatible date or that none exists within the horizon. Distinguish preexisting problems from the impact added by the purchase.

Controls for price, reserve, resale amount and receipt date allow exploring the chart. Move the resale date with a day control from 0 to 60 from today and an equivalent date field. Do not add controls for other purchases or new commitments.

Preview uses the last validated context and shared engine, without calling the model for every change. Editing removes the previous personalised analysis and shows `Preview — update analysis`. `Update analysis` resends the complete evaluation; the server refreshes balance and date and replaces context, figures and interpretation together. Incomplete inputs show errors rather than retaining figures dependent on an old value.

### Analysis that helps users decide

Present analysis as a short editorial card alongside comparison, containing:

1. **What you want to achieve:** interpretation of motive and context, distinguishing a described need from enjoyment or a desired improvement.
2. **What you give up:** one or two concrete tradeoffs tied to monthly room, reserve, waiting or dependence on selling.
3. **Which alternative fits:** recommendation with reasons, conditional on budget and expressed personal value.
4. **A useful reflection:** a case-specific question, visible without opening a chat.

The reflection does not require an answer to complete the flow. Customers may adjust context and evaluate again if they want to explore it. Do not implement a dialogue of successive questions.

An affordable wish is not condemned as a treat. A work need does not authorise invented productivity or income gains. Personal interpretation must change when motive/context changes, even if the chart remains identical. Figures and classification still come from the engine.

`Data and assumptions` shows balance and observation time, budget source, available bank activity and methodological sources. No new library is required. Acknowledge missing history without blocking an evaluation with sufficient balance and budget.

If AI fails, keep the chart, figures and flags with `Personal analysis unavailable`; do not show a generic question pretending to be personalised reflection. Allow retrying with the same form. No moral scores or promises of a safe purchase.

### States and validation

States: `purchase`, `budget`, `evaluating` and `results`, with independent context loading. During POST, one evaluation is active and its inputs are locked; switching tab or person remains allowed. Do not add a dedicated cancellation button or subsystem.

Use AbortController and a request counter; apply responses only while component, actor and revision remain current. Check the result's `userId`. A late result does not navigate back or appear for another person. No streaming or fictional stage progress.

`needs_input` returns to the relevant block and focuses accounts, budget or reserve. 400 responses contain field errors; bank balance failure allows retrying without substituting demo data. AI failure has a distinct numerical fallback. Errors stay within SpendLab.

Stack chart and cards on mobile. Controls have labels, focus and keyboard alternatives; state changes use `aria-live`. Signals combine text and colour. The chart includes a textual summary of dates and minima so it does not depend on a pointer or sight; do not develop a full event table in v1.

HowToDemo walkthroughs: Lucía with demo budget, another customer with manual budget, comparison of three alternatives, compromised reserve, preview without stale analysis and two motives with identical figures producing distinct personal analyses. Include person/tab switching during a request, data/bank/model errors and mobile and keyboard review.

Closure checks Overview, Assistant, Transfers, Documents and the person selector, together with typecheck, tests and build. Do not add browser dependencies or tests that only replicate CSS. Visual validation takes place in the usual application with the user and is recorded as completed or omitted.

## V1.1 · Implemented evolution, awaiting visual review

### Same flow, specific purchase

Keep `Spend Lab` in the menu and the three blocks: purchase → budget → result. Change the subtitle to `Think through your next tech purchase`. Do not add a chat, category-specific sections, search or catalogue. Reuse components, colours, typography, prefixed styles, SVG chart and local state.

The first block extends the form:

| Field    | V1.1 control                                                                                                                                                                                                                  |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Category | Four visual single-selection options: `Phones`, `Computers`, `Gaming & consoles`, `Other tech`. No silent preselection.                                                                                                       |
| Product  | Required `What would you like to buy?` field, 1 to 160 characters. Category-specific placeholder: `iPhone 17`, `MacBook Air`, `Nintendo Switch 2`, `Headphones…`. These are text examples, not a catalogue or recommendation. |
| Price    | Same EUR control, now `Purchase price`; still the price supplied by the person.                                                                                                                                               |
| Motive   | The four existing motives, without preselection.                                                                                                                                                                              |
| Context  | Optional, maximum 1000 characters. Contextual help: expected use, what is missing, what is already owned or urgency. No requirement for a technical specification sheet.                                                      |

The name need not be a commercial brand/model: a concrete description also works. Do not look up or autocomplete specifications, price or availability. Changing category preserves entered text and other data, allows corrections and does not calculate a different price. Matching category and product does not require an AI classifier; input limits are validated with the shared contract.

Adapt illustrations and wording currently referring to a phone to the selected device using repository SVG/CSS, without generated assets, libraries or additional animations. Keep the three alternatives prominent. Form and result wording no longer assumes a previous phone exists.

### Shared budget for all customers

On entry, fetch accounts, balance, activity and aggregated evidence. Everyone follows the same budget block. Account selection remains explicit; do not include savings automatically. Show a compact summary of observed monthly inflows and outflows for selected accounts, with dates, transaction count and a limited-coverage warning.

Place the summary beside budget help, without turning it into another dashboard. Label it `Observed bank activity`, not `Your monthly income` or `Your spending forecast`. Figures may include account openings and transfers; do not present them as salary or consumption classification. A month without records is not shown as zero spending. Old activity keeps its actual dates rather than moving into the current month.

The existing five forecast fields remain editable and are confirmed before evaluation. Do not fill them automatically from historical totals: future income, essential/discretionary expenses and upcoming dates require declarations. Help text explains that known commitments must be included; do not open an individual-expense editor. Preserve explicit zeros, disabled dates where appropriate and the user's chosen reserve.

Lucía also uses this flow without depending on her fixture. If context offers `demoBudget`, show a secondary action, `Load Lucía’s demo budget`, loading the complete example and its future dates, clearly labelled. It is not selected by default. Editing converts it into `Your budget assumptions`, as in V1. Do not offer Lucía's profile to other customers. Keep the suggestion of three months of essentials without silently overwriting the reserve when loading or editing data.

When history is missing, show `No observed activity available` and keep manual fields available. If selected accounts have no transactions, explain that scope without claiming there are no expenses. If the balance read fails, retain existing blocking and retry behaviour. Results and `Data and assumptions` distinguish bank balance/activity, forecast budget and demo example.

### Resale, preview and result

Optional resale becomes `Sell a device you already own first`. Price and date remain declared, without a market estimate or a requirement to identify another product. The purchase can be funded by selling any owned device; do not assume replacement. Without resale, `Sell first` remains unavailable. The backend preserves exactly its current calculation.

The V1.1 closure replaces the chart with a simple timeline, retaining horizon, intraday minima, reserve, cards and controls. `Buy now`, `Sell first` and `Wait` compare the same declared product/price. Baseline means not making this purchase; it does not imply ownership of an equivalent. No model or financing comparator.

Show evaluated category and product in the result. `Edit purchase & budget` returns to the first block, allowing product/category correction before budget review. Any change to product, category, motive or context removes the previous interpretation; figures change only when a financial input changes. Keep `Preview — update analysis`. Updating sends all data and replaces context, figures and interpretation together.

The editorial card retains its structure:

- `What you’re looking for`: specific purchase, motive and usefulness according to declarations, with conditions if data is missing.
- `What you give up`: sacrificed room/reserve or dependence on resale/waiting, using engine figures.
- Recommendation: coherent alternative and relevant qualitative options, without invented prices.
- Question: specific reflection about use, urgency or priority, without requiring a chat response.

Text must distinguish a computer needed for a declared work problem from a phone wanted for enjoyment, without inventing features or penalising treats. Gaming may have recreational value expressed by the user; analysis does not require financial returns. Repairing or choosing a cheaper option are not shown as calculated scenarios. AI fallback retains calculations and retry without simulating personalised advice.

V1.1 closure preserves `baseline` selection when AI recommends it: show its consequences and the secondary `Without this purchase` button, without selecting `Buy now` or adding another card. Align the reserve/resale panel to the top of its row to avoid stretching it to the budget's height. Field help explains amounts, upcoming dates, reserve and resale; forecasts are not bank-verified data. Aggregate essentials on one date and spread discretionary expenses by day.

Each tradeoff includes an expandable `Why?` with its actual IDs and applicable figures, without ratios in months, nulls or duplicated sources. Keep a relevant zero in euros. Motive interpretation shows original declarations; recommendation offers price/outlay, reserve, relevant minimum and risk if present, rather than every internal field. Distinguish these figures from explicit model citations. No additional requests. Editing still removes previous analysis and its evidence.

Before the cards, a deterministic conclusion explains buying today, when a limit is crossed and which alternatives fit. Cards separate purchase date from the actual date of the first horizon minimum. The selected scenario's timeline shows only purchase, first budget problem, first applicable problem from purchase onward when different, and minimum balance. Group the same event; no curves, axes, cursor, daily list or overlaid information from another option. The causal event remains an assumption, without invented bills. Compatible alternatives can be selected from cards or short links without repeating their figures.

Do not draw a timeline when there is no risk: a brief conclusion is enough; for safe `Buy now`, it already appears above the cards and is not repeated. If a deferred purchase respects the reserve from purchase onward but an earlier problem exists, show that problem and explain the temporal scope of compatibility. Distinguish preexisting problems from purchases worsening them by comparing already-calculated data. Preserve intraday minima, even with positive closing balances, and preview.

### V1.1 states and verification

Keep context loading, field errors, locking during POST, AbortController, request revision, identity and unmounting on person or tab change. A new product does not recover old text while analysis is loading. Example context does not appear for another person. Do not add saving states or decision lists within the proposed scope.

Implementation affects `SpendLab.tsx`, `form.ts`, dedicated styles/text and the shared contract. `BankActivity.tsx` presents evidence in the budget and `Data and assumptions`; `EvidenceDetails.tsx` resolves citations. `ScenarioCards.tsx`, `ScenarioTimeline.tsx` and helpers in `presentation.ts` present consequences. Remove `ScenarioChart.tsx` and its unused CSS. Preserve the dedicated resale-date control. `app/page.tsx` retains existing integration and the core stays unchanged.

HowToDemo covers the four categories, all customers without a mandatory demo, limited/missing history, Lucía's explicit example, product changes without changing figures and removal of stale analysis, distinct uses/motives and fallback. Mobile, keyboard, existing tabs and person/tab changes during POST remain for the user's visual review; do not claim those flows were automated.

### History · Possible design, pending a decision

Currently leaving SpendLab or switching person clears local state. V1.1 keeps that behaviour unless persistence is approved. Do not add localStorage as an intermediate solution.

Later history could integrate into SpendLab with a compact list of product, date, price and analysis status, snapshot detail and a `Re-evaluate with current data` action. This does not require reusing chat or creating another application. Viewing an old evaluation would show original date and conditions, with a notice that the balance is not current.

Recovering a decision would load declarations as a draft and fetch current context. Review accounts no longer available, budget, past dates and resale; never present the old result as a new evaluation. The new decision would have its own record and could link to the previous one.

The smallest initial comparison would be a table between the original snapshot and new evaluation: product/price, dates, balance, budget, reserve, minima and recommendation. Show which conditions changed and the versions used. No comparator LLM or new charts are required, and not every difference would be attributed to a product change.

This adds loading/list/detail, record selection, restoration, comparison and saving errors, alongside Backend authorisation and persistence. This complexity supports recommending a later V1.2 delivery. Still to decide: inclusion in V1.1, explicit or automatic saving, retention/deletion and comparison from the first delivery. These controls are not designed as committed functionality or implemented until the user settles scope.
