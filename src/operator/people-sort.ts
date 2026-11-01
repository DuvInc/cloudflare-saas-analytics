const columns: Record<string, string> = {
  user: "COALESCE(NULLIF(name, ''), NULLIF(email, ''), user_id)",
  product: "product",
  origin: "COALESCE(NULLIF(json_extract(first_touch, '$.ai_source'), ''), NULLIF(json_extract(first_touch, '$.channel'), ''))",
  country: "NULLIF(json_extract(first_touch, '$.country'), '')",
  plan: "NULLIF(plan, '')",
  replays: "(SELECT COUNT(*) FROM replay_sessions r WHERE r.product = people.product AND r.user_id = people.user_id)",
  last_seen: "COALESCE(last_seen_at, created_at)",
};

export function peopleOrder(sort: string | null): string {
  const descending = sort?.startsWith('-') ?? false;
  const key = descending ? sort!.slice(1) : sort;
  const column = key && Object.hasOwn(columns, key) ? columns[key] : undefined;
  if (!column) return 'created_at DESC, product ASC, user_id ASC';
  return `(${column} IS NULL) ASC, ${column} COLLATE NOCASE ${descending ? 'DESC' : 'ASC'}, product ASC, user_id ASC`;
}
