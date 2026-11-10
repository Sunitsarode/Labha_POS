/** Single-line text: control characters stripped, trimmed, length-capped. */
export function str(v: unknown, max = 200): string {
  if (v === undefined || v === null) return '';
  return String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

/** Multi-line text (keeps newlines). */
export function text(v: unknown, max = 1000): string {
  if (v === undefined || v === null) return '';
  return String(v)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '')
    .trim()
    .slice(0, max);
}

export function num(v: unknown, def = 0): number {
  if (v === '' || v === null || v === undefined) return def;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : def;
}

export function int(v: unknown, def = 0): number {
  return Math.trunc(num(v, def));
}

export function clampInt(v: unknown, min: number, max: number, def: number): number {
  return Math.min(max, Math.max(min, int(v, def)));
}

export function bool(v: unknown): boolean {
  return v === true || v === 1 || v === '1' || v === 'true' || v === 'on';
}

export function oneOf<T extends string>(v: unknown, list: readonly T[], def: T): T {
  return (list as readonly unknown[]).includes(v) ? (v as T) : def;
}

export function isDate(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
}
