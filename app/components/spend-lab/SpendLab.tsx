'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type {
  EvaluationResult,
  ScenarioId,
  SpendLabContext,
} from '../../../src/spend-lab/contracts';
import { addDays } from '../../../src/spend-lab/dates';
import ScenarioChart, { classNames, scenarioColors, scenarioNames } from './ScenarioChart';
import {
  demoFields,
  emptyForm,
  euroCents,
  evaluationFromForm,
  money,
  previewFromForm,
  shortDate,
  validatePurchase,
} from './form';
import type { CompleteEvaluation, FieldErrors, FormValues } from './form';
import './spend-lab.css';

const motives = [
  {
    id: 'replace_broken',
    icon: '↻',
    title: 'Replace something broken',
    note: 'Get back to the essentials',
  },
  { id: 'work_study', icon: '↗', title: 'Work or study', note: 'Help with something important' },
  { id: 'upgrade', icon: '✧', title: 'Upgrade', note: 'Make the everyday a little better' },
  { id: 'treat', icon: '♡', title: 'Just for enjoyment', note: 'A little joy counts, too' },
] as const;

class RequestError extends Error {
  constructor(
    message: string,
    public fields: FieldErrors = {},
  ) {
    super(message);
  }
}
async function request<T>(path: string, signal: AbortSignal, body?: unknown): Promise<T> {
  const response = await fetch(`/api/spend-lab/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
    cache: 'no-store',
  });
  const data = await response.json();
  if (!response.ok)
    throw new RequestError(
      data.error ?? 'Please retry.',
      Object.fromEntries(
        (data.fields ?? []).map((issue: { field: string; message: string }) => [
          issue.field,
          issue.message,
        ]),
      ),
    );
  return data as T;
}

function Field({
  name,
  label,
  value,
  onChange,
  errors,
  date = false,
  min,
  max,
  disabled = false,
  prominent = false,
}: {
  name: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  errors: FieldErrors;
  date?: boolean;
  min?: string;
  max?: string;
  disabled?: boolean;
  prominent?: boolean;
}) {
  const id = `spend-lab-${name.replaceAll('.', '-')}`;
  return (
    <label className={`spend-lab-field ${prominent ? 'spend-lab-price-field' : ''}`} htmlFor={id}>
      <span>
        {label}
        {!date && <small>EUR</small>}
      </span>
      <input
        id={id}
        name={name}
        type={date ? 'date' : 'text'}
        inputMode={date ? undefined : 'decimal'}
        placeholder={date ? undefined : '0.00'}
        value={disabled ? '' : value}
        min={min}
        max={max}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={!!errors[name]}
        aria-describedby={errors[name] ? `${id}-error` : undefined}
      />
      {errors[name] && (
        <small id={`${id}-error`} className="spend-lab-field-error">
          {errors[name]}
        </small>
      )}
    </label>
  );
}

export default function SpendLab({ userId }: { userId: string }) {
  const [form, setForm] = useState<FormValues>({ ...emptyForm, accountIds: [] });
  const [phase, setPhase] = useState<'purchase' | 'budget' | 'results'>('purchase');
  const [context, setContext] = useState<SpendLabContext | null>(null);
  const [contextLoading, setContextLoading] = useState(true);
  const [contextError, setContextError] = useState('');
  const [error, setError] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [evaluating, setEvaluating] = useState(false);
  const [result, setResult] = useState<CompleteEvaluation | null>(null);
  const [revision, setRevision] = useState(0);
  const [submittedRevision, setSubmittedRevision] = useState(-1);
  const [selected, setSelected] = useState<ScenarioId>('buy_now');
  const root = useRef<HTMLElement>(null);
  const active = useRef(false);
  const revisionRef = useRef(0);
  const contextSequence = useRef(0),
    evaluationSequence = useRef(0);
  const contextController = useRef<AbortController | null>(null),
    evaluationController = useRef<AbortController | null>(null);

  function focusField(field: string) {
    requestAnimationFrame(() => {
      if (!active.current) return;
      const inputs = root.current?.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        '[name]',
      );
      const input = Array.from(inputs ?? []).find(
        (input) =>
          input.name === field ||
          input.name.startsWith(`${field}.`) ||
          field.startsWith(`${input.name}.`),
      );
      input?.focus();
    });
  }
  function update<K extends keyof FormValues>(name: K, value: FormValues[K], budgetEdit = false) {
    revisionRef.current++;
    setRevision(revisionRef.current);
    setForm((previous) => ({
      ...previous,
      [name]: value,
      ...(budgetEdit ? { useDemo: false } : {}),
    }));
    setErrors({});
    setError('');
  }
  async function loadContext(initialize = false) {
    const seq = ++contextSequence.current;
    contextController.current?.abort();
    const controller = new AbortController();
    contextController.current = controller;
    setContextLoading(true);
    setContextError('');
    try {
      const data = await request<SpendLabContext>('context', controller.signal);
      if (!active.current || seq !== contextSequence.current || controller.signal.aborted) return;
      if (data.userId !== userId) throw new Error('Your session changed. Reopen Spend Lab.');
      setContext(data);
      setForm((previous) => ({
        ...previous,
        ...(initialize || previous.useDemo ? demoFields(data) : {}),
        ...(initialize && previous.reserve === '' && data.demoBudget
          ? {
              reserve: ((data.demoBudget.values.monthlyEssentialExpensesCents * 3) / 100).toFixed(
                2,
              ),
            }
          : {}),
      }));
    } catch (error) {
      if (active.current && seq === contextSequence.current && !controller.signal.aborted)
        setContextError(error instanceof Error ? error.message : 'Bank context is unavailable.');
    } finally {
      if (active.current && seq === contextSequence.current) setContextLoading(false);
    }
  }
  useEffect(() => {
    active.current = true;
    void loadContext(true);
    return () => {
      active.current = false;
      contextSequence.current++;
      evaluationSequence.current++;
      contextController.current?.abort();
      evaluationController.current?.abort();
    };
    // The parent keys this section by actor; a new actor gets a new form and request lifecycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const dirty = revision !== submittedRevision;
  const preview = useMemo(() => (result ? previewFromForm(form, result) : null), [form, result]);
  const calculation = result ? (dirty ? (preview?.calculation ?? null) : result.calculation) : null;
  const effectiveSelected = calculation?.scenarios.some(
    (scenario) => scenario.available && scenario.id === selected,
  )
    ? selected
    : 'buy_now';
  const fieldErrors = phase === 'results' && dirty ? { ...preview?.errors, ...errors } : errors;
  const essentials = euroCents(form.essentials);
  const suggestion =
    Number.isFinite(essentials) && essentials >= 0 && essentials <= 10000000
      ? essentials * 3
      : null;
  const selectedTotal =
    context?.accounts
      .filter((account) => form.accountIds.includes(account.id))
      .reduce((total, account) => total + account.balanceCents, 0) ?? 0;
  const maxBudgetDate = context ? addDays(context.simulationStartDate, 31) : undefined;
  const maxSaleDate = context ? addDays(context.simulationStartDate, 60) : undefined;

  async function evaluate() {
    if (!context || contextLoading || contextError || evaluationController.current) return;
    const parsed = evaluationFromForm(form, context);
    if (!parsed.success) {
      setErrors(parsed.errors);
      setError('Check the highlighted fields before evaluating.');
      focusField(Object.keys(parsed.errors)[0]);
      return;
    }
    const snapshot = ++revisionRef.current;
    setRevision(snapshot);
    const seq = ++evaluationSequence.current;
    const controller = new AbortController();
    evaluationController.current = controller;
    setEvaluating(true);
    setError('');
    setErrors({});
    try {
      const data = await request<EvaluationResult>('evaluate', controller.signal, parsed.input);
      if (
        !active.current ||
        seq !== evaluationSequence.current ||
        snapshot !== revisionRef.current ||
        controller.signal.aborted
      )
        return;
      if (data.userId !== userId) throw new Error('Your session changed. Reopen Spend Lab.');
      setContext(data.context);
      if (data.status === 'needs_input') {
        setPhase('budget');
        setErrors(
          Object.fromEntries(
            data.missingFields.map((field) => [field, 'Complete this before evaluating.']),
          ),
        );
        setError('A little more information is needed.');
        focusField(data.missingFields[0]);
        return;
      }
      setResult(data);
      setForm((previous) =>
        previous.useDemo ? { ...previous, ...demoFields(data.context) } : previous,
      );
      setSubmittedRevision(snapshot);
      setPhase('results');
      const preferred =
        data.assessment.status === 'available'
          ? data.assessment.reflection.preferredScenarioId
          : null;
      setSelected(preferred && preferred !== 'baseline' ? preferred : 'buy_now');
      requestAnimationFrame(() => {
        if (active.current)
          root.current?.querySelector<HTMLElement>('[data-result-heading]')?.focus();
      });
    } catch (error) {
      if (!active.current || seq !== evaluationSequence.current || controller.signal.aborted)
        return;
      setError(error instanceof Error ? error.message : 'The evaluation could not be completed.');
      if (error instanceof RequestError && Object.keys(error.fields).length) {
        setErrors(error.fields);
        const field = Object.keys(error.fields)[0];
        if (field.startsWith('budget') || field.startsWith('accountIds')) setPhase('budget');
        else if (field.startsWith('purchase.motive') || field.startsWith('purchase.context'))
          setPhase('purchase');
        focusField(field);
        if (
          Object.keys(error.fields).some(
            (field) => field.endsWith('Date') || field === 'resale.date',
          )
        )
          void loadContext();
      }
    } finally {
      if (active.current && seq === evaluationSequence.current) {
        evaluationController.current = null;
        setEvaluating(false);
      }
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (phase === 'purchase') {
      const errors = validatePurchase(form);
      setErrors(errors);
      if (Object.keys(errors).length) {
        focusField(Object.keys(errors)[0]);
        return;
      }
      setError('');
      setPhase('budget');
      focusField('accountIds');
    } else void evaluate();
  }
  function saleFields() {
    return (
      <>
        <label className="spend-lab-check">
          <input
            type="checkbox"
            checked={form.selling}
            onChange={(event) => update('selling', event.target.checked)}
          />
          <span>
            Sell my current phone first
            <small>Use your expected price and the date you expect to be paid.</small>
          </span>
        </label>
        {form.selling && (
          <div className="spend-lab-fields">
            <Field
              name="resale.amountCents"
              label="Expected sale price"
              value={form.saleAmount}
              onChange={(value) => update('saleAmount', value)}
              errors={fieldErrors}
            />
            <Field
              name="resale.date"
              label="Expected payment date"
              value={form.saleDate}
              onChange={(value) => update('saleDate', value)}
              errors={fieldErrors}
              date
              min={context?.simulationStartDate}
              max={maxSaleDate}
            />
          </div>
        )}
      </>
    );
  }

  return (
    <section className="spend-lab" ref={root}>
      <div className="page-heading">
        <div>
          <div className="eyebrow">A LITTLE SPACE TO THINK</div>
          <h1>
            Spend Lab<span className="hello-dot">.</span>
          </h1>
          <p>Think through your next phone.</p>
        </div>
        {context && (
          <span className="date-chip">
            From {shortDate(context.simulationStartDate)} · today, UTC
          </span>
        )}
      </div>
      <ol className="spend-lab-steps" aria-label="Purchase evaluation progress">
        {['Your purchase', 'Your breathing room', 'Three futures'].map((label, index) => (
          <li
            key={label}
            aria-current={
              index === ['purchase', 'budget', 'results'].indexOf(phase) ? 'step' : undefined
            }
          >
            <span>{String(index + 1).padStart(2, '0')}</span>
            {label}
          </li>
        ))}
      </ol>
      {error && (
        <div className="spend-lab-alert" role="alert">
          {error}
        </div>
      )}
      {contextError && (
        <div className="spend-lab-alert" role="alert">
          {contextError}{' '}
          <button
            type="button"
            className="secondary-button"
            onClick={() => void loadContext(!context)}
          >
            Retry bank context
          </button>
        </div>
      )}
      <form onSubmit={submit} noValidate>
        <fieldset className="spend-lab-form-shell" disabled={evaluating}>
          {phase === 'purchase' && (
            <div className="spend-lab-purchase-layout">
              <section className="spend-lab-panel">
                <div className="eyebrow">01 / THE PHONE YOU HAVE IN MIND</div>
                <h2>What are you making room for?</h2>
                <Field
                  name="purchase.amountCents"
                  label="Price of your new phone"
                  value={form.price}
                  onChange={(value) => update('price', value)}
                  errors={errors}
                  prominent
                />
                <fieldset
                  className="spend-lab-motives"
                  aria-describedby={
                    errors['purchase.motive'] ? 'spend-lab-motive-error' : undefined
                  }
                >
                  <legend>What is your main reason?</legend>
                  {motives.map((motive) => (
                    <label className="spend-lab-motive" key={motive.id}>
                      <input
                        type="radio"
                        name="purchase.motive"
                        value={motive.id}
                        checked={form.motive === motive.id}
                        onChange={() => update('motive', motive.id)}
                        aria-invalid={!!errors['purchase.motive']}
                      />
                      <span>
                        <b aria-hidden="true">{motive.icon}</b>
                        <strong>{motive.title}</strong>
                        <small>{motive.note}</small>
                      </span>
                    </label>
                  ))}
                </fieldset>
                {errors['purchase.motive'] && (
                  <small id="spend-lab-motive-error" className="spend-lab-field-error">
                    Choose a reason to personalize your analysis.
                  </small>
                )}
                <label className="spend-lab-field" htmlFor="spend-lab-context">
                  <span>
                    A little context <small>OPTIONAL</small>
                  </span>
                  <textarea
                    id="spend-lab-context"
                    name="purchase.context"
                    rows={3}
                    maxLength={1000}
                    value={form.context}
                    placeholder="What phone do you have now? What would the new one change for you?"
                    onChange={(event) => update('context', event.target.value)}
                    aria-invalid={!!errors['purchase.context']}
                    aria-describedby={
                      errors['purchase.context'] ? 'spend-lab-context-error' : undefined
                    }
                  />
                  {errors['purchase.context'] && (
                    <small id="spend-lab-context-error" className="spend-lab-field-error">
                      {errors['purchase.context']}
                    </small>
                  )}
                </label>
                <div className="spend-lab-actions">
                  <button type="submit" className="primary-button">
                    Continue <span aria-hidden="true">↗</span>
                  </button>
                  <small>No money moves here. Just perspective.</small>
                </div>
              </section>
              <aside className="spend-lab-intro">
                <span className="eyebrow">WANT IT. THINK IT THROUGH.</span>
                <div className="spend-lab-phone" aria-hidden="true">
                  <i />
                  <span>
                    One phone.
                    <br />
                    <b>Three futures.</b>
                  </span>
                  <div>now · sell · wait</div>
                </div>
                <h2>
                  A better phone.
                  <br />A little less guesswork.
                </h2>
                <p>
                  See what buying now, selling first or waiting would leave you with. Then weigh it
                  against what matters to you.
                </p>
                <span className="spend-lab-intro-note">
                  Enjoyment is a valid reason.
                  <br />
                  Let’s see how it fits.
                </span>
              </aside>
            </div>
          )}
          {phase === 'budget' && (
            <section className="spend-lab-panel">
              <div className="spend-lab-section-heading">
                <div>
                  <div className="eyebrow">02 / YOUR BREATHING ROOM</div>
                  <h2>A purchase needs a little context.</h2>
                </div>
                <span className="spend-lab-tag">
                  Your phone ·{' '}
                  {Number.isFinite(euroCents(form.price))
                    ? money(euroCents(form.price))
                    : 'Check price'}
                </span>
              </div>
              {contextLoading && <p role="status">Reading your bank context…</p>}
              {context && (
                <>
                  <fieldset className="spend-lab-accounts">
                    <legend>Which accounts would you use?</legend>
                    <p>
                      Only selected balances count. Savings are included only if you choose them.
                    </p>
                    <div>
                      {context.accounts.map((account) => (
                        <label className="spend-lab-account" key={account.id}>
                          <input
                            type="checkbox"
                            name="accountIds"
                            value={account.id}
                            checked={form.accountIds.includes(account.id)}
                            onChange={(event) =>
                              update(
                                'accountIds',
                                event.target.checked
                                  ? [...form.accountIds, account.id]
                                  : form.accountIds.filter((id) => id !== account.id),
                              )
                            }
                          />
                          <span>
                            <strong>{account.label}</strong>
                            <small>Bank balance</small>
                          </span>
                          <b>{money(account.balanceCents)}</b>
                        </label>
                      ))}
                    </div>
                    {errors.accountIds && (
                      <small className="spend-lab-field-error" role="alert">
                        {errors.accountIds}
                      </small>
                    )}
                    <span className="spend-lab-total">
                      Selected bank balance <b>{money(selectedTotal)}</b>
                    </span>
                  </fieldset>
                  <div className="spend-lab-budget-layout">
                    <section>
                      <div className="spend-lab-section-heading">
                        <h3>Your monthly budget</h3>
                        <span className="spend-lab-tag">
                          {form.useDemo ? 'Demo budget' : 'Your budget assumptions'}
                        </span>
                      </div>
                      <p className="spend-lab-help">
                        {form.useDemo
                          ? 'A fictional budget for Lucía, ready to review. Edit any field to use your own assumptions.'
                          : 'Your forecast, separate from your bank records.'}{' '}
                        Include known bills, debt payments and other commitments in essentials.
                      </p>
                      <div className="spend-lab-fields">
                        <Field
                          name="budget.monthlyIncomeCents"
                          label="Monthly income"
                          value={form.income}
                          onChange={(value) => update('income', value, true)}
                          errors={errors}
                        />
                        <Field
                          name="budget.nextIncomeDate"
                          label="Next pending income"
                          value={form.incomeDate}
                          onChange={(value) => update('incomeDate', value, true)}
                          errors={errors}
                          date
                          min={context.simulationStartDate}
                          max={maxBudgetDate}
                          disabled={euroCents(form.income) === 0}
                        />
                        <Field
                          name="budget.monthlyEssentialExpensesCents"
                          label="Monthly essentials"
                          value={form.essentials}
                          onChange={(value) => update('essentials', value, true)}
                          errors={errors}
                        />
                        <Field
                          name="budget.nextEssentialExpensesDate"
                          label="Next essential payment"
                          value={form.essentialsDate}
                          onChange={(value) => update('essentialsDate', value, true)}
                          errors={errors}
                          date
                          min={context.simulationStartDate}
                          max={maxBudgetDate}
                          disabled={euroCents(form.essentials) === 0}
                        />
                        <Field
                          name="budget.monthlyDiscretionaryExpensesCents"
                          label="Monthly discretionary spending"
                          value={form.discretionary}
                          onChange={(value) => update('discretionary', value, true)}
                          errors={errors}
                        />
                      </div>
                      <p className="spend-lab-help">
                        Use dates for money still to arrive or leave your account. Essentials are
                        grouped into one monthly payment; discretionary spending is spread across
                        the month.
                      </p>
                    </section>
                    <section className="spend-lab-reserve-panel">
                      <h3>Keep some breathing room.</h3>
                      <Field
                        name="reserveCents"
                        label="Your chosen reserve"
                        value={form.reserve}
                        onChange={(value) => update('reserve', value)}
                        errors={errors}
                      />
                      {suggestion !== null && (
                        <p className="spend-lab-help">
                          Three months of essentials: <b>{money(suggestion)}</b>.<br />A starting
                          point, not a bank rule. Choose what fits you.
                        </p>
                      )}
                      {suggestion !== null && (
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() => update('reserve', (suggestion / 100).toFixed(2))}
                        >
                          Use this suggestion
                        </button>
                      )}
                      <div className="spend-lab-sale-block">{saleFields()}</div>
                    </section>
                  </div>
                </>
              )}
              <div className="spend-lab-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => {
                    setPhase('purchase');
                    setErrors({});
                  }}
                >
                  Back to purchase
                </button>
                <button
                  type="submit"
                  className="primary-button"
                  disabled={!context || contextLoading || !!contextError}
                >
                  {evaluating ? 'Reflecting on your purchase…' : 'Evaluate purchase'}{' '}
                  <span aria-hidden="true">↗</span>
                </button>
              </div>
            </section>
          )}
          {phase === 'results' && (
            <section className="spend-lab-panel spend-lab-controls">
              <div className="spend-lab-section-heading">
                <div>
                  <div className="eyebrow">03 / TRY A DIFFERENT FUTURE</div>
                  <h2 data-result-heading tabIndex={-1}>
                    What would this leave you with?
                  </h2>
                </div>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setPhase('budget')}
                >
                  Edit budget & reason
                </button>
              </div>
              <div className="spend-lab-fields">
                <Field
                  name="purchase.amountCents"
                  label="New phone price"
                  value={form.price}
                  onChange={(value) => update('price', value)}
                  errors={fieldErrors}
                />
                <Field
                  name="reserveCents"
                  label="Chosen reserve"
                  value={form.reserve}
                  onChange={(value) => update('reserve', value)}
                  errors={fieldErrors}
                />
              </div>
              {saleFields()}
              {form.selling && context && (
                <label className="spend-lab-timeline">
                  Move your expected sale payment
                  <input
                    type="range"
                    min="0"
                    max="60"
                    value={
                      form.saleDate >= context.simulationStartDate && form.saleDate <= maxSaleDate!
                        ? Math.round(
                            (Date.parse(form.saleDate) - Date.parse(context.simulationStartDate)) /
                              86400000,
                          )
                        : 0
                    }
                    onChange={(event) =>
                      update(
                        'saleDate',
                        addDays(context.simulationStartDate, Number(event.target.value)),
                      )
                    }
                    aria-valuetext={
                      form.saleDate ? shortDate(form.saleDate) : 'Choose a payment date'
                    }
                  />
                  <span>
                    <small>Today</small>
                    <small>In 60 days</small>
                  </span>
                </label>
              )}
              <div className="spend-lab-actions">
                <span className="spend-lab-preview-label" role="status">
                  {dirty
                    ? 'Preview — update analysis'
                    : 'Bank context and analysis updated together'}
                </span>
                <button
                  type="submit"
                  className="primary-button"
                  disabled={contextLoading || !!contextError}
                >
                  {evaluating
                    ? 'Updating your analysis…'
                    : result?.assessment.status === 'unavailable' && !dirty
                      ? 'Retry personal analysis'
                      : 'Update analysis'}{' '}
                  <span aria-hidden="true">↗</span>
                </button>
              </div>
            </section>
          )}
        </fieldset>
      </form>
      {evaluating && (
        <p className="spend-lab-status" role="status">
          Comparing the alternatives and reflecting on your reason…
        </p>
      )}
      {phase === 'results' && result && (
        <>
          {!calculation && (
            <div className="spend-lab-alert" role="alert">
              Complete the highlighted inputs to compare your futures. No older calculation is
              shown.
            </div>
          )}
          {calculation && (
            <>
              {calculation.baseline.financialClass !== 'within_limits' && (
                <p className="spend-lab-alert">
                  Your budget without this purchase already projects{' '}
                  {calculation.baseline.financialClass === 'cash_shortfall'
                    ? 'a cash shortfall'
                    : 'a balance below your reserve'}
                  . Compare the purchase against that starting situation.
                </p>
              )}
              <div className="spend-lab-scenarios" aria-label="Choose a scenario to inspect">
                {calculation.scenarios.map((scenario) => (
                  <button
                    type="button"
                    key={scenario.id}
                    disabled={!scenario.available}
                    className={`spend-lab-scenario ${scenario.available && effectiveSelected === scenario.id ? 'spend-lab-selected' : ''}`}
                    style={
                      { '--scenario-color': scenarioColors[scenario.id] } as React.CSSProperties
                    }
                    aria-pressed={scenario.available && effectiveSelected === scenario.id}
                    onClick={() => setSelected(scenario.id as ScenarioId)}
                  >
                    <span className="spend-lab-scenario-title">
                      <i />
                      {scenarioNames[scenario.id]} <span aria-hidden="true">↗</span>
                    </span>
                    {scenario.available ? (
                      <>
                        <span className={`spend-lab-verdict spend-lab-${scenario.financialClass}`}>
                          {classNames[scenario.financialClass]}
                        </span>
                        <strong className="spend-lab-scenario-min">
                          {money(scenario.minimumBalanceCents)}
                        </strong>
                        <span className="spend-lab-help">
                          Lowest balance · {shortDate(scenario.purchaseDate!)}
                        </span>
                        <span className="spend-lab-scenario-detail">
                          {scenario.metrics.reserveGapCents >= 0
                            ? `${money(scenario.metrics.reserveGapCents)} above your reserve`
                            : `${money(-scenario.metrics.reserveGapCents)} below your reserve`}
                          <small>
                            {scenario.id === 'sell_first'
                              ? 'Only if you sell and get paid first.'
                              : scenario.id === 'wait'
                                ? 'First compatible date within 60 days.'
                                : 'Pay the full price today, without a sale.'}
                          </small>
                        </span>
                      </>
                    ) : (
                      <>
                        <strong>Not available yet</strong>
                        <span className="spend-lab-help">
                          {scenario.reason === 'no_resale'
                            ? 'Add a sale price and payment date to compare.'
                            : 'No compatible purchase date in the next 60 days.'}
                        </span>
                      </>
                    )}
                  </button>
                ))}
              </div>
              <ScenarioChart calculation={calculation} selected={effectiveSelected} />
              {!dirty && !evaluating && result.assessment.status === 'available' && (
                <section className="spend-lab-analysis" aria-labelledby="spend-lab-analysis-title">
                  <div className="eyebrow">THE NUMBERS, MEET YOUR REASON</div>
                  <h2 id="spend-lab-analysis-title">{result.assessment.reflection.headline}</h2>
                  <div className="spend-lab-analysis-grid">
                    <div>
                      <h3>What you’re looking for</h3>
                      <p>{result.assessment.reflection.motiveInterpretation}</p>
                      <h3>What you would be giving up</h3>
                      {result.assessment.reflection.financialTradeoffs.map((tradeoff, index) => (
                        <p key={index}>{tradeoff.text}</p>
                      ))}
                    </div>
                    <div>
                      <h3>What fits your situation</h3>
                      {result.assessment.reflection.preferredScenarioId && (
                        <span className="spend-lab-tag">
                          {scenarioNames[result.assessment.reflection.preferredScenarioId]}
                        </span>
                      )}
                      <p>{result.assessment.reflection.recommendation}</p>
                      <div className="spend-lab-reflection">
                        <span className="eyebrow">A QUESTION TO TAKE WITH YOU</span>
                        <p>{result.assessment.reflection.reflectionQuestion}</p>
                      </div>
                    </div>
                  </div>
                </section>
              )}
              {!dirty && !evaluating && result.assessment.status === 'unavailable' && (
                <section className="spend-lab-panel" role="status">
                  <h2>Personal analysis unavailable</h2>
                  <p>Your comparison is still here. Retry personal analysis when you’re ready.</p>
                </section>
              )}
            </>
          )}
          <details className="spend-lab-data">
            <summary>Data and assumptions</summary>
            <div className="spend-lab-data-grid">
              <div>
                <h3>Observed at the bank</h3>
                <p>
                  Selected balance:{' '}
                  {money(
                    calculation?.startingBalanceCents ?? result.calculation.startingBalanceCents,
                  )}
                  .<br />
                  Read at{' '}
                  {new Date(result.context.observedAt).toLocaleString('en-IE', {
                    timeZone: 'UTC',
                  })}{' '}
                  UTC.
                </p>
                <p>
                  {result.context.history.status === 'unavailable'
                    ? 'Bank history unavailable. The forecast uses current balances and your budget.'
                    : `${result.context.history.count} observed movements${result.context.history.mayBeTruncated ? ' (the bank limit of 100)' : ''}. This is not a complete spending history.`}
                </p>
                {result.context.activity.length > 0 && (
                  <ul>
                    {result.context.activity.map((movement) => (
                      <li key={movement.id}>
                        {shortDate(movement.createdAt)} · {movement.description} ·{' '}
                        {money(movement.amountCents)}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <h3>Forecast assumptions</h3>
                <p>
                  {form.useDemo ? 'Lucía’s fictional demo budget' : 'Budget declared by you'}, kept
                  separate from the bank records. Price, reason, reserve and sale expectations are
                  yours.
                </p>
                <ul>
                  {result.methodology.assumptions.map((assumption) => (
                    <li key={assumption}>{assumption}</li>
                  ))}
                </ul>
                <h3>Reference criteria</h3>
                {result.methodology.sources.map((source) => (
                  <a key={source.url} href={source.url} target="_blank" rel="noreferrer">
                    {source.title} ↗
                  </a>
                ))}
              </div>
            </div>
          </details>
          <p className="spend-lab-footnote">
            A projection from declared assumptions. This section does not buy a phone, sell yours or
            move money.
          </p>
        </>
      )}
    </section>
  );
}
