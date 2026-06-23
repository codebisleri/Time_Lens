/**
 * Phase Y.3 · Task 2 — holiday hygiene.
 *
 * The backend's holiday-aware detection can flag weekend dates (Saturdays /
 * Sundays) as "holidays", which is incorrect — only festival / national /
 * public / user-selected holidays should count. We can't change the backend, so
 * the UI filters weekends out wherever holidays are surfaced (EDA holiday chart,
 * anomaly "Is Holiday" flag).
 */

/** True when the ISO/parseable date falls on Saturday or Sunday. */
export function isWeekendDate(date: string | null | undefined): boolean {
  if (!date) return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  // Parse calendar-date strings in UTC so local timezones can't shift the
  // weekday; fall back to Date parsing for any other format.
  if (m) {
    const day = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
    return day === 0 || day === 6;
  }
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return false;
  const day = d.getDay();
  return day === 0 || day === 6;
}

/** A genuine holiday = backend-flagged holiday that is NOT a weekend. */
export function isRealHoliday(date: string | null | undefined, isHolidayFlag: boolean): boolean {
  return !!isHolidayFlag && !isWeekendDate(date);
}
