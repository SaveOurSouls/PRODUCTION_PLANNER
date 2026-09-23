/** PostgreSQL JSONB changes object-key order. Array order remains significant. */
export function canonicalJson(value: unknown): string {
  const canonical = (v: unknown): unknown => Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === 'object'
      ? Object.fromEntries(Object.entries(v).filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, item]) => [key, canonical(item)]))
      : v;
  return JSON.stringify(canonical(value));
}
