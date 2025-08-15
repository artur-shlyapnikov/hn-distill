// utils/date-keys.ts
export const toDateKeyUTC = (iso: string): string =>
  typeof iso === "string" && iso.length >= 10 ? iso.slice(0, 10) : "0000-00-00";

export function addDaysUTC(dateKey: string, days: number): string {
  const parts = dateKey.split("-").map((n) => parseInt(n, 10));
  if (parts.length !== 3) {
    return dateKey;
  }
  const [y, m, d] = parts;
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    return dateKey;
  }
  const dt = new globalThis.Date(globalThis.Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

// True ISO week (Mon-based), robust variant from aggregate.mts
export function isoWeekKey(iso: string): string {
  const d = new Date(iso);
  const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNumber = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - dayNumber);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((dt.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  const w = String(weekNo).padStart(2, "0");
  return `${dt.getUTCFullYear()}-w${w}`;
}