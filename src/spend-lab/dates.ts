export const HORIZON_DAYS = 90;
export const MAX_WAIT_DAYS = 60;

export function isISODate(value: string): boolean {
  if (!/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function parseDate(value: string): Date {
  if (!isISODate(value)) throw new RangeError('Invalid simulation date');
  return new Date(`${value}T00:00:00.000Z`);
}

function formatDate(value: Date): string {
  const formatted = value.toISOString().slice(0, 10);
  if (!isISODate(formatted)) throw new RangeError('Simulation date is outside the supported range');
  return formatted;
}

export function addDays(value: string, days: number): string {
  const parsed = parseDate(value);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return formatDate(parsed);
}

export function daysInMonth(value: string): number {
  const parsed = parseDate(value);
  return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, 0)).getUTCDate();
}

// Always use the original anchor: Jan 31 -> Feb 28 -> Mar 31, rather than Mar 28.
export function monthlyOccurrence(anchor: string, monthOffset: number): string {
  const parsed = parseDate(anchor);
  const first = new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth() + monthOffset, 1));
  const lastDay = new Date(
    Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0),
  ).getUTCDate();
  first.setUTCDate(Math.min(parsed.getUTCDate(), lastDay));
  return formatDate(first);
}

export function nextMonthlyDate(start: string, dayOfMonth: number): string {
  if (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31)
    throw new RangeError('Invalid monthly day');
  const parsed = parseDate(start);
  for (let offset = 0; offset <= 1; offset++) {
    const first = new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth() + offset, 1));
    const lastDay = new Date(
      Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0),
    ).getUTCDate();
    first.setUTCDate(Math.min(dayOfMonth, lastDay));
    const candidate = formatDate(first);
    if (candidate > start) return candidate;
  }
  throw new RangeError('No future monthly date');
}

export function captureSimulationClock(now: () => Date = () => new Date()) {
  const observedAt = now().toISOString();
  const simulationStartDate = observedAt.slice(0, 10);
  return {
    observedAt,
    simulationStartDate,
    horizonEnd: addDays(simulationStartDate, HORIZON_DAYS),
  };
}
