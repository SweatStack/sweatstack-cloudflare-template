// Small operational facts kept in D1 `app_state` and shown on /admin:
//   first_login_at      set once, on the first successful sign-in (hides the "Finish setup" panel)
//   last_token_error    the last credential problem at sign-in (empty when the last sign-in worked)
//   last_webhook_at     the last webhook that passed signature verification
//   last_webhook_error  the last webhook rejected because of its signature

export type AppStateName = "first_login_at" | "last_token_error" | "last_webhook_at" | "last_webhook_error";
export type AppState = Partial<Record<AppStateName, { value: string; updatedAt: number }>>;

export async function getAppState(db: D1Database): Promise<AppState> {
  const { results } = await db.prepare("SELECT name, value, updated_at FROM app_state").all<{
    name: AppStateName;
    value: string;
    updated_at: number;
  }>();
  const state: AppState = {};
  for (const row of results) if (row.value) state[row.name] = { value: row.value, updatedAt: row.updated_at };
  return state;
}

export async function setAppState(
  db: D1Database,
  name: AppStateName,
  value: string,
  { onlyIfMissing = false }: { onlyIfMissing?: boolean } = {},
): Promise<void> {
  const sql = onlyIfMissing
    ? "INSERT OR IGNORE INTO app_state (name, value, updated_at) VALUES (?, ?, ?)"
    : "INSERT INTO app_state (name, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at";
  await db.prepare(sql).bind(name, value, Date.now()).run();
}
