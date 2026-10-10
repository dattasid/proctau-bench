// Formatting shared by the documents and the coverage check, so both spell numbers the same way.

export function money(dollars: number): string {
  const whole = Number.isInteger(dollars);
  return dollars.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

export const moneyCents = (cents: number): string => money(cents / 100);
export const percent = (apy: number): string => `${apy}%`;
export const days = (n: number): string => (n === 1 ? "1 day" : `${n} days`);
export const times = (n: number): string => (n === 1 ? "1 time" : `${n} times`);

export function longDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}
