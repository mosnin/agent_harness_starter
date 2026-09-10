/**
 * Minimal, dependency-free 5-field cron matcher:
 * "minute hour day-of-month month day-of-week".
 * Supports wildcard, step (star-slash-N), comma lists, ranges (a-b), and
 * stepped ranges (a-b/N) per field. Day-of-month and day-of-week are AND-ed
 * (simpler than POSIX's OR-when-both-restricted rule — documented so callers
 * aren't surprised).
 */
export function cronMatches(expr: string, date: Date): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`invalid cron (need 5 fields): "${expr}"`);
  const [min, hour, dom, month, dow] = fields;
  return (
    fieldMatches(min, date.getMinutes(), 0, 59) &&
    fieldMatches(hour, date.getHours(), 0, 23) &&
    fieldMatches(dom, date.getDate(), 1, 31) &&
    fieldMatches(month, date.getMonth() + 1, 1, 12) &&
    fieldMatches(dow, date.getDay(), 0, 6)
  );
}

function fieldMatches(field: string, value: number, min: number, max: number): boolean {
  for (const part of field.split(",")) {
    if (part === "*") return true;
    const step = part.match(/^\*\/(\d+)$/);
    if (step) {
      const n = Number(step[1]);
      if (n > 0 && (value - min) % n === 0) return true;
      continue;
    }
    const range = part.match(/^(\d+)-(\d+)$/);
    if (range) {
      const [a, b] = [Number(range[1]), Number(range[2])];
      if (value >= a && value <= b) return true;
      continue;
    }
    const stepRange = part.match(/^(\d+)-(\d+)\/(\d+)$/);
    if (stepRange) {
      const [a, b, n] = [Number(stepRange[1]), Number(stepRange[2]), Number(stepRange[3])];
      if (value >= a && value <= b && (value - a) % n === 0) return true;
      continue;
    }
    if (Number(part) === value) return true;
  }
  return false;
}

/** Validate a cron expression (throws if malformed). */
export function assertValidCron(expr: string): void {
  cronMatches(expr, new Date(0));
}
