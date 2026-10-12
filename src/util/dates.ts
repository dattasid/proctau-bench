// ISO date helpers (YYYY-MM-DD, months as YYYY-MM), all in UTC.

const DAY_MS = 86_400_000;

const parse = (iso: string): number => Date.parse(`${iso}T00:00:00Z`);
const toIso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export const addDays = (iso: string, n: number): string => toIso(parse(iso) + n * DAY_MS);
export const daysBetween = (from: string, to: string): number => Math.round((parse(to) - parse(from)) / DAY_MS);

export const monthOf = (iso: string): string => iso.slice(0, 7);
export const monthStart = (month: string): string => `${month}-01`;

export function monthEnd(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return toIso(Date.UTC(y, m, 0));
}

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return toIso(Date.UTC(y, m - 1 + n, 1)).slice(0, 7);
}

export function ageOn(dateOfBirth: string, iso: string): number {
  const [by, bm, bd] = dateOfBirth.split("-").map(Number) as [number, number, number];
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}
