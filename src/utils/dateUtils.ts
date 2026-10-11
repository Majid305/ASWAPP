/**
 * RÈGLE 20 : Dates et fuseau horaire Africa/Casablanca
 * Toutes les dates métier doivent être interprétées dans le fuseau Africa/Casablanca.
 * Ne jamais utiliser naïvement toISOString().split("T")[0] pour une date commerciale.
 */

export const MOROCCO_TIMEZONE = 'Africa/Casablanca';

const moroccoDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: MOROCCO_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const moroccoDateTimeFormatter = new Intl.DateTimeFormat('fr-MA', {
  timeZone: MOROCCO_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/**
 * Retourne la date métier marocaine au format YYYY-MM-DD pour un instant donné.
 * Garantit qu'une vente effectuée à 23h45 ou 00h15 heure marocaine est rattachée à la bonne journée.
 */
export function getMoroccoBusinessDate(dateInput?: Date | string | number): string {
  const d = dateInput !== undefined ? new Date(dateInput) : new Date();
  if (Number.isNaN(d.getTime())) {
    return moroccoDateFormatter.format(new Date());
  }
  const parts = moroccoDateFormatter.formatToParts(d);
  const year = parts.find((p) => p.type === 'year')?.value ?? '2026';
  const month = parts.find((p) => p.type === 'month')?.value ?? '01';
  const day = parts.find((p) => p.type === 'day')?.value ?? '01';
  return `${year}-${month}-${day}`;
}

export function getMoroccoYear(dateInput?: Date | string | number): number {
  const bDate = getMoroccoBusinessDate(dateInput);
  return parseInt(bDate.slice(0, 4), 10);
}

export function formatMoroccoDateTime(isoString?: string | null): string {
  if (!isoString) return '—';
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return isoString;
  return moroccoDateTimeFormatter.format(d);
}

export function formatBusinessDateFr(businessDate?: string | null): string {
  if (!businessDate) return '—';
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(businessDate);
  if (match) {
    return `${match[3]}/${match[2]}/${match[1]}`;
  }
  return businessDate;
}

export function addMonthsToBusinessDate(businessDate: string, months: number): string {
  const [y, m, d] = businessDate.split('-').map((n) => parseInt(n, 10));
  const dt = new Date(Date.UTC(y || 2026, (m || 1) - 1 + months, d || 1, 12, 0, 0));
  return getMoroccoBusinessDate(dt);
}

export function addDaysToBusinessDate(businessDate: string, days: number): string {
  const [y, m, d] = businessDate.split('-').map((n) => parseInt(n, 10));
  const dt = new Date(Date.UTC(y || 2026, (m || 1) - 1, (d || 1) + days, 12, 0, 0));
  return getMoroccoBusinessDate(dt);
}

export function daysBetweenBusinessDates(fromDate: string, toDate: string): number {
  const [y1, m1, d1] = fromDate.split('-').map((n) => parseInt(n, 10));
  const [y2, m2, d2] = toDate.split('-').map((n) => parseInt(n, 10));
  const utc1 = Date.UTC(y1, m1 - 1, d1);
  const utc2 = Date.UTC(y2, m2 - 1, d2);
  return Math.round((utc2 - utc1) / (1000 * 60 * 60 * 24));
}
