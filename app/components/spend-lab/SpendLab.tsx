'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type {
  EvaluationResult,
  ViewedScenarioId,
  SpendLabContext,
} from '../../../src/spend-lab/contracts';
import { addDays } from '../../../src/spend-lab/dates';
import ScenarioTimeline from './ScenarioTimeline';
import ScenarioCards from './ScenarioCards';
import { scenarioNames, purchaseSummary, recommendationEvidenceIds } from './presentation';
import BankActivity from './BankActivity';
import EvidenceDetails from './EvidenceDetails';
import { selectedProjection } from '../../../src/spend-lab/insights';
import {
  demoFields,
  emptyForm,
  euroCents,
  evaluationFromForm,
  money,
  previewFromForm,
  productOptions,
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

function DeviceIcon({ kind }: { kind: (typeof productOptions)[number]['icon'] }) {
  return (
    <svg
      className="spend-lab-device-icon"
      viewBox="0 0 64 64"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {kind === 'phone' ? (
        <>
          <rect x="19" y="5" width="26" height="54" rx="6" />
          <path d="M27 10h10M30 53h4" />
        </>
      ) : kind === 'computer' ? (
        <>
          <rect x="10" y="10" width="44" height="33" rx="3" />
          <path d="M10 43 4 53h56l-6-10M26 49h12" />
        </>
      ) : kind === 'gaming' ? (
        <>
          <path d="M22 19h20c8 0 11 7 14 20 2 11-5 14-11 6l-4-5H23l-4 5c-6 8-13 5-11-6 3-13 6-20 14-20Z" />
          <path d="M18 27v12m-6-6h12M43 28h.01M48 34h.01" />
        </>
      ) : (
        <>
          <path d="M13 37v-6a19 19 0 0 1 38 0v6" />
          <rect x="10" y="34" width="10" height="21" rx="4" />
          <rect x="44" y="34" width="10" height="21" rx="4" />
        </>
      )}
    </svg>
  );
}

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
  help,
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
  help?: string;
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
        aria-describedby={
          [help ? `${id}-help` : null, errors[name] ? `${id}-error` : null]
            .filter(Boolean)
            .join(' ') || undefined
        }
      />
      {help && (
        <small id={`${id}-help`} className="spend-lab-help">
          {help}
        </small>
      )}
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
  const [selected, setSelected] = useState<ViewedScenarioId>('buy_now');
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
  async function loadContext() {
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
        ...(previous.useDemo ? demoFields(data) : {}),
        ...(previous.useDemo && !data.demoBudget ? { useDemo: false } : {}),
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
    void loadContext();
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
  const effectiveSelected = calculation ? selectedProjection(calculation, selected).id : 'buy_now';
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
  const product = productOptions.find((option) => option.id === form.category);

  function loadDemoBudget() {
    if (!context?.demoBudget) return;
    revisionRef.current++;
    setRevision(revisionRef.current);
    setForm((previous) => ({ ...previous, ...demoFields(context) }));
    setErrors({});
    setError('');
  }

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
      setSelected(preferred ?? 'buy_now');
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
            Sell a device you already own first
            <small>Use your expected price and the date you expect to be paid.</small>
          </span>
        </label>
        {form.selling && (
          <div className="spend-lab-fields">
            <Field
              name="resale.amountCents"
              help="Your estimate, not a verified resale price. It counts only in Sell first, after you expect to be paid."
              label="Expected sale price"
              value={form.saleAmount}
              onChange={(value) => update('saleAmount', value)}
              errors={fieldErrors}
            />
            <Field
              name="resale.date"
              help="When you expect to receive the sale payment, not when you list the device."
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
          <p>Think through your next tech purchase.</p>
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
          <button type="button" className="secondary-button" onClick={() => void loadContext()}>
            Retry bank context
          </button>
        </div>
      )}
      <form onSubmit={submit} noValidate>
        <fieldset className="spend-lab-form-shell" disabled={evaluating}>
          {phase === 'purchase' && (
            <div className="spend-lab-purchase-layout">
              <section className="spend-lab-panel">
                <div className="eyebrow">01 / THE PURCHASE YOU HAVE IN MIND</div>
                <h2>What are you making room for?</h2>
                <fieldset
                  className="spend-lab-motives spend-lab-categories"
                  aria-describedby={
                    errors['purchase.category'] ? 'spend-lab-category-error' : undefined
                  }
                >
                  <legend>What kind of tech?</legend>
                  {productOptions.map((option) => (
                    <label className="spend-lab-motive" key={option.id}>
                      <input
                        type="radio"
                        name="purchase.category"
                        value={option.id}
                        checked={form.category === option.id}
                        onChange={() => update('category', option.id)}
                        aria-invalid={!!errors['purchase.category']}
                      />
                      <span>
                        <DeviceIcon kind={option.icon} />
                        <strong>{option.label}</strong>
                      </span>
                    </label>
                  ))}
                </fieldset>
                {errors['purchase.category'] && (
                  <small id="spend-lab-category-error" className="spend-lab-field-error">
                    Choose a category for this purchase.
                  </small>
                )}
                <label className="spend-lab-field" htmlFor="spend-lab-product-name">
                  <span>What would you like to buy?</span>
                  <input
                    id="spend-lab-product-name"
                    name="purchase.productName"
                    type="text"
                    maxLength={160}
                    value={form.productName}
                    placeholder={product?.placeholder ?? 'Product or model…'}
                    onChange={(event) => update('productName', event.target.value)}
                    aria-invalid={!!errors['purchase.productName']}
                    aria-describedby={
                      errors['purchase.productName'] ? 'spend-lab-product-error' : undefined
                    }
                  />
                  {errors['purchase.productName'] && (
                    <small id="spend-lab-product-error" className="spend-lab-field-error">
                      {errors['purchase.productName']}
                    </small>
                  )}
                </label>
                <Field
                  name="purchase.amountCents"
                  label="Purchase price"
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
                    placeholder={
                      product?.context ?? 'How would you use it? What would it change for you?'
                    }
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
                <div className="spend-lab-device-art" aria-hidden="true">
                  <DeviceIcon kind={product?.icon ?? 'other'} />
                  <span>
                    One purchase.
                    <br />
                    <b>Three futures.</b>
                  </span>
                  <div>now · sell · wait</div>
                </div>
                <h2>
                  Something you want.
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
                  {form.productName} ·{' '}
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
                      <BankActivity context={context} accountIds={form.accountIds} />
                      <div className="spend-lab-section-heading">
                        <h3>Your monthly budget</h3>
                        <span className="spend-lab-tag">
                          {form.useDemo ? 'Demo budget' : 'Your budget assumptions'}
                        </span>
                      </div>
                      <p className="spend-lab-help">
                        {form.useDemo
                          ? 'A fictional budget for Lucía, ready to review. Edit any field to use your own assumptions.'
                          : 'These are your estimates of future income and spending, not verified bank records.'}{' '}
                        Include known bills, debt payments and other commitments in essentials.
                      </p>
                      {context.demoBudget && (
                        <button
                          type="button"
                          className="secondary-button spend-lab-demo-button"
                          onClick={loadDemoBudget}
                        >
                          Load Lucía’s demo budget
                        </button>
                      )}
                      <div className="spend-lab-fields">
                        <Field
                          name="budget.monthlyIncomeCents"
                          help="Money you expect to receive each month. We add it on the income date you choose."
                          label="Monthly income"
                          value={form.income}
                          onChange={(value) => update('income', value, true)}
                          errors={errors}
                        />
                        <Field
                          name="budget.nextIncomeDate"
                          help="When you expect the next income to arrive. Enter zero income if none is expected."
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
                          help="Necessary monthly costs, including bills and debt payments. Count them here once."
                          label="Monthly essentials"
                          value={form.essentials}
                          onChange={(value) => update('essentials', value, true)}
                          errors={errors}
                        />
                        <Field
                          name="budget.nextEssentialExpensesDate"
                          help="For this simulation, we group all necessary monthly costs into one payment on this date."
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
                          help="Optional spending, such as eating out or hobbies. We divide it across the days of each month. Do not include this purchase again."
                          label="Monthly optional spending"
                          value={form.discretionary}
                          onChange={(value) => update('discretionary', value, true)}
                          errors={errors}
                        />
                      </div>
                      <p className="spend-lab-help">
                        Use dates for money still to arrive or leave your account. We repeat these
                        amounts each month for the next 90 days. Change them if your expectations
                        change.
                      </p>
                    </section>
                    <section className="spend-lab-reserve-panel">
                      <h3>Keep some breathing room.</h3>
                      <Field
                        name="reserveCents"
                        help="Money you want to keep available for unexpected costs. Falling below it is a warning, not the same as running out of money."
                        label="Your safety cushion"
                        value={form.reserve}
                        onChange={(value) => update('reserve', value)}
                        errors={errors}
                      />
                      {suggestion !== null && (
                        <p className="spend-lab-help">
                          Our starting suggestion — three months of necessary costs:{' '}
                          <b>{money(suggestion)}</b>.<br />A starting point, not a bank rule. Choose
                          what fits you.
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
                  <div className="eyebrow">03 / {product?.label ?? 'YOUR PURCHASE'}</div>
                  <h2 data-result-heading tabIndex={-1}>
                    What would this leave you with?
                  </h2>
                  <p className="spend-lab-product-title">{form.productName}</p>
                </div>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setPhase('purchase')}
                >
                  Edit purchase & budget
                </button>
              </div>
              <div className="spend-lab-fields">
                <Field
                  name="purchase.amountCents"
                  label="Purchase price"
                  value={form.price}
                  onChange={(value) => update('price', value)}
                  errors={fieldErrors}
                />
                <Field
                  name="reserveCents"
                  help="Money you want to keep available for unexpected costs. Falling below it is a warning, not the same as running out of money."
                  label="Your safety cushion"
                  value={form.reserve}
                  onChange={(value) => update('reserve', value)}
                  errors={fieldErrors}
                />
              </div>
              {saleFields()}
              {form.selling && context && (
                <label className="spend-lab-sale-timing">
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
              <p className="spend-lab-summary" aria-live="polite">
                {purchaseSummary(calculation)}
              </p>
              <ScenarioCards
                calculation={calculation}
                selected={effectiveSelected}
                onSelect={setSelected}
              />
              <ScenarioTimeline
                calculation={calculation}
                selected={effectiveSelected}
                onSelect={setSelected}
              />
              {!dirty && !evaluating && result.assessment.status === 'available' && (
                <section className="spend-lab-analysis" aria-labelledby="spend-lab-analysis-title">
                  <div className="eyebrow">THE NUMBERS, MEET YOUR REASON</div>
                  <h2 id="spend-lab-analysis-title">{result.assessment.reflection.headline}</h2>
                  <div className="spend-lab-analysis-grid">
                    <div>
                      <h3>What you’re looking for</h3>
                      <p>{result.assessment.reflection.motiveInterpretation}</p>
                      <details className="spend-lab-why">
                        <summary>Why?</summary>
                        <p>
                          You chose “
                          {
                            motives.find((motive) => motive.id === result.input.purchase.motive)
                              ?.title
                          }
                          ” for {result.input.purchase.productName ?? 'this purchase'}.
                        </p>
                        {result.input.purchase.context && (
                          <blockquote>{result.input.purchase.context}</blockquote>
                        )}
                        <small>Your declared reason and context.</small>
                      </details>
                      <h3>What this means for your money</h3>
                      {result.assessment.reflection.financialTradeoffs.map((tradeoff, index) => (
                        <div key={index}>
                          <p>{tradeoff.text}</p>
                          <EvidenceDetails evidence={result.evidence} ids={tradeoff.evidenceIds} />
                        </div>
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
                      <EvidenceDetails
                        evidence={result.evidence}
                        ids={recommendationEvidenceIds(
                          calculation,
                          result.assessment.reflection.preferredScenarioId,
                        )}
                        explanation="Key figures for this alternative. Your reason explains its personal value."
                      />
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
                <BankActivity context={result.context} accountIds={form.accountIds} />
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
                <h3>Your forecast inputs</h3>
                <p>
                  {form.useDemo ? 'Lucía’s fictional demo budget' : 'Budget declared by you'}, kept
                  separate from the bank records. Price, reason, reserve and sale expectations are
                  yours.
                </p>
                <h3>How this simulation works</h3>
                <ul>
                  {result.methodology.assumptions.map((assumption) => (
                    <li key={assumption}>{assumption}</li>
                  ))}
                </ul>
                <h3>General financial reference points</h3>
                <ul>
                  {result.methodology.principles.map((principle) => (
                    <li key={principle}>{principle}</li>
                  ))}
                </ul>
                {result.methodology.sources.map((source) => (
                  <a key={source.url} href={source.url} target="_blank" rel="noreferrer">
                    {source.title} ↗
                  </a>
                ))}
              </div>
            </div>
          </details>
          <p className="spend-lab-footnote">
            A projection from declared assumptions. This section does not buy or sell a device or
            move money.
          </p>
        </>
      )}
    </section>
  );
}
