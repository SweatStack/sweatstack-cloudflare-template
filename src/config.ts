// Reads the Worker secrets into a typed config object, and says what is missing.
// Every secret may be empty: the app then sends people to /setup instead of crashing.

export type Config = {
  clientId: string;
  clientSecret: string;
  adminUserIds: string[];
  webhookSecret: string;
  /** Required secrets that are not set. While this is non-empty, the app only serves /setup. */
  missing: Array<"SWEATSTACK_CLIENT_ID" | "SWEATSTACK_CLIENT_SECRET">;
  /** False when SWEATSTACK_WEBHOOK_SECRET is set but does not look like `whsec_...`. */
  webhookSecretLooksValid: boolean;
};

export function readConfig(env: Env): Config {
  const clientId = clean(env.SWEATSTACK_CLIENT_ID);
  const clientSecret = clean(env.SWEATSTACK_CLIENT_SECRET);
  const webhookSecret = clean(env.SWEATSTACK_WEBHOOK_SECRET);
  const adminUserIds = clean(env.ADMIN_USER_IDS)
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  const missing: Config["missing"] = [];
  if (!clientId) missing.push("SWEATSTACK_CLIENT_ID");
  if (!clientSecret) missing.push("SWEATSTACK_CLIENT_SECRET");

  return {
    clientId,
    clientSecret,
    adminUserIds,
    webhookSecret,
    missing,
    webhookSecretLooksValid: webhookSecret === "" || webhookSecret.startsWith("whsec_"),
  };
}

// Secrets pasted into a dashboard often carry stray whitespace or quotes.
function clean(value: string | undefined): string {
  return (value ?? "").trim().replace(/^["']|["']$/g, "").trim();
}
