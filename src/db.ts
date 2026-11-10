type Bindable = string | number | null;

function toBind(v: unknown): Bindable {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

/** Prepared statement with D1-safe bindings (undefined → NULL, boolean → 0/1). */
export function prep(db: D1Database, sql: string, ...args: unknown[]): D1PreparedStatement {
  const stmt = db.prepare(sql);
  return args.length ? stmt.bind(...args.map(toBind)) : stmt;
}

export async function all<T = Record<string, any>>(db: D1Database, sql: string, ...args: unknown[]): Promise<T[]> {
  const res = await prep(db, sql, ...args).all<T>();
  return res.results ?? [];
}

export async function first<T = Record<string, any>>(db: D1Database, sql: string, ...args: unknown[]): Promise<T | null> {
  return prep(db, sql, ...args).first<T>();
}

export async function run(db: D1Database, sql: string, ...args: unknown[]): Promise<D1Result> {
  return prep(db, sql, ...args).run();
}
